#!/usr/bin/env node
// The end-to-end suite of the gateway, run on every pull request and by the `verify` skill: `npm run e2e`.
// It builds the binaries once, then runs the `zodchi` command and `zodchi-server` the way a user does, against
// scripts/e2e/fake-codex.mjs in place of Codex: no model, no network beyond 127.0.0.1, nothing spent.
//
//   node scripts/e2e.mjs [--cargo-profile <name>] [--no-build] [--bin-dir <dir>] [--keep] [--out <dir>] [scenario ...]
//
//   --cargo-profile  Cargo profile and its rust/target subfolder, default release
//   --no-build   use the binaries already built for that profile (CI builds them in the step before)
//   --bin-dir    with --no-build, test a separate candidate without replacing the active release binaries
//   --keep       keep the scratch folder (fixture repositories, data folders, Codex homes) after a pass too
//   --out <dir>  where the traces go; default .agent-tmp/e2e-traces/ of this repository, emptied at the start
//   scenario     run only these (names as printed); default all
//
// Every scenario writes one trace, <out>/<scenario>.log: each command or HTTP call with its exit code or status and
// what it printed, tokens redacted. The summary line of each scenario names its time and its trace; the build time is
// printed apart. Exit code 0 only when every scenario that runs on this system passed. A scenario that cannot run on
// this system (POSIX signals on Windows, Windows job objects elsewhere) prints SKIP with the reason.
//
// Nothing here sleeps to make a check pass: a scenario waits for a condition (a file the fake writes when a turn has
// entered, a final status, a line on stdout) with a deadline, and the fake holds a turn until the scenario releases it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = path.join(ROOT, "scripts", "e2e", "fake-codex.mjs");
const FAKE_FLOW = path.join(ROOT, "scripts", "e2e", "fake-codex-flow.mjs");
const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const option = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const noBuild = flag("--no-build");
const keep = flag("--keep");
const outOption = option("--out");
const binOption = option("--bin-dir");
const cargoProfile = option("--cargo-profile");
const profile = cargoProfile === null ? "release" : cargoProfile;
if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(profile ?? "")) throw new Error("--cargo-profile requires a Cargo profile name");
if (binOption && !noBuild) throw new Error("--bin-dir requires --no-build");
// Cargo reserves "check" as a profile name. Use it as the suite's name for the flow-check binaries.
const buildProfile = profile === "check" ? "flow-check" : profile;
const cargoDir = profile === "dev" || profile === "test" ? "debug" : profile === "bench" ? "release" : profile;
const targetDir = path.resolve(process.env.CARGO_TARGET_DIR || path.join(ROOT, "rust", "target"));
const binDir = binOption ? path.resolve(binOption) : path.join(targetDir, cargoDir);
const binaries = ["zodchi" + EXE, "zodchi-server" + EXE];
const wanted = argv;

const tempDirectory = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempDirectory, "zodchi-e2e-"));
// Windows keeps the executable of a detached worker locked until it exits. Keep candidate test workers off the
// build artifacts so the next package can rebuild into the same Cargo target directory.
const runBinDir = WIN && (binOption || profile === "check") ? path.join(scratch, "bin") : binDir;
const [ZODCHI, SERVER] = binaries.map((name) => path.join(runBinDir, name));
const traces = path.resolve(outOption || path.join(ROOT, ".agent-tmp", "e2e-traces"));
if (!outOption) fs.rmSync(traces, { recursive: true, force: true });
fs.mkdirSync(traces, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/** Tokens and bearer values never reach a trace. */
const redact = (text) => String(text).replace(/zs_[A-Za-z0-9_-]+/g, "zs_<redacted>").replace(/(Bearer\s+)\S+/gi, "$1<redacted>");
const clip = (text, n = 1500) => (text.length > n ? text.slice(0, n) + `... (${text.length} chars)` : text);
const samePath = (a, b) => {
  // The real path when it exists: macOS temp folders sit behind /var -> /private/var, Windows may give 8.3 short names.
  const n = (p) => { const r = path.resolve(String(p)); let s = r; try { s = fs.realpathSync.native(r); } catch { /* not there */ } return s.replace(/[\\/]+$/, ""); };
  return WIN ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

class Failure extends Error {}
class StartupFailure extends Error {}

function checkStartup(code, program) {
  if (WIN && [-1073741502, 3221225794].includes(code)) {
    throw new StartupFailure(`${path.basename(program)} could not initialize (0xC0000142, exit ${code})`);
  }
}

/** The trace of one scenario and its assertions. */
class Trace {
  constructor(name) {
    this.name = name;
    this.file = path.join(traces, `${name}.log`);
    this.lines = [];
    this.cleanups = [];
  }
  log(text) {
    this.lines.push(redact(text));
  }
  ok(cond, message) {
    if (!cond) {
      this.log(`FAILED: ${message}`);
      throw new Failure(message);
    }
    this.log(`ok: ${message}`);
  }
  eq(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    this.ok(a === e, `${message} (got ${clip(a, 300)}${a === e ? "" : `, expected ${clip(e, 300)}`})`);
  }
  /** Waits for `probe` to return something truthy, checking every 25 ms, at most `ms`. */
  async until(what, probe, ms = 30000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) {
        this.log(`ok: ${what}`);
        return value;
      }
      if (Date.now() > deadline) {
        this.log(`FAILED: timed out after ${ms} ms waiting for ${what}`);
        throw new Failure(`timed out waiting for ${what}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  write() {
    fs.writeFileSync(this.file, this.lines.join("\n") + "\n");
  }
}

let outputs = 0;
/** Runs a program to its end. Returns {code, out, err, json}. Its stdout and stderr go to files, not pipes: a worker
 *  it starts may inherit them, and a pipe would then stay open until the worker ends. */
function run(t, program, args, { cwd, env, input, label, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const base = path.join(scratch, "outputs", String(++outputs));
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const [outFd, errFd] = [fs.openSync(`${base}.out`, "w"), fs.openSync(`${base}.err`, "w")];
    const child = spawn(program, args, { cwd, env, stdio: [input === undefined ? "ignore" : "pipe", outFd, errFd], windowsHide: true });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    let spawnError = "";
    let ended = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const end = (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      const out = fs.readFileSync(`${base}.out`, "utf8");
      const err = fs.readFileSync(`${base}.err`, "utf8") + spawnError;
      let json = null;
      try { json = JSON.parse(out); } catch { /* not JSON */ }
      t.log(`$ ${label || path.basename(program)} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}${cwd ? `   (in ${cwd})` : ""}`);
      t.log(`  exit ${code}${out.trim() ? `\n  stdout: ${clip(out.trim()).replace(/\n/g, "\n          ")}` : ""}${err.trim() ? `\n  stderr: ${clip(err.trim()).replace(/\n/g, "\n          ")}` : ""}`);
      try { checkStartup(code, program); } catch (error) { reject(error); return; }
      resolve({ code, out, err, json });
    };
    child.on("error", (e) => { spawnError = String(e); end(null); });
    child.on("exit", (code) => end(code));
    if (input !== undefined) child.stdin.end(input);
  });
}

/** A scratch world for one scenario: its own home, zodchi home, Codex home (signed in for the fake) and roles. */
function world(name, { signedIn = true, maxParallelJobs } = {}) {
  const dir = path.join(scratch, name);
  const home = path.join(dir, "home");
  const zhome = path.join(dir, "zodchi-home");
  const codex = path.join(dir, "codex-home");
  const roles = path.join(dir, "roles");
  for (const d of [home, zhome, codex, roles]) fs.mkdirSync(d, { recursive: true });
  if (maxParallelJobs !== undefined) fs.writeFileSync(path.join(zhome, "config.json"), JSON.stringify({ maxParallelJobs }));
  if (signedIn) fs.writeFileSync(path.join(codex, "fake-auth.json"), "{}");
  const write = (file, value) => fs.writeFileSync(path.join(roles, file), JSON.stringify(value));
  write("ask.json", { description: "plain text", mode: "expert", model: "fake-model", effort: "low" });
  write("structured.json", { mode: "expert", model: "fake-model", effort: "low", schema: "structured.schema.json" });
  write("structured.schema.json", { type: "object", properties: { codexHome: { type: "string" } }, required: ["codexHome"], additionalProperties: false });
  write("picture.json", { kind: "image", mode: "expert", model: "fake-model", effort: "low" });
  write("builder.json", { mode: "work", model: "fake-model", effort: "low", sandbox: "workspace-write", mcpServers: [] });
  write("judge.json", { kind: "decisions", mode: "expert", model: "fake-model", timeoutMin: 5 });
  const env = { ...process.env, ZODCHI_CODEX_BIN: FAKE, ZODCHI_HOME: zhome, ZODCHI_ROLES: roles, CODEX_HOME: codex, HOME: home, USERPROFILE: home };
  // The enclosing Flow run can already hold the machine-wide check slot.
  env.ZODCHI_CHECK_SLOT_DIR = path.join(dir, "check-slot");
  delete env.OPENAI_API_KEY;
  delete env.ZODCHI_DENYLIST;
  return { dir, home, zhome, codex, roles, env };
}

/** A Git repository that ignores .agent-tmp/, as the gateway requires. */
function repo(t, w, name = "repo", { ignore = true } = {}) {
  const dir = path.join(w.dir, name);
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q", dir], { env: w.env, encoding: "utf8", windowsHide: true });
  checkStartup(r.status, "git");
  t.ok(r.status === 0, `git init ${name}`);
  if (ignore) fs.writeFileSync(path.join(dir, ".gitignore"), ".agent-tmp/\n");
  return dir;
}

const zodchi = (t, w, args, opts = {}) => run(t, ZODCHI, args, { env: w.env, label: "zodchi", ...opts });

/** Writes a prompt file and returns its path. */
function prompt(w, name, text) {
  const file = path.join(w.dir, "prompts", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** The turns the fake has run in a Codex home whose prompt contains `needle`. */
const turns = (codexHome, needle) => readJsonl(path.join(codexHome, "fake-turns.jsonl")).filter((x) => x.prompt.includes(needle));
const entered = (codexHome, name) => fs.existsSync(path.join(codexHome, `fake-entered-${name}`));
function release(t, codexHome, name) {
  fs.writeFileSync(path.join(codexHome, `fake-release-${name}`), "");
  t.log(`released HOLD:${name}`);
}
/** A held turn is always released at the end of its scenario, so no fake waits forever. */
function hold(t, codexHome, name) {
  t.cleanups.push(() => fs.writeFileSync(path.join(codexHome, `fake-release-${name}`), ""));
  return `HOLD:${name}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The server

/** An admin command of zodchi-server; its JSON output. */
async function admin(t, w, data, args) {
  const r = await run(t, SERVER, [...args, "--data", data], { env: w.env, label: "zodchi-server" });
  t.ok(r.code === 0 && r.json, `zodchi-server ${args.slice(0, 2).join(" ")} succeeds`);
  return r.json;
}

/** A user (signed in for the fake unless `signedIn` is false): {id, token, home}. */
async function user(t, w, data, name, signedIn = true) {
  const added = await admin(t, w, data, ["user", "add", name]);
  const home = path.join(data, "users", added.id, "codex-home");
  if (signedIn) fs.writeFileSync(path.join(home, "fake-auth.json"), "{}");
  return { id: added.id, token: added.token, home };
}

/** Starts `zodchi-server serve` on a free port of 127.0.0.1 and waits for the line that names its address. */
async function serve(t, w, data, extra = []) {
  const log = path.join(w.dir, `server-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.log`);
  const errFd = fs.openSync(log, "w");
  const args = ["serve", "--listen", "127.0.0.1:0", "--data", data, ...extra];
  const child = spawn(SERVER, args, { env: w.env, stdio: ["ignore", "pipe", errFd], windowsHide: true });
  fs.closeSync(errFd);
  t.log(`$ zodchi-server ${args.join(" ")}   (stderr: ${log})`);
  // Cleanup and the exit and error handlers come first: a server that never becomes ready is still killed and reaped.
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (e) => resolve({ code: null, signal: null, error: String(e) }));
  });
  const kill = () => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
  t.cleanups.push(kill);
  let first = "";
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Failure("the server announced no address in 30 s")), 30000);
    if (child.stdout) child.stdout.on("data", (d) => {
      first += d;
      const m = first.match(/http:\/\/(\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    exited.then((e) => { clearTimeout(timer); reject(new Failure(`the server ${e.error ? `did not start (${e.error})` : `exited with ${e.code}`} before it listened: ${fs.readFileSync(log, "utf8")}`)); });
  }).catch(async (e) => {
    kill();
    const reaped = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
    t.log(reaped ? "  the server that did not become ready was killed and reaped" : `  the server ${child.pid} did not exit within 10 s of SIGKILL`);
    throw e;
  });
  t.log(`  listening on ${address}`);
  const server = {
    child, address, log, exited, kill,
    stderr: () => fs.readFileSync(log, "utf8"),
  };
  return server;
}

/** One HTTP request; {status, type, body (Buffer), text, json}. `head` sends only the head with the given headers. */
function call(t, server, method, route, { token, body, headers = {}, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const [host, port] = [server.address.slice(0, server.address.lastIndexOf(":")), Number(server.address.slice(server.address.lastIndexOf(":") + 1))];
    const h = { Connection: "close", ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (payload) { h["Content-Type"] = "application/json"; h["Content-Length"] = payload.length; }
    const req = http.request({ host, port, method, path: route, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        const type = res.headers["content-type"] || "";
        if (!quiet) t.log(`> ${method} ${route}${token ? " (token)" : ""}${payload ? ` body ${clip(payload.toString("utf8"), 300)}` : ""}\n  ${res.statusCode} ${type} ${clip(type.startsWith("image/") ? `<${buf.length} bytes>` : text, 800)}`);
        resolve({ status: res.statusCode, type, body: buf, text, json });
      });
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("no answer in 120 s")));
    if (payload) req.end(payload); else req.end();
  });
}

