#!/usr/bin/env node
// The before-release end-to-end run: a headless Claude Code session runs the real `code-package` workflow on a
// throwaway fixture repository, with the plugins of this working tree. It SPENDS MODEL TOKENS (the writer and the
// runners are Claude models); the review goes through the candidate gateway to scripts/e2e/fake-codex.mjs, which
// answers with a scripted approval. Never run on every pull request: `npm run e2e:release`, by hand, before a release.
//
//   node scripts/e2e-release.mjs --disposable [--max-usd <n>] [--deadline-min <n>] [--model <id>] [--keep]
//
//   --disposable      required, always (CI=true does not count): states that this runs in a dedicated, disposable
//                     container or VM with no checkout but this one, no credential store mounted, and outbound
//                     network only to the model service. The run isolates the session (its own home, its own Claude
//                     config, an allow-listed environment, a throwaway fixture repository) but it is not a sandbox: an
//                     agent's shell can still reach the file system and the network. The run cannot enforce the
//                     network limit; that is the container's job. It refuses when it sees signs of a machine that is
//                     not disposable: a credential store in the real home, or a Git credential kept in this checkout.
//   --max-usd <n>     the cost cap of the whole run, default 3; passed to `claude -p --max-budget-usd`, which counts
//                     subagents and workflow agents too. The run refuses to start when that flag is not available.
//   --deadline-min <n> wall-clock deadline, default 40; the session and everything it started is killed after it
//   --model <id>      the pinned model of the session and of every Claude role of the workflow, default claude-haiku-4-5
//   --keep            keep the scratch folder after a pass (it is always kept after a failure)
//
// Credentials: only ANTHROPIC_API_KEY reaches the session (the clean home has no stored sign-in). No OpenAI key, no
// Git credentials, no SSH agent. Nothing is retried: a failed paid run is reported and left for a human.
//
// What decides the outcome, apart from the session's own exit:
//   0. the session itself: it started, exited 0 before the deadline, and its JSON on stdout is a success
//      (is_error false, subtype "success") with a cost receipt (total_cost_usd, a positive number within the cap);
//      the candidate plugin, roles, gateway binary and brief the session got are unchanged after it;
//   1. the workflow result (written by the session to a file the harness names) has the shape of the code-package
//      result and a terminal status: verdict "approved", approved true, no stoppedAt, verifiedBy "args.verify";
//   2. on the final committed tree (git archive of the branch tip), not on the working tree: the harness reruns the
//      cheap check and the smoke command itself, and runs its own acceptance check, which is written outside the
//      fixture only after the session has ended;
//   3. the branch tip is a commit made after the harness's baseline, its message ends with the `Verified:` stamp the
//      result reports, no tracked file of the fixture has an uncommitted change (so the stamp's commit is the final
//      state), and the baseline test and smoke command are unchanged at the tip;
//   4. the review was routed through the gateway: the fake Codex ran a turn with the review schema whose prompt holds
//      the REVIEW.md of the baseline commit (proof of routing, not of review quality);
//   5. nothing changed in this working tree.
// The trace of each step is in .agent-tmp/e2e-release/trace-<time>.log of this repository; the summary names it.
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = path.join(ROOT, "scripts", "e2e", "fake-codex.mjs");
const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const option = (name, fallback) => { const i = argv.indexOf(name); if (i < 0) return fallback; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const disposable = flag("--disposable");
const keep = flag("--keep");
const maxUsd = Number(option("--max-usd", "3"));
const deadlineMin = Number(option("--deadline-min", "40"));
const model = option("--model", "claude-haiku-4-5");
if (argv.length) { console.error(`Unknown arguments: ${argv.join(" ")}`); process.exit(1); }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-e2e-release-"));
// The trace outlives the scratch folder: .agent-tmp/ of this repository is ignored by Git.
const traceFile = path.join(ROOT, ".agent-tmp", "e2e-release", `trace-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
fs.mkdirSync(path.dirname(traceFile), { recursive: true });
const trace = [];
const log = (text) => {
  const line = String(text).replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-<redacted>").replace(/(Bearer\s+)\S+/gi, "$1<redacted>");
  trace.push(line);
  fs.writeFileSync(traceFile, trace.join("\n") + "\n");
};
const problems = [];
const check = (cond, message) => { log(`${cond ? "ok" : "FAILED"}: ${message}`); if (!cond) problems.push(message); };
function stop(message) {
  log(`STOP: ${message}`);
  console.log(`FAIL e2e-release: ${message}\n     trace ${traceFile}`);
  process.exit(1);
}
const sh = (program, args, opts = {}) => {
  const r = spawnSync(program, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  log(`$ ${program} ${args.join(" ")}${opts.cwd ? `   (in ${opts.cwd})` : ""}\n  exit ${r.status}${r.stdout && r.stdout.trim() ? `\n  stdout: ${r.stdout.trim().slice(0, 2000)}` : ""}${r.stderr && r.stderr.trim() ? `\n  stderr: ${r.stderr.trim().slice(0, 2000)}` : ""}`);
  return r;
};

// ---------------------------------------------------------------------------------------------------------------
// 1. Preconditions: fail closed when the limits cannot be enforced.
log(`# e2e-release: model ${model}, cap ${maxUsd} USD, deadline ${deadlineMin} min, scratch ${scratch}`);
if (!disposable) stop("refused: pass --disposable, in a dedicated disposable container or VM (no other checkout, no credential store, network only to the model service); this run spends model tokens and is not a sandbox. CI=true alone does not count");
if (!(Number.isFinite(maxUsd) && maxUsd > 0) || !(Number.isFinite(deadlineMin) && deadlineMin > 0)) stop("--max-usd and --deadline-min must be finite positive numbers");
// Signs of a machine that is not disposable: a credential store in the real home, a Git credential in this checkout.
const stores = [".ssh", ".git-credentials", ".netrc", ".aws", path.join(".config", "gh"), ".codex", ".zodchi", path.join(".claude", ".credentials.json")]
  .map((p) => path.join(os.homedir(), p)).filter((p) => fs.existsSync(p));
if (stores.length) stop(`refused: this machine is not disposable, its home holds credential stores (${stores.join(", ")})`);
if (sh("git", ["config", "--local", "--get-regexp", "^(http\\..*\\.extraheader|credential\\..*)$"], { cwd: ROOT }).stdout.trim()) {
  stop("refused: this checkout keeps a Git credential (http.*.extraheader or credential.*); run from a checkout without one");
}
if (!process.env.ANTHROPIC_API_KEY) stop("ANTHROPIC_API_KEY is not set: the clean home of the session has no other sign-in");
const version = sh("claude", ["--version"], { shell: WIN });
if (version.status !== 0) stop("the claude command is not available");
const help = sh("claude", ["--help"], { shell: WIN });
for (const needed of ["--max-budget-usd", "--plugin-dir", "--model", "--output-format", "--permission-mode"]) {
  if (!(help.stdout || "").includes(needed)) stop(`claude ${version.stdout.trim()} has no ${needed}: the budget or the isolation cannot be enforced`);
}

// 2. The candidate gateway, built once and put first on PATH as `zodchi`.
const started = Date.now();
const build = sh("cargo", ["build", "--release", "--locked", "--manifest-path", path.join(ROOT, "gateway", "Cargo.toml")]);
if (build.status !== 0) stop("cargo build --release failed");
log(`build ${((Date.now() - started) / 1000).toFixed(1)} s`);
const bin = path.join(scratch, "bin");
fs.mkdirSync(bin, { recursive: true });
fs.copyFileSync(path.join(ROOT, "gateway", "target", "release", "zodchi" + EXE), path.join(bin, "zodchi" + EXE));

// 3. A clean home, the candidate plugin and roles read-only, a Codex home for the fake with a scripted review.
const home = path.join(scratch, "home");
const codex = path.join(scratch, "codex-home");
const tmp = path.join(scratch, "tmp");
const plugins = path.join(scratch, "plugins");
const roles = path.join(scratch, "roles");
for (const d of [home, codex, tmp, plugins, path.join(home, ".zodchi")]) fs.mkdirSync(d, { recursive: true });
fs.cpSync(path.join(ROOT, "core"), path.join(plugins, "zodchi-core"), { recursive: true });
fs.cpSync(path.join(ROOT, "roles"), roles, { recursive: true });
const readOnly = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) readOnly(p); else fs.chmodSync(p, 0o444);
  }
};
readOnly(path.join(plugins, "zodchi-core"));
readOnly(roles);
fs.writeFileSync(path.join(codex, "fake-auth.json"), "{}");
fs.writeFileSync(path.join(codex, "fake-answer.json"), JSON.stringify({ verdict: "approved", summary: "Scripted approval of the end-to-end run.", findings: [], notVerified: [] }));
// The role table of this run: the pinned Claude model for every Claude role, the fake for the reviewer.
const table = { version: 1, roles: {
  writer: { candidates: [{ provider: "claude", model, effort: "low" }] },
  hardWriter: { candidates: [{ provider: "claude", model, effort: "low" }] },
  reviewer: { candidates: [{ provider: "codex", model: "fake-model", effort: "low" }] },
} };
fs.writeFileSync(path.join(home, ".zodchi", "models.json"), JSON.stringify(table, null, 2));

