import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

  scenario("flow-design-brief-private-word-exception", "only a private brief can retain a declared identifier in pinned source", async (t) => {
    const f = flowWorld(t, "flow-design-brief-private-word-exception");
    const allowed = "Fixture Harbor";
    const denied = "Fixture Ledger";
    const sensitive = "local-only-value";
    f.w.env.ZODCHI_DENYLIST = path.join(f.w.dir, "private-words.txt");
    fs.writeFileSync(f.w.env.ZODCHI_DENYLIST, `${allowed}\n${denied}\n`);
    const relative = "src/Fixture Harbor-id.mjs";
    const sourceLine = 'export const header = "X-Fixture Harbor-Product";';
    fs.writeFileSync(path.join(f.r, relative), `${sourceLine}\n// ${denied}\nconst token = "${sensitive}";\n`);
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
    f.answer("plan", { questions: [{ question, files: [alias] }] });
    f.answer("facts 1", cited("context-1.md"));
    f.answer("draft", draft("Confirm the declared limit from the supplied extract."));
    f.answer("review", f.review("approved"));
    const output = path.join(f.w.dir, "with-extract.md");
    const result = await flow(t, f, ["design-brief", "--args", argsFor(f, output, { questions: [question], context: [extract] })]);
    t.eq([result.code, result.json?.facts, f.steps()], [0, 1, ["plan", "facts 1", "draft", "review"]],
      "a stale large alias resolves to the attached extract and its verified quote");
    const request = (result, step) => JSON.parse(fs.readFileSync(path.join(result.journal, "requests", `flow-${result.runId}-${step}.json`), "utf8")).prompt;
    const available = request(result.json, "plan").match(/<attachment path="available-files\.txt">\n([\s\S]*?)\n<\/attachment>/);
    t.ok(available[1].includes("context-1.md") && !available[1].includes(alias), "large blobs stay out of the plan inventory");
    const prompt = request(result.json, "facts-1");
    t.ok(prompt.includes('<attachment path="context-1.md">') && prompt.includes(quote)
      && prompt.includes("limit 174762") && !prompt.includes("// padding"), "facts receive the excerpt and the reason the large blob was omitted");

    const withReply = path.join(f.w.dir, "with-reply.md");
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
    const resumed = await flow(t, f, ["design-brief", "--resume", id]);
    t.eq([resumed.code, resumed.json?.runId, resumed.json?.facts, f.steps().slice(5)],
      [0, id, 1, ["facts 1", "draft", "review"]], "the same run accepts a verified quote from the owner extract");
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
    const args = argsFor(f, path.join(f.w.dir, "mixed-brief.md"), {
      models: {
        writer: { candidates: [{ provider: "claude", model: "sonnet", effort: "medium" }] },
        researcher: { candidates: [{ provider: "claude", model: "haiku", effort: "high" }] },
      },
    });
    const denied = await flow(t, f, ["design-brief", "--args", args]);
    t.ok(denied.code === 2 && /not enabled/.test(denied.json?.refused ?? ""), "explicit candidates still need the user's opt-in");
    t.ok(!fs.existsSync(path.join(home, "calls.jsonl")), "the disabled executor was never started");
    fs.writeFileSync(path.join(f.w.zhome, "flow.json"), JSON.stringify({ claude: true }));
    f.answer("review", f.review("approved"));
    const cut = await flow(t, f, ["design-brief", "--args", args], { ZODCHI_FLOW_CUT: "submit facts 1" });
    t.eq(cut.code, 75, "the process stops after the Claude researcher has finished");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
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

  scenario("flow-design-brief-unsafe-evidence", "protect existing files, plan a question without file hints, and stop on a blocked review of mismatched evidence", async (t) => {
    const f = flowWorld(t, "flow-design-brief-unsafe-evidence");
    const output = path.join(f.r, ".agent-tmp", "brief.md");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "User's existing notes.\n");
    const question = "What does clamp do today?";
    const args = argsFor(f, output, { questions: [question] });
    const foreign = await flow(t, f, ["design-brief", "--args", args]);
    t.eq([foreign.code, f.steps()], [2, []], "a foreign brief is refused before any model turn");
    fs.renameSync(output, path.join(path.dirname(output), "existing.md"));
    f.answer("plan", { questions: [{ question, files: ["repo1/src/math.mjs"] }] });
    f.answer("facts 1", facts("This quote does not occur in the file."));
    f.answer("draft", draft("Review the evidence before defining the clamp scenario."));
    f.answer("review", f.review("blocked"));
    const result = await flow(t, f, ["design-brief", "--args", args]);
    t.eq([result.code, result.json?.facts, result.json?.rejectedFacts, result.json?.review?.verdict, f.steps(), fs.existsSync(output)],
      [2, 0, 1, "blocked", ["plan", "facts 1", "draft", "review"], false],
      "planning supplies the source, the bad quote yields no fact, and a blocked review stops before a fix or publication");
    const requests = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const { prompt } = requests.find(turn => turn.step === "draft");
    t.ok(!prompt.includes("This quote does not occur") && prompt.includes("No cited facts could be verified"),
      "the writer sees the evidence gap without the claim associated with the invalid quote");
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
    fs.appendFileSync(path.join(f.r, "src", "math.mjs"), `${templateLine}\nconst api_key = "${fixtureValue}";\n`);
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
    f.answer("facts 1", { facts: [{ ...answer.facts[0], claim: `${legacy} api_key=${fixtureValue}` }], unknowns: [] });
    const unsafe = await flow(t, f, ["design-brief", "--args", refusedArgs]);
    t.ok(unsafe.code === 2 && /would change during screening/.test(unsafe.json?.infra ?? ""), "a placeholder does not exempt nearby sensitive text");
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
