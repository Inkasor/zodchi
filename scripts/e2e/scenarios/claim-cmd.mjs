// The claim commands of the gate helper (core/scripts/gate.mjs claim and claim-more): lists of paths are compared and claims are
// written by the helper under the claims lock, never by a model. Run for real against a scratch claims folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { commandsIn, encodeSpec } from "../spec-arg.mjs";

export default function register({ scenario, ROOT }) {
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");

  /** A scratch claims folder (not created: the claim command makes it), removed when the scenario ends. */
  const claimsDir = (t, name) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-claim-${name}-`));
    t.cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    return `${home.replace(/\\/g, "/")}/packages/repo`;
  };
  /** The helper's one line, parsed, with its exit code. */
  const helper = (t, cmd, spec, env = {}) => {
    const r = spawnSync(process.execPath, [GATE, cmd, JSON.stringify({ api: 1, ...spec })], { encoding: "utf8", env: { ...process.env, ...env } });
    t.log(`gate.mjs ${cmd} ${spec.label}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* checked by the caller */ }
    t.ok(r.status === 0 && json && r.stdout.trim().split("\n").length === 1, `${cmd} ${spec.label}: exit 0 and one line of JSON`);
    t.ok(json && json.plugin && json.plugin.root, `${cmd} ${spec.label}: the answer names its plugin copy`);
    return json;
  };
  const claim = (t, dir, label, files, extra = {}) =>
    helper(t, "claim", { dir, label, files, branch: "main", brief: `/r/${label}.md`, tmp: `/r/.agent-tmp/${label}`, base: "abc1234", ...extra });
  const more = (t, dir, label, hard, soft, extra = {}) => helper(t, "claim-more", { dir, label, hard, soft, ...extra });
  const read = (dir, label) => JSON.parse(fs.readFileSync(`${dir}/${label}.json`, "utf8"));
  /** After a normal run the folder holds claim files only: no lock, no temp file. */
  const onlyClaims = (t, dir, labels) => t.eq(fs.readdirSync(dir).sort(), labels.map((l) => `${l}.json`).sort(), "the folder holds the claims and nothing else: no lock, no temp file");

  scenario("claim-cmd-claim", "the claim command writes a claim when no other open claim lists its files, refuses with the conflicts when one does, refuses another branch, and reuses an open claim of the same label", async (t) => {
    const dir = claimsDir(t, "claim");
    let r = claim(t, dir, "one", ["src/A.js", "src\\b.js", "./docs/x.md"]);
    t.eq([r.ok, r.conflicts, r.branchConflicts, r.reused], [true, [], [], false], "the first package claims");
    const one = read(dir, "one");
    t.eq([one.label, one.status, one.files, one.branch, one.brief, one.tmp, one.base], ["one", "open", ["src/a.js", "src/b.js", "docs/x.md"], "main", "/r/one.md", "/r/.agent-tmp/one", "abc1234"],
      "its claim holds the fields the workflow wrote before, the paths keyed (lower case, slashes forward)");
    t.ok(/^\d{4}(-\d\d){2}T\d\d(:\d\d){2}Z$/.test(one.openedAt), `openedAt is the time now (${one.openedAt})`);
    t.ok(r.file.endsWith("/packages/repo/one.json"), `the answer names the file (${r.file})`);
    r = claim(t, dir, "two", ["src/c.js", "test/c.test.js"]);
    t.eq([r.ok, r.conflicts], [true, []], "a second package with disjoint files claims too");
    onlyClaims(t, dir, ["one", "two"]);

    r = claim(t, dir, "three", ["src/new.js", "SRC/B.JS", "docs/x.md"]);
    t.eq([r.ok, r.conflicts], [false, ["one: src/b.js", "one: docs/x.md"]], "a package whose files another open claim lists is refused with each conflict");
    t.ok(!fs.existsSync(`${dir}/three.json`), "and nothing is written for it");

    r = claim(t, dir, "four", ["src/d.js"], { branch: "feat" });
    t.eq([r.ok, r.conflicts, r.branchConflicts], [false, [], ["one: main", "two: main"]], "a package on another branch than the open claims is refused with the branch conflicts");
    t.ok(!fs.existsSync(`${dir}/four.json`), "and nothing is written for it");

    // a closed claim, a claim without a branch, a stray copy and a liar are no conflicts
    fs.writeFileSync(`${dir}/old.json`, JSON.stringify({ label: "old", status: "closed", files: ["src/e.js"], branch: "feat" }));
    fs.writeFileSync(`${dir}/nobranch.json`, JSON.stringify({ label: "nobranch", status: "open", files: ["src/z.js"] }));
    fs.writeFileSync(`${dir}/one.json.bak-1`, JSON.stringify({ label: "one", status: "open", files: ["src/e.js"], branch: "feat" }));
    fs.writeFileSync(`${dir}/liar.json`, JSON.stringify({ label: "someone", status: "open", files: ["src/e.js"], branch: "feat" }));
    r = claim(t, dir, "five", ["src/e.js"]);
    t.eq([r.ok, r.conflicts, r.branchConflicts], [true, [], []], "a closed claim, a claim without a branch field and stray files are no conflicts");

    // resume: the claim of the same label is reused as it is, extended by files it lacks; nothing else changes
    more(t, dir, "one", ["src/grown.js"], []);
    const before = read(dir, "one");
    r = claim(t, dir, "one", ["src/A.js", "src/late.js"]);
    t.eq([r.ok, r.conflicts, r.reused], [true, [], true], "an open claim of the same label is reused, not a conflict");
    const after = read(dir, "one");
    t.eq(after.files, ["src/a.js", "src/b.js", "docs/x.md", "src/grown.js", "src/late.js"], "it keeps the files it grew by and gains the ones it lacked");
    t.eq([after.openedAt, after.status], [before.openedAt, "open"], "its openedAt and status are kept");
    t.eq(fs.readFileSync(`${dir}/one.json.bak-1`, "utf8").includes("src/e.js"), true, "the stray is left as it was");
    t.ok(!fs.existsSync(`${dir}/.lock`) && !fs.readdirSync(dir).some((n) => n.includes(".tmp-")), "no lock and no temp file are left");
  });

  scenario("claim-cmd-more", "claim-more leaves another package's soft files to it (the 2026-11-19 case: 45 paths, 40 of two other claims), adds only this package's own, and stops on a hard file of another package", async (t) => {
    const dir = claimsDir(t, "more");
    const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}/f${String(i).padStart(2, "0")}.js`);
    const a = range("pkg-a", 25), b = range("pkg-b", 15), own = range("release", 5);
    t.eq(claim(t, dir, "pkg-a", a).ok, true, "pkg-a claims its 25 files");
    t.eq(claim(t, dir, "pkg-b", b).ok, true, "pkg-b claims its 15 files");
    t.eq(claim(t, dir, "lm-release", ["release/main.js"]).ok, true, "lm-release claims its file");
    // Git shows 45 changed paths; the writer reported none of them as its own beyond its claim
    const soft = [...a.slice(0, 13), ...own, ...b, ...a.slice(13)].map((p, i) => (i % 7 === 0 ? p.toUpperCase() : p));
    t.eq(soft.length, 45, "45 paths changed in the shared checkout");
    const r = more(t, dir, "lm-release", [], soft);
    t.eq([r.ok, r.conflicts], [true, []], "soft files of other packages are no conflict");
    t.eq([...r.others].sort(), [...a, ...b].sort(), "the 40 files of the two other claims are named in others");
    t.eq(r.added, own, "only the package's own 5 files are added");
    t.eq(read(dir, "lm-release").files, ["release/main.js", ...own], "the claim holds its own files and none of the others'");
    t.eq([read(dir, "pkg-a").files.length, read(dir, "pkg-b").files.length], [25, 15], "the other claims are untouched");

    const again = more(t, dir, "lm-release", ["release/f00.js"], ["release/f01.js", "RELEASE/F02.JS"]);
    t.eq([again.ok, again.added], [true, []], "files the claim already lists are not added twice");

    const hard = more(t, dir, "lm-release", ["release/new.js", "pkg-b/f03.js"], ["release/soft.js", "pkg-a/f00.js"]);
    t.eq([hard.ok, hard.conflicts, hard.others, hard.added], [false, ["pkg-b: pkg-b/f03.js"], ["pkg-a/f00.js"], []], "a hard file of another package is a conflict, and nothing is added");
    t.ok(!read(dir, "lm-release").files.includes("release/new.js") && !read(dir, "lm-release").files.includes("release/soft.js"), "the claim did not grow");

    const none = more(t, dir, "ghost", ["x.js"], []);
    t.ok(none.ok === false && none.conflicts.length === 0 && /no open claim/.test(none.error), `a label without an open claim adds nothing and says why (${none.error})`);
    onlyClaims(t, dir, ["lm-release", "pkg-a", "pkg-b"]);
  });

  scenario("claim-cmd-keys", "claims of labels beginning with a dot are seen, equivalent spellings of a path conflict, a resumed claim takes the branch it asks for, and open claims in the shell's $HOME folder are not lost when Node's home folder differs", async (t) => {
    // a label beginning with a dot: its claim is written and seen by the other packages
    const dir = claimsDir(t, "keys");
    t.eq(claim(t, dir, ".release", ["src/a.js"]).ok, true, "a package labelled .release claims");
    t.ok(fs.existsSync(`${dir}/.release.json`), "its claim file is written");
    let r = claim(t, dir, "two", ["SRC/A.js"]);
    t.eq([r.ok, r.conflicts], [false, [".release: src/a.js"]], "another package's overlapping path conflicts with it");
    r = more(t, dir, ".release", [], ["src/a.js"]);
    t.eq([r.ok, r.others], [true, []], "claim-more of .release finds its own claim and no other");

    // equivalent spellings of one path: dot segments and repeated slashes are collapsed, in the request and in a stored claim
    const dir2 = claimsDir(t, "spell");
    t.eq(claim(t, dir2, "one", ["src/../a.js", "x//y/./z.js"]).ok, true, "a package claims src/../a.js and x//y/./z.js");
    t.eq(read(dir2, "one").files, ["a.js", "x/y/z.js"], "they are stored as the workflow keys them");
    r = claim(t, dir2, "two", ["a.js", "./x/y/z.js"]);
    t.eq([r.ok, r.conflicts], [false, ["one: a.js", "one: x/y/z.js"]], "the same files spelled otherwise conflict");
    fs.writeFileSync(`${dir2}/older.json`, JSON.stringify({ label: "older", status: "open", files: ["lib/./b/../c.js", "docs//d.md"], branch: "main" }));
    r = claim(t, dir2, "three", ["lib/c.js"]);
    t.eq([r.ok, r.conflicts], [false, ["older: lib/c.js"]], "a stored claim spelled otherwise conflicts too");
    r = more(t, dir2, "one", ["docs/d.md"], ["lib/sub/../c.js"]);
    t.eq([r.ok, r.conflicts, r.others], [false, ["older: docs/d.md"], ["lib/c.js"]], "claim-more keys both sides the same way");

    // a resumed claim asks for another branch: it takes it when no other open claim stands against it, and the others then see it
    const dir3 = claimsDir(t, "resume");
    t.eq(claim(t, dir3, "one", ["a.js"]).ok, true, "a package claims on main");
    r = claim(t, dir3, "one", ["a.js"], { branch: "feat" });
    t.eq([r.ok, r.reused, r.branchWas], [true, true, "main"], "the resume on feat reuses the claim and names the branch it had");
    t.eq(read(dir3, "one").branch, "feat", "the claim now names feat");
    r = claim(t, dir3, "two", ["b.js"]);
    t.eq([r.ok, r.branchConflicts], [false, ["one: feat"]], "a package on main is refused against the resumed one");
    t.eq(claim(t, dir3, "three", ["c.js"], { branch: "feat" }).ok, true, "a package on feat claims");
    r = claim(t, dir3, "one", ["a.js"], { branch: "main" });
    t.eq([r.ok, r.branchConflicts], [false, ["three: feat"]], "a resume onto main is refused while another open claim works on feat");
    t.eq(read(dir3, "one").branch, "feat", "and its claim keeps feat");
    r = claim(t, dir3, "one", ["a.js"], { branch: "feat" });
    t.eq([r.ok, r.reused, r.branchWas], [true, true, undefined], "a resume on the same branch names no earlier one");

    // the shell's $HOME and Node's home folder differ (Windows: Node reads USERPROFILE). The claims folder and its lock are the ones under the
    // shell's $HOME, which every version of the workflow reads, writes and locks, so an older session sees a new session's claim; open claims
    // that a build of the helper wrote under Node's home folder are not lost either
    if (process.platform !== "win32") { t.log("Node's home folder is $HOME on this platform: the two folders cannot differ"); return; }
    const scratch = (name) => {
      const h = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-claim-${name}-`)).replace(/\\/g, "/");
      t.cleanups.push(() => fs.rmSync(h, { recursive: true, force: true }));
      return h;
    };
    const nodeHome = scratch("node"), shellHome = scratch("shell");
    const spec = "~/.zodchi/packages/-r";
    const shellDir = `${shellHome}/.zodchi/packages/-r`, nodeDir = `${nodeHome}/.zodchi/packages/-r`;
    const msys = shellHome.replace(/^([A-Za-z]):/, (_, l) => `/${l.toLowerCase()}`);
    const newSpec = { dir: spec, label: "new", files: ["src/z.js"], branch: "main", brief: "/r/b.md", tmp: "/r/.agent-tmp/new", base: "abc1234" };
    r = helper(t, "claim", newSpec, { HOME: msys, USERPROFILE: nodeHome });
    t.eq(r.ok, true, "$HOME in Git Bash form: a clean file is claimed");
    t.ok(String(r.file).toLowerCase() === `${shellDir}/new.json`.toLowerCase(), `the claim lies under the shell's $HOME, where an older session reads it (${r.file})`);
    t.eq(read(shellDir, "new").files, ["src/z.js"], "it is there for an older session to compare with");
    t.ok(!fs.existsSync(nodeDir), "nothing is written under Node's home folder");
    r = helper(t, "claim", newSpec, { HOME: shellHome, USERPROFILE: nodeHome });
    t.eq([r.ok, r.reused], [true, true], "$HOME in Windows form names the same folder: the claim is reused");
    fs.mkdirSync(`${shellDir}/.lock`);
    r = helper(t, "claim", { ...newSpec, label: "late", files: ["src/w.js"], lockWaitSec: 1 }, { HOME: msys, USERPROFILE: nodeHome });
    t.eq([r.ok, r.conflicts], [false, ["lock busy"]], "the lock an older session holds under $HOME is the helper's lock too");
    fs.rmdirSync(`${shellDir}/.lock`);

    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(`${nodeDir}/old.json`, JSON.stringify({ label: "old", status: "open", files: ["src/a.js", "src/b.js"], branch: "main" }));
    fs.writeFileSync(`${nodeDir}/done.json`, JSON.stringify({ label: "done", status: "closed", files: ["src/c.js"], branch: "main" }));
    for (const [form, home] of [["Windows", shellHome], ["Git Bash", msys]]) {
      r = helper(t, "claim", { ...newSpec, label: "next", files: ["src/n.js"] }, { HOME: home, USERPROFILE: nodeHome });
      t.eq([r.ok, r.legacyClaims, r.conflicts], [false, ["old: 2 file(s)"], []], `$HOME in ${form} form: the open claim under Node's home folder stops the claim`);
      t.ok(String(r.legacyDir).toLowerCase() === nodeDir.toLowerCase(), `and the answer names that folder (${r.legacyDir})`);
      t.ok(!fs.existsSync(`${shellDir}/next.json`), "nothing is written");
    }
    r = helper(t, "claim", { ...newSpec, label: "next", files: ["src/n.js"] }, { HOME: shellHome, USERPROFILE: shellHome });
    t.eq([r.ok, r.legacyClaims], [true, undefined], "with one home folder for both there is nothing else to read and the claim goes through");
    r = helper(t, "claim-more", { dir: spec, label: "new", hard: ["src/y.js"], soft: ["src/a.js", "src/x.js"] }, { HOME: msys, USERPROFILE: nodeHome });
    t.eq([r.ok, r.others, r.added], [true, ["src/a.js"], ["src/y.js", "src/x.js"]], "claim-more leaves a file of an open claim under Node's home folder to it");
    r = helper(t, "claim-more", { dir: spec, label: "new", hard: ["src/b.js"], soft: [] }, { HOME: msys, USERPROFILE: nodeHome });
    t.eq([r.ok, r.conflicts], [false, ["old: src/b.js"]], "and a hard file of it is a conflict");
    t.eq(read(shellDir, "new").files, ["src/z.js", "src/y.js", "src/x.js"], "the claim holds only this package's files");
    t.ok(!fs.existsSync(`${nodeDir}/new.json`) && !fs.existsSync(`${nodeDir}/.lock`), "nothing is written under Node's home folder");

    // the workflow refuses on that answer and writes and closes no claim
    const { home: wfHome, dir: wfDir } = homeFor(t, "wf-legacy");
    const w = await runBody({ "claim lm-release": realRunner(t, wfHome, undefined, { USERPROFILE: nodeHome }) });
    t.ok(String(w.out.refused).startsWith(`Open claims lie in ${nodeDir}`) && w.out.refused.includes("old: 2 file(s)"), `the workflow refuses (${w.out.refused})`);
    t.eq(w.calls.map((x) => x.label), ["gate lm-release", "claim lm-release"], "nothing ran after the claim step, and no claim was left to close");
    t.ok(!fs.existsSync(`${wfDir}/lm-release.json`), "no claim was written");
  });

  scenario("claim-cmd-lock-busy", "a held claims lock is retried for a bounded time, then reported as the conflict \"lock busy\" and left in place; nothing is written", async (t) => {
    const dir = claimsDir(t, "lock");
    t.eq(claim(t, dir, "one", ["a.js"]).ok, true, "a package claims");
    fs.mkdirSync(`${dir}/.lock`);
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(`${dir}/.lock`, old, old);
    const started = Date.now();
    const r = claim(t, dir, "two", ["b.js"], { lockWaitSec: 1 });
    const took = Date.now() - started;
    t.eq([r.ok, r.conflicts], [false, ["lock busy"]], "claim: the lock is reported busy");
    t.ok(took >= 900, `after waiting for it (${took} ms)`);
    t.ok(!fs.existsSync(`${dir}/two.json`), "nothing was written");
    const m = more(t, dir, "one", ["c.js"], [], { lockWaitSec: 1 });
    t.eq([m.ok, m.conflicts, m.added], [false, ["lock busy"], []], "claim-more: the lock is reported busy");
    t.eq(read(dir, "one").files, ["a.js"], "nothing was added");
    t.ok(fs.existsSync(`${dir}/.lock`), "the lock is left in place, even an hour old: it is never broken");
    fs.rmdirSync(`${dir}/.lock`);
    t.eq(claim(t, dir, "two", ["b.js"], { lockWaitSec: 1 }).ok, true, "once it is released the claim goes through");
    t.ok(!fs.existsSync(`${dir}/.lock`), "and the lock is not left held after a normal run");
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The code-package body, run the way Claude Code runs it, with the claim steps answered by the real helper

  const SRC = fs.readFileSync(path.join(ROOT, "core", "workflows", "code-package.js"), "utf8");
  const BOOT = vm.runInNewContext(SRC.match(/^const GATE_BOOT = (.*)$/m)[1]);
  const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };
  const FACTS = {
    ok: true, api: 1, plugin: PLUGIN, roles: {}, modelsErrors: [], account: null, accountError: "none", git: true, head: "abc1234", runId: "a1b2c3d4", branch: "main", dirty: [], dirtyError: "",
    workflow: { name: "code-package", build: "b", copyBuild: "b", match: true }, ignoreExit: 0, ignoreLine: ".gitignore:3:.agent-tmp/\t.agent-tmp/gateway/x", verifySkill: false, reviewMd: false, config: {}, configError: "", boundary: "Important: x.\n",
    claims: { dir: "d", open: [], closed: [], kept: [], skipped: [], notes: [] },
  };
  const ARGS = {
    label: "lm-release", brief: "/r/brief.md", repo: "/r", files: ["src/a.js"], tmp: "/r/.agent-tmp/lm-release", checks: ["node t.js"],
    models: { writer: { candidates: [{ provider: "claude", model: "sonnet" }] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } },
  };
  /** A scratch home folder; the claims of the repository "/r" lie where the workflow names them: ~/.zodchi/packages/-r. */
  const homeFor = (t, name) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-claim-${name}-`)).replace(/\\/g, "/");
    t.cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    return { home, dir: `${home}/.zodchi/packages/-r` };
  };
  /**
   * The runner of a claim step: it runs the command of the prompt (the bootstrap, then gate.mjs of this checkout as the plugin copy) with
   * the scratch home as the home folder, and returns its exit code and stdout as they are. `tweak` may change the spec (a short lock wait).
   * The repository "/r" of the workflow is a scratch Git repository <home>/repo, clean when the claim is made; `changes` are the files the
   * round leaves changed in it, written before claim-more runs (claim-more reads Git itself).
   */
  const realRunner = (t, home, tweak = (s) => s, env = {}, changes = []) => (prompt) => {
    const m = commandsIn(prompt, "claim|claim-more")[0];
    if (!m) throw new Error(`no claim command in the prompt: ${prompt.slice(0, 300)}`);
    const spec = tweak(m.spec);
    if (spec.repo === "/r") {
      const repo = `${home}/repo`;
      if (!fs.existsSync(`${repo}/.git`)) { fs.mkdirSync(repo, { recursive: true }); spawnSync("git", ["-C", repo, "init", "-q"]); }
      if (m.command === "claim-more") for (const f of changes) { fs.mkdirSync(path.dirname(`${repo}/${f}`), { recursive: true }); fs.writeFileSync(`${repo}/${f}`, "changed\n"); }
      spec.repo = repo;
    }
    const r = spawnSync(process.execPath, ["-e", BOOT, "--", home, m.command, encodeSpec(spec)], {
      encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, ZODCHI_PLUGIN_ROOT: path.join(ROOT, "core"), CLAUDE_PLUGIN_ROOT: "", ...env },
    });
    t.log(`runner: gate.mjs ${m.command} ${JSON.stringify(spec)}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    return { exitCode: r.status, stdout: r.stdout, error: (r.stderr || "").slice(0, 300) };
  };
  /** Runs the code-package body once; `answers[label]` (a value or a function of the prompt) replaces a default answer. */
  async function runBody(answers, args = ARGS) {
    const calls = [];
    const answer = (label, prompt) => {
      const given = answers[label];
      if (given !== undefined) return typeof given === "function" ? given(prompt) : given;
      if (label.startsWith("gate ")) return { exitCode: 0, stdout: JSON.stringify(FACTS) + "\n" };
      if (label.startsWith("write ")) return { done: true, summary: "wrote", changed: ["/r/src/a.js"], unverified: [] };
      if (label.startsWith("status ")) return { ok: true, paths: ["src/a.js"] };
      if (label.startsWith("checks ")) return { ok: true, results: ["ok"], cause: "none", logs: [], evidence: [{ command: "node t.js", exitCode: 0, log: "l" }] };
      if (label.startsWith("commit ")) return { ok: true, summary: "deadbeef", paths: [] };
      if (label.startsWith("review ")) return { verdict: "approved", findings: [] };
      if (label.startsWith("close claim")) return { ok: true, summary: "closed" };
      throw new Error(`no scripted answer for the step "${label}"`);
    };
    const sandbox = { args, phase: () => {}, log: () => {}, agent: async (prompt, opts) => { calls.push({ label: opts.label, prompt }); return answer(opts.label, prompt); } };
    const fn = vm.runInNewContext(`(async () => {\n${SRC.replace(/^export const meta/, "const meta")}\n})`, sandbox, { filename: "code-package.js" });
    let out = null, error = null;
    try { out = await fn(); } catch (e) { error = e; }
    return { out, error, calls, of: (re) => calls.filter((c) => re.test(c.label)) };
  }
  /** The package paths a commit step was told to commit. */
  const commitPaths = (c) => JSON.parse(c.prompt.match(/The package paths, relative to the repository: (\[.*?\])\.\n/)[1]);

  scenario("claim-cmd-stopped-owner", "claim-more leaves another stopped package's dirty test with its owner through the guard and commit", async (t) => {
    const { home, dir } = homeFor(t, "stopped");
    const dirty = "tests/Partial.js", clean = "tests/removed.js";
    claim(t, dir, "earlier", [dirty, clean]);
    const stopped = { ...read(dir, "earlier"), status: "stopped", closedAt: new Date().toISOString() };
    fs.writeFileSync(`${dir}/earlier.json`, JSON.stringify(stopped));
    // An untracked file removed by the earlier package no longer appears in Git status.
    const repo = `${home}/repo`;
    fs.mkdirSync(`${repo}/tests`, { recursive: true });
    fs.writeFileSync(`${repo}/${clean}`, "partial");
    fs.unlinkSync(`${repo}/${clean}`);
    const real = realRunner(t, home, undefined, {}, [dirty, "src/a.js"]);
    const run = await runBody({
      "claim lm-release": real,
      "claim more write lm-release": (prompt) => {
        const reply = real(prompt);
        const facts = JSON.parse(reply.stdout);
        t.eq([facts.others, facts.owners, facts.changed, facts.added], [[dirty], [`earlier: ${dirty}`], ["src/a.js"], []], "Git lists only the dirty test as foreign");
        return reply;
      },
      "status write lm-release": { ok: true, paths: [dirty, "src/a.js"] },
    });
    t.eq([run.error, run.out?.approved, run.of(/^protect /).length], [null, true, 0], "the foreign test stays out of the guard");
    t.eq(commitPaths(run.of(/^commit /)[0]), ["src/a.js"], "only this package's file goes to the commit");
    const soft = more(t, dir, "lm-release", [], [dirty]);
    t.eq([soft.ok, soft.others, soft.owners, soft.added], [true, [dirty.toLowerCase()], ["earlier: tests/partial.js"], []], "the explicit soft list leaves the test with its owner");
    const hard = more(t, dir, "lm-release", [dirty], []);
    t.eq([hard.ok, hard.conflicts], [false, ["earlier: tests/partial.js"]], "reporting the test explicitly is a conflict");
    t.eq(read(dir, "lm-release").files, ["src/a.js"], "neither form took a file from the stopped claim");
    t.eq(read(dir, "earlier"), stopped, "the stopped claim stays as it was");
    const oldGit = "src/old.js", oldSoft = "src/soft.js";
    claim(t, dir, "old", [oldGit, oldSoft]);
    const closedAt = new Date(Date.now() - 2 * 3600000).toISOString();
    fs.writeFileSync(`${dir}/old.json`, JSON.stringify({ ...read(dir, "old"), status: "stopped", closedAt }));
    t.eq(claim(t, dir, "next", [clean], { repo }).ok, true, "a stopped claim does not block an explicit new claim");
    fs.writeFileSync(`${repo}/${clean}`, "new work");
    fs.writeFileSync(`${repo}/${oldGit}`, "new work");
    const git = helper(t, "claim-more", { dir, repo, label: "next", staleHours: 1 });
    t.eq([git.ok, git.changed, git.added], [true, [oldGit, clean], [oldGit]], "Git keeps the explicitly claimed edit and adds an edit listed only by an expired claim");
    fs.writeFileSync(`${repo}/${oldSoft}`, "new work");
    const listed = more(t, dir, "next", [clean], [oldSoft], { staleHours: 1 });
    t.eq([listed.ok, listed.conflicts, listed.others, listed.added], [true, [], [], [oldSoft]], "the explicit lists keep the claimed hard file and add the expired claim's soft file");
    const next = read(dir, "next");
    fs.writeFileSync(`${dir}/next.json`, JSON.stringify({ ...next, status: "stopped" }));
    const resumed = helper(t, "claim-more", { dir, repo, label: "next" });
    t.eq([resumed.ok, resumed.reopened], [true, true], "the other stopped claim does not block reopening");
  });

  scenario("claim-cmd-workflow", "code-package decides from the claim helper's own answers: with 45 changed paths of which 40 belong to two other open claims (the 2026-11-19 case) the commit holds only the package's files; conflicts refuse or stop the run; a busy lock or an unreadable answer stops it", async (t) => {
    const { home, dir } = homeFor(t, "wf");
    const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}/f${String(i).padStart(2, "0")}.js`);
    const a = range("pkg-a", 25), b = range("pkg-b", 15);
    t.eq(claim(t, dir, "pkg-a", a).ok, true, "pkg-a claims its 25 files");
    t.eq(claim(t, dir, "pkg-b", b).ok, true, "pkg-b claims its 15 files");
    const otherClaims = () => [read(dir, "pkg-a").files.length, read(dir, "pkg-b").files.length];

    // the writer reports two files; Git shows 45: the two, three more of this package's, and the 40 of the other two packages
    const ownSoft = ["release/f01.js", "release/f02.js", "release/F03.js"];
    const status = ["src/a.js", "release/main.js", ...ownSoft, ...a.slice(0, 20), ...b, ...a.slice(20).map((p) => p.toUpperCase())];
    t.eq(status.length, 45, "45 paths changed in the shared checkout");
    const real = realRunner(t, home, undefined, {}, status);
    const r = await runBody({
      "claim lm-release": real, "claim more write lm-release": real,
      "write lm-release": { done: true, summary: "wrote", changed: ["/r/src/a.js", "/r/release/main.js"], unverified: [] },
      "status write lm-release": { ok: true, paths: status },
    });
    t.eq([r.error, r.out && r.out.approved], [null, true], "the run goes through to approval");
    t.eq([...read(dir, "lm-release").files].sort(), ["release/f01.js", "release/f02.js", "release/f03.js", "release/main.js", "src/a.js"], "the claim the helper wrote holds the package's own files and none of the others'");
    t.eq(otherClaims(), [25, 15], "the other two claims are untouched");
    const commits = r.of(/^commit /);
    t.eq(commits.length, 1, "one commit step");
    t.eq(commitPaths(commits[0]).sort(), ["release/F03.js", "release/f01.js", "release/f02.js", "release/main.js", "src/a.js"], "the commit step's path list holds only the package's own files");
    t.eq([...r.out.claimAdded].sort(), ["release/F03.js", "release/f01.js", "release/f02.js", "release/main.js"], "claimAdded is what the helper added");
    const more = r.of(/^claim more /)[0].prompt;
    t.ok(!/compare its "files"|entry by entry|Read every claim/.test(more), "the runner is never asked to compare lists itself");
    const moreSent = commandsIn(more, "claim-more")[0];
    const moreCmd = moreSent ? JSON.stringify(moreSent.spec) : "";
    t.ok(moreSent && moreSent.arg.startsWith("b64:") && moreSent.arg.length < 400, `the spec is sent as b64: (${moreSent && moreSent.arg.length} characters)`);
    t.ok(moreCmd.includes('"repo":"/r"') && !/release\/|pkg-a\/|pkg-b\//.test(moreCmd) && moreCmd.length < 300, `the claim-more command names no file, the helper reads Git itself: ${moreCmd.length} characters for 45 changed paths`);
    t.ok(!fs.existsSync(`${dir}/.lock`), "no lock is left held after the run");
    t.ok(r.of(/^close claim/)[0].prompt.includes(`"${dir}/lm-release.json"`), "the close step names the very file the helper wrote");

    // a file the writer reports, which another open package claims: the helper's conflict stops the run before any commit
    const { home: home2, dir: dir2 } = homeFor(t, "wf-hard");
    claim(t, dir2, "pkg-b", b);
    const real2 = realRunner(t, home2, undefined, {}, ["src/a.js", "pkg-b/f03.js"]);
    const c = await runBody({
      "claim lm-release": real2, "claim more write lm-release": real2,
      "write lm-release": { done: true, summary: "wrote", changed: ["/r/src/a.js", "/r/pkg-b/f03.js"], unverified: [] },
      "status write lm-release": { ok: true, paths: ["src/a.js", "pkg-b/f03.js"] },
    });
    t.eq([c.out.stoppedAt, c.out.conflicts], ["claim conflict", ["pkg-b: pkg-b/f03.js"]], "a reported file the helper names as another package's stops the run");
    t.eq(c.of(/^commit /).length, 0, "nothing was committed");
    t.eq(read(dir2, "lm-release").files, ["src/a.js"], "and the claim did not grow");

    // a package whose own file another open claim lists is refused at the claim step, and nothing is written for it
    const { home: home3, dir: dir3 } = homeFor(t, "wf-refuse");
    claim(t, dir3, "pkg-a", a);
    const f = await runBody({ "claim lm-release": realRunner(t, home3) }, { ...ARGS, files: ["src/a.js", "PKG-A/f07.js"] });
    t.ok(String(f.out.refused).startsWith("Open packages claim the same files: pkg-a: pkg-a/f07.js"), `refused with the conflict (${f.out.refused})`);
    t.eq(f.calls.map((x) => x.label), ["gate lm-release", "claim lm-release"], "nothing ran after the claim step, and no claim was left to close");
    t.ok(!fs.existsSync(`${dir3}/lm-release.json`), "no claim was written");

    // a held lock: the helper waits (here 1 s), reports it busy and leaves it; the run stops, it is no refusal
    const { home: home4, dir: dir4 } = homeFor(t, "wf-lock");
    claim(t, dir4, "pkg-a", a);
    fs.mkdirSync(`${dir4}/.lock`);
    const l = await runBody({ "claim lm-release": realRunner(t, home4, (s) => ({ ...s, lockWaitSec: 1 })) });
    t.ok(/^claim \(lock busy/.test(l.out.stoppedAt) && l.out.refused === undefined, `a busy lock stops the run at the claim (${l.out.stoppedAt})`);
    t.ok(fs.existsSync(`${dir4}/.lock`) && !fs.existsSync(`${dir4}/lm-release.json`), "the lock is left in place and nothing was written");
    t.eq(l.of(/^write /).length, 0, "nothing was written by the writer either");
    t.eq(l.of(/^(close|await) claim/).length, 0, "and no claim file is marked or closed: the helper confirmed none");

    // an answer the workflow cannot read is no claim: a bad exit code, no JSON line, another api
    const bad = {
      "exit 2": { exitCode: 2, stdout: JSON.stringify({ ok: false, api: 1, error: "spec.files is missing or not a list" }) + "\n" },
      "no JSON": { exitCode: 0, stdout: "claimed, no conflicts" },
      "api 2": { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 2, plugin: PLUGIN, conflicts: [] }) + "\n" },
      "no conflicts list": { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN }) + "\n" },
    };
    for (const [what, answer] of Object.entries(bad)) {
      const x = await runBody({ "claim lm-release": answer });
      t.ok(/^claim \(the claim helper/.test(String(x.out.stoppedAt)) && x.of(/^write /).length === 0, `${what}: the run stops at the claim (${x.out.stoppedAt})`);
      t.ok(x.of(/^(close|await) claim/).length === 0 && /is unknown/.test(String(x.out.claimUnknown)), `${what}: no guessed claim file is closed; the claim state is reported unknown (${x.out.claimUnknown})`);
      const y = await runBody({
        "claim lm-release": { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, conflicts: [], branchConflicts: [], file: "/h/.zodchi/packages/-r/lm-release.json" }) + "\n" }, "claim more write lm-release": answer,
        "write lm-release": { done: true, summary: "w", changed: ["/r/src/a.js", "/r/src/n.js"], unverified: [] }, "status write lm-release": { ok: true, paths: ["src/a.js", "src/n.js"] },
      });
      t.ok(/^claim more \(the claim-more helper/.test(String(y.out.stoppedAt)) && y.of(/^commit /).length === 0, `${what}: the run stops at the extension, nothing committed (${y.out.stoppedAt})`);
      t.ok(y.of(/^close claim/)[0].prompt.includes('"/h/.zodchi/packages/-r/lm-release.json"'), `${what}: the claim the helper confirmed is closed by its own path`);
    }
    // a success without this label's absolute claim file confirms no claim: the run stops with the claim state unknown, nothing is closed
    for (const file of [undefined, "lm-release.json", "/h/.zodchi/packages/-r/other.json"]) {
      const z = await runBody({ "claim lm-release": { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, conflicts: [], branchConflicts: [], file }) + "\n" } });
      t.ok(z.out.stoppedAt === "claim (the helper reported success without its claim file)" && /is unknown/.test(String(z.out.claimUnknown)), `file ${JSON.stringify(file)}: the run stops with the claim state unknown (${z.out.stoppedAt})`);
      t.eq([z.of(/^write /).length, z.of(/^(close|await) claim/).length], [0, 0], `file ${JSON.stringify(file)}: nothing ran after it and no claim file was marked or closed`);
    }

    // args.branch outside the shared-branch mode: the switch is a runner step of its own, after the helper wrote the claim
    const { home: home5 } = homeFor(t, "wf-switch");
    const s = await runBody({ "claim lm-release": realRunner(t, home5), "switch lm-release": { ok: false, summary: "branch is checked out elsewhere" } }, { ...ARGS, branch: "feat" });
    t.eq(s.out.stoppedAt, "switch to feat (branch is checked out elsewhere)", "a failed switch stops the run");
    t.ok(s.of(/^switch /)[0].prompt.includes("git switch 'feat'") && !s.of(/^claim lm-release$/)[0].prompt.includes("git switch"), "the switch is not in the claim step");
    t.eq(s.of(/^close claim/).length, 1, "and the claim it wrote is closed");
  });

  scenario("claim-cmd-more-from-git", "claim-more with the repository reads Git itself: the command stays short with 61 changed files, a file another open claim lists goes to others with its owner, the job folder and what was changed before the package started stay out", async (t) => {
    const dir = claimsDir(t, "git");
    const repo = `${path.dirname(path.dirname(dir))}/repo`;
    fs.mkdirSync(`${repo}/src`, { recursive: true });
    const git = (...args) => spawnSync("git", ["-C", repo, "-c", "user.name=tester", "-c", `user.email=${["tester", "example.test"].join("@")}`, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    git("init", "-q");
    fs.writeFileSync(`${repo}/src/a.js`, "a\n");
    git("add", "src/a.js");
    git("commit", "-q", "-m", "base");
    fs.writeFileSync(`${repo}/notes.txt`, "somebody's change before the package\n");
    let r = claim(t, dir, "pkg", ["src/a.js"], { repo });
    t.eq([r.ok, read(dir, "pkg").atGate], [true, ["notes.txt"]], "the claim records what Git listed when the package started");
    t.eq(claim(t, dir, "other", ["lib/o.js"]).ok, true, "another package claims lib/o.js");
    // the round: the package's own files, 60 generated ones, the other package's file, the job folder, and the earlier change edited again
    fs.writeFileSync(`${repo}/src/a.js`, "a2\n");
    fs.writeFileSync(`${repo}/src/New.js`, "n\n");
    fs.mkdirSync(`${repo}/gen`); for (let i = 0; i < 60; i++) fs.writeFileSync(`${repo}/gen/f${i}.js`, `${i}\n`);
    fs.mkdirSync(`${repo}/lib`); fs.writeFileSync(`${repo}/lib/o.js`, "o\n");
    fs.mkdirSync(`${repo}/.agent-tmp/pkg`, { recursive: true }); fs.writeFileSync(`${repo}/.agent-tmp/pkg/log.txt`, "l\n");
    fs.writeFileSync(`${repo}/notes.txt`, "edited again\n");
    const spec = { dir, label: "pkg", repo };
    t.ok(JSON.stringify(spec).length < 400, `the spec names no changed file (${JSON.stringify(spec).length} characters for 64 changed paths)`);
    r = helper(t, "claim-more", spec);
    t.eq([r.ok, r.conflicts, r.others, r.owners], [true, [], ["lib/o.js"], ["other: lib/o.js"]], "the other package's file is its own, with its owner, and no conflict here");
    t.eq(r.changed.length, 62, "changed: src/a.js, src/New.js and the 60 generated files");
    t.ok(r.changed.includes("src/New.js") && !r.changed.includes("notes.txt") && !r.changed.some((p) => p.startsWith(".agent-tmp")), "spelled as Git spells them, without the earlier change and the job folder");
    t.eq(r.added.length, 61, "every changed file the claim lacked is added (src/a.js was claimed)");
    t.ok(r.added.includes("src/new.js") && !r.added.includes("lib/o.js"), "keyed, and never the other package's file");
    t.eq(read(dir, "pkg").files.length, 62, "the claim holds them");
    t.eq(read(dir, "other").files, ["lib/o.js"], "the other claim is untouched");
    r = helper(t, "claim-more", spec);
    t.eq([r.ok, r.added], [true, []], "a second look adds nothing");
    r = helper(t, "claim-more", { ...spec, repo: `${repo}/no-such-folder` });
    t.eq([r.ok, r.gitError, r.added], [false, true, []], "a repository Git cannot read is an error, never a clean work tree");
    r = helper(t, "claim-more", { ...spec, label: "ghost" });
    t.ok(r.ok === false && /no open claim/.test(r.error), "a label without an open claim adds nothing");
    onlyClaims(t, dir, ["other", "pkg"]);
  });
}