// An allow-listed environment: nothing of the caller's credentials but the one key the writer needs.
const env = { PATH: [bin, ...(process.env.PATH || "").split(path.delimiter)].join(path.delimiter), HOME: home, USERPROFILE: home,
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ZODCHI_HOME: path.join(home, ".zodchi"), ZODCHI_ROLES: roles, ZODCHI_CODEX_BIN: FAKE,
  CODEX_HOME: codex, TEMP: tmp, TMP: tmp, TMPDIR: tmp, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, GIT_TERMINAL_PROMPT: "0" };
for (const name of ["SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "WINDIR", "LANG", "TERM", "PROGRAMFILES", "ProgramFiles", "ProgramData", "LOCALAPPDATA", "APPDATA"]) {
  if (process.env[name] && !env[name]) env[name] = name.match(/APPDATA/) ? path.join(home, name.toLowerCase()) : process.env[name];
}

// 4. The fixture repository and the baseline commit the harness owns.
const fixture = path.join(scratch, "fixture");
const files = {
  ".gitignore": ".agent-tmp/\n",
  "src/math.mjs": "export const add = (a, b) => a + b\n",
  "test/math.test.mjs": "import { add } from '../src/math.mjs'\nif (add(2, 3) !== 5) { console.error('FAIL add'); process.exit(1) }\nconsole.log('ok add')\n",
  "scripts/smoke.mjs": "import * as m from '../src/math.mjs'\nif (typeof m.clamp !== 'function') { console.error('FAIL: no clamp'); process.exit(1) }\nconsole.log('smoke ok', m.clamp(5, 0, 3))\n",
  "REVIEW.md": "# Review focus\n\nFlag:\n- A math helper that mutates its arguments (marker e2e-review-base-7f3a).\n",
};
for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(fixture, f)), { recursive: true }); fs.writeFileSync(path.join(fixture, f), text); }
const git = (...args) => sh("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "-c", "core.autocrlf=false", ...args], { cwd: fixture, env });
git("init", "-q", "-b", "main");
git("config", "user.name", "e2e");
git("config", "user.email", "e2e@localhost");
git("add", "-A");
git("commit", "-q", "-m", "baseline");
const base = git("rev-parse", "HEAD").stdout.trim();
const brief = path.join(scratch, "brief.md");
fs.writeFileSync(brief, [
  "# Brief: clamp",
  "",
  "## Goal",
  "Add `clamp(x, lo, hi)` to `src/math.mjs`: it returns `lo` when `x < lo`, `hi` when `x > hi`, else `x`. Keep `add` as it is.",
  "",
  "## Files",
  "`src/math.mjs`; a new test file under `test/` is welcome. Do not change `test/math.test.mjs`.",
  "",
  "## Done",
  "`clamp` is exported and behaves as above; `node test/math.test.mjs` and `node scripts/smoke.mjs` exit 0.",
  "",
].join("\n"));
const label = "e2e-clamp";
const resultFile = path.join(scratch, "result.json");
const workflowArgs = { label, brief, repo: fixture, files: ["src/math.mjs"], tmp: path.join(scratch, "package"), branch: "e2e-clamp",
  checks: ["node test/math.test.mjs"], verify: ["node scripts/smoke.mjs"], rounds: 1, models: table.roles };
const before = sh("git", ["status", "--porcelain"], { cwd: ROOT }).stdout;
// What the session is given and must not change: compared after it has ended.
const digest = (target) => {
  const h = crypto.createHash("sha256");
  const walk = (p) => {
    if (fs.statSync(p).isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name));
    else h.update(path.relative(target, p) + "\0").update(fs.readFileSync(p));
  };
  try { walk(target); } catch (e) { return `unreadable (${e.code || e.message})`; }
  return h.digest("hex");
};
const inputs = [path.join(plugins, "zodchi-core"), roles, bin, brief];
const inputDigests = inputs.map(digest);

