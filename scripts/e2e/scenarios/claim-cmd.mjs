// The claim commands of the gate helper (core/scripts/gate.mjs claim and claim-more): lists of paths are compared and claims are
// written by the helper under the claims lock, never by a model. Run for real against a scratch claims folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

export default function register({ scenario, ROOT }) {
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");

  /** A scratch claims folder (not created: the claim command makes it), removed when the scenario ends. */
  const claimsDir = (t, name) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-claim-${name}-`));
    t.cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    return `${home.replace(/\\/g, "/")}/packages/repo`;
  };
  /** The helper's one line, parsed, with its exit code. */
  const helper = (t, cmd, spec) => {
    const r = spawnSync(process.execPath, [GATE, cmd, JSON.stringify({ api: 1, ...spec })], { encoding: "utf8" });
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
    ok: true, api: 1, plugin: PLUGIN, roles: {}, modelsErrors: [], account: null, accountError: "none", git: true, head: "abc1234", branch: "main", dirty: [], dirtyError: "",
    ignoreExit: 0, ignoreLine: ".gitignore:3:.agent-tmp/\t.agent-tmp/gateway/x", verifySkill: false, reviewMd: false, config: {}, configError: "", boundary: "Important: x.\n",
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
   */
  const realRunner = (t, home, tweak = (s) => s) => (prompt) => {
    const m = prompt.match(/ (claim|claim-more) '(\{.*\})'\n/);
    if (!m) throw new Error(`no claim command in the prompt: ${prompt.slice(0, 300)}`);
    const spec = tweak(JSON.parse(m[2].replace(/'\\''/g, "'")));
    const r = spawnSync(process.execPath, ["-e", BOOT, "--", home, m[1], JSON.stringify(spec)], {
      encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, ZODCHI_PLUGIN_ROOT: path.join(ROOT, "core"), CLAUDE_PLUGIN_ROOT: "" },
    });
    t.log(`runner: gate.mjs ${m[1]} ${JSON.stringify(spec)}: exit ${r.status}\n${r.stdout}${r.stderr}`);
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
    const real = realRunner(t, home);
    const r = await runBody({
      "claim lm-release": real, "claim more write lm-release": real,
      "write lm-release": { done: true, summary: "wrote", changed: ["/r/src/a.js", "/r/release/main.js"], unverified: [] },
      "status write lm-release": { ok: true, paths: status },
    });
    t.eq([r.error, r.out && r.out.approved], [null, true], "the run goes through to approval");
    t.eq(read(dir, "lm-release").files, ["src/a.js", "release/main.js", "release/f01.js", "release/f02.js", "release/f03.js"], "the claim the helper wrote holds the package's own files and none of the others'");
    t.eq(otherClaims(), [25, 15], "the other two claims are untouched");
    const commits = r.of(/^commit /);
    t.eq(commits.length, 1, "one commit step");
    t.eq(commitPaths(commits[0]).sort(), ["release/F03.js", "release/f01.js", "release/f02.js", "release/main.js", "src/a.js"], "the commit step's path list holds only the package's own files");
    t.eq(r.out.claimAdded, ["release/main.js", "release/f01.js", "release/f02.js", "release/F03.js"], "claimAdded is what the helper added");
    const more = r.of(/^claim more /)[0].prompt;
    t.ok(!/compare its "files"|entry by entry|Read every claim/.test(more), "the runner is never asked to compare lists itself");
    t.ok(!fs.existsSync(`${dir}/.lock`), "no lock is left held after the run");
    t.ok(r.of(/^close claim/)[0].prompt.includes(`"${dir}/lm-release.json"`), "the close step names the very file the helper wrote");

    // a file the writer reports, which another open package claims: the helper's conflict stops the run before any commit
    const { home: home2, dir: dir2 } = homeFor(t, "wf-hard");
    claim(t, dir2, "pkg-b", b);
    const real2 = realRunner(t, home2);
    const c = await runBody({
      "claim lm-release": real2, "claim more write lm-release": real2,
      "write lm-release": { done: true, summary: "wrote", changed: ["/r/src/a.js", "/r/pkg-b/f03.js"], unverified: [] },
      "status write lm-release": { ok: true, paths: ["src/a.js", "pkg-b/f03.js"] },
    });
    t.eq([c.out.stoppedAt, c.out.conflicts], ["claim conflict", ["pkg-b: pkg-b/f03.js"]], "the helper's conflict stops the run");
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
      const y = await runBody({
        "claim lm-release": { exitCode: 0, stdout: JSON.stringify({ ok: true, api: 1, plugin: PLUGIN, conflicts: [], branchConflicts: [] }) + "\n" }, "claim more write lm-release": answer,
        "write lm-release": { done: true, summary: "w", changed: ["/r/src/a.js", "/r/src/n.js"], unverified: [] }, "status write lm-release": { ok: true, paths: ["src/a.js", "src/n.js"] },
      });
      t.ok(/^claim more \(the claim-more helper/.test(String(y.out.stoppedAt)) && y.of(/^commit /).length === 0, `${what}: the run stops at the extension, nothing committed (${y.out.stoppedAt})`);
    }

    // args.branch outside the shared-branch mode: the switch is a runner step of its own, after the helper wrote the claim
    const { home: home5 } = homeFor(t, "wf-switch");
    const s = await runBody({ "claim lm-release": realRunner(t, home5), "switch lm-release": { ok: false, summary: "branch is checked out elsewhere" } }, { ...ARGS, branch: "feat" });
    t.eq(s.out.stoppedAt, "switch to feat (branch is checked out elsewhere)", "a failed switch stops the run");
    t.ok(s.of(/^switch /)[0].prompt.includes("git switch 'feat'") && !s.of(/^claim lm-release$/)[0].prompt.includes("git switch"), "the switch is not in the claim step");
    t.eq(s.of(/^close claim/).length, 1, "and the claim it wrote is closed");
  });
}
