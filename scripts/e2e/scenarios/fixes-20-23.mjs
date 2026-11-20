// code-package fixes 20-23: a resumed run reopens its claim; the gateway keys belong to the run; the workflow must be the one of the plugin copy
// it talks to; a package that goes on reviews base..HEAD from its recorded base; the writer is told where its logs go.
//
// Two layers, as in claim-cmd.mjs and code-package.mjs: the gate helper (core/scripts/gate.mjs) run for real against a scratch home and scratch Git
// repositories, and the workflow (core/workflows/code-package.js) run the way Claude Code runs it, with scripted answers (and, where the claim
// matters, the real helper answering the claim steps).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { commandsIn, encodeSpec, specIn, seenIn } from "../spec-arg.mjs";

export default function register({ scenario, ROOT }) {
  const GATE = path.join(ROOT, "core", "scripts", "gate.mjs");
  const WF = path.join(ROOT, "core", "workflows", "code-package.js");
  const SRC = fs.readFileSync(WF, "utf8");
  const BOOT = vm.runInNewContext(SRC.match(/^const GATE_BOOT = (.*)$/m)[1]);
  const BUILD = SRC.match(/^const WORKFLOW_BUILD = '([0-9a-f]*)'/m)[1];
  const PLUGIN = { root: "/plugin/core", commit: "c0ffee", version: "1.0.0-dev", via: "installed_plugins.json, scope user" };

  const scratch = (t, name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-f2023-${name}-`)).replace(/\\/g, "/");
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
    const home = scratch(t, "reopen"), dir = `${home}/.zodchi/packages/r`;
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
    const cb = gate(t, "claim-base", { dir, label: "pkg", base: "5555555" }, home).json;
    t.eq([cb.ok, readClaim(dir, "pkg").base], [true, "5555555"], "claim-base sets the base of the open claim");
    closeClaim(dir, "pkg", "stopped");
    t.eq(gate(t, "claim-base", { dir, label: "pkg", base: "6666666" }, home).json.ok, false, "and changes nothing of a closed one");
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
    const answer = (label, prompt) => {
      const given = answers[label];
      if (given !== undefined) return typeof given === "function" ? given(prompt, calls) : given;
      if (label === "gate pkg") return line(gateFacts(o.gate));
      if (label === "claim pkg") return line({ ok: true, conflicts: [], branchConflicts: [], reused: false, files: ["src/a.js"], file: "/h/.zodchi/packages/-r/pkg.json", base: "abc1234" });
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
    t.eq(specIn(cb[0].prompt, "claim-base"), { api: 1, dir: "~/.zodchi/packages/-r", label: "pkg", base: "ccccccc" }, "with the claim-base command and the base the package works from");
    t.eq(baseKey(fresh), "pkg-ccccccc-a1b2c3d4-review-1", "and the keys carry it");
    const plain = await run();
    t.eq(plain.of(/claim base/).length, 0, "without a switch there is nothing to record");
  });

  scenario("fixes-writer-logs-under-tmp", "the writer's prompt, of the first write and of every fix, says logs and scratch files go under the package tmp folder and never into the repository", async (t) => {
    const r = await run({ "review 1": { verdict: "changes_requested", summary: "s", findings: ["F1 important src/a.js: x"], gateway: "final", infra: "" } }, { models: { writer: { candidates: [{ provider: "claude", model: "sonnet" }] }, reviewer: { candidates: [CODEX] } } });
    const writes = r.calls.filter((c) => c.opts.agentType === "zodchi-core:coder");
    t.ok(writes.length >= 2, `the writer ran for the package and for the findings (${writes.map((c) => c.label)})`);
    for (const w of writes) {
      t.ok(seenIn(w.prompt).some((x) => x.includes("Logs, scratch files, notes and command outputs go only under /r/.agent-tmp/pkg") && x.includes("never into the repository")), `${w.label}: logs and scratch files go under the tmp folder only`);
    }
  });
}