// 5. The session.
const promptText = [
  "Run the workflow `code-package` of the plugin zodchi-core (`zodchi-core:code-package`) with exactly these args:",
  "```json", JSON.stringify(workflowArgs, null, 2), "```",
  "Do not do the package's work yourself and do not change the args. When the workflow returns, write the value it returned,",
  `exactly as returned, as JSON to ${resultFile} and stop. If it throws, write {"error": "<its message>"} there instead.`,
].join("\n");
fs.writeFileSync(path.join(scratch, "session-prompt.md"), promptText);
// The prompt goes on stdin, so no shell quoting touches it.
const claudeArgs = ["-p", "--model", model, "--max-budget-usd", String(maxUsd), "--plugin-dir", path.join(plugins, "zodchi-core"),
  "--output-format", "json", "--permission-mode", "bypassPermissions"];
log(`$ claude ${claudeArgs.join(" ")} < session-prompt.md   (in ${fixture})`);
// npm installs claude as a .cmd script on Windows, which only a shell starts; an argument with a space is quoted for it.
const shellArgs = WIN ? claudeArgs.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : claudeArgs;
const sessionStarted = Date.now();
const session = await new Promise((resolve) => {
  const out = fs.openSync(path.join(scratch, "session.json"), "w");
  const err = fs.openSync(path.join(scratch, "session.err"), "w");
  const child = spawn("claude", shellArgs, { cwd: fixture, env, stdio: ["pipe", out, err], shell: WIN, detached: !WIN, windowsHide: true });
  fs.closeSync(out);
  fs.closeSync(err);
  child.stdin.end(promptText);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (WIN) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
  }, deadlineMin * 60_000);
  child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, timedOut, error: String(e) }); });
  child.on("exit", (code) => { clearTimeout(timer); resolve({ code, timedOut }); });
});
const sessionMs = Date.now() - sessionStarted;
log(`session exit ${session.code}${session.timedOut ? " (killed at the deadline)" : ""}${session.error ? ` (did not start: ${session.error})` : ""} after ${(sessionMs / 60000).toFixed(1)} min`);
let transport = null;
try { transport = JSON.parse(fs.readFileSync(path.join(scratch, "session.json"), "utf8")); } catch { /* not JSON */ }
log(`session transport: ${transport ? JSON.stringify({ is_error: transport.is_error, subtype: transport.subtype, total_cost_usd: transport.total_cost_usd, num_turns: transport.num_turns }) : "no JSON on stdout"}`);
check(!session.timedOut, `the session ended before the deadline of ${deadlineMin} min`);
check(!session.error && session.code === 0, `the session started and exited 0 (exit ${session.code}${session.error ? `, ${session.error}` : ""})`);
check(Boolean(transport) && transport.is_error === false && transport.subtype === "success", `the session's JSON reports success (${transport ? `is_error ${transport.is_error}, subtype ${transport.subtype}` : "no JSON on stdout"})`);
const cost = transport ? transport.total_cost_usd : undefined;
check(typeof cost === "number" && Number.isFinite(cost) && cost > 0 && cost <= maxUsd, `the session has a cost receipt within the cap of ${maxUsd} USD (total_cost_usd ${JSON.stringify(cost)})`);
inputs.forEach((p, i) => check(digest(p) === inputDigests[i], `the session left ${path.basename(p)} as it was given`));