/** Polls a job until its status is final; returns the job as the API shows it. */
async function finished(t, server, token, key, ms = 60000) {
  const done = ["succeeded", "failed", "limited", "auth_required", "unknown", "timeout"];
  let job = null;
  await t.until(`job ${key} is final`, async () => {
    const a = await call(t, server, "GET", `/v1/jobs/${key}?waitSec=5`, { token, quiet: true });
    job = a.json && a.json.job;
    return a.status === 200 && job && done.includes(job.status);
  }, ms);
  t.log(`  job ${key}: ${JSON.stringify(job).slice(0, 400)}`);
  return job;
}

/** An answer names neither the data folder, nor the scratch folder, nor the internal file names. */
function noPaths(t, w, data, answer, what) {
  const text = answer.text.toLowerCase();
  const strings = [];
  const walk = (v) => { if (typeof v === "string") strings.push(v.toLowerCase()); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(answer.json);
  const all = [text, ...strings].join("\n");
  const needles = ["server.json", "users\\", "users/", "codex-home"];
  for (const p of [data, w.dir, scratch]) {
    const abs = path.resolve(p).toLowerCase();
    needles.push(abs.replace(/\\/g, "/"), abs.replace(/\//g, "\\"));
  }
  const found = needles.filter((n) => all.includes(n));
  t.ok(found.length === 0, `${what}: the answer names no server path${found.length ? ` (it names ${found.join(", ")})` : ""}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios

const scenarios = [];
const scenario = (name, about, fn, only) => scenarios.push({ name, about, fn, only });

scenario("cli-keyed-job", "a job under a key through the CLI: submit, wait, look up; the same request again from a fresh client is the same job and one execution; another request on the key is refused", async (t) => {
  const w = world("cli-keyed-job");
  const r = repo(t, w);
  const p1 = prompt(w, "p1.md", "hello one\n");
  const sub = await zodchi(t, w, ["submit", "--role", "ask", "--key", "k1", "--prompt", p1], { cwd: r });
  t.eq([sub.code, sub.json && sub.json.created], [0, true], "submit stores the job and returns at once");
  t.ok(["queued", "running"].includes(sub.json.job.status), `the new job is queued or running (${sub.json.job.status})`);
  const out = path.join(w.dir, "out", "k1.txt");
  const waited = await zodchi(t, w, ["wait", "--key", "k1", "--wait-sec", "60", "--out", out], { cwd: r });
  t.eq([waited.code, waited.json.job.status], [0, "succeeded"], "wait ends with the final status (the worker outlived the submit)");
  const answer = fs.readFileSync(out, "utf8");
  t.ok(answer.startsWith("CODEX_HOME=") && samePath(answer.slice("CODEX_HOME=".length).trim(), w.codex), "--out holds the answer, made in the Codex home of the account");
  t.eq(waited.json.job.account, "default", "the job names the account it ran on");
  const looked = await zodchi(t, w, ["job", "--key", "k1"], { cwd: r });
  t.eq([looked.code, looked.json.job.status, looked.json.job.createdAt], [0, "succeeded", sub.json.job.createdAt], "job prints the same job");

  const again = await zodchi(t, w, ["submit", "--role", "ask", "--key", "k1", "--prompt", p1], { cwd: r });
  t.eq([again.code, again.json.created, again.json.job.createdAt, again.json.job.status], [0, false, sub.json.job.createdAt, "succeeded"], "the same request from a fresh client returns the same job");
  const rerun = await zodchi(t, w, ["run", "--role", "ask", "--key", "k1", "--prompt", p1, "--wait-sec", "60"], { cwd: r });
  t.eq([rerun.code, rerun.json.created], [0, false], "run with the same request is that job too");
  t.eq(turns(w.codex, "hello one").length, 1, "the fake ran the request once");

  const p2 = prompt(w, "p2.md", "hello two\n");
  const changed = await zodchi(t, w, ["submit", "--role", "ask", "--key", "k1", "--prompt", p2], { cwd: r });
  t.ok(changed.code === 1 && /already belongs to a different request/.test(changed.err), "another request on the key is refused");
  const effort = await zodchi(t, w, ["submit", "--role", "ask", "--key", "k1", "--prompt", p1, "--effort", "high"], { cwd: r });
  t.ok(effort.code === 1 && /already belongs to a different request/.test(effort.err), "the same prompt with another effort is another request");
  t.eq([turns(w.codex, "hello two").length, turns(w.codex, "hello one").length], [0, 1], "the refusals ran nothing");

  const structured = path.join(w.dir, "out", "j1.json");
  const json = await zodchi(t, w, ["run", "--role", "structured", "--key", "j1", "--prompt", p1, "--wait-sec", "60", "--out", structured], { cwd: r });
  t.eq(json.code, 0, "a role with a schema succeeds");
  t.ok(samePath(JSON.parse(fs.readFileSync(structured, "utf8")).codexHome, w.codex), "--out holds the JSON of the schema");
  const attach = prompt(w, "notes.txt", "attached words\n");
  const att = await zodchi(t, w, ["run", "--role", "ask", "--key", "a1", "--prompt", p2, "--attach", attach, "--wait-sec", "60"], { cwd: r });
  t.eq(att.code, 0, "a call with an attachment succeeds");
  const sent = turns(w.codex, "attached words");
  t.ok(sent.length === 1 && sent[0].prompt.includes("<attachment path="), "the attachment reached the model inside the prompt");

  const fail = await zodchi(t, w, ["run", "--role", "ask", "--key", "f1", "--prompt", prompt(w, "fail.md", "FAIL now\n"), "--wait-sec", "60"], { cwd: r });
  t.eq([fail.code, fail.json.job.status], [2, "failed"], "a failed turn ends failed, exit 2");

  const badKey = await zodchi(t, w, ["submit", "--role", "ask", "--key", "bad key!", "--prompt", p1], { cwd: r });
  t.ok(badKey.code === 1 && /--key is 1-96 characters/.test(badKey.err), "a key outside A-Z a-z 0-9 . _ - is refused");
  const unignored = repo(t, w, "unignored", { ignore: false });
  const refused = await zodchi(t, w, ["submit", "--role", "ask", "--key", "u1", "--prompt", p1], { cwd: unignored });
  t.ok(refused.code === 1 && /does not ignore \.agent-tmp\//.test(refused.err), "a repository that does not ignore .agent-tmp/ is refused");
  t.ok(!fs.existsSync(path.join(unignored, ".agent-tmp")), "nothing was stored there");
  const outside = path.join(w.dir, "not-a-repo");
  fs.mkdirSync(outside, { recursive: true });
  const nowhere = await zodchi(t, w, ["submit", "--role", "ask", "--key", "n1", "--prompt", p1], { cwd: outside });
  t.ok(nowhere.code === 1 && /inside a Git repository/.test(nowhere.err), "outside a repository the call is refused");
  const rooted = await zodchi(t, w, ["run", "--role", "ask", "--key", "n1", "--prompt", p1, "--root", r, "--wait-sec", "60"], { cwd: outside });
  t.eq(rooted.code, 0, "--root names the repository from outside it");
  t.ok(fs.existsSync(path.join(r, ".agent-tmp", "gateway", "n1", "job.json")), "the job lives in .agent-tmp/gateway/<key>/ of that repository");
});

scenario("cli-image-job", "an image job through the CLI: an input image goes in, the image of the answer comes out with --out", async (t) => {
  const w = world("cli-image-job");
  const r = repo(t, w);
  const input = path.join(w.dir, "in.png");
  fs.writeFileSync(input, PNG);
  const out = path.join(w.dir, "out", "picture.png");
  const p = prompt(w, "dot.md", "draw a dot\n");
  const res = await zodchi(t, w, ["run", "--role", "picture", "--key", "img1", "--prompt", p, "--image", input, "--wait-sec", "60", "--out", out], { cwd: r });
  t.eq([res.code, res.json.job.status, res.json.job.kind], [0, "succeeded", "image"], "the image job succeeds");
  t.ok(fs.readFileSync(out).subarray(0, 8).equals(PNG.subarray(0, 8)), "--out is the PNG the model made");
  t.eq(res.json.written.length, 1, "one file written");
  t.ok(fs.readFileSync(path.join(r, ".agent-tmp", "gateway", "img1", "in-0.png")).equals(PNG), "the input image is stored with the job");
  t.ok(turns(w.codex, "draw a dot")[0].image, "the turn ran as an image job");
  const notImage = path.join(w.dir, "not-an-image.png");
  fs.writeFileSync(notImage, "plain text");
  const bad = await zodchi(t, w, ["submit", "--role", "picture", "--key", "img2", "--prompt", p, "--image", notImage], { cwd: r });
  t.ok(bad.code === 1 && /PNG, JPEG or WebP/.test(bad.err), "an input that is not an image is refused");
  t.ok(!fs.existsSync(path.join(r, ".agent-tmp", "gateway", "img2")), "the refused key stays free");
});

scenario("cli-dead-worker", "a worker killed after its turn entered: a fresh look-up settles the job as unknown, the same for every reader at once, and never reruns it", async (t) => {
  const w = world("cli-dead-worker", { maxParallelJobs: 2 });
  const r = repo(t, w);
  const sub = await zodchi(t, w, ["submit", "--role", "ask", "--key", "dead1", "--prompt", prompt(w, "dead.md", `${hold(t, w.codex, "dead")}\n`)], { cwd: r });
  t.eq(sub.code, 0, "submitted");
  await t.until("the turn entered the fake", () => entered(w.codex, "dead"));
  const running = await zodchi(t, w, ["job", "--key", "dead1"], { cwd: r });
  t.eq([running.code, running.json.job.status], [3, "running"], "the job is running");
  const worker = running.json.job.workerPid;
  const codexPid = Number(fs.readFileSync(path.join(w.codex, "fake-entered-dead"), "utf8"));
  t.ok(codexPid > 0 && alive(codexPid), `the Codex process ${codexPid} of the turn is alive`);
  t.ok(worker > 0 && alive(worker), `the worker ${worker} is alive`);
  process.kill(worker, "SIGKILL");
  t.log(`killed the worker ${worker}`);
  await t.until("the worker is gone", () => !alive(worker), 10000);
  const readers = await Promise.all([0, 1, 2, 3].map(() => zodchi(t, w, ["job", "--key", "dead1"], { cwd: r })));
  for (const x of readers) t.eq([x.code, x.json.job.status], [2, "unknown"], "a fresh look-up reports unknown, exit 2");
  t.eq(new Set(readers.map((x) => x.json.job.finishedAt)).size, 1, "every reader got the same end");
  t.ok(/whether the turn ran is unknown/.test(readers[0].json.job.error), "the error says the turn may have run");
  t.ok(!alive(codexPid), "the Codex process of the dead worker was stopped");
  const later = await zodchi(t, w, ["wait", "--key", "dead1", "--wait-sec", "5"], { cwd: r });
  t.eq([later.code, later.json.job.status, later.json.job.finishedAt], [2, "unknown", readers[0].json.job.finishedAt], "the end stands");
  t.eq(turns(w.codex, "HOLD:dead").length, 1, "the turn was never run again");

  // A worker that dies while its job still waits for a place: nothing was asked, so the job fails and says so.
  const fill = ["fill1", "fill2"];
  for (const n of fill) t.eq((await zodchi(t, w, ["submit", "--role", "ask", "--key", n, "--prompt", prompt(w, `${n}.md`, `${hold(t, w.codex, n)}\n`)], { cwd: r })).code, 0, `${n} takes a place`);
  await t.until("both places are taken", () => fill.every((n) => entered(w.codex, n)));
  t.eq((await zodchi(t, w, ["submit", "--role", "ask", "--key", "queued1", "--prompt", prompt(w, "queued.md", "waiting in the queue\n")], { cwd: r })).code, 0, "a third job is submitted");
  const queued = await t.until("its worker waits for a place", async () => {
    const j = await zodchi(t, w, ["job", "--key", "queued1"], { cwd: r });
    return j.json && j.json.job.status === "queued" && j.json.job.workerPid ? j.json.job : null;
  });
  process.kill(queued.workerPid, "SIGKILL");
  t.log(`killed the queued worker ${queued.workerPid}`);
  await t.until("the queued worker is gone", () => !alive(queued.workerPid), 10000);
  const settled = await zodchi(t, w, ["job", "--key", "queued1"], { cwd: r });
  t.eq([settled.code, settled.json.job.status], [2, "failed"], "a worker dead before the model call: failed");
  t.ok(/before the model call; the model was not asked and nothing was spent/.test(settled.json.job.error), "the error says nothing was spent");
  for (const n of fill) release(t, w.codex, n);
  t.eq(turns(w.codex, "waiting in the queue").length, 0, "the model was never asked");
});

scenario("cli-three-jobs", "three jobs at once in one repository: two run, the third waits in the queue until a place is free; each ends with its own result", async (t) => {
  const w = world("cli-three-jobs", { maxParallelJobs: 2 });
  const r = repo(t, w);
  const names = ["q1", "q2", "q3"];
  const subs = await Promise.all(names.map((n) => zodchi(t, w, ["submit", "--role", "ask", "--key", n, "--prompt", prompt(w, `${n}.md`, `job ${n} ${hold(t, w.codex, n)}\n`)], { cwd: r })));
  t.ok(subs.every((s) => s.code === 0 && s.json.created), "three submits at once, each created");
  await t.until("two turns entered the fake", () => names.filter((n) => entered(w.codex, n)).length >= 2);
  const waiting = names.find((n) => !entered(w.codex, n));
  t.ok(waiting, "one job has not entered");
  await t.until(`the worker of ${waiting} is up and waiting for a place`, async () => {
    const j = await zodchi(t, w, ["job", "--key", waiting], { cwd: r });
    return j.json && j.json.job.workerPid && j.json.job.status === "queued";
  });
  t.eq(names.filter((n) => entered(w.codex, n)).length, 2, "still two in the fake: the queue holds two per repository");
  const first = names.find((n) => n !== waiting);
  release(t, w.codex, first);
  await t.until(`${waiting} entered once a place was free`, () => entered(w.codex, waiting));
  for (const n of names) release(t, w.codex, n);
  const done = await Promise.all(names.map((n) => zodchi(t, w, ["wait", "--key", n, "--wait-sec", "60", "--out", path.join(w.dir, "out", `${n}.txt`)], { cwd: r })));
  for (const [i, n] of names.entries()) {
    t.eq([done[i].code, done[i].json.job.status, done[i].json.job.key], [0, "succeeded", n], `${n} succeeded`);
    t.eq(turns(w.codex, `job ${n} `).length, 1, `${n} ran once`);
  }
});

scenario("cli-commands", "help, roles of this repository, the account and the check of a role, without a model call", async (t) => {
  const w = world("cli-commands");
  const r = repo(t, w);
  const help = await zodchi(t, w, ["help"], { cwd: r });
  t.ok(help.code === 0 && /Usage: zodchi/.test(help.out), "help prints the usage");
  const unknown = await zodchi(t, w, ["frobnicate"], { cwd: r });
  t.eq(unknown.code, 1, "an unknown command exits 1");
  const roles = await zodchi(t, w, ["roles"], { cwd: r, env: { ...w.env, ZODCHI_ROLES: path.join(ROOT, "roles") } });
  t.ok(roles.code === 0 && Array.isArray(roles.json), "roles prints a list");
  t.eq(roles.json.filter((x) => x.error).map((x) => x.role), [], "every role of this repository loads");
  t.ok(roles.json.length >= 10, `the repository has its roles (${roles.json.length})`);
  const account = await zodchi(t, w, ["account"], { cwd: r });
  t.eq([account.code, account.json.connected, account.json.plan, account.json.email], [0, true, "plus", "t***" + "@example.org"], "account shows the sign-in, masked");
  const check = await zodchi(t, w, ["check", "--role", "ask"], { cwd: r });
  t.eq([check.code, check.json.ok, check.json.sandbox], [0, true, "read-only"], "check opens the thread of the role and starts no turn");
  t.eq(readJsonl(path.join(w.codex, "fake-turns.jsonl")).length, 0, "no turn ran");
  const unsigned = world("cli-commands-unsigned", { signedIn: false });
  const ur = repo(t, unsigned);
  const job = await zodchi(t, unsigned, ["run", "--role", "ask", "--key", "s1", "--prompt", prompt(unsigned, "p.md", "hi\n"), "--wait-sec", "60"], { cwd: ur });
  t.eq([job.code, job.json.job.status], [2, "auth_required"], "without a sign-in the job ends auth_required");
});

// A Windows job object around the submitting shell, as an agent's shell has: the worker must break away and live on.
// With a sixth argument (a file), the shell and with it the job object stay open after the submit until that file exists.
const JOB_OBJECT_PS1 = String.raw`param([string]$Zodchi, [string]$Repo, [string]$Prompt, [string]$Key, [int]$Breakaway, [string]$Wait = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class ZJob {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a, IntPtr n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, byte[] i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr j, int c, byte[] i, uint l, IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
}
"@
$self = [ZJob]::GetCurrentProcess()
# Only the survival case needs breakaway from an outer job object, so only it reads one and may skip. The fallback
# case reads nothing: it assigns this shell to its own job object below and fails if it cannot.
if ($Breakaway -eq 1) {
  $inJob = $false
  [void][ZJob]::IsProcessInJob($self, [IntPtr]::Zero, [ref]$inJob)
  if ($inJob) {
    $info = New-Object byte[] 144
    if (-not [ZJob]::QueryInformationJobObject([IntPtr]::Zero, 9, $info, 144, [IntPtr]::Zero)) { 'SKIP: the job object around this process cannot be read'; exit 0 }
    if (([BitConverter]::ToUInt32($info, 16) -band 0x1800) -eq 0) { 'SKIP: the job object around this process forbids breakaway, so no worker can leave one here'; exit 0 }
  }
}
$job = [ZJob]::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)
$info = New-Object byte[] 144
# LimitFlags at offset 16: KILL_ON_JOB_CLOSE, with BREAKAWAY_OK as the job object of an agent's shell has it.
$flags = 0x2000
if ($Breakaway -eq 1) { $flags = $flags -bor 0x800 }
[BitConverter]::GetBytes([uint32]$flags).CopyTo($info, 16)
if (-not [ZJob]::SetInformationJobObject($job, 9, $info, 144)) { throw 'SetInformationJobObject failed' }
if (-not [ZJob]::AssignProcessToJobObject($job, $self)) { throw 'AssignProcessToJobObject failed' }
# Started without a pipe of this shell: a worker inherits the handles of its submitter on Windows, and a pipe it holds
# would keep this shell waiting until the job ends. Its output goes where this shell's goes (a file of the suite).
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $Zodchi
$start.Arguments = 'submit --role ask --key ' + $Key + ' --prompt "' + $Prompt + '" --root "' + $Repo + '"'
$start.UseShellExecute = $false
$submit = [System.Diagnostics.Process]::Start($start)
$submit.WaitForExit()
"SUBMITTED $($submit.ExitCode)"
if ($Wait) {
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path -LiteralPath $Wait)) {
    if ((Get-Date) -gt $deadline) { 'TIMEOUT: the scenario never asked to close the job object'; exit 1 }
    Start-Sleep -Milliseconds 25
  }
}
# This process ends here; with it the last handle of the job object closes and everything still inside it is killed.
`;

/** PowerShell keeps caches under LOCALAPPDATA; in the scratch home they stay out of the working tree and the real profile. */
const psEnv = (w) => ({ ...w.env, LOCALAPPDATA: path.join(w.home, "AppData", "Local"), APPDATA: path.join(w.home, "AppData", "Roaming") });

scenario("cli-worker-outlives-job-object", "Windows: the submitting shell runs in a job object that kills its processes when it closes; the worker breaks away and finishes the job", async (t) => {
  const w = world("cli-worker-outlives-job-object");
  const r = repo(t, w);
  const ps1 = path.join(w.dir, "job-object.ps1");
  fs.writeFileSync(ps1, JOB_OBJECT_PS1);
  const p = prompt(w, "jo.md", `in a job object ${hold(t, w.codex, "jo")}\n`);
  const ps = await run(t, "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, ZODCHI, r, p, "jo1", "1"], { cwd: w.dir, env: psEnv(w), label: "powershell" });
  if (/^SKIP: /m.test(ps.out)) return { skip: ps.out.match(/^SKIP: (.*)$/m)[1].trim() };
  t.ok(ps.code === 0 && /SUBMITTED 0/.test(ps.out), "the shell in the job object submitted the job and ended");
  await t.until("the turn entered the fake after the job object closed", () => entered(w.codex, "jo"));
  const now = await zodchi(t, w, ["job", "--key", "jo1"], { cwd: r });
  t.ok(now.json.job.status === "running" && alive(now.json.job.workerPid), "the worker lives on after its shell's job object closed");
  release(t, w.codex, "jo");
  const done = await zodchi(t, w, ["wait", "--key", "jo1", "--wait-sec", "60"], { cwd: r });
  t.eq([done.code, done.json.job.status], [0, "succeeded"], "the job finished");
}, "win32");

scenario("cli-job-object-without-breakaway", "Windows: a job object that forbids breakaway does not make the submit fail; the worker starts inside it, runs the turn and dies when the job object closes", async (t) => {
  const w = world("cli-job-object-without-breakaway");
  const r = repo(t, w);
  const ps1 = path.join(w.dir, "job-object.ps1");
  fs.writeFileSync(ps1, JOB_OBJECT_PS1);
  const p = prompt(w, "jn.md", `no breakaway ${hold(t, w.codex, "jn")}\n`);
  const gate = path.join(w.dir, "close-the-job-object");
  t.cleanups.push(() => fs.writeFileSync(gate, ""));
  let ps = null;
  const shell = run(t, "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, ZODCHI, r, p, "jn1", "0", gate], { cwd: w.dir, env: psEnv(w), label: "powershell" }).then((x) => (ps = x));
  // No skip here: the fallback needs no setting of an outer job object, so a shell that cannot run it fails the scenario.
  await t.until("the turn entered the fake, or the shell ended", () => entered(w.codex, "jn") || ps);
  t.ok(!ps, `the turn entered while the shell and its job object are still open${ps ? ` (the shell ended with ${ps.code}: ${clip(ps.out + ps.err, 400)})` : ""}`);
  const running = await zodchi(t, w, ["job", "--key", "jn1"], { cwd: r });
  const worker = running.json && running.json.job.workerPid;
  t.ok(running.json && running.json.job.status === "running" && worker > 0 && alive(worker), `the worker ${worker} runs the turn`);
  const codexPid = Number(fs.readFileSync(path.join(w.codex, "fake-entered-jn"), "utf8"));
  t.ok(codexPid > 0 && alive(codexPid), `its Codex process ${codexPid} is alive`);
  fs.writeFileSync(gate, "");
  t.log("asked the shell to end, which closes its job object");
  const ended = await shell;
  t.ok(ended.code === 0 && /SUBMITTED 0/.test(ended.out), "the submit had succeeded: the worker was started without breakaway");
  await t.until(`the worker ${worker} died with the job object`, () => !alive(worker), 10000);
  await t.until(`its Codex process ${codexPid} died with it`, () => !alive(codexPid), 10000);
  const settled = await zodchi(t, w, ["job", "--key", "jn1"], { cwd: r });
  t.eq([settled.code, settled.json.job.status], [2, "unknown"], "a fresh look-up settles the job as unknown");
}, "win32");

scenario("server-auth", "the server's tokens: no token and a wrong one are refused, only hashes are stored, a new token or a removed user takes effect without a restart, one server per data folder", async (t) => {
  const w = world("server-auth");
  const data = path.join(w.dir, "data");
  const a = await user(t, w, data, "Ada Lovelace");
  t.ok(a.id.startsWith("ada-lovelace"), `the id is made from the name (${a.id})`);
  const sha256 = (token) => crypto.createHash("sha256").update(token).digest("hex");
  const hashesOf = (id) => JSON.parse(fs.readFileSync(path.join(data, "server.json"), "utf8")).users.find((u) => u.id === id).tokenHashes;
  const registry = fs.readFileSync(path.join(data, "server.json"), "utf8");
  t.ok(!registry.includes(a.token), "server.json holds no token");
  t.eq(hashesOf(a.id), [sha256(a.token)], "server.json holds the SHA-256 of the token in tokenHashes");
  const server = await serve(t, w, data);
  const health = await call(t, server, "GET", "/health");
  t.eq([health.status, health.json.ok], [200, true], "/health needs no token");
  const none = await call(t, server, "GET", "/v1/roles");
  t.eq([none.status, none.json.error.code], [401, "unauthorized"], "no token: 401");
  t.eq((await call(t, server, "GET", "/v1/roles", { token: "zs_wrong" })).status, 401, "a wrong token: 401");
  t.eq((await call(t, server, "GET", "/v1/jobs/any", { token: a.token + "x" })).status, 401, "a token with one more letter: 401");
  t.eq((await call(t, server, "GET", "/v1/roles", { headers: { Authorization: `Basic ${a.token}` } })).status, 401, "a token under another scheme: 401");
  t.eq((await call(t, server, "GET", "/v1/roles", { headers: { Authorization: `bearer  ${a.token} ` } })).status, 200, "the bearer scheme in any case and spacing");
  const roles = await call(t, server, "GET", "/v1/roles", { token: a.token });
  t.eq(roles.json.map((x) => x.role), ["ask", "picture", "structured"], "only expert text and image roles are offered");
  t.ok(roles.json.every((x) => x.source === undefined), "the roles show no server path");

  const second = await run(t, SERVER, ["serve", "--listen", "127.0.0.1:0", "--data", data], { env: w.env, label: "zodchi-server", timeoutMs: 30000 });
  t.ok(second.code !== 0 && /server\.lock/.test(second.err), "a second server on the same data folder refuses to start");

  const renewed = await admin(t, w, data, ["user", "token", a.id]);
  t.eq(hashesOf(a.id), [sha256(renewed.token)], "a new token replaces the stored hash with its own SHA-256");
  t.ok(!fs.readFileSync(path.join(data, "server.json"), "utf8").includes(renewed.token), "and holds no token");
  t.eq((await call(t, server, "GET", "/v1/roles", { token: a.token })).status, 401, "the old token stops at once");
  t.eq((await call(t, server, "GET", "/v1/roles", { token: renewed.token })).status, 200, "the new token works without a restart");
  const listed = await admin(t, w, data, ["user", "list"]);
  t.ok(listed[0].tokens === 1 && !JSON.stringify(listed).includes("zs_"), "user list shows how many tokens, never one");
  await admin(t, w, data, ["user", "remove", a.id]);
  t.eq((await call(t, server, "GET", "/v1/roles", { token: renewed.token })).status, 401, "a removed user is refused at once");
  t.ok(fs.statSync(path.join(data, "users", a.id)).isDirectory(), "the folder of a removed user stays");

  const good = fs.readFileSync(path.join(data, "server.json"));
  fs.writeFileSync(path.join(data, "server.json"), "{ broken");
  for (const token of [renewed.token, undefined]) {
    const broken = await call(t, server, "GET", "/v1/roles", { token });
    t.eq([broken.status, broken.json.error.code], [500, "unavailable"], "a registry that cannot be read lets nobody in");
    noPaths(t, w, data, broken, "the broken registry");
  }

  fs.writeFileSync(path.join(data, "server.json"), JSON.stringify({ users: [{ id: "../x", name: "x", createdAt: "t", tokenHashes: [] }] }));
  t.eq((await call(t, server, "GET", "/v1/roles", { token: renewed.token })).status, 500, "a registry with an id outside [a-z0-9-] lets nobody in");
  fs.writeFileSync(path.join(data, "server.json"), good);

  // A crashed server leaves no lock behind: the system releases it with the process.
  server.kill();
  await server.exited;
  const next = await serve(t, w, data);
  t.eq((await call(t, next, "GET", "/health")).status, 200, "after a crash a new server takes the data folder");
});

scenario("server-admin", "admin commands racing: eight users added at once, none lost", async (t) => {
  const w = world("server-admin");
  const data = path.join(w.dir, "data");
  const results = await Promise.all([...Array(8).keys()].map((i) => run(t, SERVER, ["user", "add", `racer ${i}`, "--data", data], { env: w.env, label: "zodchi-server" })));
  t.ok(results.every((x) => x.code === 0), "every add succeeded");
  const listed = await admin(t, w, data, ["user", "list"]);
  t.eq(listed.length, 8, "eight users listed");
  t.eq(new Set(listed.map((u) => u.id)).size, 8, "eight distinct ids");
  const odd = await admin(t, w, data, ["user", "add", "  !!"]);
  t.ok(odd.id.startsWith("user"), `a name without letters gets a plain id (${odd.id})`);
  const long = await admin(t, w, data, ["user", "add", "x".repeat(80)]);
  t.ok(/^[a-z0-9-]{1,40}$/.test(long.id), `a long name gets a short id (${long.id})`);
});

scenario("server-isolation", "two users: A's job through HTTP, its idempotent repeat and a refused changed request; B asks for A's job by its key and gets nothing of it; each job runs on its own user's Codex home", async (t) => {
  const w = world("server-isolation");
  const data = path.join(w.dir, "data");
  const a = await user(t, w, data, "Anna");
  const b = await user(t, w, data, "Boris");
  const server = await serve(t, w, data);
  const body = { key: "k1", role: "ask", prompt: "hello from A" };
  const first = await call(t, server, "POST", "/v1/jobs", { token: a.token, body });
  t.eq([first.status, first.json.created], [201, true], "A creates the job");
  t.ok(first.json.job.dir === undefined && first.json.job.requestSha256 === undefined, "the job shows no server path and no hash");
  const done = await finished(t, server, a.token, "k1");
  t.eq([done.status, done.account, done.error], ["succeeded", a.id, null], "A's job ran on A's account, with no error");
  const text = await call(t, server, "GET", "/v1/jobs/k1/result", { token: a.token });
  t.ok(text.status === 200 && samePath(text.text.replace(/^CODEX_HOME=/, ""), a.home), "and in A's Codex home");
  const again = await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { prompt: "hello from A", role: "ask", key: "k1", credits: false } });
  t.eq([again.status, again.json.created, again.json.job.createdAt], [200, false, first.json.job.createdAt], "the same request (fields in another order) is the same job");
  const effort = await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { ...body, effort: "high" } });
  t.eq([effort.status, effort.json.error.code, effort.json.error.field], [409, "key_conflict", "key"], "another effort on the key: 409");
  const other = await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { ...body, prompt: "something else" } });
  t.eq(other.status, 409, "another prompt on the key: 409");
  t.eq(turns(a.home, "hello from A").length, 1, "A's request ran once");

  for (const route of ["/v1/jobs/k1", "/v1/jobs/k1?waitSec=1", "/v1/jobs/k1/result", "/v1/jobs/k1/result/0"]) {
    const peek = await call(t, server, "GET", route, { token: b.token });
    t.eq([peek.status, peek.json && peek.json.error.code], [404, "not_found"], `B asks for ${route}: 404, never 403`);
    t.ok(!peek.text.includes("hello") && !peek.text.includes(a.id) && !peek.text.includes(first.json.job.createdAt), "the answer holds nothing of A's job");
  }
  const theirs = await call(t, server, "POST", "/v1/jobs", { token: b.token, body: { key: "k1", role: "ask", prompt: "hello from B" } });
  t.eq(theirs.status, 201, "the key is free for B");
  const bDone = await finished(t, server, b.token, "k1");
  t.eq([bDone.status, bDone.account], ["succeeded", b.id], "B's job ran on B's account");
  const bText = await call(t, server, "GET", "/v1/jobs/k1/result", { token: b.token });
  t.ok(samePath(bText.text.replace(/^CODEX_HOME=/, ""), b.home), "and in B's Codex home");
  t.eq([turns(b.home, "hello from A").length, turns(a.home, "hello from B").length], [0, 0], "neither home ran the other's request");

  const anon = await call(t, server, "POST", "/v1/jobs", { body: { key: "k9", role: "ask", prompt: "anyone" } });
  t.eq(anon.status, 401, "a job without a token is refused");
  t.eq((await call(t, server, "GET", "/v1/jobs/k1")).status, 401, "a look-up without a token is refused");
  t.ok(!fs.existsSync(path.join(data, "users", a.id, "jobs", "k9")) && !fs.existsSync(path.join(data, "users", b.id, "jobs", "k9")), "nothing was stored for it");
});

scenario("server-results", "every kind of result through HTTP, the refusals of the server, the body and prompt limits, a changed role on a retry and a job without a sign-in", async (t) => {
  const w = world("server-results");
  const data = path.join(w.dir, "data");
  const a = await user(t, w, data, "Anna");
  const unsigned = await user(t, w, data, "Nobody", false);
  const server = await serve(t, w, data);
  for (const [key, role, text] of [["text-1", "ask", "plain"], ["json-1", "structured", "schema"], ["png-1", "picture", "a dot"], ["fail-1", "ask", "FAIL now"]]) {
    t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key, role, prompt: text } })).status, 201, `${key} created`);
  }
  t.eq((await finished(t, server, a.token, "text-1")).status, "succeeded", "text-1 succeeded");
  const text = await call(t, server, "GET", "/v1/jobs/text-1/result", { token: a.token });
  t.ok(text.status === 200 && text.type.startsWith("text/plain"), "a text result is text/plain");
  t.eq((await finished(t, server, a.token, "json-1")).status, "succeeded", "json-1 succeeded");
  const data1 = await call(t, server, "GET", "/v1/jobs/json-1/result", { token: a.token });
  t.ok(data1.status === 200 && data1.type === "application/json" && samePath(data1.json.codexHome, a.home), "a schema result is its JSON");
  t.eq((await finished(t, server, a.token, "png-1")).status, "succeeded", "png-1 succeeded");
  const manifest = await call(t, server, "GET", "/v1/jobs/png-1/result", { token: a.token });
  t.eq([manifest.status, manifest.json.images[0].contentType, manifest.json.images[0].url], [200, "image/png", "/v1/jobs/png-1/result/0"], "an image result is a manifest");
  const bytes = await call(t, server, "GET", "/v1/jobs/png-1/result/0", { token: a.token });
  t.ok(bytes.status === 200 && bytes.type === "image/png" && bytes.body.subarray(0, 4).equals(PNG.subarray(0, 4)), "the image bytes with their type");
  t.eq((await call(t, server, "GET", "/v1/jobs/png-1/result/1", { token: a.token })).status, 404, "no second image");
  t.eq((await call(t, server, "GET", "/v1/jobs/png-1/result/..%2Frequest.json", { token: a.token })).status, 404, "nothing else of the job folder is served");
  // The filename guard itself: the stored manifest of the finished job names files of its folder that are not output
  // images (they exist, so only the guard stands between them and the client), asked for by valid indexes.
  const pngDir = path.join(data, "users", a.id, "jobs", "png-1");
  const notImages = ["request.json", "job.json", "codex-stderr.log", "out-0.png/../request.json"];
  for (const name of ["final.json", "job.json"]) {
    const file = path.join(pngDir, name);
    if (!fs.existsSync(file)) continue;
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.result.images.push(...notImages.map((f, i) => ({ index: i + 1, file: f, bytes: 1 })));
    fs.writeFileSync(file, JSON.stringify(stored));
  }
  t.ok(fs.existsSync(path.join(pngDir, "request.json")), "the job folder holds request.json, which a broken guard would serve");
  const requestText = fs.readFileSync(path.join(pngDir, "request.json"), "utf8");
  t.eq((await call(t, server, "GET", "/v1/jobs/png-1/result", { token: a.token })).json.images.length, 1 + notImages.length, "the manifest now lists the planted entries");
  for (let i = 1; i <= notImages.length; i++) {
    const answer = await call(t, server, "GET", `/v1/jobs/png-1/result/${i}`, { token: a.token });
    t.ok(answer.status === 404 && answer.json && answer.json.error.code === "not_found" && !answer.text.includes(requestText.trim().slice(0, 40)) && !answer.text.includes("a dot"),
      `a manifest entry naming ${notImages[i - 1]} is refused (404 not_found) without the file's contents`);
  }
  t.ok((await call(t, server, "GET", "/v1/jobs/png-1/result/0", { token: a.token })).status === 200, "the real output image is still served");
  t.eq((await finished(t, server, a.token, "fail-1")).status, "failed", "fail-1 failed");
  const failed = await call(t, server, "GET", "/v1/jobs/fail-1/result", { token: a.token });
  t.eq([failed.status, failed.json.status, failed.json.error.code], [422, "failed", "job_failed"], "a failed job's result: 422 job_failed");
  t.ok(!failed.text.includes("boom"), "the stored error text does not reach the client");
  t.ok(fs.readFileSync(path.join(data, "users", a.id, "jobs", "fail-1", "job.json"), "utf8").includes("boom"), "the job folder keeps it");

  const refusals = [
    [{ key: "w1", role: "builder", prompt: "p" }, "no repository"],
    [{ key: "d1", role: "judge", prompt: "p" }, "OpenAI API key"],
    [{ key: "d2", role: "ask", prompt: "p", paid: true }, "OpenAI API key"],
    [{ key: "r1", role: "ask", prompt: "p", resume: "k0" }, "work call"],
    [{ key: "t1", role: "ask", prompt: "p", keepThread: true }, ""],
    [{ key: "i1", role: { mode: "expert", model: "m", effort: "low" }, prompt: "p" }, "inline role"],
    [{ key: "i2", role: "ask.json", prompt: "p" }, "role file"],
    [{ key: "i3", role: "missing", prompt: "p" }, "No role missing"],
    [{ key: "m2", role: "ask", prompt: "p", images: ["AAAA"] }, "PNG, JPEG or WebP"],
    [{ key: "m1", role: "ask", prompt: "p", images: Array(9).fill("iVBORw0KGgo=") }, "At most 8"],
    [{ key: "u1", role: "ask", prompt: "p", other: 1 }, "Unknown field"],
  ];
  for (const [body, words] of refusals) {
    const answer = await call(t, server, "POST", "/v1/jobs", { token: a.token, body });
    t.ok(answer.status === 400 && ["bad_request", "role_not_found", "role_not_allowed"].includes(answer.json.error.code) && answer.json.error.message.includes(words), `refused: ${JSON.stringify(body).slice(0, 80)}`);
  }
  const stored = fs.readdirSync(path.join(data, "users", a.id, "jobs")).filter((n) => !n.startsWith(".")).sort();
  t.eq(stored, ["fail-1", "json-1", "png-1", "text-1"], "nothing was stored for a refused request");

  // The body limit, both ways a client can send a body: a length announced over 32 MB is refused before anything is
  // read; a chunked body without a length is read and refused once its real bytes pass 32 MB. The chunked body is a
  // valid job padded with spaces, so a broken limit would create the job big-1. Each request has a deadline.
  const LIMIT_BODY = 32 * 1024 * 1024;
  // The promise settles once: on the whole answer, on a cut-off or failed answer, on a request error before the answer,
  // or at the deadline, which rejects by itself and destroys the request.
  const oversized = (what, headers, body) => new Promise((resolve, reject) => {
    const [host, port] = [server.address.slice(0, server.address.lastIndexOf(":")), Number(server.address.slice(server.address.lastIndexOf(":") + 1))];
    let answered = false;
    let settled = false;
    const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { settle(reject, new Failure(`no whole answer to ${what} in 60 s`)); req.destroy(); }, 60000);
    const req = http.request({ host, port, method: "POST", path: "/v1/jobs", agent: false, headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json", Connection: "close", ...headers } }, (res) => {
      let text = "";
      answered = true;
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        settle(resolve, { status: res.statusCode, text, json });
      });
      res.on("aborted", () => settle(reject, new Failure(`the answer to ${what} was cut off`)));
      res.on("error", (e) => settle(reject, new Failure(`the answer to ${what} failed: ${e.message}`)));
      res.on("close", () => { if (!res.complete) settle(reject, new Failure(`the answer to ${what} was cut off`)); });
    });
    // The server may close the connection right after its answer; a write error after the answer is not a failure,
    // and a cut-off answer is caught on the response above.
    req.on("error", (e) => { if (!answered) settle(reject, new Failure(`${what}: ${e.message}`)); });
    if (body) { for (let i = 0; i < body.length; i += 1024 * 1024) req.write(body.subarray(i, i + 1024 * 1024)); req.end(); } else req.flushHeaders();
  });
  const refusedForSize = (answer) => answer.status === 400 && answer.json && answer.json.error && answer.json.error.code === "bad_request" && /32 MB/.test(answer.json.error.message);
  const announced = await oversized("an announced length", { "Content-Length": LIMIT_BODY + 1 }, null);
  t.log(`> POST /v1/jobs with Content-Length 32 MB + 1 and no body\n  ${announced.status} ${announced.text}`);
  t.ok(refusedForSize(announced), "a length announced over 32 MB is refused before the body is read: 400 bad_request, the limit named");
  const job = Buffer.from(JSON.stringify({ key: "big-1", role: "ask", prompt: "p" }));
  const padded = Buffer.concat([job, Buffer.alloc(LIMIT_BODY + 1 - job.length, " ")]);
  const chunked = await oversized("a chunked body", { "Transfer-Encoding": "chunked" }, padded);
  t.log(`> POST /v1/jobs with a chunked body of 32 MB + 1 bytes (a valid job padded with spaces)\n  ${chunked.status} ${chunked.text}`);
  t.ok(refusedForSize(chunked), "a chunked body whose bytes pass 32 MB is refused: 400 bad_request, the limit named");
  t.eq((await call(t, server, "GET", "/v1/jobs/big-1", { token: a.token })).status, 404, "no job was created from it");

  // The prompt limit is exact: the composed prompt (trailing whitespace trimmed, one newline added) is at most 512 KB.
  const limit = 512 * 1024;
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, quiet: true, body: { key: "at-limit", role: "ask", prompt: "a".repeat(limit - 1) } })).status, 201, "a prompt at the limit is taken");
  const over = await call(t, server, "POST", "/v1/jobs", { token: a.token, quiet: true, body: { key: "over-limit", role: "ask", prompt: "a".repeat(limit) } });
  t.eq([over.status, over.json.error.code], [400, "bad_request"], "one byte over is a 400 of the client");
  t.eq((await call(t, server, "GET", "/v1/jobs/over-limit", { token: a.token })).status, 404, "the refused key stays free");
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, quiet: true, body: { key: "trimmed", role: "ask", prompt: "a".repeat(limit - 1) + "   " } })).status, 201, "trailing whitespace does not count");
  t.eq((await finished(t, server, a.token, "at-limit")).status, "succeeded", "the job at the limit ran");

  // A retry after the installed role changed, or went, is still the same job.
  const same = { key: "same-1", role: "ask", prompt: "hello" };
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: same })).status, 201, "created");
  fs.writeFileSync(path.join(w.roles, "ask.json"), JSON.stringify({ mode: "expert", model: "other-model", effort: "high" }));
  const retry = await call(t, server, "POST", "/v1/jobs", { token: a.token, body: same });
  t.eq([retry.status, retry.json.job.model], [200, "fake-model"], "the retry is the job as created, with its role");
  fs.unlinkSync(path.join(w.roles, "ask.json"));
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: same })).status, 200, "also when the role is gone");

  const unsignedJob = await call(t, server, "POST", "/v1/jobs", { token: unsigned.token, body: { key: "s1", role: "picture", prompt: "hi" } });
  t.eq(unsignedJob.status, 201, "a user without a sign-in can submit");
  t.eq((await finished(t, server, unsigned.token, "s1")).status, "auth_required", "the job ends auth_required");
  const why = await call(t, server, "GET", "/v1/jobs/s1/result", { token: unsigned.token });
  t.eq([why.status, why.json.error.code], [422, "auth_required"], "its result says so");
});

