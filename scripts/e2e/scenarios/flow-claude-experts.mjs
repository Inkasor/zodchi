import fs from "node:fs";
import path from "node:path";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonl = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const opus = { candidates: [{ provider: "claude", model: "opus", effort: "high" }] };

export default function register({ scenario, flowWorld, gitOut, zodchi, ROOT, FIXED }) {
  function expertWorld(t, name) {
    const f = flowWorld(t, name);
    const home = path.join(f.w.dir, "claude-home");
    const file = (name) => path.join(f.w.dir, name);
    const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
    fs.mkdirSync(path.join(home, "answers"), { recursive: true });
    writeJson(path.join(home, "fake-auth.json"), {});
    writeJson(path.join(f.w.zhome, "flow.json"), { claude: true });
    // An explicit script works on every platform and keeps the real CLI off the call path.
    f.w.env.ZODCHI_CLAUDE_BIN = path.join(ROOT, "scripts", "e2e", "fake-claude.mjs");
    f.w.env.FAKE_CLAUDE_HOME = home;
    const run = (args, env = {}) => zodchi(t, f.w, ["flow", ...args], {
      cwd: f.r, env: { ...f.w.env, ...env },
    });
    const answer = (step, value) => writeJson(path.join(home, "answers", step.replaceAll(" ", "-") + ".json"), value);
    const calls = () => readJsonl(path.join(home, "calls.jsonl")).filter((row) => row.kind === "call");
    const flows = path.join(f.w.zhome, "flows");
    const events = (id) => readJsonl(path.join(flows, id, "events.jsonl"));
    const argsFile = (value) => {
      const args = file("args.json");
      writeJson(args, value);
      return args;
    };
    return { f, file, run, answer, calls, flows, events, argsFile, writeJson };
  }

  function claudeIntent(t, rows, step) {
    const intents = rows.filter((row) => row.kind === "intent" && row.step === step);
    t.eq(intents.map(({ executor, model, effort }) => [executor, model, effort]), [["claude", "opus", "high"]],
      "the step has one intent naming the Claude executor, model and effort");
    return intents[0];
  }

  scenario("flow-branch-review-claude", "resume a Claude branch reviewer from its saved result after a cut", async (t) => {
    const c = expertWorld(t, "flow-branch-review-claude");
    const { f } = c;
    fs.writeFileSync(path.join(f.r, "src", "math.mjs"), FIXED);
    gitOut(f.r, ["add", "--", "src/math.mjs"]);
    gitOut(f.r, ["commit", "-qm", "Fix clamp for review"]);
    c.answer("review", f.review("approved"));
    const args = c.argsFile({
      repo: f.r, base: f.base, label: "review", author: ["codex/opus"], models: { reviewer: opus },
    });
    const first = await c.run(["branch-review", "--args", args], { ZODCHI_FLOW_CUT: "submit review" });
    t.eq(first.code, 75, "the engine was cut after Claude saved its result");
    const [id] = fs.readdirSync(c.flows);
    const intent = claudeIntent(t, c.events(id), "review");
    const final = readJson(path.join(c.flows, id, "claude", intent.key, "final.json"));
    t.eq(final.status, "succeeded", "the original Claude job has a successful receipt");
    t.ok(!c.events(id).some((row) => row.kind === "done" && row.step === "review"), "the cut precedes the step's done event");
    const resumed = await c.run(["branch-review", "--resume", id]);
    t.eq([resumed.code, resumed.json?.runId, resumed.json?.verdict], [0, id, "approved"], "the original review finishes");
    t.ok(/^claude-[0-9a-f]{16}$/.test(final.account) && resumed.json.models.reviewer.account === final.account,
      "the receipt names the account pinned at the gate");
    claudeIntent(t, c.events(id), "review");
    t.eq([c.calls().map((row) => row.step), f.steps()], [["preflight", "review"], []], "resume spent no second turn");
    t.ok(c.calls()[1].prompt.includes("Math.max(lo, x)"), "Claude saw the committed change");
  });

  scenario("flow-research-claude", "a Claude expert answers a research question with screened material", async (t) => {
    const c = expertWorld(t, "flow-research-claude");
    const { f } = c;
    const request = c.file("request.md"), question = c.file("question.md"), attachment = c.file("drawing.txt");
    const tmp = c.file("decisions");
    const privateWord = "WITHHOLD-RESEARCH-741";
    const denylist = path.join(f.w.zhome, "private-words.txt");
    fs.writeFileSync(denylist, privateWord + "\n");
    fs.writeFileSync(request, "Plan a workshop shelf.\n" + privateWord);
    fs.writeFileSync(question, "Where should the supports go?");
    fs.writeFileSync(attachment, "Width 40 cm.\nSupports are shown at the edges.\n");
    const args = c.argsFile({
      repo: f.r, tmp, label: "shelf", request, questions: [{ file: question, title: "Supports" }],
      attachments: [attachment], models: { researchExpert: opus },
    });
    f.answer("constraints", { complete: true, constraints: [] });
    c.answer("ask q1", {
      items: [{ text: "Use one support at each edge.", group: "Supports", replaces: [] }],
      assumptions: [],
      facts: [{ claim: "The drawing places a support at each edge.", source: "1-drawing.txt:2" }],
    });
    f.answer("check f1", { verdicts: [{ id: "F1.1", verdict: "supported", note: "The drawing agrees." }] });

    const first = await c.run(["research", "--args", args], { ZODCHI_FLOW_CUT: "submit constraints" });
    t.eq(first.code, 75, "the engine was cut before asking the expert");
    const [id] = fs.readdirSync(c.flows);
    fs.writeFileSync(denylist, "");
    const remark = c.file("remark.txt");
    fs.writeFileSync(remark, "Use the smaller drawing.\n" + privateWord + "\nResearch folder " + tmp);
    t.eq((await c.run(["remark", id, "--file", remark])).code, 0, "an owner remark arrives before the expert call");

    const ready = await c.run(["research", "--resume", id]);
    t.eq([ready.code, ready.json?.status], [2, "waiting"], "the Claude answer reaches the owner");
    const intent = claudeIntent(t, c.events(id), "ask q1");
    const stored = readJson(path.join(c.flows, id, intent.request));
    const expert = c.calls().find((row) => row.step === "ask q1");
    for (const prompt of [stored.prompt, expert.prompt]) {
      t.ok(prompt.includes("Use the smaller drawing.") && prompt.includes("<research>"), "the request includes the screened owner remark");
      t.ok(!prompt.includes(privateWord) && !prompt.includes(tmp), "pinned privacy rules still cover the owner remark");
    }
    const reply = c.file("reply.json");
    c.writeJson(reply, [{ n: 1, verdict: "accept" }]);
    t.eq((await c.run(["reply", id, "--file", reply])).code, 0, "the owner accepts the Claude proposal");
    const completed = await c.run(["research", "--resume", id]);
    t.eq([completed.code, completed.json?.approved], [0, true], "the round finishes");
    const ledger = readJson(path.join(tmp, "decisions.json"));
    t.eq([ledger.entries[0].state, ledger.entries[0].text], ["accepted", "Use one support at each edge."],
      "the proposal from the Claude expert reaches the ledger");
    t.eq([c.calls().map((row) => row.step), f.steps()], [["preflight", "ask q1"], ["constraints", "check f1"]],
      "each role goes to the pinned executor once");
  });
}