// 6. The workflow result: schema and terminal status, apart from the session's own exit.
let result = null;
try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch (e) { log(`no result: ${e.message}`); }
check(result && !result.error, `the workflow returned a result${result && result.error ? ` (it threw: ${result.error})` : ""}`);
if (result && !result.error) {
  const shape = [
    ["label", (v) => v === label], ["verdict", (v) => ["approved", "changes_requested", "blocked"].includes(v)], ["approved", (v) => typeof v === "boolean"],
    ["openFindings", Array.isArray], ["rounds", Array.isArray], ["verifiedBy", (v) => ["args.verify", "verify skill", "checks", "none"].includes(v)],
    ["verification", (v) => v && typeof v === "object" && Array.isArray(v.evidence) && typeof v.stamp === "string"],
  ];
  for (const [key, ok] of shape) check(ok(result[key]), `result.${key} has the shape of the code-package result (${JSON.stringify(result[key]).slice(0, 200)})`);
  check(result.verdict === "approved" && result.approved === true && !result.stoppedAt, `terminal status: approved, not stopped (stoppedAt ${result.stoppedAt || "-"})`);
  check(result.verifiedBy === "args.verify", `verified by the verify command (${result.verifiedBy})`);
  const ev = (result.verification && result.verification.evidence) || [];
  const at = (cmd) => ev.findIndex((e) => e.command === cmd && e.exitCode === 0);
  check(at("node test/math.test.mjs") >= 0 && at("node scripts/smoke.mjs") > at("node test/math.test.mjs"), "the evidence holds the cheap check, then the verify command, both exit 0");
}