scenario("server-admission", "the limits of unfinished jobs: 429 with fixed text and the key left free, a repeat never refused, the count failing closed", async (t) => {
  const w = world("server-admission");
  const data = path.join(w.dir, "data");
  const a = await user(t, w, data, "Anna");
  const b = await user(t, w, data, "Boris");
  let server = await serve(t, w, data, ["--max-user-jobs", "1", "--max-jobs", "59"]);
  const held = { key: "held-1", role: "ask", prompt: `one ${hold(t, a.home, "a1")}` };
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: held })).status, 201, "the first job is taken");
  const over = await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: "a-key-8", role: "ask", prompt: "two" } });
  t.eq([over.status, over.json.error.code, over.json.error.message], [429, "busy", "You have too many unfinished jobs; wait for one to finish. The key a-key-8 is still free."], "over the user's limit: 429 with fixed text");
  t.ok(server.stderr().includes("1 unfinished, at most 1"), "the counts go to the server's log");
  t.eq((await call(t, server, "GET", "/v1/jobs/a-key-8", { token: a.token })).status, 404, "the refused key stays free");
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: held })).status, 200, "a repeat of the existing key is never refused");
  const early = await call(t, server, "GET", "/v1/jobs/held-1/result", { token: a.token });
  t.ok(early.status === 409 && early.json.error.code === "not_final" && ["queued", "running"].includes(early.json.status), "the result of an unfinished job: 409 with its status");
  await t.until("held-1 entered the fake", () => entered(a.home, "a1"));
  release(t, a.home, "a1");
  t.eq((await finished(t, server, a.token, "held-1")).status, "succeeded", "held-1 succeeded");
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: "a-key-8", role: "ask", prompt: "two" } })).status, 201, "once it finished the key is taken");
  await finished(t, server, a.token, "a-key-8");
  server.kill();
  await server.exited;

  server = await serve(t, w, data, ["--max-user-jobs", "73", "--max-jobs", "2"]);
  for (const n of ["a2", "a3"]) t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: `held-${n}`, role: "ask", prompt: `${n} ${hold(t, a.home, n)}` } })).status, 201, `held-${n} taken`);
  const busy = await call(t, server, "POST", "/v1/jobs", { token: b.token, body: { key: "b-key-7", role: "ask", prompt: "three" } });
  t.eq([busy.status, busy.json.error.message], [429, "The server is busy; try again later. The key b-key-7 is still free."], "over the server's limit: 429 for another user, fixed text");
  t.ok(!/\d/.test(busy.json.error.message.replace("b-key-7", "")), "no count and no limit in the answer");
  t.ok(server.stderr().includes("2 unfinished on the server, at most 2"), "the counts go to the server's log");
  for (const n of ["a2", "a3"]) release(t, a.home, n);
  for (const n of ["a2", "a3"]) await finished(t, server, a.token, `held-${n}`);

  // Failing closed: a record that cannot be read counts as unfinished; a jobs folder that cannot be listed refuses.
  server.kill();
  await server.exited;
  server = await serve(t, w, data, ["--max-user-jobs", "3"]);
  const jobs = path.join(data, "users", a.id, "jobs");
  for (const k of ["broken-1", "broken-2", "broken-3"]) { fs.mkdirSync(path.join(jobs, k)); fs.writeFileSync(path.join(jobs, k, "job.json"), "{"); }
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: "next-1", role: "ask", prompt: "one" } })).status, 429, "unreadable records count as unfinished");
  for (const k of ["broken-1", "broken-2", "broken-3"]) fs.rmSync(path.join(jobs, k), { recursive: true });
  const ghost = path.join(data, "users", "ghost-1");
  fs.mkdirSync(ghost, { recursive: true });
  fs.writeFileSync(path.join(ghost, "jobs"), "not a folder");
  const unknown = await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: "next-1", role: "ask", prompt: "one" } });
  t.ok(unknown.status === 500 && unknown.json.error.code === "storage_error" && /cannot be counted/.test(unknown.json.error.message), "a jobs folder that cannot be listed refuses with 500");
  noPaths(t, w, data, unknown, "the storage error");
  t.ok(!unknown.text.includes("ghost-1") && server.stderr().includes("ghost-1"), "the folder is named only in the server's log");
  t.eq((await call(t, server, "GET", "/v1/jobs/next-1", { token: a.token })).status, 404, "the refused key stays free");
  fs.unlinkSync(path.join(ghost, "jobs"));
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: "next-1", role: "ask", prompt: "one" } })).status, 201, "then it is taken");
  await finished(t, server, a.token, "next-1");
});

