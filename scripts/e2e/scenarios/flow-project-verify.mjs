import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, zodchi, STUB, FIXED }) {
  function configure(f, value) {
    const file = path.join(f.r, ".zodchi", "verify.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    gitOut(f.r, ["add", "--", ".zodchi/verify.json"]);
    gitOut(f.r, ["commit", "-qm", "Declare project verification"]);
    return file;
  }

  const readJsonl = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  const eventsFile = (result) => path.join(result.json.journal, "events.jsonl");
  const gapStates = (gaps) => gaps.map(({ id, state }) => [id, state]);
  const options = ["accept", "attach context or verification", "review again"];
  const cli = (t, f, args, env = {}) => zodchi(t, f.w, args, { cwd: f.r, env: { ...f.w.env, ...env } });

  function reply(t, f, id, text, env) {
    const file = path.join(f.w.dir, "gap-reply.txt");
    fs.writeFileSync(file, text);
    return cli(t, f, ["flow", "reply", id, "--file", file], env);
  }

  function gapWorld(t, name) {
    const f = flowWorld(t, name);
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    return f;
  }

  const gap = (what, why, writerCloseable = false) => ({ what, why, writerCloseable });
  const blocked = (f, gaps) => ({ ...f.review("blocked"), gaps });

  async function mixedGaps(t) {
    const f = gapWorld(t, "flow-project-verify-mixed-gaps");
    const writer = gap("Evidence for the lower bound", "Show a lower-bound check.", true);
    const owner = gap("Expected production limits", "Only the owner knows the production limits.");
    f.answer("review 1", blocked(f, [writer, owner]));
    f.answer("close 1", f.patch([f.modify("src/math.mjs", FIXED, "// Keep limits inclusive.\n" + FIXED)]));
    f.answer("review 2", blocked(f, [{ ...writer, what: "  EVIDENCE FOR  the lower bound  " }, owner]));
    f.answer("close 2", f.patch([], "The lower-bound assertion in test/math.test.mjs passed."));
    f.answer("review 3", blocked(f, [owner]));

    const wait = await f.flow(["--args", f.args({ rounds: 4, budget: { calls: 6 } })]);
    t.eq([wait.code, wait.json.status, f.claim().status], [2, "waiting", "open"], "unsettled evidence waits with the claim open");
    t.eq(wait.json.rounds.map(({ verdict }) => verdict), ["changes_requested", "changes_requested", "blocked"],
      "both writer rounds precede the owner question");
    t.eq(f.steps(), ["write", "review 1", "close 1", "review 2", "close 2", "review 3"],
      "the writer is asked again while another round remains");
    const events = readJsonl(eventsFile(wait));
    for (const round of [1, 2]) {
      const done = events.findIndex((event) => event.kind === "done" && event.step === `review ${round}`);
      t.eq(events.slice(done + 1, done + 3).map((event) => [event.kind, event.step]),
        [["gaps", `review ${round}`], ["intent", `close ${round}`]], "the next action is a writer round");
      t.eq(gapStates(events[done + 1].gaps), [["g1-1", "finding"], ["g1-2", "open"]],
        "the unresolved 'what' keeps its ID despite capitalization and whitespace changes");
    }
    const turns = readJsonl(path.join(f.w.codex, "fake-turns.jsonl"));
    for (const { prompt } of turns.filter((turn) => turn.step.startsWith("close "))) {
      t.ok(prompt.includes("g1-1 important evidence gap") && !prompt.includes("g1-2 important evidence gap"),
        "only the evidence the writer can supply becomes a finding");
    }
    const review3 = events.find((event) => event.kind === "gaps" && event.step === "review 3");
    t.eq(gapStates(review3.gaps), [["g1-2", "open"], ["g1-1", "superseded"]], "omitting the writer gap supersedes it");
    const questions = events.filter((event) => event.kind === "waiting");
    t.eq(questions.map(({ step, gaps, options }) => [step, gaps.map(({ id }) => id), options]),
      [["review gaps 3", ["g1-2"], options]], "only the remaining owner gap reaches the owner, even with a writer round available");
    const id = wait.json.runId;
    const status = await cli(t, f, ["flow", "status", id]);
    t.eq([status.code, status.json.question], [0, wait.json.question], "status carries the owner question and reply options");

    const request = events.find((event) => event.kind === "intent" && event.step === "review 1").request;
    const schema = JSON.parse(fs.readFileSync(path.join(wait.json.journal, request), "utf8")).role.outputSchema;
    for (const shape of [schema, schema.properties.findings.items, schema.properties.gaps.items]) {
      t.eq([shape.additionalProperties, [...shape.required].sort()], [false, Object.keys(shape.properties).sort()],
        "every property is required on each strict object schema");
    }
    t.eq(schema.properties.gaps.items.properties.writerCloseable.type, "boolean", "the reviewer gets a boolean closeability field");

    t.eq((await reply(t, f, id, "g1-2: accept\n")).code, 0, "the owner can accept a gap");
    const done = await f.flow(["--resume", id]);
    t.eq([done.code, done.json.verdict, done.json.rounds[2].review.verdict, f.claim().status],
      [0, "approved", "blocked", "done"], "acceptance unblocks the candidate and keeps the reviewer's verdict");
    const applied = readJsonl(eventsFile(done)).find((event) => event.kind === "gaps" && event.step === "review gaps 3");
    t.eq(gapStates(applied.gaps), [["g1-2", "accepted"]], "the acceptance is journaled");
    t.eq([done.json.budget.writerCalls, done.json.budget.reviewerCalls, f.steps()],
      [3, 3, ["write", "review 1", "close 1", "review 2", "close 2", "review 3"]], "accepting a gap spends no model call");
  }

  async function attachedEvidence(t) {
    const f = gapWorld(t, "flow-project-verify-gap-context");
    const first = gap("Owner sign-off", "The reviewer has no sign-off.");
    const second = gap("Boundary fixture coverage", "The reviewer needs another check receipt.", true);
    f.answer("review 1", blocked(f, [first, second]));
    f.answer("review 2", blocked(f, [second, { ...first, what: "OWNER SIGN-OFF" }]));
    const wait = await f.flow(["--args", f.args({ rounds: 1, budget: { calls: 2 } })]);
    const id = wait.json.runId;
    t.eq([wait.code, gapStates(wait.json.openGaps), f.steps()],
      [2, [["g1-1", "open"], ["g1-2", "open"]], ["write", "review 1"]],
      "with no writer rounds left both gaps need a reply");
    const file = eventsFile(wait);
    // Treat a partial last line like a cut while appending a reply. An invalid reply must leave it alone.
    fs.appendFileSync(file, '{"kind":"rerun"');
    const before = fs.readFileSync(file);
    for (const [text, problem] of [
      ["g1-1: accept\ng1-2: review again\ng1-9: accept", "Unknown review gap g1-9"],
      ["g1-1: accept\ng1-2: accept\ng1-1: review again", "Repeated review gap g1-1"],
      ["g1-1: accept", "Missing decision for review gap g1-2"],
    ]) {
      const refused = await reply(t, f, id, text);
      t.ok(refused.code === 1 && refused.err.includes(problem), "the invalid reply is refused");
      t.ok(fs.readFileSync(file).equals(before), "a refused reply leaves the journal unchanged");
    }

    const material = "  Verification: the boundary fixture passed.\nReceipt 42 confirms inclusive limits.";
    const recorded = await reply(t, f, id,
      `g1-1: accept\nThe sign-off needs no further review.\ng1-2: attach context or verification\n${material}\n`);
    t.eq([recorded.code, recorded.json.status], [0, "ready"], "one reply addresses both gaps");
    const budget = await f.flow(["--resume", id]);
    t.eq([budget.code, budget.json.stoppedAt, budget.json.budget.reviewerCalls, f.steps()],
      [2, "budget at review 2", 1, ["write", "review 1"]], "a gap review waits at the normal budget limit");
    const applied = readJsonl(file).find((event) => event.kind === "gaps" && event.step === "review gaps 1");
    t.eq(gapStates(applied.gaps), [["g1-1", "accepted"], ["g1-2", "context attached"]],
      "the accept and attach choices are applied to their own gaps");
    t.eq((await cli(t, f, ["flow", "budget", id, "--add-calls", "1"])).code, 0, "one more call fits the extended budget");

    const again = await f.flow(["--resume", id]);
    t.eq([again.code, gapStates(again.json.openGaps), again.json.budget.reviewerCalls, f.steps()],
      [2, [["g1-2", "open"]], 2, ["write", "review 1", "review 2"]],
      "the same unresolved gap survives the review and the accepted one stays waived");
    const { prompt } = readJsonl(path.join(f.w.codex, "fake-turns.jsonl")).find((turn) => turn.step === "review 2");
    const attachment = prompt.match(/<attachment path="owner-gap-reply\.json">\n([^\n]+)\n<\/attachment>/);
    t.ok(attachment, "the reviewer receives a dedicated attachment for the reply");
    t.eq(JSON.parse(attachment[1]).decisions.map((decision) => [decision.id, decision.option, decision.material ?? null]),
      [["g1-1", "accept", null], ["g1-2", "attach context or verification", material]], "multiline evidence belongs to the selected gap");
    t.eq((await reply(t, f, id, "g1-2: accept")).code, 0, "the remaining gap can be resolved independently");
    const done = await f.flow(["--resume", id]);
    t.eq([done.code, done.json.approved, done.json.budget.reviewerCalls, f.steps()],
      [0, true, 2, ["write", "review 1", "review 2"]], "both decisions are replayed without another call");
  }

  async function reviewAgainAfterCuts(t) {
    const f = gapWorld(t, "flow-project-verify-gap-resume");
    const old = { ...f.review("blocked"), summary: "The old reviewer could not confirm the fixture result." };
    f.answer("review 1", old);
    f.answer("review 2", { ...f.review("approved"), gaps: [] });
    const wait = await f.flow(["--args", f.args({ rounds: 1, budget: { calls: 3 } })]);
    const id = wait.json.runId;
    const file = eventsFile(wait);
    t.eq([wait.code, gapStates(wait.json.openGaps), wait.json.openGaps[0].what], [2, [["g1-0", "open"]], old.summary],
      "the decoder accepts the old answer and the owner sees its summary");
    t.ok(options.every((option) => wait.json.question.includes(`<gap id>: ${option}`)), "the owner question shows all three options");

    const replyCut = await reply(t, f, id, "g1-0: review again\n", { ZODCHI_FLOW_CUT: "review gap reply" });
    t.eq([replyCut.code, f.steps()], [75, ["write", "review 1"]], "the reply is durable before any new review");
    const answer = readJsonl(file).at(-1);
    t.eq([answer.kind, answer.step, answer.ownerAnswer[0].option], ["rerun", "review gaps 1", "review again"],
      "the journal has the owner's decision");

    const intentCut = await f.flow(["--resume", id], { ZODCHI_FLOW_CUT: "intent review 2" });
    t.eq([intentCut.code, f.steps()], [75, ["write", "review 1"]], "resume reserves a reviewer key before dispatch");
    const beforeDispatch = readJsonl(file);
    const intent = beforeDispatch.at(-1);
    t.eq([intent.kind, intent.step, intent.gapReplySeq], ["intent", "review 2", answer.seq], "the intent binds the reply to the new review");
    t.eq(gapStates(beforeDispatch.find((event) => event.kind === "gaps" && event.step === answer.step).gaps),
      [["g1-0", "review again"]], "the review-again decision is applied before the intent");
    const reserved = await cli(t, f, ["flow", "status", id]);
    t.eq([reserved.json.jobKey, reserved.json.budget.callLimit, reserved.json.budget.reviewerCalls],
      [intent.key, 3, 2], "the durable intent reserves one call before dispatch");

    const submitCut = await f.flow(["--resume", id], { ZODCHI_FLOW_CUT: "submit review 2" });
    t.eq(submitCut.code, 75, "resume dispatches the recorded key and cuts before the outcome is recorded");
    t.eq(readJsonl(file), beforeDispatch, "submission needs no second intent and leaves no recorded outcome yet");
    const job = await cli(t, f, ["wait", "--key", intent.key, "--wait-sec", "60"]);
    t.eq([job.code, job.json.job.key, f.steps()], [0, intent.key, ["write", "review 1", "review 2"]],
      "the executor finished one re-review under the reserved key");

    const done = await f.flow(["--resume", id]);
    t.eq([done.code, done.json.approved, done.json.budget.callLimit, done.json.budget.writerCalls,
      done.json.budget.reviewerCalls, done.json.budget.checkRuns, f.steps()],
      [0, true, 3, 1, 2, 1, ["write", "review 1", "review 2"]], "outcome recovery uses the same key and the same budget charge");
    const events = readJsonl(file);
    t.eq(events.filter((event) => event.kind === "intent" && event.step === "review 2").map((event) => event.key),
      [intent.key], "the reply has exactly one durable review intent");
    t.eq(events.find((event) => event.kind === "done" && event.step === "review 1").result, old,
      "the old-format blocked review remains in the journal");
  }

  async function reviewAgainAfterFailure(t) {
    const f = gapWorld(t, "flow-project-verify-gap-rerun");
    f.answer("review 1", blocked(f, [gap("Owner sign-off", "The reviewer has no sign-off.")]));
    f.answer("review 2", { flowError: { message: "Fixture re-review failed." } });
    const wait = await f.flow(["--args", f.args({ rounds: 1, budget: { calls: 4 } })]);
    const id = wait.json.runId;
    const file = eventsFile(wait);
    t.eq((await reply(t, f, id, "g1-1: review again")).code, 0, "the owner requests another review");
    const answer = readJsonl(file).at(-1);

    const failed = await f.flow(["--resume", id]);
    t.eq([failed.code, failed.json.stoppedAt, failed.json.budget.reviewerCalls, f.claim().status, f.steps()],
      [2, "gateway failed at review 2", 2, "open", ["write", "review 1", "review 2"]],
      "the failed re-review spends one call and leaves the claim open");
    t.ok(failed.json.next.includes('--rerun "review 2"'), "the stop tells the owner how to retry under a new key");
    const first = readJsonl(file).find((event) => event.kind === "intent" && event.step === "review 2");

    f.answer("review 2", { ...f.review("approved"), gaps: [] });
    const resumed = await f.flow(["--resume", id]);
    t.eq([resumed.code, resumed.json.stoppedAt, resumed.json.budget.reviewerCalls, f.steps()],
      [2, "gateway failed at review 2", 2, ["write", "review 1", "review 2"]],
      "a plain resume reads the failed outcome without spending another call");

    const done = await f.flow(["--resume", id, "--rerun", "review 2"]);
    t.eq([done.code, done.json.approved, done.json.budget.callLimit, done.json.budget.writerCalls,
      done.json.budget.reviewerCalls, f.claim().status, f.steps()],
      [0, true, 4, 1, 3, "done", ["write", "review 1", "review 2", "review 2"]],
      "an explicit rerun completes the review with exactly one additional charged call");
    const intents = readJsonl(file).filter((event) => event.kind === "intent" && event.step === "review 2");
    t.eq(intents.map(({ attempt, key, gapReplySeq }) => [attempt, key, gapReplySeq]),
      [[1, first.key, answer.seq], [2, `${first.key}-a2`, answer.seq]], "the new key is bound to the original reply");
  }

  async function blockedWithFindings(t) {
    const f = gapWorld(t, "flow-project-verify-blocked-findings");
    f.answer("review 1", { ...f.review("blocked", [f.finding("F1")]), gaps: [gap("Owner sign-off", "No sign-off is attached.")] });
    const result = await f.flow(["--args", f.args()]);
    t.eq([result.code, result.json.stoppedAt, f.claim().status, f.steps()],
      [2, "review verdict blocked", "stopped", ["write", "review 1"]], "blocked with findings still finishes directly");
    const events = readJsonl(eventsFile(result));
    const review = events.findIndex((event) => event.kind === "intent" && event.step === "review 1");
    t.eq(events.slice(review).filter((event) => event.kind !== "cleanup").map((event) => event.kind),
      ["intent", "submitted", "done", "closing", "finished"],
      "blocked with findings keeps its existing journal sequence");
  }

  scenario("flow-project-verify", "a review finding closes with pinned checks and full verification, and evidence gaps go to the writer or owner", async (t) => {
    const f = flowWorld(t, "flow-project-verify");
    const file = configure(f, {
      checks: ["node --check src/math.mjs"],
      verify: ["node test/math.test.mjs"],
      full: { run: "local", commands: ["node smoke.mjs"] },
    });
    const base = gitOut(f.r, ["rev-parse", "HEAD"]);
    const closed = "// The result stays inside the range.\n" + FIXED;
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("changes_requested", [f.finding("F1")]));
    f.answer("close 1", f.patch([f.modify("src/math.mjs", FIXED, closed)]));
    f.answer("review 2", f.review("approved"));
    const cut = await f.flow(["--args", f.args({ checks: [], verify: [] })], { ZODCHI_FLOW_CUT: "apply write" });
    t.eq(cut.code, 75, "the package has pinned the verification plan");
    fs.writeFileSync(file, JSON.stringify({ verify: ["node smoke.mjs --fail"] }));
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const result = await f.flow(["--resume", id]);
    t.eq([result.code, result.json.verdict, result.json.verifiedBy], [0, "approved", "project.verify"], "uses the plan from the recorded base");
    t.eq(result.json.rounds.map(round => round.verdict), ["changes_requested", "approved"], "the second round is approved");
    t.ok(/F1 important src\/math\.mjs:1/.test(result.json.rounds[0].review.findings[0]), "the finding is read with its severity");
    t.eq(gitOut(f.r, ["log", "--format=%s", `${base}..HEAD`]).split("\n"), ["clamp: round 2", "clamp: round 1"], "one commit per round");
    t.eq(fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8"), closed, "the close round's patch is in place");
    const turns = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const close = turns.find(turn => turn.step === "close 1");
    t.ok(close.prompt.includes("F1 important") && close.prompt.includes('<attachment path="review-1.json">'), "the writer got the finding and the review");
    const second = turns.find(turn => turn.step === "review 2");
    t.ok(second.prompt.includes('<attachment path="review-1.json">'), "the second review sees the first");
    for (const round of result.json.rounds) {
      t.eq(round.checks.evidence.map((command) => command.source), ["project.checks", "project.verify"],
        "each round runs only the two targeted lists");
    }
    t.eq(result.json.fullVerification.evidence.map((command) => [command.source, command.exitCode]),
      [["project.full", 0]], "the accepted tree receives one full check receipt");
    t.eq(result.json.fullVerification.tree, result.json.rounds[1].commit.tree, "full checks use the exact commit tree");
    t.eq(f.steps(), ["write", "review 1", "close 1", "review 2"], "the cut and verification add no model calls");
    const events = readJsonl(eventsFile(result));
    t.ok(!events.some((event) => event.kind === "gaps" || event.kind === "waiting"), "ordinary approval adds no gap events");

    await mixedGaps(t);
    await attachedEvidence(t);
    await reviewAgainAfterCuts(t);
    await reviewAgainAfterFailure(t);
    await blockedWithFindings(t);
  });

  scenario("flow-project-verify-ci", "scoped verification overrides the default and records pending CI separately", async (t) => {
    const f = flowWorld(t, "flow-project-verify-ci");
    configure(f, { verify: ["node smoke.mjs --fail"], full: { run: "ci" } });
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const result = await f.flow(["--args", f.args()]);
    t.eq([result.code, result.json.verifiedBy, result.json.fullVerification], [0, "args.verify", { status: "pending_ci" }],
      "the package uses the supplied scoped command and leaves a CI status");
  });

  scenario("flow-project-verify-inputs", "missing project tools are reported before writing and checks locate inputs from an isolated export", async (t) => {
    const f = flowWorld(t, "flow-project-verify-inputs");
    configure(f, { tools: ["fixture-missing-tool"], verify: ["node smoke.mjs"] });
    const stopped = await f.flow(["--args", f.args({ checks: [], verify: [] })]);
    t.ok(stopped.json?.refused?.includes("fixture-missing-tool"), "the missing tool is an environment error");
    t.eq(f.steps(), [], "no model is called before the tool check");
    configure(f, {
      tools: ["node"],
      verify: [`node -e 'const fs = require("node:fs"); const p = require("node:path"); const s = process.env.ZODCHI_VERIFY_REPOSITORY; if (fs.realpathSync(s) === fs.realpathSync(".") || !fs.existsSync(p.join(s,".zodchi","verify.json"))) process.exit(2);'`],
    });
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("approved"));
    const passed = await f.flow(["--args", f.args({ checks: [], verify: [] })]);
    t.eq([passed.code, passed.json?.rounds?.[0]?.checks?.evidence?.[0]?.exitCode], [0, 0], "the check receives the source locator and runs in the distinct candidate");
  });
}