// 7. Commits and the stamp, on the branch the package used.
const tip = git("rev-parse", "e2e-clamp").stdout.trim();
check(tip && tip !== base && git("merge-base", "--is-ancestor", base, tip).status === 0, "the branch has commits on top of the baseline");
const message = git("log", "-1", "--format=%B", tip).stdout.trim();
const stamp = (message.match(/^Verified: .*$/m) || [""])[0];
check(/^Verified: /.test(stamp) && message.endsWith(stamp), `the tip's message ends with its Verified stamp (${stamp || "none"})`);
if (result && result.verification) check(stamp === `Verified: ${result.verification.stamp}` || stamp === result.verification.stamp, "the stamp of the tip is the one the result reports");
check(stamp === "Verified: checks exit 0; args.verify exit 0", "the stamp names the checks and the verify command with their exit codes");
check(!/node |scripts\/|test\//.test(message), "the commit message names no command");
const head = git("rev-parse", "HEAD").stdout.trim();
check(head === tip, `the fixture's HEAD is the branch tip (${head || "none"})`);
const dirty = git("status", "--porcelain", "--untracked-files=no").stdout.trim();
check(dirty === "", `no tracked file of the fixture has an uncommitted change: the stamped commit is the final state${dirty ? ` (${dirty.replace(/\n/g, ", ")})` : ""}`);
check(git("diff", "--quiet", base, tip, "--", "test/math.test.mjs", "scripts/smoke.mjs").status === 0, "the baseline test and the smoke command are unchanged at the tip");

// 8. On the final committed tree: the harness reruns the check and the smoke command, and runs its acceptance check,
// written outside the fixture only now that the session has ended, so the session never saw or reached it.
const final = path.join(scratch, "final");
fs.mkdirSync(final, { recursive: true });
const archive = path.join(scratch, "final.tar");
git("archive", "--format=tar", "-o", archive, tip);
sh("tar", ["-xf", archive, "-C", final]);
for (const command of ["test/math.test.mjs", "scripts/smoke.mjs"]) {
  check(sh(process.execPath, [command], { cwd: final }).status === 0, `node ${command} exits 0 on the committed tree`);
}
const acceptance = path.join(scratch, "acceptance.mjs");
fs.writeFileSync(acceptance, [
  "import { pathToFileURL } from 'node:url'",
  "import path from 'node:path'",
  "const m = await import(pathToFileURL(path.join(process.argv[2], 'src', 'math.mjs')).href)",
  "const cases = [[5, 0, 3, 3], [-2, 0, 3, 0], [2, 0, 3, 2], [0, 0, 3, 0], [3, 0, 3, 3]]",
  "const bad = cases.filter(([x, lo, hi, want]) => m.clamp(x, lo, hi) !== want)",
  "if (m.add(2, 3) !== 5) bad.push('add changed')",
  "if (bad.length) { console.error('acceptance FAIL', JSON.stringify(bad)); process.exit(1) }",
  "console.log('acceptance ok')",
  "",
].join("\n"));
const accepted = sh(process.execPath, [acceptance, final]);
check(accepted.status === 0, "the acceptance check passes on the committed tree");

// 9. The review went through the gateway with the REVIEW.md of the baseline.
const turns = fs.existsSync(path.join(codex, "fake-turns.jsonl")) ? fs.readFileSync(path.join(codex, "fake-turns.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
check(turns.some((x) => x.schema && x.prompt.includes("e2e-review-base-7f3a")), `a review turn reached the fake Codex with the baseline REVIEW.md (${turns.length} turns)`);

// 10. This working tree is untouched.
check(sh("git", ["status", "--porcelain"], { cwd: ROOT }).stdout === before, "nothing changed in this working tree");

const verdict = problems.length ? "FAIL" : "PASS";
console.log(`${verdict} e2e-release: session ${(sessionMs / 60000).toFixed(1)} min${typeof cost === "number" ? `, ${cost} USD` : ", no cost receipt"}${problems.length ? `\n  - ${problems.join("\n  - ")}` : ""}\n     trace ${traceFile}`);
if (!problems.length && !keep) {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* left in the temp folder */ }
}
process.exit(problems.length ? 1 : 0);