scenario("server-diagnostics", "no raw diagnostic reaches a client: stored job errors, roles that cannot load, a Codex that fails with a path, unknown routes and methods", async (t) => {
  const w = world("server-diagnostics");
  const data = path.join(w.dir, "data");
  const a = await user(t, w, data, "Anna");
  const b = await user(t, w, data, "Boris");
  const routes = "cannot read /v1/private/auth.json and /health/private/auth.json";
  const raw = `Cannot write ${path.join(data, "users")} nor ${a.home.replace(/\\/g, "/")}: denied; ${routes}`;
  const said = `the model saw ${a.home} and ${routes}`;
  const now = new Date().toISOString();
  const store = (key, status, error, extra = {}) => {
    const dir = path.join(path.resolve(data), "users", a.id, "jobs", key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ key, role: "ask", kind: "text", mode: "expert", status, error, result: null, createdAt: now, finishedAt: now, ...extra }));
    return dir;
  };
  const one = store("stored-1", "failed", raw, { result: { text: said }, servers: { x: { error: "cannot read /v1/private/servers.json" } }, dir: path.resolve(data), root: "/health/private" });
  store("stored-2", "limited", "cannot read /health/private/auth.json", { resetsAt: "cannot read /v1/private/reset.json" });
  store("stored-3", "auth_required", "cannot read /v1/private/auth.json");
  store("stored-4", "timeout", "cannot read /v1/private/auth.json");
  store("stored-5", "unknown", "cannot read /v1/private/auth.json");
  store("stored-6", "running", "x /etc/passwd", { finishedAt: null });
  store("stored-7", "limited", "cannot read /v1/private/auth.json", { resetsAt: 1760000000 });
  fs.writeFileSync(path.join(w.roles, "broken.json"), "{ not json");
  fs.writeFileSync(path.join(w.roles, "odd.json"), JSON.stringify({ mode: "expert", model: "m", effort: "low", colour: "red" }));
  fs.writeFileSync(path.join(b.home, "fake-account-error"), "");
  const server = await serve(t, w, data);
  const clean = (answer, what) => {
    const found = ["private", "auth.json", "denied", "Cannot write", "cannot read /", "permission"].filter((n) => answer.text.includes(n));
    t.ok(found.length === 0, `${what}: no raw diagnostic${found.length ? ` (found ${found.join(", ")})` : ""}`);
    noPaths(t, w, data, answer, what);
  };

  const job = await call(t, server, "GET", "/v1/jobs/stored-1", { token: a.token });
  t.eq([job.status, job.json.job.status, job.json.job.error.code], [200, "failed", "job_failed"], "a stored failure shows its public code");
  t.eq(job.json.job.result.text, said, "the model's own answer is returned as it was given");
  t.ok(["dir", "root", "servers"].every((k) => job.json.job[k] === undefined), "the job folder, root and servers stay on the server");
  const shown = { ...job.json, job: { ...job.json.job, result: null } };
  clean({ text: JSON.stringify(shown), json: shown }, "stored-1 without the model's answer");
  for (const [key, status, code] of [["stored-1", "failed", "job_failed"], ["stored-2", "limited", "limited"], ["stored-3", "auth_required", "auth_required"], ["stored-4", "timeout", "timeout"], ["stored-5", "unknown", "unknown"]]) {
    const polled = await call(t, server, "GET", `/v1/jobs/${key}`, { token: a.token });
    t.eq([polled.status, polled.json.job.error.code], [200, code], `${key}: ${code}`);
    if (key !== "stored-1") clean(polled, `${key} polled`);
    const result = await call(t, server, "GET", `/v1/jobs/${key}/result`, { token: a.token });
    t.eq([result.status, result.json.status, result.json.error.code], [422, status, code], `${key} result: 422 ${code}`);
    clean(result, `${key} result`);
  }
  t.ok(fs.readFileSync(path.join(one, "job.json"), "utf8").includes("/v1/private/auth.json"), "the job folder keeps the raw text");
  const running = await call(t, server, "GET", "/v1/jobs/stored-6", { token: a.token });
  t.ok(running.json.job.status === "running" && running.json.job.error === null && !running.text.includes("passwd"), "a stored error of a job that is not final is not shown");
  t.ok((await call(t, server, "GET", "/v1/jobs/stored-2", { token: a.token })).json.job.resetsAt === undefined, "a resetsAt that is not a number is not shown");
  t.eq((await call(t, server, "GET", "/v1/jobs/stored-7", { token: a.token })).json.job.resetsAt, 1760000000, "a numeric resetsAt is shown");
  for (const role of ["broken", "odd"]) {
    const refused = await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: `${role}-1`, role, prompt: "p" } });
    t.eq([refused.status, refused.json.error.code, refused.json.error.field], [400, "role_invalid", "role"], `a role that cannot load (${role}): role_invalid`);
    t.ok(refused.json.error.message.includes(role), "the message names the role");
    t.eq(Object.keys(refused.json.error).sort(), ["code", "field", "message"], "the error carries a code, a message and a field, nothing else");
    clean(refused, `role ${role}`);
    t.eq((await call(t, server, "GET", `/v1/jobs/${role}-1`, { token: a.token })).status, 404, "the refused key stays free");
  }
  t.ok(server.stderr().includes("is not JSON") && server.stderr().includes("Unknown field"), "the role errors are in the server's log");
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: "m-1", role: "ask", prompt: "p", effort: "not-an-effort" } })).json.error.code, "bad_request", "a wrong effort: bad_request");
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: "m-2", role: "gone", prompt: "p" } })).json.error.code, "role_not_found", "a missing role: role_not_found");

  const account = await call(t, server, "GET", "/v1/account", { token: b.token });
  t.eq([account.status, account.json.connected, account.json.error.code, account.json.accounts[0].error.code], [200, false, "codex_unavailable", "codex_unavailable"], "an account Codex cannot read: codex_unavailable");
  clean(account, "the account");
  const login = await call(t, server, "GET", "/v1/login", { token: b.token });
  t.eq([login.status, login.json.status, login.json.error.code], [200, "none", "codex_unavailable"], "the sign-in too");
  clean(login, "the sign-in");
  t.ok(server.stderr().includes("permission denied") && server.stderr().includes("auth.json"), "the Codex error is in the server's log");
  const none = await call(t, server, "GET", "/v1/private/auth.json", { token: a.token });
  t.eq([none.status, none.json.error.code], [404, "not_found"], "an unknown route: not_found");
  const method = await call(t, server, "PUT", "/v1/jobs/stored-1", { token: a.token });
  t.eq([method.status, method.json.error.code], [405, "method_not_allowed"], "a method the route does not take: method_not_allowed");
});

