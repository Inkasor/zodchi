import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, zodchi, FIXED }) {
  scenario("flow-branch-review-fork-screening", "honor the base fork allow-list but keep independent screening and verdicts", async t => {
    const f = flowWorld(t, "flow-branch-review-fork-screening");
    const ownWord = "fixture-harbor";
    const otherWord = "fixture-cove";
    const marked = "fixture-sensitive-value";
    fs.writeFileSync(path.join(f.w.zhome, "private-words.txt"), `${ownWord}\n${otherWord}\n`);
    gitOut(f.r, ["remote", "add", "upstream", "https://upstream.example.test/branch.git"]);
    const allow = ".zodchi/allowed-words.txt";
    fs.mkdirSync(path.join(f.r, ".zodchi"), { recursive: true });
    fs.writeFileSync(path.join(f.r, allow), ownWord + "\n");
    gitOut(f.r, ["add", "--", allow]);
    gitOut(f.r, ["commit", "-qm", "record the fork identity in the base"]);
    const base = gitOut(f.r, ["rev-parse", "HEAD"]);
    const currentPath = `src/${ownWord}.mjs`;
    fs.writeFileSync(path.join(f.r, currentPath), [
      `export const route = "/${ownWord}/status";`,
      `// ${otherWord}`,
      `const token = "${marked}";`,
      'const serviceSecret = process.env["SVC_INTERNAL_SECRET"];',
      'request.header("X-Service-Secret", serviceSecret);',
      "",
    ].join("\n"));
    fs.appendFileSync(path.join(f.r, allow), otherWord + "\n");
    gitOut(f.r, ["add", "--", allow, currentPath]);
    gitOut(f.r, ["commit", "-qm", "add a change with fork terminology"]);
    const cli = args => zodchi(t, f.w, ["flow", ...args], { cwd: f.r });
    const args = path.join(f.w.dir, "review.json");
    const plan = { repo: f.r, base, label: "fork", author: ["codex/fake-writer"],
      context: [currentPath], checks: [`node -e 'console.log("${ownWord} check")'`] };
    fs.writeFileSync(args, JSON.stringify(plan));
    f.answer("review", f.review("approved"));
    const internal = await cli(["branch-review", "--args", args]);
    t.eq([internal.code, internal.json?.screening?.forkAllowlistApplied, internal.json?.screening?.diffLinesWithheld],
      [0, true, 3], "only the base allow-list applies, even when the candidate expands it");
    const readPrompt = result => JSON.parse(fs.readFileSync(path.join(result.journal, "requests", `flow-${result.runId}-review.json`), "utf8")).prompt;
    const text = readPrompt(internal.json);
    t.ok(text.includes(currentPath) && text.includes(`/${ownWord}/status`) && !text.includes(otherWord) && !text.includes(marked),
      "the reviewer receives fork paths and content while other words and credentials stay screened");
    t.ok(text.includes('process.env["SVC_INTERNAL_SECRET"]') && text.includes('request.header("X-Service-Secret", serviceSecret)'),
      "the reviewer sees environment variable and request header names");
    t.eq(internal.json.screening.withheld.map(({ file, reason, scope }) => [file, reason, scope]),
      [[allow, "private-word", "line"], [currentPath, "private-word", "line"], [currentPath, "credential", "literal"]],
      "each omission identifies the file, reason and scope in the local result");
    const receipt = text.match(/<attachment path="verification\.json">\n([\s\S]*?)\n<\/attachment>/);
    t.ok(JSON.parse(receipt[1]).commands[0].output.includes(`${ownWord} check`), "the verification JSON preserves the same allowed wording");
    const handoff = await cli(["status", internal.json.runId, "--handoff"]);
    t.eq(handoff.json?.screening?.diffLinesWithheld, 3, "the handoff reports evidence loss");
    fs.writeFileSync(args, JSON.stringify({ ...plan, publicRepo: true, checks: [] }));
    f.answer("review", { ...f.review("blocked"), notVerified: ["Required lines were withheld."] });
    const publicRun = await cli(["branch-review", "--args", args]);
    t.eq([publicRun.code, publicRun.json?.verdict, publicRun.json?.screening?.forkAllowlistApplied],
      [2, "blocked", false], "public screening and a block without findings remain authoritative");
    t.ok(!readPrompt(publicRun.json).includes(currentPath), "public review omits the private path");
  });

  scenario("flow-branch-review-coordinator-rounds", "a bounded review chain carries findings and externally recorded checks on the exact tree", async t => {
    const f = flowWorld(t, "flow-branch-review-coordinator-rounds");
    fs.writeFileSync(path.join(f.r, "src", "math.mjs"), FIXED);
    gitOut(f.r, ["commit", "-qm", "implement clamp", "--", "src/math.mjs"]);
    const head = gitOut(f.r, ["rev-parse", "HEAD"]);
    const tree = gitOut(f.r, ["rev-parse", "HEAD^{tree}"]);
    const receipt = path.join(f.w.dir, "verification-receipt.json");
    const args = path.join(f.w.dir, "review-args.json");
    const cli = (argv) => zodchi(t, f.w, ["flow", ...argv], { cwd: f.r });
    const plan = { repo: f.r, base: f.base, head, label: "clamp-review", author: "codex/fake-writer", verificationFile: receipt };
    const run = (overrides) => {
      fs.writeFileSync(args, JSON.stringify({ ...plan, ...overrides }));
      return cli(["branch-review", "--args", args]);
    };
    const command = { command: "node test/math.test.mjs", exitCode: 0, output: "clamp ok" };
    fs.writeFileSync(receipt, JSON.stringify({ tree: head, commands: [command] }));
    const wrongTree = await run({ rounds: 2 });
    t.ok(wrongTree.code === 2 && /exact candidate tree/.test(wrongTree.json?.refused ?? ""), "another tree is rejected at the gate");
    fs.writeFileSync(receipt, JSON.stringify({ tree, commands: [{ ...command, exitCode: 3 }] }));
    const failed = await run({ rounds: 2 });
    t.ok(failed.code === 2 && /exitCode 0/.test(failed.json?.refused ?? ""), "a failing check is refused as passing evidence");
    t.eq(f.steps(), [], "invalid evidence does not call a reviewer");

    fs.writeFileSync(receipt, JSON.stringify({ head, tree, commands: [command] }));
    f.answer("review", f.review("changes_requested", [f.finding("F1")]));
    const first = await run({ rounds: 2 });
    t.eq([first.code, first.json?.reviewRound, first.json?.reviewLimit, first.json?.verificationReceipt?.tree],
      [2, 1, 2, tree], "the first round pins the candidate evidence and the chain limit");
    const firstPrompt = JSON.parse(fs.readFileSync(path.join(first.json.journal, "requests", `flow-${first.json.runId}-review.json`), "utf8")).prompt;
    const evidence = firstPrompt.match(/<attachment path="verification\.json">\n([\s\S]*?)\n<\/attachment>/);
    t.eq([JSON.parse(evidence[1]).provenance, JSON.parse(evidence[1]).commands], ["coordinator", [command]],
      "the review sees the externally reported command, exit and output");

    f.answer("review", f.review("approved"));
    const second = await run({ previousReview: first.json.runId });
    t.eq([second.code, second.json?.reviewRound, second.json?.reviewLimit, second.json?.previousReview],
      [0, 2, 2, first.json.runId], "the second round inherits the first round limit");
    const secondPrompt = JSON.parse(fs.readFileSync(path.join(second.json.journal, "requests", `flow-${second.json.runId}-review.json`), "utf8")).prompt;
    const history = secondPrompt.match(/<attachment path="previous-branch-reviews\.json">\n([\s\S]*?)\n<\/attachment>/);
    t.eq(JSON.parse(history[1]).map(entry => [entry.runId, entry.head, entry.review.findings[0].id]),
      [[first.json.runId, head, "F1"]], "the next reviewer receives the preceding finding with its revision");
    const exhausted = await run({ previousReview: second.json.runId });
    t.ok(exhausted.code === 2 && /limit of 2/.test(exhausted.json?.refused ?? ""), "the chain stops before round three");
    t.eq(f.steps(), ["review", "review"], "only the two requested rounds submit a review");
  });

  scenario("flow-project-domains", "the project can select workflow domains before a run starts", async (t) => {
    const f = flowWorld(t, "flow-project-domains");
    const cli = args => zodchi(t, f.w, ["flow", ...args], { cwd: f.w.dir, env: f.w.env });
    const config = path.join(f.r, ".zodchi", "workflows.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const select = (domains) => {
      fs.writeFileSync(config, JSON.stringify({ domains }));
      gitOut(f.r, ["add", "--", ".zodchi/workflows.json"]);
      gitOut(f.r, ["commit", "-qm", "select workflow domains"]);
    };
    select([]);
    const first = await cli(["list", "--repo", f.r]);
    const installed = await cli(["list"]);
    const core = installed.json.workflows.filter(item => item.domain === "core").map(item => item.name);
    t.eq(first.json?.workflows.map(item => item.name), core, "disabling optional domains lists exactly the installed core workflows");
    t.ok(core.includes("code-package") && core.includes("design-brief"), "the development core remains available");
    const args = path.join(f.w.dir, "review.json");
    fs.writeFileSync(args, JSON.stringify({ label: "review", repo: f.r, base: f.base, author: ["codex/fake-writer"] }));
    const refused = await cli(["branch-review", "--args", args]);
    t.eq([refused.code, f.steps()], [2, []], "a disabled domain is refused before any model turn");
    select(["web-apps"]);
    const after = await cli(["list", "--repo", f.r]);
    t.ok(after.json?.workflows.some(item => item.name === "branch-review"), "the newly selected domain adds branch-review");
  });

  scenario("flow-branch-review-resume", "review steps inspect the original committed range after a cut and a change of checkout", async (t) => {
    const f = flowWorld(t, "flow-branch-review-resume");
    const flow = (args, env = {}) => zodchi(t, f.w, ["flow", ...args], { cwd: f.w.dir, env: { ...f.w.env, ...env } });
    const put = (name, text) => fs.writeFileSync(path.join(f.r, name), text);
    const commit = (rel, message) => {
      gitOut(f.r, ["add", "--", rel]);
      gitOut(f.r, ["commit", "-qm", message]);
      return gitOut(f.r, ["rev-parse", "HEAD"]);
    };
    put("src/math.mjs", FIXED);
    const originalHead = commit("src/math.mjs", "fix clamp for review");
    put("src/other.mjs", "local worktree marker outside review\n");
    f.answer("review", f.review("approved"));
    f.answer("architecture", f.review("approved"));
    const args = path.join(f.w.dir, "branch.json");
    const claude = { provider: "claude", model: "opus", effort: "high" };
    fs.writeFileSync(args, JSON.stringify({
      label: "review", repo: f.r, base: f.base, author: ["codex/fake-writer"], architecture: true,
      models: {
        reviewer: { candidates: [
          claude,
          { provider: "codex", model: "fake-writer", effort: "medium" },
          { provider: "codex", model: "fake-reviewer", effort: "high" },
        ] },
        architect: { candidates: [claude, { provider: "codex", model: "fake-architect", effort: "high" }] },
      },
      context: ["src/math.mjs"],
    }));
    const first = await flow(["branch-review", "--args", args], { ZODCHI_FLOW_CUT: "submit review" });
    t.eq(first.code, 75, "the model job was submitted before the engine was cut");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const journal = path.join(f.w.zhome, "flows", id);
    t.ok(!fs.existsSync(path.join(journal, "workflow.js")), "the native review journal contains data only");
    commit("src/other.mjs", "move the checkout after pinning");
    const done = await flow(["branch-review", "--resume", id]);
    t.eq([done.code, done.json?.runId, done.json?.version, done.json?.head, done.json?.files, done.json?.approved],
      [0, id, "2", originalHead, ["src/math.mjs"], true], "the pinned range was reviewed under the original run ID");
    t.eq([done.json.models.reviewer.model, done.json.models.architect.model], ["fake-reviewer", "fake-architect"],
      "reviewer and architect are distinct from the authors and each other");
    t.eq([done.json.models.reviewer.provider, done.json.models.architect.provider], ["codex", "codex"],
      "both review roles use the Codex fallback when Claude is disabled");
    for (const role of ["reviewer", "architect"]) {
      t.ok(done.json.models.skipped.some(reason => reason.includes(`${role} claude/opus: Claude is not an executor of this run: not enabled`)),
        `the pinned picks explain why the ${role} skipped Claude`);
    }
    const status = await flow(["status", id]);
    t.eq([status.json?.workflow, status.json?.status, status.json?.result?.head],
      ["branch-review", "finished", originalHead], "any CLI reads the same result");
    t.eq(f.steps(), ["review", "architecture"], "the recovery spent no duplicate model turn");
    const log = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8");
    t.ok(!log.includes("local worktree marker") && log.includes(originalHead), "only pinned material reaches the model");
  });


  scenario("flow-branch-review-omit-data", "large data stays in the pinned review range with its exact blob identity", async (t) => {
    const f = flowWorld(t, "flow-branch-review-omit-data");
    const file = "test/frozen.json";
    const context = "review-context.md";
    const payload = JSON.stringify({ expected: "FROZEN_DATA_VALUE_" + "x".repeat(396 * 1024) }) + "\n";
    fs.writeFileSync(path.join(f.r, context), "a".repeat(140 * 1024));
    gitOut(f.r, ["add", "--", context]);
    gitOut(f.r, ["commit", "-qm", "add review context"]);
    const base = gitOut(f.r, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(f.r, "src/math.mjs"), FIXED);
    fs.writeFileSync(path.join(f.r, file), payload);
    gitOut(f.r, ["add", "--", "src/math.mjs", file]);
    gitOut(f.r, ["commit", "-qm", "fix clamp with a frozen fixture"]);
    const head = gitOut(f.r, ["rev-parse", "HEAD"]);
    const blob = gitOut(f.r, ["rev-parse", head + ":" + file]);
    const args = path.join(f.w.dir, "branch.json");
    const cli = (argv, env = {}) => zodchi(t, f.w, ["flow", ...argv], { cwd: f.r, env: { ...f.w.env, ...env } });
    const start = (extra, env) => {
      fs.writeFileSync(args, JSON.stringify({ label: "review-data", repo: f.r, base, head, author: ["codex/fake-writer"], context: [context], ...extra }));
      return cli(["branch-review", "--args", args], env);
    };
    const overflow = await start({});
    t.ok(overflow.code === 2 && overflow.json?.refused?.includes(file) && overflow.json?.refused?.includes("524288"),
      "a size refusal names the largest file and the actual gateway limit");
    const outside = await start({ exclude: ["src/other.mjs"] });
    t.ok(outside.code === 2 && outside.json?.refused?.includes("src/other.mjs"), "an exclusion must name a changed path");
    const conflict = await start({ exclude: [file], context: [file] });
    t.ok(conflict.code === 2 && conflict.json?.refused?.includes(file), "the same path cannot supply context and be excluded");
    t.eq(f.steps(), [], "refused arguments spend no turns");

    f.answer("review", f.review("approved"));
    fs.writeFileSync(path.join(f.r, file), '{"not":"the committed fixture"}\n');
    const readFixture = 'node -e \'const f = require("node:fs").readFileSync("test/frozen.json", "utf8"); if (!f.includes("FROZEN_DATA_VALUE_")) process.exit(5); console.log("frozen fixture checked");\'';
    const cut = await start({ exclude: [file], checks: ["node --check src/math.mjs"], verify: [readFixture, "git rev-parse HEAD"] },
      { ZODCHI_FLOW_CUT: "submit review" });
    t.eq(cut.code, 75, "the review was submitted before a simulated interruption");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const result = await cli(["branch-review", "--resume", id]);
    const omitted = result.json?.excludedDiff?.[0];
    t.eq([result.code, result.json?.head, result.json?.files?.includes(file), omitted?.path, omitted?.after?.blob, omitted?.after?.bytes],
      [0, head, true, file, blob, Buffer.byteLength(payload)], "the final review names the same commit and exact omitted blob");
    const verification = result.json?.verification;
    t.eq([verification?.ok, verification?.tree, verification?.head, verification?.evidence?.map(check => check.exitCode)],
      [true, gitOut(f.r, ["rev-parse", head + "^{tree}"]), head, [0, 0, 0]], "branch-review verifies the exact pinned head, including the omitted file");
    const events = fs.readFileSync(path.join(f.w.zhome, "flows", id, "events.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    t.eq(events.filter(event => event.kind === "check started" && event.step === "verify").length, 3,
      "resuming does not execute completed checks again");
    t.eq(f.steps(), ["review"], "resume reuses the review turn");
    const log = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8");
    t.ok(log.includes("excluded-diff.json") && log.includes(file) && log.includes(blob)
      && log.includes("src/math.mjs") && !log.includes("FROZEN_DATA_VALUE_" + "x".repeat(32)),
      "the reviewer receives the fixture manifest and full code diff");
    t.ok(log.includes("verification.json") && log.includes("frozen fixture checked"), "the reviewer sees real check output");
    const prompt = JSON.parse(log.trim()).prompt;
    const reviewEvidence = JSON.parse(prompt.split('<attachment path="verification.json">\n')[1].split("\n</attachment>")[0]);
    t.eq(reviewEvidence.commands[2].output.trim(), head, "the check's own Git output identifies the original commit");
    const missingVerification = await start({ exclude: [file], checks: ["node -e 'process.exit(7)'"], verify: ["git rev-parse HEAD"] });
    t.eq([missingVerification.code, missingVerification.json?.stoppedAt, missingVerification.json?.verification?.evidence?.map(check => check.exitCode), f.steps()],
      [2, "checks failed at verify", [7], ["review"]], "a failed check stops before the next command and reviewer");
  });

  scenario("flow-branch-review-ignore-gate", "a missing local ignore rule is reported before accepting a review", async (t) => {
    const f = flowWorld(t, "flow-branch-review-ignore-gate");
    fs.writeFileSync(path.join(f.r, ".gitignore"), "!.agent-tmp/\n!.agent-tmp/gateway/\n");
    fs.writeFileSync(path.join(f.r, "src/math.mjs"), FIXED);
    gitOut(f.r, ["commit", "-qm", "fix clamp", "--", "src/math.mjs"]);
    const args = path.join(f.w.dir, "branch.json");
    fs.writeFileSync(args, JSON.stringify({ label: "review-ignore", repo: f.r, base: f.base, author: ["codex/fake-writer"] }));
    const result = await zodchi(t, f.w, ["flow", "branch-review", "--args", args], { cwd: f.r, env: f.w.env });
    t.eq([result.code, result.json?.runId ?? null, f.steps()], [2, null, []], "the missing ignore rule leaves no run");
    t.ok(result.json?.refused?.includes("does not ignore .agent-tmp/"), "the local Git prerequisite is reported in the gate");
  });

  scenario("flow-branch-review-source", "a finished code package supplies the full range and findings to review only", async (t) => {
    const f = flowWorld(t, "flow-branch-review-source");
    f.answer("write", f.patch([f.modify("src/math.mjs", "export const clamp = (x, lo, hi) => x;\n", FIXED)]));
    f.answer("review 1", f.review("changes_requested", [f.finding("F35")]));
    const original = await f.flow(["--args", f.args({ rounds: 1 })]);
    t.eq(original.json?.verdict ?? null, "changes_requested", "the original package finished without approval");
    const reviewOnly = (fields) => {
      const args = path.join(f.w.dir, "rereview.json");
      fs.writeFileSync(args, JSON.stringify({ label: "rereview", repo: f.r, sourceRun: original.json.runId, ...fields }));
      return zodchi(t, f.w, ["flow", "branch-review", "--args", args], { cwd: f.r, env: f.w.env });
    };
    const commit = (rel, text) => {
      fs.writeFileSync(path.join(f.r, rel), text);
      gitOut(f.r, ["add", "--", rel]);
      gitOut(f.r, ["commit", "-qm", "follow-up"]);
      return gitOut(f.r, ["rev-parse", "HEAD"]);
    };
    const corrected = commit("src/math.mjs", `// Keeps each value in range.\n${FIXED}`);
    const unrelated = commit("src/other.mjs", "// outside package\n");
    const stale = await reviewOnly({ head: corrected, verificationRun: original.json.runId });
    t.ok(stale.json?.refused?.includes("no passing checks for tree"), "checks from a different tree are refused");
    const outside = await reviewOnly({ head: unrelated });
    t.ok(outside.json?.refused?.includes("src/other.mjs is outside"), "diffs containing another package are refused before review");
    f.answer("review", f.review("approved"));
    const review = await reviewOnly({ head: corrected });
    t.eq([review.code, review.json?.sourceRun, review.json?.base, review.json?.head, review.json?.models?.reviewer?.model],
      [0, original.json.runId, f.base, corrected, "fake-reviewer"], "the original base and exact correction are fixed, with an independent reviewer");
    const reviewJournal = path.join(f.w.zhome, "flows", review.json.runId);
    const material = fs.readFileSync(path.join(reviewJournal, "material.md"), "utf8");
    t.ok(material.includes("F35 important") && material.includes("Make clamp(x, lo, hi)")
      && material.includes("export const clamp = (x, lo, hi) => x;") && material.includes("Keeps each value in range")
      && !material.includes("outside package"), "the reviewer sees the original change, correction, brief and findings");
    t.eq(f.steps(), ["write", "review 1", "review"], "the successor review starts no writer and rejected inputs spend no calls");
  });
}
