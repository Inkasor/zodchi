// code-package fixes 20-23: a resumed run reopens its claim; the gateway keys belong to the run; the workflow must be the one of the plugin copy
// it talks to; a package that goes on reviews base..HEAD from its recorded base; the writer is told where its logs go.
//
// Two layers, as in claim-cmd.mjs and code-package.mjs: the gate helper (core/scripts/gate.mjs) run for real against a scratch home and scratch Git
// repositories, and the workflow (core/workflows/code-package.js) run the way Claude Code runs it, with scripted answers (and, where the claim
// matters, the real helper answering the claim steps).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { commandsIn, encodeSpec, specIn, seenIn } from "../spec-arg.mjs";

export default function register({ scenario, ROOT, scratch: suiteScratch }) {
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");
  const WF = path.join(ROOT, "core", "workflows", "code-package.js");
  const SRC = fs.readFileSync(WF, "utf8");
  const BOOT = vm.runInNewContext(SRC.match(/^const GATE_BOOT = (.*)$/m)[1]);
  const BUILD = SRC.match(/^const WORKFLOW_BUILD = '([0-9a-f]*)'/m)[1];
  const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };

  // Under the suite's own scratch folder (scripts/e2e.mjs removes it at the end, also after a failure unless --keep): nothing is made in the system temp folder.
  const scratch = (t, name) => {
    const dir = fs.mkdtempSync(path.join(suiteScratch, `f2023-${name}-`)).replace(/\\/g, "/");
    t.cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const gate = (t, cmd, spec, home) => {
    const r = spawnSync(process.execPath, [GATE, cmd, JSON.stringify({ api: 1, ...spec })], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
    t.log(`gate.mjs ${cmd}: exit ${r.status}\n${r.stdout}${r.stderr}`);
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* the caller's assertion fails on null */ }
    return { code: r.status, json };
  };
  const claimSpec = (dir, label, files, extra = {}) => ({ dir, label, files, branch: "main", brief: `/r/${label}.md`, tmp: `/r/.agent-tmp/${label}`, base: "abc1234", ...extra });
  const readClaim = (dir, label) => JSON.parse(fs.readFileSync(`${dir}/${label}.json`, "utf8"));
  /** What the workflow's close step writes: the status and the time, the other fields kept. */
  const closeClaim = (dir, label, status) => {
    const c = readClaim(dir, label);
    fs.writeFileSync(`${dir}/${label}.json`, JSON.stringify({ ...c, status, closedAt: "2026-11-20T10:00:00Z" }) + "\n");
  };

  // ------------------------------------------------------------------------------------------------------------- item 20: the claim of a stopped run

  scenario("fixes-claim-reopened-after-stop", "a claim the stopped run closed 'stopped' is opened again by claim-more and by claim (same tmp), keeps its base and start record, and is never opened over another open claim's files; a claim closed 'done' or of another tmp is a new claim", async (t) => {
    const home = scratch(t, "reopen"), dir = `${home}/.zodchi/packages/r`, TMP = "/r/.agent-tmp/another";
    const repo = `${home}/repo`;
    fs.mkdirSync(repo);
    spawnSync("git", ["-C", repo, "init", "-q"]);
    fs.writeFileSync(`${repo}/before.txt`, "before the package\n");
    const first = gate(t, "claim", claimSpec(dir, "pkg", ["src/a.js"], { repo, base: "1111111" }), home).json;
    t.eq([first.ok, first.reused, first.base], [true, false, "1111111"], "the first run writes the claim and answers with its base");
    t.eq(readClaim(dir, "pkg").atGate, ["before.txt"], "it recorded what Git listed at the start");

    // the run stopped (a protected check changed, say) and closed its claim "stopped"; its round-1 work is in the checkout
    closeClaim(dir, "pkg", "stopped");
    fs.writeFileSync(`${repo}/src-new.js`, "work of the earlier run\n");
    // the resumed run takes its claim step from the journal, so the first helper call is claim-more
    const more = gate(t, "claim-more", { dir, label: "pkg", repo }, home).json;
    t.eq([more.ok, more.reopened, more.changed, more.added], [true, true, ["src-new.js"], ["src-new.js"]], "claim-more opens the stopped claim again and adds the work");
    const reopened = readClaim(dir, "pkg");
    t.eq([reopened.status, reopened.base, reopened.atGate, "closedAt" in reopened, typeof reopened.reopenedAt], ["open", "1111111", ["before.txt"], false, "string"], "open again, its base and start record kept, the close time gone");
    t.eq(reopened.files, ["src/a.js", "src-new.js"], "and its files grew by the work");

    // a stopped claim and another package that took one of its files meanwhile: not opened, and the answer names the clash
    closeClaim(dir, "pkg", "stopped");
    gate(t, "claim", claimSpec(dir, "rival", ["src-new.js"]), home);
    const clash = gate(t, "claim-more", { dir, label: "pkg", repo }, home).json;
    t.ok(clash.ok === false && clash.conflicts.join() === "rival: src-new.js", `a clash with another open claim is reported (${JSON.stringify(clash.conflicts)})`);
    t.eq(readClaim(dir, "pkg").status, "stopped", "and the claim stays closed");
    closeClaim(dir, "rival", "closed");

    // the claim command of a new run with the same tmp folder: the same claim, opened again, its base is the original one
    const again = gate(t, "claim", claimSpec(dir, "pkg", ["src/a.js"], { repo, base: "2222222" }), home).json;
    t.eq([again.ok, again.reused, again.reopened, again.base], [true, true, true, "1111111"], "claim reopens it and answers with the recorded base, not the new HEAD");
    t.eq(readClaim(dir, "pkg").status, "open", "open on disk");

    // a package that finished ("done") is no continuation: the same label starts a new claim at its new base
    closeClaim(dir, "pkg", "done");
    const fresh = gate(t, "claim", claimSpec(dir, "pkg", ["src/a.js"], { repo, base: "3333333" }), home).json;
    t.eq([fresh.ok, fresh.reused, fresh.reopened, fresh.base], [true, false, undefined, "3333333"], "a claim closed done is replaced by a new one");
    closeClaim(dir, "pkg", "stopped");
    const other = gate(t, "claim", claimSpec(dir, "pkg", ["src/a.js"], { repo, base: "4444444", tmp: "/r/.agent-tmp/another" }), home).json;
    t.eq([other.ok, other.reused, other.base], [true, false, "4444444"], "a stopped claim of another tmp folder is not this run's: a new claim");
    // claim-base records the base a package really starts from
    const cb = gate(t, "claim-base", { dir, label: "pkg", base: "5555555", tmp: TMP }, home).json;
    t.eq([cb.ok, readClaim(dir, "pkg").base], [true, "5555555"], "claim-base sets the base of the open claim");
    closeClaim(dir, "pkg", "done");
    t.eq([gate(t, "claim-base", { dir, label: "pkg", base: "6666666", tmp: TMP }, home).json.ok, readClaim(dir, "pkg").base], [false, "5555555"], "and changes nothing of a claim closed done");
    // a claim closed 'stopped' (the run stopped at claim-base itself) is opened again by claim-base, under the rule claim-more uses
    closeClaim(dir, "pkg", "stopped");
    const re = gate(t, "claim-base", { dir, label: "pkg", base: "7777777", tmp: TMP }, home).json;
    t.eq([re.ok, re.reopened, readClaim(dir, "pkg").status, readClaim(dir, "pkg").base, "closedAt" in readClaim(dir, "pkg")], [true, true, "open", "7777777", false], "claim-base opens a stopped claim of the label again and records the base");
    closeClaim(dir, "pkg", "stopped");
    gate(t, "claim", claimSpec(dir, "rival", readClaim(dir, "pkg").files), home);
    const no = gate(t, "claim-base", { dir, label: "pkg", base: "8888888", tmp: TMP }, home).json;
    t.ok(no.ok === false && no.conflicts.length === 1 && no.conflicts[0].startsWith("rival: "), `but not over another open claim's files (${JSON.stringify(no.conflicts)})`);
    t.eq([readClaim(dir, "pkg").status, readClaim(dir, "pkg").base], ["stopped", "7777777"], "the claim stays closed and keeps its base");
    // a claim closed 'stopped' by a run of another tmp folder (a newer run of the same label) is not this run's: claim-base leaves it closed with its base
    fs.rmSync(`${dir}/rival.json`);
    const wrong = gate(t, "claim-base", { dir, label: "pkg", base: "9999999", tmp: "/r/.agent-tmp/older-run" }, home).json;
    t.ok(wrong.ok === false && /no open claim/.test(String(wrong.error)), `a stopped claim of another tmp folder is not opened by claim-base (${wrong.error})`);
    t.eq([readClaim(dir, "pkg").status, readClaim(dir, "pkg").base, readClaim(dir, "pkg").tmp], ["stopped", "7777777", TMP], "it stays closed with its base and tmp folder unchanged");
    t.ok(gate(t, "claim-base", { dir, label: "pkg", base: "9999999" }, home).code === 2, "claim-base without a tmp folder is refused");
  });

  // ---------------------------------------------------------------------------------------- the workflow, run as Claude Code runs it

  const gateFacts = (over = {}) => ({
    ok: true, api: 1, plugin: PLUGIN, workflow: { name: "code-package", build: BUILD, copyBuild: BUILD, match: true },
    roles: {}, modelsErrors: [], account: { connected: true, ordinaryUsageAllowed: true, primary: { usedPercent: 1 }, secondary: { usedPercent: 1 } }, accountError: "",
    git: true, head: "abc1234", branch: "main", dirty: [], ignoreExit: 0, ignoreLine: ".gitignore:1:.agent-tmp/\t.agent-tmp/gateway/x", verifySkill: false, reviewMd: false, runId: "a1b2c3d4",
    config: {}, configError: "", boundary: "Important: x.", claims: { dir: "d", open: [], closed: [], kept: [], skipped: [], notes: [] }, ...over,
  });
  const line = (facts) => ({ exitCode: 0, stdout: JSON.stringify({ api: 1, plugin: PLUGIN, ...facts }) + "\n" });
  const CODEX = { provider: "codex", model: "gpt-x", effort: "medium" };

  /** Runs the workflow once. `answers[label]` (a value or a function of the prompt and the calls so far) replaces a default answer. */
  async function run(answers = {}, argsOver = {}, o = {}) {
    const calls = [];
    const args = {
      label: "pkg", brief: "/r/brief.md", repo: "/r", files: ["src/a.js"], tmp: "/r/.agent-tmp/pkg", checks: ["node t.js"],
      models: { writer: { candidates: [{ provider: "claude", model: "sonnet" }] }, reviewer: { candidates: [CODEX] } }, ...argsOver,
    };
    const answer = (rawLabel, prompt) => {
      // a long label in args.label: its steps are answered as those of "pkg"
      const label = args.label === "pkg" ? rawLabel : rawLabel.split(args.label).join("pkg");
      const given = answers[label];
      if (given !== undefined) return typeof given === "function" ? given(prompt, calls) : given;
      if (label === "gate pkg") return line(gateFacts(o.gate));
      if (label === "claim pkg") return line({ ok: true, conflicts: [], branchConflicts: [], reused: false, files: ["src/a.js"], file: `/h/.zodchi/packages/-r/${args.label}.json`, base: "abc1234" });
      if (label === "write pkg") return { done: true, summary: "wrote", changed: ["/r/src/a.js"], unverified: [] };
      if (label === "base pkg") return { ok: true, head: "abc1234", branch: "main", verifySkill: false, reviewMd: false };
      if (label.startsWith("status ")) return { ok: true, paths: ["src/a.js"] };
      if (label.startsWith("checks ")) return { ok: true, results: ["ok"], cause: "none", logs: [], evidence: [{ command: "node t.js", exitCode: 0, log: "l" }] };
      if (label.startsWith("commit ")) return { ok: true, summary: "deadbeef", paths: ["src/a.js"] };
      if (label.startsWith("review ")) return { verdict: "approved", summary: "s", findings: [], gateway: "final", infra: "" };
      if (label.startsWith("claim more")) return line({ ok: true, conflicts: [], others: [], owners: [], changed: ["src/a.js"], added: [] });
      if (label.startsWith("claim base")) return line({ ok: true, conflicts: [], base: "x" });
      if (label.startsWith("close claim")) return { ok: true, summary: "closed" };
      throw new Error(`no scripted answer for the step "${label}"`);
    };
    const sandbox = { args, phase: () => {}, log: () => {}, agent: async (prompt, opts) => { calls.push({ label: opts.label, prompt, opts }); return answer(opts.label, prompt); } };
    const fn = vm.runInNewContext(`(async () => {\n${SRC.replace(/^export const meta/, "const meta")}\n})`, sandbox, { filename: "code-package.js" });
    let out = null, error = null;
    try { out = await fn(); } catch (e) { error = e; }
    return { out, error, calls, of: (re) => calls.filter((c) => re.test(c.label)) };
  }
  const baseKey = (r, n = 1) => (r.of(new RegExp(`^review ${n}$`))[0].prompt.match(/Gateway call, base key (\S+?)\./) || [])[1];

  scenario("fixes-resumed-run-reopens-claim", "a resumed run takes its claim step from the journal while the stopped run closed the claim: the next helper call reopens it, the run goes on and no longer stops with 'has no open claim'", async (t) => {
    const home = scratch(t, "resume"), dir = `${home}/.zodchi/packages/-r`;
    const repo = `${home}/repo`;
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q"]);
    const real = (prompt) => {
      const m = commandsIn(prompt, "claim|claim-more|claim-base")[0];
      const spec = { ...m.spec, ...(m.spec.repo === "/r" ? { repo } : {}) };
      const r = spawnSync(process.execPath, ["-e", BOOT, "--", home, m.command, encodeSpec(spec)], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, ZODCHI_PLUGIN_ROOT: path.join(ROOT, "core"), CLAUDE_PLUGIN_ROOT: "" } });
      t.log(`runner: gate.mjs ${m.command}: exit ${r.status}\n${r.stdout}${r.stderr}`);
      return { exitCode: r.status, stdout: r.stdout, error: (r.stderr || "").slice(0, 300) };
    };
    // the first run: its claim step is real, then the run stops with the claim closed "stopped" (the writer's round is in the checkout)
    fs.mkdirSync(`${repo}/src`, { recursive: true });
    fs.writeFileSync(`${repo}/src/a.js`, "round 1\n");
    const stopped = await run({ "claim pkg": real, "claim more write pkg": real, "write pkg": { done: false, summary: "stop", changed: ["/r/src/a.js"], unverified: [] } });
    t.eq(stopped.out.stoppedAt, "write", "the first run stops after the writer");
    closeClaim(dir, "pkg", "stopped");
    const journaled = line({ ok: true, conflicts: [], branchConflicts: [], reused: false, files: ["src/a.js"], file: `${dir}/pkg.json`, base: "abc1234" });
    // the resume: the claim step comes back from the journal (the old answer, the helper is not called), the first live helper call is claim-more
    fs.writeFileSync(`${repo}/src/b.js`, "round 2\n");
    const resumed = await run({
      "claim pkg": journaled, "claim more write pkg": real,
      "write pkg": { done: true, summary: "wrote", changed: ["/r/src/a.js", "/r/src/b.js"], unverified: [] }, "status write pkg": { ok: true, paths: ["src/a.js", "src/b.js"] },
    });
    t.eq([resumed.error, resumed.out && resumed.out.stoppedAt, resumed.out && resumed.out.approved], [null, undefined, true], "the resumed run goes on to approval (before: 'has no open claim')");
    t.eq([readClaim(dir, "pkg").status, readClaim(dir, "pkg").files.includes("src/b.js")], ["open", true], "its claim is open again and holds the new file");
  });

  scenario("fixes-resume-stopped-at-claim-base", "a run that stops at claim-base (after a switch to args.branch) and whose claim is closed 'stopped' for real resumes with its earlier claim answer replayed: claim-base opens the claim again and the run goes on", async (t) => {
    const home = scratch(t, "claimbase"), dir = `${home}/.zodchi/packages/-r`;
    const repo = `${home}/repo`;
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q"]);
    const real = (prompt) => {
      const m = commandsIn(prompt, "claim|claim-more|claim-base")[0];
      const spec = { ...m.spec, ...(m.spec.repo === "/r" ? { repo } : {}) };
      const r = spawnSync(process.execPath, ["-e", BOOT, "--", home, m.command, encodeSpec(spec)], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, ZODCHI_PLUGIN_ROOT: path.join(ROOT, "core"), CLAUDE_PLUGIN_ROOT: "" } });
      t.log(`runner: gate.mjs ${m.command}: exit ${r.status}\n${r.stdout}${r.stderr}`);
      return { exitCode: r.status, stdout: r.stdout, error: (r.stderr || "").slice(0, 300) };
    };
    const onBranch = { "switch pkg": { ok: true, summary: "ok" }, "base pkg": { ok: true, head: "ccccccc", branch: "feat", verifySkill: false, reviewMd: false } };
    // the first run: the claim is written for real, the claim-base step is refused (another package holds a file: a real answer, not a transient failure), the workflow stops and closes the claim 'stopped'
    const first = await run({ ...onBranch, "claim pkg": real, "claim base pkg": line({ ok: false, conflicts: ["rival: src/a.js"], error: "" }) }, { branch: "feat" });
    t.ok(/^claim base/.test(String(first.out && first.out.stoppedAt)), `the first run stops at claim-base (${first.out && first.out.stoppedAt})`);
    t.eq([readClaim(dir, "pkg").status, readClaim(dir, "pkg").base], ["open", "abc1234"], "the claim was written at the base the gate saw");
    closeClaim(dir, "pkg", "stopped");
    // the resume: the claim step comes back from the journal (its old answer), claim-base is the first live helper call
    const journaled = line({ ok: true, conflicts: [], branchConflicts: [], reused: false, files: ["src/a.js"], file: `${dir}/pkg.json`, base: "abc1234" });
    const resumed = await run({ ...onBranch, "claim pkg": journaled, "claim base pkg": real, "claim more write pkg": real }, { branch: "feat" });
    t.eq([resumed.error, resumed.out && resumed.out.stoppedAt, resumed.out && resumed.out.approved], [null, undefined, true], "the resumed run goes on to approval (before: 'has no open claim')");
    t.eq([readClaim(dir, "pkg").status, readClaim(dir, "pkg").base], ["open", "ccccccc"], "its claim is open again and records the base of the branch");
  });

  scenario("fixes-continuation-needs-path-list", "a continuation that adopts a recorded base needs the base step's path list as an array: a missing or non-array list stops the run before the writer (infrastructure failure, with the reason), a valid empty array still means no earlier files", async (t) => {
    const ORIGINAL = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", HEAD = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const claimed = line({ ok: true, conflicts: [], branchConflicts: [], reused: true, reopened: true, files: ["src/a.js", "src/old.js"], file: "/h/.zodchi/packages/-r/pkg.json", base: ORIGINAL });
    const go = (basePkg) => run({ "claim pkg": claimed, "base pkg": { ok: true, head: HEAD, branch: "main", verifySkill: false, reviewMd: false, ancestor: true, ...basePkg } }, { models: { writer: { candidates: [{ provider: "claude", model: "sonnet" }] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } }, { gate: { head: HEAD } });
    for (const [what, given] of [["missing", {}], ["not an array", { paths: "src/old.js" }], ["null", { paths: null }]]) {
      const r = await go(given);
      const msg = String(r.error && r.error.message);
      t.ok(r.error && /Infrastructure failure at step "base pkg"/.test(msg) && /"paths"/.test(msg) && msg.includes(ORIGINAL), `a ${what} list is an infrastructure failure at the base step that says so (${msg.slice(0, 200)})`);
      t.eq([r.of(/^write pkg$/).length, r.of(/^review /).length, r.of(/^commit /).length], [0, 0, 0], `a ${what} list: nothing is written, reviewed or committed`);
    }
    const empty = await go({ paths: [] });
    t.eq([String(empty.error), empty.out && empty.out.approved], ["null", true], "an empty array is valid: the run goes on");
    t.ok(!JSON.parse(empty.of(/^review 1$/)[0].prompt.match(/for these paths: (\[.*?\])\./)[1]).includes("src/old.js"), "and the earlier files are none");
    // a fresh run (no recorded base) never needs the list
    const fresh = await run({ "base pkg": { ok: true, head: "ccccccc", branch: "feat", verifySkill: false, reviewMd: false }, "switch pkg": { ok: true, summary: "ok" } }, { branch: "feat" });
    t.eq(fresh.out && fresh.out.approved, true, "a run that adopts no base needs no list");
  });

  scenario("fixes-mismatched-run-closes-no-claim", "a run refused as mismatched (another workflow build than the plugin copy's) closes no other package's stale claim; the same gate call with the matching build still closes it", async (t) => {
    const home = scratch(t, "mismatch"), repo = `${home}/repo`;
    fs.mkdirSync(repo);
    const git = (...a) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    fs.writeFileSync(`${repo}/f1.txt`, "base\n");
    fs.writeFileSync(`${repo}/.gitignore`, ".agent-tmp/\n");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").stdout.trim();
    fs.writeFileSync(`${repo}/f1.txt`, "done work\n");
    git("commit", "-q", "-a", "-m", "done: round 1");
    const dir = `${home}/.zodchi/packages/k`;
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 10 * 3600 * 1000);
    fs.writeFileSync(`${dir}/done.json`, JSON.stringify({ label: "done", status: "open", files: ["f1.txt"], branch: "main", base }));
    fs.utimesSync(`${dir}/done.json`, old, old);
    const brief = `${home}/brief.md`;
    fs.writeFileSync(brief, "## Review boundary\nx\n");
    const ask = (build) => gate(t, "code-package", { repo, brief, label: "mine", claimsKey: "k", want: [], workflow: { name: "code-package", build } }, home).json;
    const bad = ask("0123456789abcdef");
    t.eq([bad.workflow.match, bad.claims.closed, bad.claims.open.map((c) => c.label)], [false, [], ["done"]], "a mismatched run closes nothing and the claim is still listed open");
    t.ok(bad.claims.notes.some((n) => /not examined for closing/.test(n) && /refused/.test(n)), `and the answer says why (${JSON.stringify(bad.claims.notes)})`);
    t.eq(readClaim(dir, "done").status, "open", "the claim file is untouched");
    const good = ask(BUILD);
    t.eq([good.workflow.match, good.claims.closed.map((c) => c.label)], [true, ["done"]], "with the matching build the same stale claim is closed");
    t.eq(readClaim(dir, "done").status, "closed", "on disk too");
  });

  scenario("fixes-gateway-keys-per-run", "the gateway keys carry the package base commit and an id of the run the helper allocates: two runs of one label never share a key, not even at one base and HEAD; a resume of one run builds the same keys", async (t) => {
    const home = scratch(t, "runid"), repo = `${home}/repo`;
    fs.mkdirSync(repo);
    spawnSync("git", ["-C", repo, "init", "-q"]);
    fs.writeFileSync(`${home}/brief.md`, "# b\n");
    const ask = () => gate(t, "code-package", { repo, brief: `${home}/brief.md`, label: "mine", claimsKey: "k", want: [] }, home).json;
    const g1 = ask(), g2 = ask();
    t.ok(/^[0-9a-f]{8}$/.test(g1.runId) && /^[0-9a-f]{8}$/.test(g2.runId) && g1.runId !== g2.runId, `the helper allocates an id for each gate call, so for each run (${g1.runId}, ${g2.runId})`);

    const a = await run();
    t.eq(baseKey(a), "pkg-abc1234-a1b2c3d4-review-1", "the review key is <label>-<base7>-<run>-<kind>-<n>");
    t.eq(baseKey(await run()), baseKey(a), "the same run again (a resume: the gate answer, with its run id, comes back from the journal) gets the same key");
    const second = await run({}, {}, { gate: { runId: "b2c3d4e5" } });
    t.eq(baseKey(second), "pkg-abc1234-b2c3d4e5-review-1", "a new run of the label at the same base and HEAD has another key");
    const moved = await run({}, {}, { gate: { head: "def5678", runId: "c3d4e5f6" } });
    t.eq(baseKey(moved), "pkg-def5678-c3d4e5f6-review-1", "and so has one at another commit");
    // a run that goes on: its claim is reused with the recorded base, HEAD has moved on
    const cont = await run({
      "claim pkg": line({ ok: true, conflicts: [], branchConflicts: [], reused: true, reopened: true, files: ["src/a.js"], file: "/h/.zodchi/packages/-r/pkg.json", base: "abc1234" }),
      "base pkg": { ok: true, head: "def5678", branch: "main", verifySkill: false, reviewMd: false, ancestor: true, paths: ["src/a.js"] },
    }, {}, { gate: { head: "def5678", runId: "d4e5f6a7" } });
    t.eq(baseKey(cont), "pkg-abc1234-d4e5f6a7-review-1", "a run that goes on from the recorded base carries that base and its own run id");
    t.ok(new Set([baseKey(a), baseKey(second), baseKey(moved), baseKey(cont)]).size === 4, "all four differ");
    const none = await run({}, {}, { gate: { runId: undefined } });
    t.ok(none.calls.length === 1 && /no run id/.test(String(none.out.stoppedAt)), `a gate answer without a run id stops the run before any claim (${none.out && none.out.stoppedAt})`);
    // the writer's and the expert's keys follow the same rule
    const work = await run({ "write pkg": { done: true, summary: "w", changed: ["/r/src/a.js"], unverified: [], gateway: "final", infra: "" } }, { models: { writer: { candidates: [CODEX] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } });
    t.ok(/base key pkg-abc1234-a1b2c3d4-work-1\./.test(work.of(/^write pkg$/)[0].prompt), "the Codex writer's key");
    const expert = await run({
      "write pkg ask": { ok: true, summary: "a", paths: ["/r/.agent-tmp/pkg/expert-1.answer.md"], gateway: "final", infra: "" },
      "write pkg apply": { done: true, summary: "w", changed: ["/r/src/a.js"], unverified: [] },
    }, { mode: "expert", models: { expertWriter: { candidates: [CODEX] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } }, { gate: { roles: { expertWriter: { candidates: [CODEX] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } } });
    t.ok(/base key pkg-abc1234-a1b2c3d4-expert-1\./.test((expert.of(/^write pkg ask$/)[0] || { prompt: "" }).prompt), `the expert's key (${expert.error})`);
    // a rerun after an infrastructure failure keeps its own suffix on top of that
    const rr = await run({}, { rerun: { "review 1": 2 } });
    t.eq(baseKey(rr), "pkg-abc1234-a1b2c3d4-review-1-a2", "the attempt suffix follows the run part");
  });

  scenario("fixes-workflow-equals-its-copy", "the workflow sends its build to the helper, which stamps the code-package.js of its own copy; a different build or a copy that reports none refuses the run at the gate, naming both and what to do; the same build passes", async (t) => {
    // the helper, for real
    const home = scratch(t, "build"), repo = `${home}/repo`;
    fs.mkdirSync(repo);
    spawnSync("git", ["-C", repo, "init", "-q"]);
    const brief = `${home}/brief.md`;
    fs.writeFileSync(brief, "# b\n");
    const ask = (workflow) => gate(t, "code-package", { repo, brief, label: "mine", claimsKey: "k", want: [], ...(workflow ? { workflow } : {}) }, home).json;
    const same = ask({ name: "code-package", build: BUILD });
    t.eq([same.workflow.match, same.workflow.copyBuild, same.workflow.build], [true, BUILD, BUILD], "the build of this workflow is the build of the copy's file: it passes");
    const diff = ask({ name: "code-package", build: "0123456789abcdef" });
    t.eq([diff.workflow.match, diff.workflow.copyBuild, diff.workflow.build], [false, BUILD, "0123456789abcdef"], "another build does not match, and both are in the answer");
    t.eq(ask({ name: "no-such-workflow", build: BUILD }).workflow.match, false, "a workflow the copy does not have does not match");
    t.eq(ask(undefined).workflow, null, "an older workflow that sends none gets none");
    // the stamp in the file is current, line ends do not change it, the stamp does not depend on itself
    const cli = (file, ...more) => JSON.parse(spawnSync(process.execPath, [GATE, "workflow-build", file, ...more], { encoding: "utf8" }).stdout);
    t.eq(cli(WF).current, true, "core/workflows/code-package.js carries its current build (after an edit: node core/scripts/gate.mjs workflow-build core/workflows/code-package.js --write)");
    const crlf = `${home}/crlf.js`;
    fs.writeFileSync(crlf, SRC.replace(/\n/g, "\r\n"));
    t.eq(cli(crlf).build, BUILD, "line ends do not change the build");
    fs.writeFileSync(`${home}/edited.js`, SRC + "// edited\n");
    const edited = cli(`${home}/edited.js`);
    t.ok(edited.build !== BUILD && edited.current === false, "an edit changes it and the stamp in the file is then not current");
    cli(`${home}/edited.js`, "--write");
    t.eq([cli(`${home}/edited.js`).current, fs.readFileSync(`${home}/edited.js`, "utf8").includes(`'${edited.build}'`)], [true, true], "--write brings the line up to date");

    // the workflow
    const ok = await run();
    t.eq([ok.out.approved, ok.out.workflow], [true, { build: BUILD, copyBuild: BUILD, copyCommit: "c0ffee" }], "equal builds: the run goes on and the result names both stamps");
    const gateSpec = specIn(ok.calls[0].prompt, "code-package");
    t.eq(gateSpec.workflow, { name: "code-package", build: BUILD }, "the gate command carries the workflow's name and build");
    const other = await run({}, {}, { gate: { workflow: { name: "code-package", build: BUILD, copyBuild: "feedfacefeedface", match: false } } });
    t.eq(other.calls.length, 1, "a mismatch stops at the gate: nothing was claimed");
    const msg = String(other.out.refused);
    t.ok(msg.includes(BUILD) && msg.includes("feedfacefeedface") && msg.includes("c0ffee") && msg.includes("/plugin/core") && msg.includes("git show main:core/workflows/code-package.js") && msg.includes("installer"), `the refusal names both builds, the copy's commit and what to do (${msg})`);
    t.eq(other.out.next, other.out.refused, "next says it too");
    const old = await run({}, {}, { gate: { workflow: undefined } });
    t.ok(old.calls.length === 1 && /reports no workflow build: it is older/.test(String(old.out.refused)), `a copy that reports no build is refused too (${old.out.refused})`);
  });

  scenario("fixes-continuation-reviews-whole-package", "a package that goes on keeps the base its claim recorded and reviews base..HEAD with every file of the package; a base that is no longer on the branch stops the run and leaves the claim as it was; a rename lists both paths; a base read after a switch is recorded in the claim", async (t) => {
    const ORIGINAL = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", HEAD = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const claimed = line({ ok: true, conflicts: [], branchConflicts: [], reused: true, reopened: true, files: ["src/a.js", "src/old.js"], file: "/h/.zodchi/packages/-r/pkg.json", base: ORIGINAL });
    const answers = (over = {}) => ({
      "claim pkg": claimed,
      "base pkg": { ok: true, head: HEAD, branch: "main", verifySkill: false, reviewMd: true, ancestor: true, paths: ["src/a.js", "SRC/Old.js", "src/foreign.js", ".agent-tmp/pkg/x"] },
      ...over,
    });
    const r = await run(answers(), { models: { writer: { candidates: [{ provider: "claude", model: "sonnet" }] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } }, { gate: { head: HEAD } });
    t.eq([String(r.error), r.out && r.out.approved], ["null", true], "the continuation runs to approval");
    const baseStep = r.of(/^base pkg$/)[0].prompt;
    t.ok(baseStep.includes(`git merge-base --is-ancestor ${ORIGINAL} HEAD`) && baseStep.includes(`git cat-file -e ${ORIGINAL}:REVIEW.md`) && baseStep.includes(`diff --name-only --no-renames ${ORIGINAL} HEAD`), "the base step reads the recorded base: ancestry, REVIEW.md and the files since it");
    const review = r.of(/^review 1$/)[0].prompt;
    t.ok(review.includes(`git diff ${ORIGINAL} -- `) && !review.includes(`git diff ${HEAD} -- `), "the review diffs from the recorded base, not from HEAD (the earlier rounds' commits are in it)");
    t.ok(review.includes(`git show ${ORIGINAL}:REVIEW.md`), "and reads REVIEW.md as of that base");
    const paths = JSON.parse(review.match(/for these paths: (\[.*?\])\./)[1]);
    t.eq(paths.sort(), ["SRC/Old.js", "src/a.js"], "the paths hold the files of the earlier rounds the claim lists, in Git's spelling, not another package's file or the job folder");
    t.eq(JSON.parse(r.of(/^commit 1$/)[0].prompt.match(/The package paths, relative to the repository: (\[.*?\])\./)[1]).sort(), ["SRC/Old.js", "src/a.js"], "the commit step carries them too");
    t.ok(r.of(/claim base/).length === 0, "the claim already records that base: no claim-base step");
    t.ok((r.out.notes || []).some((n) => n.includes("opened again") && n.includes(ORIGINAL)), "a note says the claim was opened again");

    // the recorded base is not on the branch (rebased, reset): no fallback to HEAD, the run stops before the writer and the claim keeps its base
    const gone = await run(answers({ "base pkg": { ok: true, head: HEAD, branch: "main", verifySkill: false, reviewMd: false, ancestor: false, paths: [] } }), { models: { writer: { candidates: [{ provider: "claude", model: "sonnet" }] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } }, { gate: { head: HEAD } });
    t.ok(/^base \(/.test(String(gone.out.stoppedAt)) && String(gone.out.stoppedAt).includes(ORIGINAL), `a base that is not an ancestor stops the run (${gone.out.stoppedAt})`);
    t.ok(String(gone.out.next).includes(ORIGINAL) && String(gone.out.next).includes("/h/.zodchi/packages/-r/pkg.json") && /ancestor/.test(String(gone.out.next)), "and says which base, which claim file to fix, and why");
    t.eq([gone.of(/^write pkg$/).length, gone.of(/^review /).length, gone.of(/claim base/).length], [0, 0, 0], "no writer, no review and no claim-base step: the claim base is not overwritten with HEAD");
    t.eq(gone.of(/^close claim/).length, 1, "the claim is closed stopped, as for any stop");

    // a rename: the continuation's path list is read with --no-renames, so both the old and the new path are there (Git itself, on the command the workflow sends)
    const cmd = (baseStep.match(/`(git -c core\.quotepath=off diff [^`]*)`/) || [])[1];
    t.ok(cmd && cmd.includes("--no-renames"), `the command that lists the earlier rounds' files carries --no-renames (${cmd})`);
    const home = scratch(t, "rename"), repo = `${home}/repo`;
    fs.mkdirSync(repo);
    const git = (...a) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    git("init", "-q");
    fs.writeFileSync(`${repo}/old.js`, "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n");
    git("add", "."); git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD").stdout.trim();
    git("mv", "old.js", "new.js"); git("commit", "-q", "-m", "round 1: a rename");
    const listed = spawnSync("git", ["-C", repo, ...cmd.replace(/^git /, "").replace(ORIGINAL, baseSha).split(" ")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
    t.eq(listed, ["new.js", "old.js"], "Git lists both sides of the rename");
    const noFlag = spawnSync("git", ["-C", repo, "diff", "--name-only", baseSha, "HEAD"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    t.eq(noFlag, ["new.js"], "(without the flag only the destination is listed: what the review found)");

    // a fresh run on args.branch: the base read after the switch is not the HEAD the gate saw, so it is written into the claim
    const fresh = await run({ "switch pkg": { ok: true, summary: "ok" }, "base pkg": { ok: true, head: "ccccccc", branch: "feat", verifySkill: false, reviewMd: false } }, { branch: "feat" });
    const cb = fresh.of(/^claim base pkg$/);
    t.eq(cb.length, 1, "a base that differs from the one the claim was written with is recorded");
    t.eq(specIn(cb[0].prompt, "claim-base"), { api: 1, dir: "~/.zodchi/packages/-r", label: "pkg", base: "ccccccc", tmp: "/r/.agent-tmp/pkg" }, "with the claim-base command and the base the package works from");
    t.eq(baseKey(fresh), "pkg-ccccccc-a1b2c3d4-review-1", "and the keys carry it");
    const plain = await run();
    t.eq(plain.of(/claim base/).length, 0, "without a switch there is nothing to record");
  });

  scenario("fixes-writer-logs-under-tmp", "the writer's prompt, of the first write and of every fix, says logs and scratch files go under the package tmp folder and never into the repository", async (t) => {
    const r = await run({ "review 1": { verdict: "changes_requested", summary: "s", findings: ["F1 important src/a.js: x"], gateway: "final", infra: "" } }, { models: { writer: { candidates: [{ provider: "claude", model: "sonnet" }] }, reviewer: { candidates: [CODEX] } } });
    const writes = r.calls.filter((c) => c.opts.agentType === "zodchi-core:coder");
    t.ok(writes.length >= 2, `the writer ran for the package and for the findings (${writes.map((c) => c.label)})`);
    for (const w of writes) {
      t.ok(seenIn(w.prompt).some((x) => x.includes("Logs, scratch files, notes and command outputs go only under /r/.agent-tmp/pkg") && x.includes("a stray file in the repository can fail its own checks")), `${w.label}: logs and scratch files go under the tmp folder only`);
    }
  });

  // ------------------------------------------------------------------------------------------------- continuation 4: keys, progress files, commit paths

  const allKeys = (r) => r.calls.flatMap((c) => [...c.prompt.matchAll(/Gateway call, base key (\S+?)\. /g)].map((m) => m[1]));

  scenario("fixes-gateway-key-within-limit", "a label the workflow accepts never builds a gateway key over the gateway's 96 characters, retries and attempt suffixes included; a label too long for the key format is refused at the start with a clear message", async (t) => {
    const LIMIT = 96, label = "a".repeat(60);
    const r = await run({}, { label, rerun: { "review 1": 99 } });
    t.eq([String(r.error), r.out && r.out.approved], ["null", true], "a label of the longest accepted length runs");
    const review = baseKey(r);
    t.eq(review, `${label}-abc1234-a1b2c3d4-review-1-a99`, "the key is still <label>-<base7>-<run>-<kind>-<n>-a<attempt>");
    t.ok(review.length + "-r3".length <= LIMIT, `the longest key of a rerun with two retries fits (${review.length + 3} <= ${LIMIT})`);
    const work = await run({ "write pkg": { done: true, summary: "w", changed: ["/r/src/a.js"], unverified: [], gateway: "final", infra: "" } }, { label, models: { writer: { candidates: [CODEX] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } });
    const expert = await run({
      "write pkg ask": { ok: true, summary: "a", paths: ["/r/.agent-tmp/pkg/expert-1.answer.md"], gateway: "final", infra: "" },
      "write pkg apply": { done: true, summary: "w", changed: ["/r/src/a.js"], unverified: [] },
    }, { label, mode: "expert", models: { expertWriter: { candidates: [CODEX] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } }, { gate: { roles: { expertWriter: { candidates: [CODEX] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } } });
    const keys = [...allKeys(await run({}, { label })), ...allKeys(work), ...allKeys(expert)];
    t.ok(keys.length >= 3 && keys.some((k) => k.includes("-work-")) && keys.some((k) => k.includes("-expert-")), `review, work and expert keys were built (${keys.length})`);
    t.ok(keys.every((k) => k.length + "-a99-r3".length <= LIMIT), `every key fits with the longest suffixes (${Math.max(...keys.map((k) => k.length))} + 7 <= ${LIMIT})`);
    t.eq(baseKey(await run({}, { label }), 1), `${label}-abc1234-a1b2c3d4-review-1`, "no key is shortened: two labels never share one, and a resume builds the same key");

    for (const bad of [{ rerun: { "review 1": 100000 } }, { rerun: { "review 1": 100 } }, { rerun: { "review 1": 0 } }, { rounds: 100 }]) {
      const e = await run({}, { label, ...bad });
      t.ok(e.error && /from 1 to 99/.test(e.error.message) && e.calls.length === 0, `${JSON.stringify(bad)}: a round or attempt number the key budget does not hold is refused before any step (${e.error && e.error.message})`);
    }
    t.eq(String((await run({}, { label, rounds: 99, rerun: { "review 1": 99 } })).error), "null", "99 for each is the longest accepted and runs");

    const long = await run({}, { label: "a".repeat(61) });
    t.ok(long.error && /61 characters/.test(long.error.message) && /shorter label/.test(long.error.message) && long.calls.length === 0, `a label of 61 characters is refused before any step (${long.error && long.error.message})`);
  });

  scenario("fixes-gateway-progress-of-earlier-run", "a gateway call tells the step that a key in the progress file without this run's key prefix belongs to an earlier run of the label and is ignored; a resume of the same run (same prefix) is unchanged; another run has another prefix", async (t) => {
    const r = await run();
    const review = r.of(/^review 1$/)[0].prompt;
    t.ok(review.includes("Keys of this run all start with pkg-abc1234-a1b2c3d4-; count only those."), "the call names the prefix of this run");
    t.ok(/A key without it[^]*belong to an earlier run of this label: leave them out of every wait, reuse and retry count[^]*With none, submit under pkg-abc1234-a1b2c3d4-review-1/.test(review), "a key without it is left out and the step submits under its own key");
    t.ok(review.includes("UNKNOWN:") && review.includes("any \"UNKNOWN:\" line that names it belong to an earlier run"), "an UNKNOWN line that names such a key is ignored too");
    t.ok(review.includes("The active key is the key of the latest submission: pkg-abc1234-a1b2c3d4-review-1 at first"), "the rest of the resume rules stay");
    const again = await run();
    t.eq(again.of(/^review 1$/)[0].prompt, review, "the same run again (a resume) gets the same prompt, so its own recorded keys are waited on");
    const other = await run({}, {}, { gate: { runId: "b2c3d4e5" } });
    const otherPrompt = other.of(/^review 1$/)[0].prompt;
    t.ok(otherPrompt.includes("Keys of this run all start with pkg-abc1234-b2c3d4e5-;") && !otherPrompt.includes("pkg-abc1234-a1b2c3d4-"), "a fresh run of the same label and tmp has another prefix: the earlier run's keys do not match it");
    const work = await run({ "write pkg": { done: true, summary: "w", changed: ["/r/src/a.js"], unverified: [], gateway: "final", infra: "" } }, { models: { writer: { candidates: [CODEX] }, reviewer: { candidates: [{ provider: "claude", model: "opus" }] } } });
    t.ok(work.of(/^write pkg$/)[0].prompt.includes("Keys of this run all start with pkg-abc1234-a1b2c3d4-; count only those."), "the writer's gateway call carries it too");
    t.ok(/First look in the progress file for a submission of this call by this run: if it records pkg-abc1234-a1b2c3d4-review-1, [^]*the latest of them is the active key/.test(review), "the resume rule picks the latest key of this run only: the prefix is named before the rule that chooses what to wait on");
    const re = await run({}, { rerun: { "review 1": 2 } });
    t.ok(/take the latest key of this run \(it starts with pkg-abc1234-a1b2c3d4-\) that the progress file records for this call/.test(re.of(/^review 1$/)[0].prompt), "the rerun rule filters by the prefix before it takes the latest key");
  });

  scenario("fixes-continuation-commit-list", "the commit step of a continuation commits only paths that exist, are in the index or are tracked in HEAD: the old side of a rename and a file deleted in an earlier round are dropped from the pathspec, because git commit rejects a pathspec that matches nothing", async (t) => {
    const ORIGINAL = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", HEAD = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const claimed = line({ ok: true, conflicts: [], branchConflicts: [], reused: true, reopened: true, files: ["src/a.js", "src/old.js", "src/gone.js"], file: "/h/.zodchi/packages/-r/pkg.json", base: ORIGINAL });
    const r = await run({
      "claim pkg": claimed,
      "base pkg": { ok: true, head: HEAD, branch: "main", verifySkill: false, reviewMd: false, ancestor: true, paths: ["src/a.js", "src/old.js", "src/new.js", "src/gone.js"] },
    }, {}, { gate: { head: HEAD } });
    t.eq(String(r.error), "null", "the continuation runs");
    const commit = r.of(/^commit 1$/)[0].prompt;
    const listed = JSON.parse(commit.match(/The package paths, relative to the repository: (\[.*?\])\./)[1]);
    t.ok(listed.includes("src/old.js") && listed.includes("src/gone.js"), "the package paths still hold the earlier rounds' old paths (the review needs them)");
    t.ok(/Narrow the package paths to "those paths"/.test(commit) && commit.includes("git ls-files -- <path>") && commit.includes("git cat-file -e HEAD:<path>") && /Drop every other path/.test(commit) && /rejects a pathspec that matches nothing/.test(commit), "the step narrows the paths: work tree, index or HEAD, the rest dropped");
    t.ok(/For each of those paths run/.test(commit) && commit.includes("git diff --cached --quiet -- <those paths>") && commit.includes("-- <those paths>` (the paths after --") && !commit.includes("<the commit list>"), "add, the empty check and the commit all use the commit list, never the whole list");
    t.ok(/If those paths are none, return ok true/.test(commit), "no path left is nothing to commit");
    const again = commit.indexOf('narrow "those paths" once more');
    t.ok(/Staging can remove the index entry of a path that was only an abandoned addition[^]*once more[^]*no longer prints[^]*cat-file -e HEAD:<path>[^]*second list[^]*If it is empty, return ok true/.test(commit) && again > commit.indexOf("git add -A --") && again < commit.indexOf("git diff --cached --quiet"), "after the add the list is narrowed again, before the empty check and the commit");

    // Git itself: a pathspec with the old side of an earlier round's rename is rejected; the commit list the step describes is not
    const home = scratch(t, "commitlist"), repo = `${home}/repo`;
    fs.mkdirSync(repo);
    const git = (...a) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    git("init", "-q");
    for (const f of ["old.js", "gone.js", "keep.js"]) fs.writeFileSync(`${repo}/${f}`, `${f} line\n`.repeat(4));
    git("add", "."); git("commit", "-q", "-m", "base");
    git("mv", "old.js", "new.js"); git("rm", "-q", "gone.js"); git("commit", "-q", "-m", "round 1");
    fs.writeFileSync(`${repo}/keep.js`, "round 2\n");
    fs.writeFileSync(`${repo}/new.js`, "round 2 new\n");
    const all = ["old.js", "new.js", "gone.js", "keep.js"];
    const known = (f) => fs.existsSync(`${repo}/${f}`) || git("ls-files", "--", f).stdout.trim() !== "" || git("cat-file", "-e", `HEAD:${f}`).status === 0;
    const list = all.filter(known);
    t.eq(list, ["new.js", "keep.js"], "the old side of the rename and the file deleted in round 1 are not in the commit list");
    git("add", "-A", "--", ...list);
    const bad = git("commit", "-q", "-m", "x", "--", ...all);
    t.ok(bad.status !== 0 && /did not match any file/.test(bad.stderr), `the whole list is rejected by git commit (${bad.stderr.trim()})`);
    const good = git("commit", "-q", "-m", "round 2", "--", ...list);
    t.eq([good.status, git("show", "--name-only", "--format=", "HEAD").stdout.split("\n").filter(Boolean).sort()], [0, ["keep.js", "new.js"]], "the commit list commits");

    // a staged addition gone from the work tree before the commit: staging removes its index entry, so it must leave the list after the add
    fs.writeFileSync(`${repo}/ghost.js`, "ghost\n");
    git("add", "ghost.js");
    fs.rmSync(`${repo}/ghost.js`);
    fs.writeFileSync(`${repo}/keep.js`, "round 3\n");
    const first = ["ghost.js", "keep.js"].filter(known);
    t.eq(first, ["ghost.js", "keep.js"], "before staging the abandoned addition still passes the first narrowing (it is in the index)");
    git("add", "-A", "--", ...first);
    const stale = git("commit", "-q", "-m", "x", "--", ...first);
    t.ok(stale.status !== 0 && /did not match any file/.test(stale.stderr), `the list of the first narrowing fails after staging (${stale.stderr.trim()})`);
    const second = first.filter(known);
    t.eq(second, ["keep.js"], "narrowed again after the add, the abandoned addition is gone from the list");
    const round3 = git("commit", "-q", "-m", "round 3", "--", ...second);
    t.eq([round3.status, git("show", "--name-only", "--format=", "HEAD").stdout.split("\n").filter(Boolean)], [0, ["keep.js"]], "and the commit goes through");
  });

  // ------------------------------------------------------------------------------------------------------------- next-fixes 24, 27, 28

  scenario("fixes-claim-base-transient-failure", "a claim-base step that fails on a transient error (the claims lock busy, a helper exit that is no refusal) is an infrastructure failure: the run stops with the claim open, an unchanged resume replays the stop, a resume with args.rerun for the step calls the helper live and goes on; a real refusal still stops as before", async (t) => {
    const home = scratch(t, "cbtransient"), dir = `${home}/.zodchi/packages/-r`;
    const repo = `${home}/repo`;
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["-C", repo, "init", "-q"]);
    let live = 0;
    const real = (prompt) => {
      const m = commandsIn(prompt, "claim|claim-more|claim-base")[0];
      if (m.command === "claim-base") live++;
      const spec = { ...m.spec, ...(m.spec.repo === "/r" ? { repo } : {}) };
      const r = spawnSync(process.execPath, ["-e", BOOT, "--", home, m.command, encodeSpec(spec)], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, ZODCHI_PLUGIN_ROOT: path.join(ROOT, "core"), CLAUDE_PLUGIN_ROOT: "" } });
      t.log(`runner: gate.mjs ${m.command}: exit ${r.status}\n${r.stdout}${r.stderr}`);
      return { exitCode: r.status, stdout: r.stdout, error: (r.stderr || "").slice(0, 300) };
    };
    const onBranch = { "switch pkg": { ok: true, summary: "ok" }, "base pkg": { ok: true, head: "ccccccc", branch: "feat", verifySkill: false, reviewMd: false }, "await claim pkg": { ok: true, summary: "marked" } };
    const stopAt = (r) => (r.error ? (r.error.message.match(/^Infrastructure failure at step "[^"]*", attempt \d+/) || [r.error.message.slice(0, 80)])[0] : "no stop");
    // the claim is written for real at the base the gate saw; a resume has that first answer back from the journal
    const journaled = line({ ok: true, conflicts: [], branchConflicts: [], reused: false, files: ["src/a.js"], file: `${dir}/pkg.json`, base: "abc1234" });
    const first = await run({ ...onBranch, "claim pkg": real, "claim base pkg": { exitCode: 0, stdout: "", error: "" } }, { branch: "feat" });
    t.eq(stopAt(first), 'Infrastructure failure at step "claim base pkg", attempt 1', "an answer with no JSON line is an infrastructure failure at the step");
    t.eq(readClaim(dir, "pkg").status, "open", "the claim stays open: the package goes on when resumed");
    // the real helper's own answer for a claims lock that is held is what the claim-base step gets
    fs.mkdirSync(`${dir}/.lock`);
    const busy = gate(t, "claim-base", { dir, label: "pkg", base: "ccccccc", tmp: "/r/.agent-tmp/pkg", lockWaitSec: 1 }, home);
    fs.rmdirSync(`${dir}/.lock`);
    t.ok(busy.json && busy.json.ok === false && busy.json.conflicts.join() === "lock busy", `the real helper answers a held lock as ok false with the conflict "lock busy" (${JSON.stringify(busy.json && busy.json.conflicts)})`);
    const busyAnswer = { exitCode: busy.code, stdout: JSON.stringify(busy.json) + "\n", error: "" };
    const stopped = await run({ ...onBranch, "claim pkg": journaled, "claim base pkg": busyAnswer }, { branch: "feat" });
    t.eq(stopAt(stopped), 'Infrastructure failure at step "claim base pkg", attempt 1', "a busy claims lock stops the run as an infrastructure failure (it was a plain stop that only a new label got past)");
    t.ok(/args\.rerun \{"claim base pkg":2\}/.test(stopped.error.message.replace(/\\"/g, '"')) && /lock busy/.test(stopped.error.message), "the failure names the rerun that retries the step, and the cause");
    t.eq([stopped.of(/^write pkg$/).length, stopped.of(/^close claim/).length, stopped.of(/^await claim/).length], [0, 0, 1], "nothing was written; the claim is marked as waiting for a person, not closed");
    // the journal hands back the failed answer: an unchanged resume stops again, and the helper is not called
    const before = live;
    const replay = await run({ ...onBranch, "claim pkg": journaled, "claim base pkg": busyAnswer }, { branch: "feat" });
    t.eq([stopAt(replay), live], ['Infrastructure failure at step "claim base pkg", attempt 1', before], "an unchanged resume replays the stop and calls the helper no more");
    // the resume with rerun asks the helper live (the lock is free now) and the run goes on
    const resumed = await run({ ...onBranch, "claim pkg": journaled, "claim base pkg": real, "claim more write pkg": real }, { branch: "feat", rerun: { "claim base pkg": 2 } });
    t.eq([String(resumed.error), resumed.out && resumed.out.approved, live], ["null", true, before + 1], "a resume with args.rerun calls the helper live and goes on to approval");
    t.ok(/attempt 2/.test(resumed.of(/^claim base pkg$/)[0].prompt), "the step's prompt carries the attempt, so its journaled answer is not found");
    t.eq([readClaim(dir, "pkg").status, readClaim(dir, "pkg").base], ["open", "ccccccc"], "the claim records the base of the branch");
    // a helper exit that is not a refusal (no JSON, exit 1) is transient too
    const crashed = await run({ ...onBranch, "claim pkg": journaled, "claim base pkg": { exitCode: 1, stdout: "", error: "EBUSY" } }, { branch: "feat" });
    t.eq(stopAt(crashed), 'Infrastructure failure at step "claim base pkg", attempt 1', "a helper that exits 1 without an answer is an infrastructure failure");
    // the lock could not be created for a reason other than a held lock: the helper answers "lock: <error>" with no conflicts; that is transient too
    const noLock = await run({ ...onBranch, "claim pkg": journaled, "claim base pkg": line({ ok: false, conflicts: [], error: "lock: EACCES: permission denied, mkdir '/h/.zodchi/packages/-r/.lock'" }) }, { branch: "feat" });
    t.eq(stopAt(noLock), 'Infrastructure failure at step "claim base pkg", attempt 1', "a lock that cannot be created (error \"lock: ...\", no conflicts) is an infrastructure failure, not a plain stop");
    t.ok(/args.rerun {"claim base pkg":2}/.test(noLock.error.message.replace(/\\"/g, '"')) && /EACCES/.test(noLock.error.message), "and it names the rerun and the cause");
    // real refusals keep stopping with a plain stoppedAt
    for (const [what, answer] of [
      ["files another package holds", line({ ok: false, conflicts: ["rival: src/a.js"], error: "" })],
      ["no open claim of the label", line({ ok: false, conflicts: [], error: "pkg has no open claim at /h/.zodchi/packages/-r/pkg.json" })],
    ]) {
      const r = await run({ ...onBranch, "claim pkg": journaled, "claim base pkg": answer, "close claim pkg": { ok: true, summary: "closed" } }, { branch: "feat" });
      t.ok(r.error === null && /^claim base \(/.test(String(r.out && r.out.stoppedAt)) && !r.out.infra && r.of(/^write pkg$/).length === 0, `${what}: a refusal stops the run as before, not as an infrastructure failure (${r.out && r.out.stoppedAt})`);
    }
  });

  scenario("fixes-commit-staged-deletion", "the commit step takes a path whose deletion is already staged: it runs no git add for it (git add -A fails on it), keeps it in the commit list and commits the deletion; shown with the steps of the prompt run on a real repository", async (t) => {
    const r = await run();
    const prompt = r.of(/^commit 1$/)[0].prompt;
    t.ok(/except a path that is gone from the work tree and that `git ls-files -- <path>` no longer prints \(its deletion is already staged\): run no `git add` for it/.test(prompt) && /it stays in "those paths"/.test(prompt), "the commit step says to skip git add for a path whose deletion is already staged, and to keep it in the list");
    const home = scratch(t, "stageddel"), repo = `${home}/repo`;
    fs.mkdirSync(repo);
    const git = (...a) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    git("init", "-q");
    for (const f of ["a.js", "gone.js", "other.js"]) fs.writeFileSync(`${repo}/${f}`, `${f} line\n`.repeat(4));
    git("add", "."); git("commit", "-q", "-m", "base");
    // the round: a.js changed, gone.js deleted with the deletion already staged (git rm), other.js staged by another package (stays out)
    fs.writeFileSync(`${repo}/a.js`, "round 1\n");
    git("rm", "-q", "gone.js");
    fs.writeFileSync(`${repo}/other.js`, "another package\n");
    git("add", "other.js");
    const paths = ["a.js", "gone.js"];
    const inTree = (f) => fs.existsSync(`${repo}/${f}`);
    const inIndex = (f) => git("ls-files", "--", f).stdout.trim() !== "";
    const inHead = (f) => git("cat-file", "-e", `HEAD:${f}`).status === 0;
    // the old instruction: git add -A -- <path> for every path
    const old = git("add", "-A", "--", "gone.js");
    t.ok(old.status !== 0 && /did not match any files/.test(old.stderr), `git add -A on the staged deletion fails (${old.stderr.trim()})`);
    // the instruction now: step 1 narrows, runs git add for the paths that are not a staged deletion, step 2 narrows again, step 3 commits
    const narrowed = paths.filter((f) => inTree(f) || inIndex(f) || inHead(f));
    t.eq(narrowed, paths, "the staged deletion passes the first narrowing (it is in HEAD)");
    for (const f of narrowed) if (inTree(f) || inIndex(f)) t.eq(git("add", "-A", "--", f).status, 0, `git add -A -- ${f}`);
    const second = narrowed.filter((f) => inIndex(f) || inHead(f));
    t.eq(second, paths, "the second narrowing keeps it too");
    t.ok(git("diff", "--cached", "--quiet", "--", ...second).status !== 0, "there is something to commit");
    const c = git("commit", "-q", "-m", "pkg: round 1", "-m", "Verified: x", "--", ...second);
    t.eq(c.status, 0, `the commit goes through (${c.stderr.trim()})`);
    t.eq(git("show", "--name-only", "--format=", "HEAD").stdout.split("\n").filter(Boolean).sort(), ["a.js", "gone.js"], "it commits the change and the deletion, nothing else");
    t.eq(git("diff", "--cached", "--name-only").stdout.split("\n").filter(Boolean), ["other.js"], "the other package's staged file stays staged and out of the commit");
    t.ok(!inHead("gone.js") && !inTree("gone.js"), "the file is deleted in HEAD");
  });

  scenario("fixes-run-id-collision-check", "the run id stays 8 hex characters (the gateway key budget), and every id the gate hands out is recorded per repository and label: an id handed out before is drawn again, so two runs of one label never share one", async (t) => {
    const home = scratch(t, "runidcheck"), repo = `${home}/repo`;
    fs.mkdirSync(repo);
    spawnSync("git", ["-C", repo, "init", "-q"]);
    fs.writeFileSync(`${home}/brief.md`, "# b\n");
    // a random source that repeats itself, per process: deadbeef, deadbeef, cafef00d
    const preload = `${home}/fake-random.mjs`;
    fs.writeFileSync(preload, [
      'import crypto from "node:crypto";',
      'import { syncBuiltinESMExports } from "node:module";',
      'const seq = ["deadbeef", "deadbeef", "cafef00d", "0badf00d"];',
      "let i = 0;",
      'crypto.randomBytes = (n) => Buffer.from(seq[Math.min(i++, seq.length - 1)], "hex").subarray(0, n);',
      "syncBuiltinESMExports();",
    ].join("\n"));
    const spec = (label) => JSON.stringify({ api: 1, repo, brief: `${home}/brief.md`, label, claimsKey: "k", want: [] });
    const ask = (label) => {
      const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, GATE, "code-package", spec(label)], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
      t.log(`gate.mjs code-package (fake random): exit ${r.status}\n${r.stdout}${r.stderr}`);
      return JSON.parse(r.stdout).runId;
    };
    t.eq(ask("mine"), "deadbeef", "the first run of the label gets the id the random source gave");
    t.eq(ask("mine"), "cafef00d", "the same id again is refused: the second run of the label draws on and gets another");
    t.eq(ask("other"), "deadbeef", "ids are per label: another label may have that id (the key holds the label)");
    t.eq(fs.readdirSync(`${home}/.zodchi/run-ids/k`).sort(), ["mine.cafef00d", "mine.deadbeef", "other.deadbeef"], "each id handed out is recorded");
    const open = gate(t, "claim", claimSpec(`${home}/.zodchi/packages/k`, "mine", ["a.js"], { repo }), home).json;
    t.eq([open.ok, open.conflicts, fs.readdirSync(`${home}/.zodchi/packages/k`).sort()], [true, [], ["mine.json"]], "the records are not in the claims folder: the claim commands see none of them");
    // the real random source: many runs, all different, 8 hex characters each
    const ids = Array.from({ length: 4 }, () => gate(t, "code-package", { repo, brief: `${home}/brief.md`, label: "many", claimsKey: "k", want: [] }, home).json.runId);
    t.ok(ids.every((id) => /^[0-9a-f]{8}$/.test(id)) && new Set(ids).size === ids.length, "4 runs of one label with the real random source: 8 hex characters each and no id twice");
    // the longest key still fits: the id did not grow
    const longest = `${"l".repeat(60)}-abc1234-${ids[0]}-review-99-a99-r9`;
    t.ok(longest.length <= 96, `a gateway key with a 60-character label, the longest kind and the largest attempt and retry numbers is ${longest.length} characters (the gateway takes 96)`);
    // a folder that cannot be created does not stop the gate
    fs.writeFileSync(`${home}/blocked`, "a file where the home folder must be\n");
    const blocked = spawnSync(process.execPath, [GATE, "code-package", spec("mine")], { encoding: "utf8", env: { ...process.env, HOME: `${home}/blocked`, USERPROFILE: `${home}/blocked` } });
    t.ok(blocked.status === 0 && /^[0-9a-f]{8}$/.test(JSON.parse(blocked.stdout).runId), "a record folder that cannot be created still gives an id");
  });
}