scenario("server-sign-in", "device-code sign-in per user: completion after and before the answer, one open sign-in per user, cancel and sign-out of that user only, the caller's own account", async (t) => {
  const w = world("server-sign-in");
  const data = path.join(w.dir, "data");
  const late = await user(t, w, data, "Late", false);
  const early = await user(t, w, data, "Early", false);
  const never = await user(t, w, data, "Never", false);
  fs.writeFileSync(path.join(early.home, "fake-login-mode"), "early");
  fs.writeFileSync(path.join(never.home, "fake-login-mode"), "never");
  const server = await serve(t, w, data);
  t.eq((await call(t, server, "GET", "/v1/login", { token: late.token })).json.status, "none", "not signed in: none");
  for (const u of [late, early]) {
    const started = await call(t, server, "POST", "/v1/login", { token: u.token });
    t.eq([started.status, started.json.status, started.json.userCode], [200, "pending", "ABCD-1234"], "a device code is handed out");
    await t.until("the sign-in is connected", async () => {
      const s = await call(t, server, "GET", "/v1/login", { token: u.token, quiet: true });
      return s.json.status === "connected" && s.json.plan === "plus";
    });
  }
  const first = await call(t, server, "POST", "/v1/login", { token: never.token });
  const second = await call(t, server, "POST", "/v1/login", { token: never.token });
  t.eq([first.json.status, second.json.loginId], ["pending", first.json.loginId], "one open sign-in per user");
  t.eq((await call(t, server, "GET", "/v1/login", { token: never.token })).json.status, "pending", "it stays pending");
  t.eq((await call(t, server, "DELETE", "/v1/login", { token: never.token })).json.status, "none", "DELETE cancels it");
  t.eq(fs.readFileSync(path.join(never.home, "fake-login-cancelled"), "utf8"), first.json.loginId, "the cancel reached Codex with its loginId");
  t.eq((await call(t, server, "DELETE", "/v1/login", { token: late.token })).status, 200, "Late signs out");
  t.eq((await call(t, server, "GET", "/v1/login", { token: late.token })).json.status, "none", "Late is signed out");
  t.eq((await call(t, server, "GET", "/v1/login", { token: early.token })).json.status, "connected", "Early is still signed in");
  const account = await call(t, server, "GET", "/v1/account", { token: early.token });
  t.eq([account.status, account.json.connected, account.json.accounts.length, account.json.name], [200, true, 1, early.id], "the account route shows the caller's own account");
  t.ok(account.json.codexHome === undefined, "and no server path");
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: early.token, body: { key: "e1", role: "ask", prompt: "after sign-in" } })).status, 201, "a signed-in user's job");
  t.eq((await finished(t, server, early.token, "e1")).status, "succeeded", "runs on the subscription it signed in");
});

