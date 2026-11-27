import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const assignment = (name, value) => `${name} = ${JSON.stringify(value)}`;

const facts = (quote) => ({
  facts: [{ claim: "The clamp implementation currently returns the original value.", file: "repo1/src/math.mjs", line: 1, quote }],
  unknowns: [],
});
const draft = (criterion, ownerDecisions = []) => ({
  markdown: [
    "# Bounded clamp", "", "## Goal", "Respect the specified limits.", "", "## Review boundary",
    "Important: clamp must return the limit when the input exceeds it.", "Out of scope: a new module layout.",
    "", "## Checks", criterion,
  ].join("\n"),
  ownerDecisions,
  unverified: [],
});

export default function register({ scenario, flowWorld, gitOut, zodchi, STUB, ROOT }) {
  const argsFor = (f, output, extra = {}) => {
    const args = path.join(f.w.dir, "brief-input.json");
    fs.writeFileSync(args, JSON.stringify({
      label: "clamp", goal: "Keep the clamp output within the requested range.",
      repos: [f.r], out: output, publicRepo: true,
      questions: [{ question: "What does clamp do today?", files: ["src/math.mjs"] }],
      models: { architect: { candidates: [{ provider: "codex", model: "fake-architect", effort: "high" }] } },
      ...extra,
    }));
    return args;
  };
  const flow = (t, f, args, env = {}) => zodchi(t, f.w, ["flow", ...args], { cwd: f.w.dir, env: { ...f.w.env, ...env } });

  scenario("flow-design-brief-private-word-exception", "private source exceptions and owner choices for screened task lines", async (t) => {
    const f = flowWorld(t, "flow-design-brief-private-word-exception");
    const allowed = "Fixture Harbor";
    const denied = "Fixture Ledger";
    const sensitive = "local-only-value";
    f.w.env.ZODCHI_DENYLIST = path.join(f.w.dir, "private-words.txt");
    fs.writeFileSync(f.w.env.ZODCHI_DENYLIST, `${allowed}\n${denied}\n`);
    const relative = "src/Fixture Harbor-id.mjs";
    const sourceLine = 'export const header = "X-Fixture Harbor-Product";';
    fs.writeFileSync(path.join(f.r, relative), `${sourceLine}\n// ${denied}\nconst ${assignment("token", sensitive)};\n`);
    gitOut(f.r, ["add", "--", relative]);
    gitOut(f.r, ["commit", "-qm", "add the private identifier fixture"]);
    const output = path.join(f.w.dir, "private.md");
    const options = { allowPrivateWords: ["fixture harbor"], questions: ["Where is the identifier defined?"] };
    const publicRun = await flow(t, f, ["design-brief", "--args", argsFor(f, output, options)]);
    t.ok(publicRun.code === 2 && /only for private design briefs/.test(publicRun.json?.refused ?? ""),
      "a public brief cannot declare a private-word exception");
    const alias = `repo1/${relative}`;
    f.answer("plan", { questions: [{ question: options.questions[0], files: [alias] }] });
    f.answer("facts 1", { facts: [{ claim: "Uses the Fixture Harbor header.", file: alias, line: 1, quote: sourceLine }], unknowns: [] });
    f.answer("draft", draft(`Verify the header from ${alias}.`));
    f.answer("review", f.review("approved"));
    const args = argsFor(f, output, { ...options, publicRepo: false });
    const result = await flow(t, f, ["design-brief", "--args", args]);
    t.eq([result.code, result.json?.facts, f.steps()], [0, 1, ["plan", "facts 1", "draft", "review"]],
      "the same alias is available to planning, research and drafting");
    const record = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8");
    t.ok(record.includes(alias) && record.includes("X-Fixture Harbor-Product") && !record.includes(denied) && !record.includes(sensitive),
      "the exact exception preserves the identifier and screens other words and credential lines");
    t.ok(fs.readFileSync(output, "utf8").includes(alias), "the approved draft keeps the real relative path");

    const continueChoice = "Continue without those lines";
    const stopChoice = "Stop to rephrase";
    const allowChoice = "Allow these words for this run";
    const goalLine = `Review the clamp rollout with ${denied}.`;
    const goalKeywordLine = "Fix the token refresh";
    const mixedGoalLine = `Review password handling with ${denied}.`;
    const goal = ["Keep the clamp within its range.", goalLine, "Check both limits.", goalKeywordLine, mixedGoalLine].join("\n");
    const question = "What does clamp do today?";
    const questionKeywordLine = "How is the cookie renewed?";
    const fileHint = "repo1/src/math.mjs";
    const extract = path.join(f.w.dir, "rollout.md");
    const invented = ["sk", "live", "fixturevalue".repeat(3)].join("-");
    const contextLine = `Keep the rollout notes from ${denied}.`;
    const contextKeywordLine = "Describe how the cookie is scoped.";
    const keywordLines = [goalKeywordLine, mixedGoalLine, questionKeywordLine, contextKeywordLine];
    fs.writeFileSync(extract, ["Compare the two limits.", assignment("api_key", `${invented}-${denied}`), contextLine, contextKeywordLine].join("\n") + "\n");
    const begin = async (name, publicRepo, questions, context = []) => {
      const output = path.join(f.w.dir, `${name}.md`);
      const prior = f.steps().length;
      const args = argsFor(f, output, { publicRepo, goal, questions, context });
      const waiting = await flow(t, f, ["design-brief", "--args", args]);
      const id = waiting.json?.runId;
      t.eq([waiting.code, waiting.json?.status, waiting.json?.ownerDecisions?.[0]?.options, f.steps().length, fs.existsSync(output)],
        [2, "waiting", publicRepo ? [continueChoice, stopChoice, allowChoice] : [continueChoice, stopChoice], prior, false],
        "the workflow waits for a screening choice before using a model");
      t.ok(waiting.json?.question?.includes("goal:2 (private-word)"), "the question identifies the affected goal line and reason");
      t.ok(["goal:4 (credential)", "goal:5 (credential)"].every(location => waiting.json?.question?.includes(location)),
        "the question reports goal lines matched by the original task rule, including a line that also contains a private word");
      const pin = JSON.parse(fs.readFileSync(path.join(waiting.json.journal, "run.json"), "utf8"));
      t.ok(pin.inputs?.argsSha256 && !pin.inputs?.args, "the run pins its argument digest without saving the withheld goal in run.json");
      return { ...waiting, id, output, prior, args };
    };
    const noLeak = (run, ...responses) => {
      const readJournal = name => fs.readFileSync(path.join(run.json.journal, name), "utf8");
      const diagnostics = [readJournal("events.jsonl"), readJournal("result.json"),
        ...[run, ...responses].flatMap(response => [response.out, response.err])];
      const hidden = [denied, invented, ...keywordLines].map(value => value.toLowerCase());
      t.ok(diagnostics.every(text => !hidden.some(value => text.toLowerCase().includes(value))),
        "events, results and CLI diagnostics omit the matched task text");
    };
    const choose = async (run, choice) => {
      const file = path.join(f.w.dir, "screening-choice.txt");
      fs.writeFileSync(file, choice);
      const replied = await flow(t, f, ["reply", run.id, "--file", file]);
      t.eq([replied.code, replied.json?.status], [0, "ready"], "the normal reply command records the screening choice");
      return replied;
    };
    const planPrompt = run => JSON.parse(fs.readFileSync(path.join(run.json.journal, "requests", `flow-${run.id}-plan.json`), "utf8")).prompt;
    f.answer("facts 1", facts(STUB.trim()));
    f.answer("draft", draft("Check both limits."));

    const screenedQuestion = `${question}\n[private text removed]\n[source line withheld]`;
    const continued = await begin("without-lines", false, [[question, `Ask ${denied}.`, questionKeywordLine].join("\n")], [extract]);
    const waiting = await flow(t, f, ["status", continued.id]);
    const repeated = await flow(t, f, ["design-brief", "--resume", continued.id, "--args", continued.args]);
    t.eq([waiting.json?.status, repeated.json?.question, f.steps().length], ["waiting", continued.json?.question, continued.prior],
      "status and resume expose the same waiting decision before any model call");
    const locations = ["questions[1]:2 (private-word)", "questions[1]:3 (credential)",
      "context-1.md:2 (credential)", "context-1.md:3 (private-word)", "context-1.md:4 (credential)"];
    t.ok(locations.every(location => continued.json?.question?.includes(location)),
      "the owner can identify affected lines in questions and context documents");
    const keep = await choose(continued, continueChoice);
    f.answer("plan", { questions: [{ question: `${screenedQuestion}\nSend the report to ${denied}.`, files: [fileHint] }] });
    const resumed = await flow(t, f, ["design-brief", "--resume", continued.id]);
    t.eq([resumed.code, f.steps().slice(continued.prior), fs.existsSync(continued.output)],
      [0, ["plan", "facts 1", "draft", "review"], true], "continue uses the retained task on the same run");
    const screenedPrompt = planPrompt(continued);
    t.ok(screenedPrompt.includes("Keep the clamp within its range.") && screenedPrompt.includes("Check both limits.")
      && !screenedPrompt.includes(denied) && !screenedPrompt.includes(invented), "the planner gets the remaining goal and context lines");
    t.ok(keywordLines.every(line => !screenedPrompt.includes(line)), "continuing with screened input withholds each line matched by the original rule");
    noLeak(continued, waiting, repeated, keep, resumed);

    const stopped = await begin("rephrase", false, [question]);
    const stopReply = await choose(stopped, stopChoice);
    const refused = await flow(t, f, ["design-brief", "--resume", stopped.id]);
    t.ok(refused.code === 2 && refused.json?.refused?.includes("stopped to rephrase") && f.steps().length === stopped.prior && !fs.existsSync(stopped.output),
      "stopping to rephrase finishes without a request or publication");
    noLeak(stopped, stopReply, refused);

    const permitted = await begin("allow-words", true, [question], [extract]);
    const allowReply = await choose(permitted, allowChoice);
    fs.writeFileSync(extract, "An edit after the run pinned the document.\n");
    f.answer("plan", { questions: [{ question: `${question}\nSend the report to ${denied}.`, files: [fileHint] }] });
    const interrupted = await flow(t, f, ["design-brief", "--resume", permitted.id], { ZODCHI_FLOW_CUT: "submit plan" });
    t.eq(interrupted.code, 75, "the allowed prompt is pinned before the first call");
    const receipt = JSON.parse(fs.readFileSync(path.join(permitted.json.journal, "task-screening.json"), "utf8"));
    t.eq(receipt.allowPrivateWords, [denied.toLowerCase()], "the private journal records the approved word for this run");
    const allowedPrompt = planPrompt(permitted);
    t.ok(allowedPrompt.includes(goalLine) && allowedPrompt.includes(contextLine) && !allowedPrompt.includes(invented)
      && !allowedPrompt.includes("An edit after the run"), "the approved original lines reach the planner while the credential stays withheld");
    t.ok(keywordLines.every(line => !allowedPrompt.includes(line)), "the word exception leaves lines matched by the original rule withheld");
    const approved = await flow(t, f, ["design-brief", "--resume", permitted.id]);
    t.eq([approved.code, f.steps().slice(permitted.prior)], [0, ["plan", "facts 1", "draft", "review"]],
      "the accepted task uses its saved plan turn after interruption");
    noLeak(permitted, allowReply, interrupted, approved);
  });

  scenario("flow-design-brief-large-source", "oversized Git sources use numbered extracts or wait for a same-run reply", async t => {
    const f = flowWorld(t, "flow-design-brief-large-source");
    const question = "What limit does the generated configuration declare?";
    const relative = "src/generated.mjs";
    const alias = "repo1/src/generated.mjs";
    const quote = "export const limit = 42;";
    fs.writeFileSync(path.join(f.r, relative), quote + "\n// padding\n".repeat(20_000));
    gitOut(f.r, ["add", "--", relative]);
    gitOut(f.r, ["commit", "-qm", "add a large generated file"]);
    const extract = path.join(f.w.dir, "extract.md");
    fs.writeFileSync(extract, quote + "\n");
    const cited = file => ({ facts: [{ claim: "The declared limit is 42.", file, line: 1, quote }], unknowns: [] });
    f.answer("plan", { questions: [{ question, files: [alias, "repo1/src/math.mjs"] }] });
    f.answer("facts 1", cited("context-1.md"));
    f.answer("draft", draft("Confirm the declared limit from the supplied extract."));
    f.answer("review", f.review("approved"));
    const output = path.join(f.w.dir, "with-extract.md");
    const contextOnly = await flow(t, f, ["design-brief", "--args", argsFor(f, output, { questions: [question], context: [extract] })]);
    t.eq([contextOnly.code, contextOnly.json?.status, contextOnly.json?.repositoryFacts, contextOnly.json?.contextFacts, f.steps()],
      [2, "waiting", 0, 1, ["plan", "facts 1"]], "a readable repository source and a verified context quote still require an owner decision");
    t.ok(/No repository facts/.test(contextOnly.json?.question ?? "") && !contextOnly.json?.draft && !fs.existsSync(output),
      "the context-only stop explains the missing evidence before writing a draft");
    const request = (result, step) => JSON.parse(fs.readFileSync(path.join(result.journal, "requests", `flow-${result.runId}-${step}.json`), "utf8")).prompt;
    const planPrompt = request(contextOnly.json, "plan");
    const available = planPrompt.match(/<attachment path="available-files\.txt">\n([\s\S]*?)\n<\/attachment>/);
    t.ok(available[1].includes("context-1.md") && !available[1].includes(alias), "the readable inventory includes the extract alias");
    const oversized = planPrompt.match(/<attachment path="oversized-files\.txt">\n([\s\S]*?)\n<\/attachment>/);
    t.eq(oversized?.[1].split("\n"), [alias], "the planner can cite the oversized file by its pinned alias");
    t.ok(!planPrompt.includes("// padding"), "the planner receives only the oversized file name");
    const prompt = request(contextOnly.json, "facts-1");
    t.ok(prompt.includes('<attachment path="context-1.md">') && prompt.includes(quote)
      && prompt.includes("limit 174762") && !prompt.includes("// padding"), "facts receive the excerpt and the reason the large blob was omitted");
    const contextRun = contextOnly.json.runId;
    const status = await flow(t, f, ["status", contextRun]);
    t.eq([status.json?.status, status.json?.ownerDecisions?.[0]?.options], ["waiting", ["Continue anyway", "Add sources", "Stop"]],
      "the usual owner status displays all evidence choices");
    const choice = path.join(f.w.dir, "evidence-choice.txt");
    fs.writeFileSync(choice, "Continue anyway");
    const proceed = await flow(t, f, ["reply", contextRun, "--file", choice]);
    t.eq(proceed.code, 0, "the owner can explicitly continue using the existing reply command");
    const result = await flow(t, f, ["design-brief", "--resume", contextRun]);
    t.eq([result.code, result.json?.facts, f.steps()], [0, 1, ["plan", "facts 1", "draft", "review"]],
      "a stale large alias resolves to the attached extract and its verified quote after the owner chooses to proceed");

    const withReply = path.join(f.w.dir, "with-reply.md");
    f.answer("plan", { questions: [{ question, files: [alias] }] });
    const waiting = await flow(t, f, ["design-brief", "--args", argsFor(f, withReply, { questions: [question] })]);
    t.eq([waiting.code, waiting.json?.status, f.steps().at(-1)], [2, "waiting", "plan"],
      "missing readable source asks for input without starting a fact call");
    t.ok(waiting.json.question.includes(alias) && waiting.json.question.includes("flow reply"), "the question names the missing source and the reply command");
    const id = waiting.json.runId;
    const resumedWaiting = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([resumedWaiting.json?.runId, resumedWaiting.json?.status, f.steps().length], [id, "waiting", 5],
      "resuming before an answer preserves the question without repeating the plan");
    const reply = await flow(t, f, ["reply", id, "--file", extract]);
    t.eq(reply.code, 0, "the owner supplies the focused extract to the existing run");
    f.answer("facts 1", cited("owner-source.md"));
    const ownerOnly = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([ownerOnly.code, ownerOnly.json?.status, ownerOnly.json?.repositoryFacts, ownerOnly.json?.contextFacts, f.steps().slice(5)],
      [2, "waiting", 0, 1, ["facts 1"]], "a quote from the owner's extract is context evidence");
    const acceptExtract = await flow(t, f, ["reply", id, "--file", choice]);
    t.eq(acceptExtract.code, 0, "the owner authorizes drafting from the extract");
    const draftCut = await flow(t, f, ["design-brief", "--resume", id], { ZODCHI_FLOW_CUT: "submit draft" });
    t.eq(draftCut.code, 75, "the owner extract supports a saved draft request");
    // Recreate a journal from before the repository evidence gate and origin counts.
    const eventFile = path.join(ownerOnly.json.journal, "events.jsonl");
    const events = fs.readFileSync(eventFile, "utf8").trim().split(/\r?\n/).map(JSON.parse)
      .filter(event => event.step !== "repository evidence");
    const researched = events.find(event => event.kind === "done" && event.step === "facts 1");
    delete researched.result.repositoryFacts;
    fs.writeFileSync(eventFile, events.map((event, index) => JSON.stringify({ ...event, seq: index + 1 })).join("\n") + "\n");
    const resumed = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([resumed.code, resumed.json?.runId, resumed.json?.facts, f.steps().slice(5)],
      [0, id, 1, ["facts 1", "draft", "review"]], "the same run accepts a verified quote from the owner extract");
    t.eq([resumed.json?.repositoryFacts, resumed.json?.contextFacts], [0, 1],
      "an older run resumes its saved draft with context-only evidence");
  });

  scenario("flow-design-brief-claude", "an opted-in brief pins a Claude researcher and writer, and a Codex reviewer", async (t) => {
    const f = flowWorld(t, "flow-design-brief-claude");
    const home = path.join(f.w.dir, "claude-fixture");
    fs.mkdirSync(path.join(home, "answers"), { recursive: true });
    fs.writeFileSync(path.join(home, "fake-auth.json"), "{}");
    fs.writeFileSync(path.join(home, "answers", "facts-1.json"), JSON.stringify(facts(STUB.trim())));
    fs.writeFileSync(path.join(home, "answers", "draft.json"), JSON.stringify(draft("Run the clamp scenario.")));
    f.w.env.FAKE_CLAUDE_HOME = home;
    f.w.env.ZODCHI_CLAUDE_BIN = path.join(ROOT, "scripts", "e2e", "fake-claude.mjs");
    const modelOptions = {
      models: {
        writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "medium" }] },
        researcher: { candidates: [{ provider: "claude", model: "haiku", effort: "high" }] },
      },
    };
    const output = path.join(f.w.dir, "mixed-brief.md");
    const args = argsFor(f, output, modelOptions);
    const denied = await flow(t, f, ["design-brief", "--args", args]);
    t.ok(denied.code === 2 && /not enabled/.test(denied.json?.refused ?? ""), "explicit candidates still need the user's opt-in");
    t.ok(!fs.existsSync(path.join(home, "calls.jsonl")), "the disabled executor was never started");
    fs.writeFileSync(path.join(f.w.zhome, "flow.json"), JSON.stringify({ claude: true }));
    const privateTerm = ["Fixture", "Planning Group"].join(" ");
    f.w.env.ZODCHI_DENYLIST = path.join(f.w.dir, "private-words.txt");
    fs.writeFileSync(f.w.env.ZODCHI_DENYLIST, privateTerm + "\n");
    const screened = await flow(t, f, ["design-brief", "--args", argsFor(f, path.join(f.w.dir, "screened-claude.md"), {
      ...modelOptions,
      goal: `Keep the clamp within its range.\nReview the change with ${privateTerm}.`,
    })]);
    t.eq([screened.code, screened.json?.status, fs.existsSync(path.join(home, "calls.jsonl")), f.steps()],
      [2, "waiting", false, []], "task screening precedes even the first Claude availability call");
    t.ok(screened.json?.question?.includes("goal:2 (private-word)"), "the Claude run displays the affected input location");
    const replyFile = path.join(f.w.dir, "screening-choice.txt");
    fs.writeFileSync(replyFile, "Stop to rephrase");
    const stopped = await flow(t, f, ["reply", screened.json.runId, "--file", replyFile]);
    t.eq(stopped.json?.status, "ready", "the owner can decline before any model preflight");
    const refused = await flow(t, f, ["design-brief", "--resume", screened.json.runId]);
    t.ok(refused.json?.refused?.includes("stopped to rephrase") && !fs.existsSync(path.join(home, "calls.jsonl")),
      "the refused task has no Claude calls");
    argsFor(f, output, modelOptions);
    f.answer("review", f.review("approved"));
    const cut = await flow(t, f, ["design-brief", "--args", args], { ZODCHI_FLOW_CUT: "submit facts 1" });
    t.eq(cut.code, 75, "the process stops after the Claude researcher has finished");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows")).filter(id => id !== screened.json.runId);
    const result = await flow(t, f, ["design-brief", "--resume", id]);
    const pair = result.json?.models;
    t.eq([result.code, result.json?.facts, pair?.researcher?.model, pair?.writer?.model, pair?.architect?.provider],
      [0, 1, "haiku", "sonnet", "codex"], "the same run uses the pinned models and publishes the brief");
    const calls = fs.readFileSync(path.join(home, "calls.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse)
      .filter(row => row.kind === "call" && row.step !== "preflight");
    t.eq(calls.map(row => [row.step, row.model, row.effort]), [["facts 1", "haiku", "high"], ["draft", "sonnet", "medium"]],
      "each Claude expert answers once, with the selected effort");
    t.eq(f.steps(), ["review"], "the independent review is the only Codex turn");
  });

  scenario("flow-design-brief-private-jobs", "long file arguments and an interrupted brief work in a checkout without an ignore rule", async (t) => {
    const f = flowWorld(t, "flow-design-brief-private-jobs");
    fs.writeFileSync(path.join(f.r, ".gitignore"), "");
    gitOut(f.r, ["commit", "-qm", "remove the fixture ignore rule", "--", ".gitignore"]);
    const output = path.join(f.w.dir, "reviewed.md");
    const args = argsFor(f, output, {
      goal: "Проверить поведение функции в двух случаях. ".repeat(120),
      questions: [
        { question: "What does clamp return?", files: ["src/math.mjs"] },
        { question: "Which parameters are used?", files: ["src/math.mjs"] },
      ],
      models: { researcher: { candidates: [{ provider: "codex", model: "fake-researcher", effort: "high" }] } },
    });
    f.answer("facts 1", facts(STUB.trim()));
    f.answer("facts 2", facts(STUB.trim()));
    f.answer("draft", draft("Run the clamp scenario."));
    f.answer("review", f.review("approved"));
    const interrupted = await flow(t, f, ["design-brief", "--args", args], { ZODCHI_FLOW_CUT: "submit facts 2" });
    t.eq(interrupted.code, 75, "the first fact was accepted before the second job was submitted");
    const runs = path.join(f.w.zhome, "flows");
    const [id] = fs.readdirSync(runs);
    fs.writeFileSync(path.join(f.w.zhome, "models.json"), JSON.stringify({ version: 1, roles: {} }));
    const result = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([result.code, result.json?.runId, result.json?.facts, result.json?.models?.researcher?.model],
      [0, id, 2, "fake-researcher"], "the second session uses the recorded research model and both validated steps");
    t.eq(f.steps(), ["facts 1", "facts 2", "draft", "review"], "the resumed run submits no duplicate model turns");
    t.ok(fs.existsSync(path.join(f.w.zhome, "local-jobs")) && fs.existsSync(output), "the private jobs and brief are stored as requested");
    t.eq(gitOut(f.r, ["status", "--porcelain", "--untracked-files=all"]), "", "the source checkout gets no workflow scratch files");

    const tooLarge = argsFor(f, path.join(f.w.dir, "oversized.md"), { goal: "Я".repeat(140_000) });
    const refusal = await flow(t, f, ["design-brief", "--args", tooLarge]);
    t.ok(refusal.code === 2 && /UTF-8 bytes \(limit 262144\)/.test(refusal.json?.refused ?? ""),
      "the input gate reports the measured UTF-8 size and limit");
    t.eq([fs.readdirSync(runs), f.steps()], [[id], ["facts 1", "facts 2", "draft", "review"]], "an oversized goal never starts a run or a model turn");

    const generated = "src/generated.json";
    fs.writeFileSync(path.join(f.r, generated), Buffer.alloc(174_763, 97));
    gitOut(f.r, ["add", "--", generated]);
    gitOut(f.r, ["commit", "-qm", "add an oversized tracked source"]);
    const largeSource = argsFor(f, path.join(f.w.dir, "large-source.md"), {
      questions: [{ question: "Inspect the generated source.", files: [generated] }],
    });
    const rejectedSource = await flow(t, f, ["design-brief", "--args", largeSource]);
    t.ok(rejectedSource.code === 2 && /repo1\/src\/generated\.json.*174763.*174762/.test(rejectedSource.json?.refused ?? ""),
      "an oversized Git source is named with its size and limit");
    t.eq([fs.readdirSync(runs), f.steps()], [[id], ["facts 1", "facts 2", "draft", "review"]], "a large source hint fails before any model turn");
  });

  scenario("flow-design-brief-decision", "research, an owner answer, a fix and its review survive a cut at publication", async (t) => {
    const f = flowWorld(t, "flow-design-brief-decision");
    const output = path.join(f.r, ".agent-tmp", "reviewed.md");
    const args = argsFor(f, output);
    f.w.env.ZODCHI_DENYLIST = path.join(f.w.dir, "fixture-private-words.txt");
    fs.writeFileSync(f.w.env.ZODCHI_DENYLIST, "Fixture Person\n");
    f.answer("facts 1", facts(STUB.trim()));
    f.answer("draft", draft("Run the clamp scenario.", [
      { question: "Which limit should lead?", options: ["Lower", "Upper"], default: "Upper" },
      { question: "How should the old result be handled?", options: ["Keep it", "Replace it"], default: "Keep it and ask Fixture Person to confirm." },
    ]));
    const start = await flow(t, f, ["design-brief", "--args", args]);
    const id = start.json?.runId;
    const journal = path.join(f.w.zhome, "flows", id);
    t.ok(!fs.existsSync(path.join(journal, "workflow.js")), "the native brief journal contains data only");
    t.eq([start.code, start.json?.status, start.json?.ownerDecisions?.[0]?.question, f.steps(), fs.existsSync(output)],
      [2, "waiting", "Which limit should lead?", ["facts 1", "draft"], false], "the run waits for the owner before publishing");
    const status = await flow(t, f, ["status", id]);
    t.eq([status.json?.version, status.json?.status, status.json?.ownerDecisions?.[0]?.default], ["2", "waiting", "Upper"],
      "the second client can read the choices");
    const pending = status.json?.ownerDecisions?.[1];
    t.eq([pending?.question, pending?.options, pending?.default], ["How should the old result be handled?", ["Keep it", "Replace it"], null],
      "an unmatched recommendation is removed and the actual choice stays with the owner");
    const input = path.join(f.w.dir, "choice.txt");
    fs.writeFileSync(input, "Use the upper limit. Keep the old result.");
    const replied = await flow(t, f, ["reply", id, "--file", input]);
    t.eq(replied.code, 0, "the answer is recorded on the original run");
    const revised = draft("Run the clamp scenario for the upper limit.");
    f.answer("draft", revised);
    f.answer("review", f.review("changes_requested", [f.finding("F1")]));
    const fixed = draft("Run node test/math.test.mjs and check the upper and lower limits.");
    f.answer("fix", fixed);
    f.answer("review fix", f.review("approved"));
    const cut = await flow(t, f, ["design-brief", "--resume", id], { ZODCHI_FLOW_CUT: "publish design brief" });
    t.eq(cut.code, 75, "the runner cut after the brief was published");
    const final = await flow(t, f, ["design-brief", "--resume", id]);
    const delivered = fs.readFileSync(output);
    const digest = crypto.createHash("sha256").update(delivered).digest("hex");
    t.eq([final.code, final.json?.approved, final.json?.facts, final.json?.reviewedSha256],
      [0, true, 1, digest], "the published file matches the journal digest");
    t.eq(f.steps(), ["facts 1", "draft", "draft", "review", "fix", "review fix"], "no fact, review or publication was paid for twice");
    const turns = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const turn of turns.filter(({ step }) => step === "draft" || step === "fix")) {
      t.ok(turn.prompt.includes("`## Review boundary`") && turn.prompt.includes("`## Checks`") && turn.prompt.includes("verbatim"),
        "the drafting and revision requests spell out the exact headings and decision defaults");
    }
    const attachment = (step, name) => {
      const prompt = turns.find(turn => turn.step === step).prompt;
      return prompt.split(`<attachment path="${name}">\n`)[1]?.split("\n</attachment>")[0];
    };
    t.eq(attachment("review", "brief.md"), revised.markdown, "first review sees the Markdown starting with the title");
    t.eq(attachment("fix", "draft.md"), revised.markdown, "revision receives just the draft Markdown");
    t.eq(attachment("review fix", "brief.md"), fixed.markdown, "final review sees the revised Markdown starting with the title");
    t.eq(delivered.toString(), `<!-- design-brief: clamp -->\n${fixed.markdown}\n`, "publication adds exactly one ownership marker to the reviewed Markdown");
  });

  scenario("flow-design-brief-unsafe-evidence", "protect existing files, recover from an ungrounded plan, and stop on a blocked review of mismatched evidence", async (t) => {
    const f = flowWorld(t, "flow-design-brief-unsafe-evidence");
    const output = path.join(f.r, ".agent-tmp", "brief.md");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "User's existing notes.\n");
    const question = "What does clamp do today?";
    const args = argsFor(f, output, { questions: [question] });
    const foreign = await flow(t, f, ["design-brief", "--args", args]);
    t.eq([foreign.code, f.steps()], [2, []], "a foreign brief is refused before any model turn");
    fs.renameSync(output, path.join(path.dirname(output), "existing.md"));
    fs.writeFileSync(path.join(f.r, "src", "worktree-only.mjs"), STUB);
    f.answer("plan", { questions: [{ question, files: ["repo1/src/worktree-only.mjs"] }] });
    f.answer("replan", { questions: [{ question, files: ["repo1/src/math.mjs"] }] });
    f.answer("facts 1", facts("This quote does not occur in the file."));
    f.answer("draft", draft("Review the evidence before defining the clamp scenario."));
    f.answer("review", f.review("blocked"));
    const cut = await flow(t, f, ["design-brief", "--args", args], { ZODCHI_FLOW_CUT: "submit replan" });
    t.eq(cut.code, 75, "a file absent from the pinned commit triggers the second planning call");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const waiting = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([waiting.code, waiting.json?.status, waiting.json?.repositoryFacts, waiting.json?.contextFacts, f.steps()],
      [2, "waiting", 0, 0, ["plan", "replan", "facts 1"]], "the recovered plan starts research once and a rejected quote cannot authorize drafting");
    const choice = path.join(f.w.dir, "evidence-choice.txt");
    fs.writeFileSync(choice, "I read the question.");
    const acknowledged = await flow(t, f, ["reply", id, "--file", choice, "--answered", "all"]);
    t.eq(acknowledged.code, 0, "the usual reply command records the acknowledgement");
    const stillWaiting = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([stillWaiting.json?.status, f.steps()], ["waiting", ["plan", "replan", "facts 1"]],
      "marking the question answered without choosing to proceed cannot start a draft");
    fs.writeFileSync(choice, "Continue anyway");
    const proceed = await flow(t, f, ["reply", id, "--file", choice]);
    t.eq(proceed.code, 0, "the owner explicitly chooses to draft with an evidence gap");
    const result = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([result.code, result.json?.facts, result.json?.rejectedFacts, result.json?.review?.verdict, f.steps(), fs.existsSync(output)],
      [2, 0, 1, "blocked", ["plan", "replan", "facts 1", "draft", "review"], false],
      "planning supplies the source, the bad quote yields no fact, and a blocked review stops before a fix or publication");
    const requests = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    t.ok(requests.find(turn => turn.step === "replan").prompt.includes(question), "the second planning call names the ungrounded question");
    for (const step of ["plan", "replan"]) {
      const { prompt } = requests.find(turn => turn.step === step);
      t.ok(prompt.includes("When a code question needs an owner extract, cite the original file alias.")
        && prompt.includes("Set notCode to true only for questions unrelated to code."),
        `${step} explains when to cite an extract's repository file and when to mark a question notCode`);
    }
    const { prompt } = requests.find(turn => turn.step === "draft");
    t.ok(!prompt.includes("This quote does not occur") && prompt.includes("No cited facts could be verified"),
      "the writer sees the evidence gap without the claim associated with the invalid quote");
  });

  scenario("flow-design-brief-unfit-plan", "a plan gets one correction before refusal if its questions still lack repository sources", async (t) => {
    const f = flowWorld(t, "flow-design-brief-unfit-plan");
    const output = path.join(f.w.dir, "unfit-brief.md");
    const questions = [
      "Where is clamp implemented?",
      "Which arguments does clamp read?",
      "What result does clamp return?",
      "Where do callers use clamp?",
      "Which tests exercise the limits?",
    ];
    const unsourced = { questions: questions.map(question => ({ question, files: [] })) };
    f.answer("plan", unsourced);
    f.answer("replan", unsourced);
    const refused = await flow(t, f, ["design-brief", "--args", argsFor(f, output, { questions: [] })]);
    t.eq([refused.code, refused.json?.approved, refused.json?.offendingQuestions, f.steps(), fs.existsSync(output)],
      [2, false, questions, ["plan", "replan"], false], "two ungrounded plans refuse the run and name all five questions");
    t.ok(questions.every(question => refused.json?.refused?.includes(question)), "the refusal explains the missing repository evidence by question");
    const recovered = await flow(t, f, ["design-brief", "--resume", refused.json.runId]);
    t.eq([recovered.code, recovered.json?.offendingQuestions, f.steps()], [2, questions, ["plan", "replan"]],
      "resuming a refusal uses the same result without a third planning call");

    const general = { questions: questions.map((question, index) => ({
      question, files: index === 0 ? ["repo1/src/math.mjs"] : [], notCode: true,
    })) };
    f.answer("plan", general);
    f.answer("replan", general);
    const allGeneral = await flow(t, f, ["design-brief", "--args", argsFor(f, output, { questions: [] })]);
    t.eq([allGeneral.code, allGeneral.json?.offendingQuestions, f.steps()],
      [2, questions, ["plan", "replan", "plan", "replan"]], "marking every question notCode fails even with a repository alias in the plan");
    t.ok(allGeneral.json?.refused?.includes("notCode"), "the refusal explains why all-general questions are unfit");

    const runs = path.join(f.w.zhome, "flows");
    const existingRuns = fs.readdirSync(runs);
    const withoutRepos = await flow(t, f, ["design-brief", "--args", argsFor(f, output, { repos: [] })]);
    t.eq([withoutRepos.code, withoutRepos.json, fs.readdirSync(runs), f.steps()],
      [2, { workflow: "design-brief", approved: false, refused: "Design brief needs at least one repository." },
        existingRuns, ["plan", "replan", "plan", "replan"]], "the no-repository result and lack of run events stay the same");
  });

  scenario("flow-design-brief-owner-closed", "localized headings and partial owner answers survive repeated draft steps", async (t) => {
    const f = flowWorld(t, "flow-design-brief-owner-closed");
    const output = path.join(f.w.dir, "owner-closed-brief.md");
    const args = argsFor(f, output);
    const first = { question: "Which limit should lead?", options: ["Lower", "Upper"], default: "Upper" };
    const second = { question: "Should the old result be retained?", options: ["Keep it", "Replace it"], default: "Keep it" };
    const next = { question: "Should the next job be scheduled?", options: ["Schedule it", "Leave it idle"], default: "Leave it idle" };
    const initial = draft("Проверить верхний предел.", [first, second]);
    initial.markdown = initial.markdown.replace("## Review boundary", "## Границы ревью").replace("## Checks", "## Проверки");
    f.answer("facts 1", facts(STUB.trim()));
    f.answer("draft", initial);
    const started = await flow(t, f, ["design-brief", "--args", args]);
    t.eq([started.code, started.json?.status, started.json?.ownerDecisions?.length], [2, "waiting", 2],
      "the localized brief reaches its owner questions");
    const id = started.json.runId;
    const initialFile = fs.readFileSync(started.json.draft, "utf8");
    t.ok(initialFile.includes("\n## Review boundary\n") && initialFile.includes("\n## Checks\n"), "the engine emits canonical headings");
    const replyFile = path.join(f.w.dir, "owner-answer.txt");
    fs.writeFileSync(replyFile, "Use the upper limit.");
    const invalid = await flow(t, f, ["reply", id, "--file", replyFile, "--answered", "3"]);
    t.ok(invalid.code !== 0, "numbers outside the displayed list are refused");
    const partial = await flow(t, f, ["reply", id, "--file", replyFile, "--answered", "1"]);
    t.eq(partial.code, 0, "the owner confirms just the first question");
    const repeated = { ...first, question: first.question + " (ответ владельца: верхний предел)" };
    f.answer("draft", draft("Check the upper limit.", [repeated, next]));
    const waiting = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq(waiting.json?.ownerDecisions?.map(item => item.question), [next.question, second.question],
      "the repeated question is removed and both open questions remain visible");
    fs.writeFileSync(replyFile, "Keep it.");
    const closed = await flow(t, f, ["reply", id, "--file", replyFile, "--answered", "2", "--no-new-decisions"]);
    t.eq(closed.code, 0, "the owner answers one item and closes the decision round");
    f.answer("draft", draft("Check the upper limit and preserve the old result.", [second, next, repeated]));
    f.answer("review", f.review("approved"));
    const cut = await flow(t, f, ["design-brief", "--resume", id], { ZODCHI_FLOW_CUT: "publish design brief" });
    t.eq(cut.code, 75, "the draft reaches review and publication without a third owner round");
    const result = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([result.code, result.json?.approved, f.steps()], [0, true, ["facts 1", "draft", "draft", "draft", "review"]],
      "resuming preserves the research and the approved revision");
    const brief = fs.readFileSync(output, "utf8");
    t.eq(brief.split("\n## Assumptions\n").length, 2, "assumptions are written once across resume");
    t.ok(brief.includes(next.question) && brief.includes("Provisional assumption is Leave it idle.") && !brief.includes(repeated.question),
      "the unresolved choice is a provisional assumption and the answered question stays closed");
  });

  scenario("flow-design-brief-screened-evidence", "a saved brief answer can mention a withheld line and quote a visible excerpt", async (t) => {
    const f = flowWorld(t, "flow-design-brief-screened-evidence");
    const legacy = "[a line that may hold a credential is left out]";
    const withheld = "[source line withheld]";
    const fixtureValue = "screening-fixture-value";
    f.w.env.ZODCHI_DENYLIST = path.join(f.w.dir, "fixture-private-words.txt");
    fs.writeFileSync(f.w.env.ZODCHI_DENYLIST, "Fixture Person\n");
    const templateLine = "export const text = `sample`;";
    const comparison = "export const matches = (token, expected) => token == expected;";
    fs.appendFileSync(path.join(f.r, "src", "math.mjs"), `${templateLine}\nconst ${assignment("api_key", fixtureValue)};\n${comparison}\n`);
    gitOut(f.r, ["commit", "-qm", "add a line that must be withheld", "--", "src/math.mjs"]);
    const output = path.join(f.w.dir, "screened-brief.md");
    const args = argsFor(f, output);
    const answer = { ...facts("=> x;"), unknowns: [`Line 3 is unavailable: ${legacy}.`, "The result has to be confirmed with Fixture Person."] };
    answer.facts.push(
      { ...answer.facts[0], line: 2, quote: "2 export const text = \\`sample\\`" },
      { ...answer.facts[0], line: 3, quote: withheld },
      { ...answer.facts[0], line: 1, quote: "unknown implementation" },
      { ...answer.facts[0], line: 2, quote: "=> x;" },
    );
    f.answer("facts 1", answer);
    f.answer("draft", draft("Run the clamp scenario."));
    f.answer("review", f.review("approved"));
    const interrupted = await flow(t, f, ["design-brief", "--args", args], { ZODCHI_FLOW_CUT: "submit facts 1" });
    t.eq(interrupted.code, 75, "there is a saved request before the facts are validated");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const result = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([result.code, result.json?.facts, result.json?.rejectedFacts, result.json?.infra ?? null], [0, 2, 3, null],
      "the saved answer passes screening and keeps the verified facts");
    t.eq(f.steps(), ["facts 1", "draft", "review"], "continuing sends no second facts request");
    const turns = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    t.ok(turns[0].prompt.includes(`3 ${withheld}`) && !turns[0].prompt.includes(fixtureValue), "the source hides the sensitive line with a neutral placeholder");
    t.ok(turns[0].prompt.includes(`\n4 ${withheld}\n`) && !turns[0].prompt.includes(comparison),
      "a clean task keeps the repository screening rule for a line containing a credential keyword");
    t.ok(turns[1].prompt.includes(JSON.stringify(STUB.trim())) && turns[1].prompt.includes(JSON.stringify(templateLine)),
      "the draft receives the full verified lines after accepting excerpts, numbering and escaped backticks");
    const journal = path.join(f.w.zhome, "flows", id, "events.jsonl");
    const events = fs.readFileSync(journal, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const evidence = events.find(event => event.kind === "done" && event.step === "facts 1").result;
    t.eq(evidence.rejectedFacts.map(entry => entry.fact), [3, 4, 5], "the journal records each rejected fact by its original position");
    t.eq(evidence.withheldUnknowns, 1, "screening an unresolved point leaves the verified facts intact");
    t.ok(!turns[1].prompt.includes("Fixture Person") && turns[1].prompt.includes("unresolved points were withheld"),
      "the writer sees the missing information without the private text");
    t.ok(!turns[1].prompt.includes("unknown implementation"), "the incorrect citation is absent from the draft input");

    const refusedArgs = argsFor(f, path.join(f.w.dir, "refused-brief.md"));
    f.answer("facts 1", { facts: [{ ...answer.facts[0], claim: `${legacy} ${assignment("api_key", fixtureValue)}` }], unknowns: [] });
    const unsafe = await flow(t, f, ["design-brief", "--args", refusedArgs]);
    t.ok(unsafe.code === 2 && /would change during screening/.test(unsafe.json?.infra ?? ""), "a placeholder does not exempt nearby sensitive text");

    const samePath = path.join(f.r, "src", "math.mjs");
    const contextLines = ["The rollout uses the upper limit.", "Keep the old result."];
    fs.writeFileSync(samePath, contextLines.join("\n") + "\n");
    const questions = ["What does the pinned implementation contain?", "What did the owner choose for rollout?"];
    const mixedArgs = argsFor(f, path.join(f.w.dir, "mixed-evidence.md"), { questions, context: [samePath] });
    f.answer("plan", { questions: [
      { question: questions[0], files: ["repo1/src/math.mjs", "repo1/src/other.mjs"] },
      { question: questions[1], files: [], notCode: true },
    ] });
    f.answer("facts 1", { facts: [
      ...facts(STUB.trim()).facts,
      { claim: "The source also defines text.", file: "repo1/src/math.mjs", line: 2, quote: templateLine },
      { claim: "The other module exports a constant.", file: "repo1/src/other.mjs", line: 1, quote: "export const other = 1;" },
      { claim: "The source states the rollout policy.", file: "repo1/src/math.mjs", line: 1, quote: contextLines[0] },
    ], unknowns: [] });
    f.answer("facts 2", { facts: contextLines.map((quote, index) => ({
      claim: quote, file: "context-1.md", line: index + 1, quote,
    })), unknowns: [] });
    const runs = path.join(f.w.zhome, "flows");
    const existingRuns = new Set(fs.readdirSync(runs));
    const priorTurns = f.steps().length;
    const mixedCut = await flow(t, f, ["design-brief", "--args", mixedArgs], { ZODCHI_FLOW_CUT: "submit facts 2" });
    t.eq(mixedCut.code, 75, "a single notCode question can use the attached context without a file hint");
    const [mixedRun] = fs.readdirSync(runs).filter(id => !existingRuns.has(id));
    const mixed = await flow(t, f, ["design-brief", "--resume", mixedRun]);
    t.eq([mixed.code, mixed.json?.facts, mixed.json?.repositoryFacts, mixed.json?.contextFacts, mixed.json?.rejectedFacts],
      [0, 5, 3, 2, 1], "one path supplies distinct pinned and attached texts, and a quote from the wrong origin is rejected");
    t.eq(f.steps().slice(priorTurns), ["plan", "facts 1", "facts 2", "draft", "review"],
      "the mixed plan and the two sets of evidence are reused across the interruption");

    const invented = ["sk", "live", "inventedvalue".repeat(3)].join("-");
    const inventedLine = "Use a token.";
    const extract = path.join(f.w.dir, "comparison-extract.md");
    fs.writeFileSync(extract, `${comparison}\n`);
    const question = "What does the supplied comparison check?";
    const repoAlias = answer.facts[0].file;
    const extractAlias = "context-1.md";
    const comparisonFact = { file: extractAlias, line: 1, claim: "The comparison checks equality.", quote: comparison };
    f.answer("plan", { questions: [{ question, files: [repoAlias, extractAlias], notCode: false }] });
    const setting = ["password", "="].join(" ");
    f.answer("facts 1", { facts: [
      comparisonFact,
      { ...comparisonFact, quote: "token == expected", claim: "The comparison uses the expected value." },
      { ...comparisonFact, claim: `An invented value is ${invented}.` },
      { ...comparisonFact, claim: inventedLine },
      { ...comparisonFact, file: repoAlias, line: 4 },
      ...answer.facts.slice(0, 2),
    ], unknowns: [`Confirm how callers handle the result.\n${invented}`, `${setting}\n${comparison}`, inventedLine] });
    const writer = draft("Run the clamp scenario.");
    f.answer("draft", { ...writer, markdown: `${writer.markdown}\n\n${comparison}\nAsk Fixture Person to confirm.` });
    const review = f.review("approved");
    f.answer("review", { ...review, summary: `${review.summary}\nAsk Fixture Person to confirm.` });
    const quotedArgs = argsFor(f, path.join(f.w.dir, "quoted.md"), {
      questions: [question], context: [extract],
    });
    const beforeQuote = f.steps().length;
    const screenedQuote = await flow(t, f, ["design-brief", "--args", quotedArgs]);
    t.eq([screenedQuote.code, screenedQuote.json?.status, screenedQuote.json?.ownerDecisions?.[0]?.options, f.steps().length],
      [2, "waiting", ["Continue without those lines", "Stop to rephrase"], beforeQuote],
      "a freshly supplied extract that matches the original task rule requires a screening choice before any model call");
    const screenedJournal = screenedQuote.json.journal;
    t.ok(screenedQuote.json.question.includes("context-1.md:1 (credential)")
      && ![screenedQuote.out, screenedQuote.err, fs.readFileSync(path.join(screenedJournal, "events.jsonl"), "utf8")]
        .some(text => text.includes(comparison)), "the wait reports the affected extract line without exposing it");

    // Recreate a run pinned before the task rule was restored, with the comparison already visible in its extract.
    const material = JSON.parse(fs.readFileSync(path.join(screenedJournal, "material.json"), "utf8"));
    t.eq(material.extracts[extractAlias], withheld, "the fresh run pins the screened extract");
    const attachment = `<attachment path="${extractAlias}">\n`;
    material.context = material.context.replace(`${attachment}${withheld}\n`, `${attachment}${comparison}\n`);
    material.extracts[extractAlias] = comparison;
    delete material.taskScreening;
    const materialText = JSON.stringify(material);
    const pin = JSON.parse(fs.readFileSync(path.join(screenedJournal, "run.json"), "utf8"));
    const quotedId = `${pin.runId}-pinned`;
    const quotedJournal = path.join(runs, quotedId);
    fs.mkdirSync(quotedJournal);
    fs.writeFileSync(path.join(quotedJournal, "events.jsonl"), "");
    fs.writeFileSync(path.join(quotedJournal, "material.json"), materialText);
    fs.writeFileSync(path.join(quotedJournal, "run.json"), JSON.stringify({
      ...pin, runId: quotedId, pair: mixed.json.models,
      inputs: { args: JSON.parse(fs.readFileSync(quotedArgs, "utf8")), materialSha256: crypto.createHash("sha256").update(materialText).digest("hex") },
    }));
    const quoted = await flow(t, f, ["design-brief", "--resume", quotedId]);
    t.eq([
      quoted.code, quoted.json?.facts, quoted.json?.repositoryFacts,
      quoted.json?.contextFacts, quoted.json?.rejectedFacts, f.steps().slice(-4),
    ], [0, 4, 2, 2, 3, ["plan", "facts 1", "draft", "review"]], "two Git facts and two quotes of the supplied comparison reach draft and review");
    const quotedEvents = fs.readFileSync(path.join(quoted.json.journal, "events.jsonl"), "utf8");
    const done = quotedEvents.trim().split(/\r?\n/).map(JSON.parse).filter(event => event.kind === "done");
    const research = done.find(event => event.step === "facts 1").result;
    t.eq(research.facts.map(({ file, quote }) => [file, quote]), [
      [extractAlias, comparison], [extractAlias, comparison], [repoAlias, STUB.trim()], [repoAlias, templateLine],
    ], "both verified comparison quotes use the supplied extract line");
    t.eq(research.rejectedFacts, [
      { fact: 3, reason: "credential" },
      { fact: 4, reason: "credential" },
      { fact: 5, reason: "source line withheld" },
    ], "the journal records invented text and a quote of a withheld source line by position and reason");
    t.eq(research.rejectedLines, [
      { field: "unknowns[1]", line: 2, reason: "credential" },
      { field: "unknowns[2]", line: 1, reason: "credential" },
      { field: "unknowns[3]", line: 1, reason: "credential" },
    ], "the unresolved points record only the unsafe lines");
    t.ok(research.unknowns[0].includes("Confirm how callers handle the result."), "the useful line in the same unresolved point survives");
    t.eq(research.unknowns[1], comparison, "a supplied line survives even beside an invented credential assignment");
    const filtered = done.find(event => event.step === "draft").result;
    t.eq(filtered.rejectedLines, [{ field: "markdown", line: writer.markdown.split("\n").length + 3, reason: "private-word" }],
      "an invented private line in the draft is recorded without discarding the Markdown");
    t.eq([quoted.json.review.summary.trim(), quoted.json.review.rejectedLines],
      [review.summary, [{ field: "summary", line: 2, reason: "private-word" }]], "the review retains its verdict and its useful summary line");
    const approved = fs.readFileSync(quoted.json.path, "utf8");
    t.ok(approved.includes(comparison) && ![quoted.out, quoted.err, quotedEvents, approved]
      .some(text => [invented, inventedLine, "Fixture Person"].some(value => text.includes(value))),
      "the approved brief preserves supplied text and the rejected values stay out of output and events");
  });


  scenario("flow-design-brief-stopped-reply", "a stopped draft keeps its facts and receives a clarification in order", async (t) => {
    const f = flowWorld(t, "flow-design-brief-stopped-reply");
    const args = argsFor(f, path.join(f.w.dir, "stopped-brief.md"));
    f.answer("facts 1", facts(STUB.trim()));
    f.answer("draft", draft("Check the selected clamp limit.", [
      { question: "Which limit should lead?", options: ["Use Lower", "Use Upper"], default: "Use Upper" },
    ]));
    const first = await flow(t, f, ["design-brief", "--args", args]);
    t.eq(first.json?.status, "waiting", "the first draft waits for the owner");
    const id = first.json.runId;
    const file = path.join(f.w.dir, "reply.txt");
    fs.writeFileSync(file, "Use Upper");
    const initialReply = await flow(t, f, ["reply", id, "--file", file]);
    t.eq(initialReply.code, 0, "the owner answers the original choice");
    f.answer("draft", { ...draft("Check the clamp."), markdown: "# An incomplete draft" });
    const failed = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq(failed.json?.stoppedAt, "invalid answer at draft", "the revised draft is stopped");
    fs.writeFileSync(file, "Correction from the owner. Use Lower.");
    const recorded = await flow(t, f, ["reply", id, "--file", file]);
    t.eq([recorded.code, recorded.json?.step], [0, "draft"], "the stopped run accepts the owner clarification");
    const status = await flow(t, f, ["status", id]);
    t.eq([status.json?.status, status.json?.step], ["stopped", "draft"], "recording the reply preserves the stopped step");

    f.answer("draft", draft("Verify the lower limit."));
    f.answer("review", f.review("approved"));
    const ordinary = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([ordinary.json?.stoppedAt, f.steps()], ["invalid answer at draft", ["facts 1", "draft", "draft"]],
      "a normal resume uses the saved answer without spending a fresh turn");
    const approved = await flow(t, f, ["design-brief", "--resume", id, "--rerun", "draft"]);
    t.eq([approved.code, approved.json?.runId, approved.json?.facts, f.steps()], [0, id, 1, ["facts 1", "draft", "draft", "draft", "review"]],
      "explicitly retrying the step preserves the facts and uses the original run");
    const turns = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const prompt = turns[3].prompt;
    t.ok(prompt.includes("Use Upper") && prompt.indexOf("Correction from the owner. Use Lower.") > prompt.indexOf("Use Upper"),
      "the correction is delivered after the original owner answer");
  });
}