scenario("server-threads", "a long poll holds an HTTP thread: one thread is refused at start, and with two /health answers while a poll waits", async (t) => {
  const w = world("server-threads");
  const data = path.join(w.dir, "data");
  const a = await user(t, w, data, "Anna");
  for (const n of ["1", "0"]) {
    const refused = await run(t, SERVER, ["serve", "--threads", n, "--listen", "127.0.0.1:0", "--data", data], { env: w.env, label: "zodchi-server", timeoutMs: 30000 });
    t.ok(refused.code !== 0 && refused.err.includes("--threads is at least 2") && !refused.out.trim(), `--threads ${n} is refused and nothing listens`);
  }
  const server = await serve(t, w, data, ["--threads", "2"]);
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: "poll-1", role: "ask", prompt: `poll ${hold(t, a.home, "p1")}` } })).status, 201, "a held job");
  await t.until("the job entered the fake", () => entered(a.home, "p1"));
  let poll = null;
  let pollSettled = true;
  const startPoll = () => {
    pollSettled = false;
    poll = call(t, server, "GET", "/v1/jobs/poll-1?waitSec=30", { token: a.token }).finally(() => (pollSettled = true));
  };
  startPoll();
  // The acknowledgement that the server admitted the poll: with two threads one poll place exists. A probe poll that
  // gets the place waits its whole second; a probe answered in under a second found the place taken, and the only
  // other poll is the pending one above, so it is admitted and still waiting (the job is held, so it cannot end).
  // When the probe got the place first, the long poll is answered at once; it is then asked again.
  await t.until("the server admitted the long poll (a probe poll is answered at once: the one poll place is taken)", async () => {
    if (pollSettled) {
      t.log("  the long poll was answered without waiting (the probe held the poll place); asking again");
      startPoll();
      return false;
    }
    const sent = Date.now();
    const probe = await call(t, server, "GET", "/v1/jobs/poll-1?waitSec=1", { token: a.token, quiet: true });
    const ms = Date.now() - sent;
    t.log(`  probe poll: ${probe.status} ${probe.json && probe.json.job && probe.json.job.status} after ${ms} ms`);
    return probe.status === 200 && probe.json.job.status === "running" && ms < 1000 && !pollSettled;
  });
  t.ok(!pollSettled, "the long poll is still waiting");
  const started = Date.now();
  for (let i = 0; i < 5; i++) t.eq((await call(t, server, "GET", "/health")).status, 200, "/health answers during the poll");
  t.ok(Date.now() - started < 3000, `/health did not wait behind the poll (${Date.now() - started} ms)`);
  t.ok(!pollSettled, "the long poll was still waiting through every /health");
  release(t, a.home, "p1");
  const polled = await poll;
  t.eq([polled.status, polled.json.job.status], [200, "succeeded"], "the poll ends with the final status");
});

scenario("server-stop", "POSIX: SIGTERM stops the server: a sign-in whose start is still held in Codex is answered and cancelled and its app-server ends, the lock is free for the next server, finished workers were reaped", async (t) => {
  const w = world("server-stop");
  const data = path.join(w.dir, "data");
  const a = await user(t, w, data, "Anna");
  const slow = await user(t, w, data, "Slow", false);
  fs.writeFileSync(path.join(slow.home, "fake-login-mode"), "held");
  t.cleanups.push(() => fs.writeFileSync(path.join(slow.home, "fake-login-release"), ""));
  const server = await serve(t, w, data);
  t.eq((await call(t, server, "POST", "/v1/jobs", { token: a.token, body: { key: "reap-1", role: "ask", prompt: "hello" } })).status, 201, "a job");
  const done = await finished(t, server, a.token, "reap-1");
  await t.until(`the worker ${done.workerPid} was reaped (no zombie)`, () => spawnSync("ps", ["-o", "stat=", "-p", String(done.workerPid)], { encoding: "utf8" }).stdout.trim() === "", 20000);
  t.ok(server.child.exitCode === null, "the server runs on");
  // The fake holds this start until the scenario releases it: the server is told to stop while the start is held,
  // and the start is answered only once the server has said it is stopping.
  const inFlight = call(t, server, "POST", "/v1/login", { token: slow.token });
  await t.until("the sign-in start reached Codex", () => fs.existsSync(path.join(slow.home, "fake-login-started")));
  const loginId = fs.readFileSync(path.join(slow.home, "fake-login-started"), "utf8");
  t.ok(/^login-\d+$/.test(loginId), `the start names its loginId (${loginId})`);
  server.child.kill("SIGTERM");
  await t.until("the server is stopping while the start is held", () => server.stderr().includes("zodchi-server: stopping"));
  t.ok(!fs.existsSync(path.join(slow.home, "fake-login-cancelled")), "nothing was cancelled before the start was answered");
  fs.writeFileSync(path.join(slow.home, "fake-login-release"), "");
  t.log("released the sign-in start");
  const answered = await inFlight;
  t.ok(answered.status === 200 && answered.text.includes(loginId), "the request in flight is answered");
  const ended = await server.exited;
  t.eq(ended.code, 0, "the server exits 0 on SIGTERM");
  t.eq(fs.readFileSync(path.join(slow.home, "fake-login-cancelled"), "utf8"), loginId, "the sign-in was cancelled with its own loginId");
  t.ok(!alive(Number(loginId.replace("login-", ""))), "its app-server is gone");
  const next = await serve(t, w, data);
  t.eq((await call(t, next, "GET", "/health")).status, 200, "the lock is free: a new server starts");
}, "posix");

// ---------------------------------------------------------------------------------------------------------------
// zodchi flow code-package: the engine against scripts/e2e/fake-codex-flow.mjs, which answers each model turn by its
// step from fake-flow/<step>.json, on a throwaway fixture repository (a clamp stub, its test, a smoke command and a
// REVIEW.md). The roles are those of this repository; the role table names two distinct fake Codex models.

const gitOut = (r, args, input) => {
  const res = spawnSync("git", ["-C", r, ...args], { encoding: "utf8", input, windowsHide: true });
  checkStartup(res.status, "git");
  return (res.stdout || "").trim();
};
const STUB = "export const clamp = (x, lo, hi) => x;\n";
const FIXED = "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n";
const CLOSED = "// clamp keeps x between lo and hi.\nexport const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n";
const blobOf = (r, text) => gitOut(r, ["hash-object", "--no-filters", "--stdin"], text);

function flowWorld(t, name) {
  const w = world(name);
  w.env = { ...w.env, ZODCHI_CODEX_BIN: FAKE_FLOW, ZODCHI_ROLES: path.join(ROOT, "roles") };
  delete w.env.ZODCHI_FLOW_CUT;
  // The first writer is Claude (skipped: not an executor of this version); the first reviewer is the writer's model
  // (skipped: not independent).
  fs.writeFileSync(path.join(w.zhome, "models.json"), JSON.stringify({ version: 1, roles: {
    expertWriter: { candidates: [{ provider: "claude", model: "opus", effort: "high" }, { provider: "codex", model: "fake-writer", effort: "medium" }] },
    writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "high" }, { provider: "codex", model: "fake-writer", effort: "xhigh" }] },
    reviewer: { candidates: [{ provider: "codex", model: "fake-writer", effort: "medium" }, { provider: "codex", model: "fake-reviewer", effort: "high" }] },
  } }));
  const r = repo(t, w);
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), text); };
  put("src/math.mjs", STUB);
  put("src/other.mjs", "export const other = 1;\n");
  put("test/math.test.mjs", 'import { clamp } from "../src/math.mjs";\nif (clamp(5, 0, 3) !== 3 || clamp(-1, 0, 3) !== 0) { console.error("clamp is wrong"); process.exit(1); }\nconsole.log("clamp ok");\n');
  put("smoke.mjs", 'import { clamp } from "./src/math.mjs";\nconsole.log("smoke", clamp(9, 1, 4));\nprocess.exit(process.argv.includes("--fail") ? 1 : 0);\n');
  put("REVIEW.md", "# Review focus\n\nFlag:\n- A clamp that lets a value out of its range (REVIEW-BASE-MARKER).\n");
  for (const args of [["config", "user.name", "Fixture"], ["config", "user.email", "fixture" + "@" + "example.org"], ["add", "-A"], ["commit", "-q", "-m", "baseline"]]) gitOut(r, args);
  const base = gitOut(r, ["rev-parse", "HEAD"]);
  t.ok(/^[0-9a-f]{40}$/.test(base), `the fixture has its baseline commit ${base}`);
  const brief = path.join(w.dir, "brief.md");
  fs.writeFileSync(brief, "# Brief: clamp\n\nMake clamp(x, lo, hi) keep x between lo and hi. Done: node test/math.test.mjs passes.\n");
  const answer = (step, value) => {
    fs.mkdirSync(path.join(w.codex, "fake-flow"), { recursive: true });
    fs.writeFileSync(path.join(w.codex, "fake-flow", `${step.replace(/ /g, "-")}.json`), JSON.stringify(value));
  };
  const patch = (changes, summary = "clamp keeps x in range") => ({
    status: "done", summary, changes: changes.map((change) => ({ edits: null, ...change })), unverified: [], questions: [],
  });
  const modify = (rel, from, content) => ({ op: "modify", path: rel, from: null, baseBlob: blobOf(r, from), content });
  const review = (verdict, findings = []) => ({ verdict, summary: `review: ${verdict}`, findings, notVerified: [] });
  const finding = (id) => ({ id, severity: "important", location: "src/math.mjs:1", problem: "no comment says what clamp keeps", consequence: "a reader guesses", fix: "add one line" });
  const args = (extra = {}) => {
    const file = path.join(w.dir, `args-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify({ label: "clamp", brief, repo: r, files: ["src/math.mjs"], checks: ["node test/math.test.mjs"], verify: ["node smoke.mjs"], ...extra }));
    return file;
  };
  const flow = (argv, env = {}) => zodchi(t, w, ["flow", "code-package", ...argv], { cwd: r, env: { ...w.env, ...env } });
  const steps = () => readJsonl(path.join(w.codex, "fake-turns.jsonl")).map((x) => x.step);
  const claim = () => {
    const dir = path.join(w.home, ".zodchi", "packages");
    const [folder] = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const file = folder && path.join(dir, folder, "clamp.json");
    return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  };
  const commits = () => gitOut(r, ["rev-list", `${base}..HEAD`]).split("\n").filter(Boolean);
  return { w, r, base, brief, answer, patch, modify, review, finding, args, flow, steps, claim, commits };
}

scenario("flow-round-exhaustion", "important findings in every review: the run stops by the rounds rule, the findings stay open, the claim is closed as stopped", async (t) => {
  const f = flowWorld(t, "flow-round-exhaustion");
  f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
  f.answer("review 1", f.review("changes_requested", [f.finding("F1")]));
  f.answer("close 1", f.patch([f.modify("src/math.mjs", FIXED, CLOSED)], "comment added"));
  f.answer("review 2", f.review("changes_requested", [f.finding("F1")]));
  const res = await f.flow(["--args", f.args({ rounds: 2 })]);
  t.eq([res.code, res.json.verdict, res.json.approved], [2, "changes_requested", undefined], "not approved, exit 2");
  t.eq(res.json.stoppedAt, "stop rule: 2 review rounds without approval", "stopped by the rounds rule");
  t.ok(res.json.openFindings.length === 1 && /^F1 important/.test(res.json.openFindings[0]), "the finding stays open");
  t.ok(/after 2 rounds/.test(res.json.question), "the question goes back to a human");
  t.eq(f.commits().length, 2, "both rounds were committed");
  t.eq(f.claim().status, "stopped", "the claim is closed as stopped");
  t.eq(f.steps().filter((s) => s.startsWith("close")), ["close 1"], "no close after the last round");
});

scenario("flow-outside-claim", "a patch waits before touching unclaimed paths, then applies the recorded patch after approval", async (t) => {
  const f = flowWorld(t, "flow-outside-claim");
  const branch = await f.flow(["--args", f.args({ branch: "elsewhere" })]);
  t.ok(branch.code === 2 && /args\.branch is not supported/.test(branch.json.refused), "an unsupported option is refused");
  const pass = await f.flow(["--args", f.args({ checks: [{ cmd: "node test/math.test.mjs", pass: "prints ok" }] })]);
  t.ok(pass.code === 2 && /exit code only/.test(pass.json.refused), "a pass rule in words is refused");
  t.ok(f.claim() === null && f.steps().length === 0, "neither claimed anything nor called a model");
  f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED), f.modify("src/other.mjs", "export const other = 1;\n", "export const other = 2;\n")]));
  const res = await f.flow(["--args", f.args()]);
  t.eq([res.code, res.json.stoppedAt, res.json.status], [2, "patch outside the claim at apply write", "waiting"], "the patch waits for a scope decision");
  t.eq(res.json.outsideClaim, ["src/other.mjs"], "the result names the file outside the claim");
  t.eq([fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8"), fs.readFileSync(path.join(f.r, "src", "other.mjs"), "utf8")], [STUB, "export const other = 1;\n"], "nothing of it was applied");
  t.eq([f.commits().length, f.steps()], [0, ["write"]], "no commit, no review");
  t.eq(f.claim().status, "open", "the same run retains its initial claim");
  const approved = path.join(f.w.dir, "approve.json");
  const reply = () => zodchi(t, f.w, ["flow", "reply", res.json.runId, "--allow-files", approved], { cwd: f.w.dir, env: f.w.env });
  fs.writeFileSync(approved, JSON.stringify(["src/other.mjs", "wrong.mjs"]));
  t.eq((await reply()).code, 1, "a scope decision cannot add arbitrary files");
  fs.writeFileSync(approved, JSON.stringify(["src/other.mjs"]));
  t.eq((await reply()).code, 0, "the exact scope expansion is recorded");
  f.answer("review 1", f.review("approved"));
  const final = await f.flow(["--resume", res.json.runId]);
  t.eq([final.code, final.json.runId, final.json.claimAdded, f.steps()], [0, res.json.runId, ["src/other.mjs"], ["write", "review 1"]],
    "the engine publishes the expanded patch without sending the write request again");
});

scenario("flow-protected", "a patch that edits an existing test stops the package before review; nothing applied", async (t) => {
  const f = flowWorld(t, "flow-protected");
  const test = fs.readFileSync(path.join(f.r, "test", "math.test.mjs"), "utf8");
  f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED), f.modify("test/math.test.mjs", test, 'console.log("clamp ok");\n')]));
  const res = await f.flow(["--args", f.args({ files: ["src/math.mjs", "test/math.test.mjs"] })]);
  t.eq([res.code, res.json.stoppedAt, res.json.protectedChanged], [2, "protected checks changed at apply write", ["test/math.test.mjs"]], "stopped before review with the protected file");
  t.eq(fs.readFileSync(path.join(f.r, "test", "math.test.mjs"), "utf8"), test, "the test is unchanged");
  t.eq([f.commits().length, f.steps()], [0, ["write"]], "no commit, no review");
});

scenario("flow-protected-worktree", "a claimed test edited in the work tree while the run is cut is caught on the candidate tree: the package stops before the checks run, nothing committed", async (t) => {
  const f = flowWorld(t, "flow-protected-worktree");
  f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
  f.answer("review 1", f.review("approved"));
  const first = await f.flow(["--args", f.args({ files: ["src/math.mjs", "test/math.test.mjs"] })], { ZODCHI_FLOW_CUT: "submit write" });
  t.eq(first.code, 75, "cut after the submission of the write turn");
  const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
  fs.writeFileSync(path.join(f.r, "test", "math.test.mjs"), 'console.log("clamp ok");\n');
  const res = await f.flow(["--resume", id]);
  t.eq([res.code, res.json.stoppedAt, res.json.protectedChanged], [2, "protected checks changed at checks 1", ["test/math.test.mjs"]], "stopped with the edited test, though the patch did not touch it");
  t.ok(!res.json.verification, "no check ran on the edited test");
  t.eq([f.commits().length, f.steps()], [0, ["write"]], "no commit, no review");
});

scenario("flow-cleaned-job", "a cut after the submission, then the job folder cleaned up: resume cannot prove the job never ran, so it stops with an unknown outcome instead of asking the model again", async (t) => {
  const f = flowWorld(t, "flow-cleaned-job");
  f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
  const first = await f.flow(["--args", f.args()], { ZODCHI_FLOW_CUT: "submit write" });
  t.eq(first.code, 75, "cut after the submission of the write turn");
  const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
  const waited = await zodchi(t, f.w, ["wait", "--key", `flow-${id}-write`, "--wait-sec", "60"], { cwd: f.r });
  t.eq(waited.code, 0, "the submitted job ran to its end");
  fs.rmSync(path.join(f.r, ".agent-tmp", "gateway"), { recursive: true, force: true });
  const res = await f.flow(["--resume", id]);
  t.eq([res.code, res.json.stoppedAt], [2, "unknown outcome at write"], "an unknown outcome, not a second submission");
  t.ok(/--rerun "write"/.test(res.json.next), "next says how to run the step again after looking");
  t.eq(f.steps(), ["write"], "the model was asked once");
  t.eq(f.claim().status, "open", "the claim stays open");
});

scenario("flow-no-review-md", "a repository with neither REVIEW.md nor a verify skill passes the gate and runs to approval; the review judges by the brief", async (t) => {
  const f = flowWorld(t, "flow-no-review-md");
  gitOut(f.r, ["rm", "-q", "REVIEW.md"]);
  gitOut(f.r, ["commit", "-q", "-m", "no review focus"]);
  f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
  f.answer("review 1", f.review("approved"));
  const res = await f.flow(["--args", f.args({ verify: [] })]);
  t.eq([res.code, res.json.verdict, res.json.refused], [0, "approved", undefined], "the gate passes and the run ends approved");
  const reviewTurn = readJsonl(path.join(f.w.codex, "fake-turns.jsonl")).find((x) => x.step === "review 1");
  t.ok(/has no REVIEW\.md/.test(reviewTurn.prompt) && !reviewTurn.prompt.includes("REVIEW.base.md"), "the review says the base has no REVIEW.md");
});

scenario("flow-staged-after-commit", "a cut right after the commit, then the parent's version staged by hand: resume records the commit and leaves that staging alone", async (t) => {
  const f = flowWorld(t, "flow-staged-after-commit");
  f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
  f.answer("review 1", f.review("approved"));
  const first = await f.flow(["--args", f.args()], { ZODCHI_FLOW_CUT: "commit 1" });
  t.eq(first.code, 75, "cut after the commit of round 1");
  t.eq(gitOut(f.r, ["diff", "--cached", "--name-only", "HEAD"]), "", "the index already follows the commit at the cut");
  gitOut(f.r, ["reset", "-q", f.base, "--", "src/math.mjs"]);
  t.eq(gitOut(f.r, ["diff", "--cached", "--name-only", "HEAD"]), "src/math.mjs", "the parent's version is staged by hand");
  const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
  const res = await f.flow(["--resume", id]);
  t.eq([res.code, res.json.verdict], [0, "approved"], "the resumed run ends approved");
  t.eq(res.json.rounds[0].commit.indexLeft, ["src/math.mjs"], "the receipt names the staging it left alone");
  t.eq(gitOut(f.r, ["diff", "--cached", "--name-only", "HEAD"]), "src/math.mjs", "the hand-made staging is still there");
  t.eq(gitOut(f.r, ["show", ":src/math.mjs"]) + "\n", STUB, "the staged entry is the parent's version");
  t.eq([f.commits().length, f.steps()], [1, ["write", "review 1"]], "one commit, each model turn once");
});

scenario("flow-private-checks", "check evidence removes private commands, folders and credential lines before reaching a model", async (t) => {
  const f = flowWorld(t, "flow-private-checks");
  fs.writeFileSync(path.join(f.w.zhome, "private-words.txt"), "PRIVMARK\n");
  const BAD = 'console.log("at", process.cwd());\nconsole.log("api_key=PRIVKEY-1");\nexport const clamp = (x, lo, hi) => x;\n';
  f.answer("write", f.patch([f.modify("src/math.mjs", STUB, BAD)], "first try"));
  f.answer("fix 1.1", f.patch([f.modify("src/math.mjs", BAD, FIXED)], "clamp fixed"));
  f.answer("review 1", f.review("approved"));
  const res = await f.flow(["--args", f.args({ checks: ["node test/math.test.mjs PRIVMARK-CMD"], verify: ["node smoke.mjs PRIVMARK-VERIFY"], fixes: 1 })]);
  t.eq([res.code, res.json.verdict], [0, "approved"], "the fix makes the checks pass and the run ends approved");
  const turns = readJsonl(path.join(f.w.codex, "fake-turns.jsonl"));
  t.eq(turns.map((x) => x.step), ["write", "fix 1.1", "review 1"], "write, one fix, one review");
  t.ok(turns.every((x) => !x.prompt.includes("PRIVMARK")), "raw private commands do not reach a model");
  t.ok(turns[0].prompt.includes("checks #1, args.verify #1"), "the writer learns the checks by source and number");
  // The failure as the fixing writer sees it (the claimed file itself is attached as it is, with its own text).
  const fix = (turns[1].prompt.match(/checks #1 exit 1\n```\n([\s\S]*?)\n```/) || [])[1] || "";
  t.ok(fix.includes("clamp is wrong"), "the fixing writer gets the failed check and its output");
  t.ok(!fix.includes("PRIVKEY") && fix.includes("[source line withheld]"), "a line that may hold a credential is left out");
  t.ok(!fix.toLowerCase().includes(tempDirectory.toLowerCase()) && fix.includes("<tmp>"), "the export folder is named <tmp>, not by its path");
  t.ok(!turns[1].prompt.toLowerCase().includes(tempDirectory.toLowerCase()), "no private folder anywhere in the fix request");
  const proof = JSON.parse(turns[2].prompt.match(/<attachment path="verification\.json">\n([\s\S]*?)\n<\/attachment>/)[1]);
  t.eq(proof.commands.map(e => [e.check, e.exitCode, e.command]), [
    ["checks #1", 0, "[private text removed]"], ["args.verify #1", 0, "[private text removed]"],
  ], "the review evidence names the checks and redacts both private commands");
});

// ---------------------------------------------------------------------------------------------------------------
// Main

function build() {
  const started = Date.now();
  const log = path.join(traces, "build.log");
  const args = ["build", "--profile", buildProfile, "--locked", "--manifest-path", path.join(ROOT, "rust", "Cargo.toml")];
  if (profile === "check") args.push("--message-format=json-render-diagnostics");
  const r = spawnSync("cargo", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  fs.writeFileSync(log, `${r.stdout || ""}${r.stderr || ""}${r.error ? String(r.error) : ""}`);
  const ms = Date.now() - started;
  try { checkStartup(r.status, "cargo"); } catch (error) {
    console.error(`BLOCKED build (${ms} ms): ${error.message}; log ${log}`);
    process.exit(2);
  }
  if (r.status !== 0) {
    console.log(`FAIL build (${ms} ms): cargo build --profile ${buildProfile} exited ${r.status}; log ${log}`);
    process.exit(1);
  }
  if (profile === "check") {
    // An explicit build target adds a Cargo output subdirectory even when it matches the host.
    const executables = new Map();
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line.startsWith("{")) continue;
      const artifact = JSON.parse(line);
      if (artifact.reason !== "compiler-artifact" || !artifact.executable || !artifact.target.kind.includes("bin")) continue;
      const name = artifact.target.name + EXE;
      if (!binaries.includes(name)) continue;
      if (executables.has(name) && executables.get(name) !== artifact.executable) {
        throw new Error(`Cargo reported multiple executables for ${name}; log ${log}`);
      }
      executables.set(name, artifact.executable);
    }
    const missing = binaries.filter((name) => !executables.has(name));
    if (missing.length) throw new Error(`Cargo did not report executables for ${missing.join(", ")}; log ${log}`);
    fs.mkdirSync(binDir, { recursive: true });
    for (const name of binaries) {
      fs.copyFileSync(executables.get(name), path.join(binDir, name));
    }
  }
  console.log(`build ${(ms / 1000).toFixed(1)} s (log ${log})`);
}

// More scenarios live in scripts/e2e/scenarios/*.mjs, one file per area, so parallel packages each add their own file
// instead of editing this one. Each file's default export receives the helpers and registers with scenario().
{
  const dir = path.join(ROOT, "scripts", "e2e", "scenarios");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort() : [];
  const helpers = { scenario, world, repo, prompt, zodchi, run, ZODCHI, serve, admin, user, finished, flowWorld, gitOut, blobOf, samePath, ROOT, FAKE, FAKE_FLOW, STUB, FIXED, scratch };
  for (const f of files) (await import(pathToFileURL(path.join(dir, f)).href)).default(helpers);
}

const names = scenarios.map((s) => s.name);
const unknownNames = wanted.filter((n) => !names.includes(n));
if (unknownNames.length) {
  console.error(`No scenario ${unknownNames.join(", ")}. Scenarios: ${names.join(", ")}`);
  process.exit(1);
}
if (!noBuild) build();
for (const name of binaries) {
  const bin = path.join(binDir, name);
  if (!fs.existsSync(bin)) {
    console.error(`${bin} is missing: run the suite without --no-build or point --bin-dir at a build`);
    process.exit(1);
  }
}
if (runBinDir !== binDir) {
  fs.mkdirSync(runBinDir);
  for (const name of binaries) {
    fs.copyFileSync(path.join(binDir, name), path.join(runBinDir, name));
  }
}

const suiteStarted = Date.now();
let failed = 0;
let passed = 0;
let skipped = 0;
let blocked = 0;
const selectedScenarios = scenarios.filter((x) => !wanted.length || wanted.includes(x.name));

for (const s of selectedScenarios) {
  const t = new Trace(s.name);
  t.log(`# ${s.name}: ${s.about}`);
  const started = Date.now();
  const platformSkip = s.only === "win32" && !WIN ? "Windows only" : s.only === "posix" && WIN ? "POSIX signals and processes only" : null;
  let outcome;
  if (platformSkip) outcome = { skip: platformSkip };
  else {
    try {
      outcome = (await s.fn(t)) || {};
    } catch (e) {
      if (e instanceof StartupFailure) outcome = { blocked: e.message, stop: true };
      else if (WIN && e.code === "EPERM" && e.syscall === "symlink") outcome = { blocked: "Windows denied creation of a fixture link." };
      else {
        outcome = { error: e instanceof Failure ? e.message : e.stack || String(e) };
        if (!(e instanceof Failure)) t.log(`THREW: ${e.stack || e}`);
      }
    }
  }
  for (const clean of t.cleanups.reverse()) { try { clean(); } catch { /* best effort */ } }
  const ms = Date.now() - started;
  if (outcome.skip) t.log(`SKIP: ${outcome.skip}`);
  if (outcome.blocked) t.log(`BLOCKED: ${outcome.blocked}`);
  t.write();
  if (outcome.error) {
    failed++;
    console.log(`FAIL ${s.name} (${ms} ms): ${redact(outcome.error)}\n     trace ${t.file}`);
  } else if (outcome.blocked) {
    blocked++;
    console.log(`BLOCKED ${s.name} (${ms} ms): ${outcome.blocked}\n        trace ${t.file}`);
    if (outcome.stop) break;
  } else if (outcome.skip) {
    skipped++;
    console.log(`SKIP ${s.name}: ${outcome.skip}`);
  } else {
    passed++;
    console.log(`PASS ${s.name} (${ms} ms) trace ${t.file}`);
  }
}
const total = Date.now() - suiteStarted;
const notRun = selectedScenarios.length - passed - failed - skipped - blocked;
console.log(`\nscenarios ${(total / 1000).toFixed(1)} s: ${passed} passed, ${failed} failed, ${skipped} skipped, ${blocked} blocked, ${notRun} not run; traces in ${traces}`);
if (!failed && !blocked && !keep) {
  // Workers may hold a file for a moment after their job ended; what stays behind is in the temp folder.
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); } catch { /* left in the temp folder */ }
} else if (failed || blocked) {
  console.log(`kept for inspection: ${scratch}`);
}
process.exit(failed ? 1 : blocked ? 2 : 0);
