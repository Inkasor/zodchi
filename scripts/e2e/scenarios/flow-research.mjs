import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export default function register({ scenario, flowWorld, zodchi, FAKE_FLOW }) {
  function fixture(t, name) {
    const f = flowWorld(t, name);
    const tmp = path.join(f.w.dir, "decisions");
    const file = name => path.join(f.w.dir, name);
    const request = file("request.md"), question = file("question.md"), attachment = file("tools.txt");
    fs.writeFileSync(request, "A shelf for a workshop.\nDENY-THIS-WORD-62");
    fs.writeFileSync(question, "Where should the shelf supports go?");
    fs.writeFileSync(attachment, "Width 40 cm.\nA support at either edge.\n");
    fs.writeFileSync(path.join(f.w.zhome, "private-words.txt"), "DENY-THIS-WORD-62\n");
    const args = file("args.json");
    fs.writeFileSync(args, JSON.stringify({ repo: f.r, tmp, label: "workshop", request,
      questions: [{ file: question, title: "Supports" }], attachments: [attachment] }));
    f.answer("constraints", { complete: true, constraints: [{ text: "Hold one small box.", status: "unconfirmed", decision: "" }] });
    f.answer("ask q1", {
      items: [{ text: "Use a support at each edge.", group: "Supports", replaces: [] }],
      assumptions: [],
      facts: [{ claim: "The drawing places a support at each edge.", source: "1-tools.txt:2" }],
    });
    f.answer("check f1", { verdicts: [{ id: "F1.1", verdict: "supported", note: "Checked the second line." }] });
    const run = (argv, env={}) => zodchi(t, f.w, ["flow", ...argv], {
      cwd: f.r, env: { ...f.w.env, ...env },
    });
    return { f, tmp, args, file, run };
  }
  scenario("flow-research-owner-resume", "call each role once and resume the exact list and owner decision", async t => {
    const { f, tmp, args, file, run } = fixture(t, "flow-research-owner-resume");
    const first = await run(["research", "--args", args], { ZODCHI_FLOW_CUT: "submit ask q1" });
    t.eq(first.code, 75, "after the expert's submit the original CLI was cut");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const ready = await run(["research", "--resume", id]);
    t.eq([ready.code, ready.json?.status], [2, "waiting"], "the resumed run waits for a list decision");
    t.eq(f.steps(), ["constraints", "ask q1", "check f1"], "the three roles ran once");
    t.ok(!fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").includes("DENY-THIS-WORD-62"), "no private material reaches a model");
    t.ok(fs.readFileSync(ready.json.list, "utf8").includes("Use a support at each edge"), "the owner can inspect the list");
    const response = file("owner.json");
    fs.writeFileSync(response, JSON.stringify([{ n: 1, verdict: "accept" }]));
    t.eq((await run(["reply", id, "--file", response])).code, 0, "record the exact owner choice");
    t.eq((await run(["research", "--resume", id], { ZODCHI_FLOW_CUT: "research decisions" })).code, 75, "cut after the atomic decision write");
    const completed = await run(["research", "--resume", id]);
    t.eq([completed.code, completed.json?.runId], [0, id], "the last CLI closes the same round");
    const ledger = JSON.parse(fs.readFileSync(path.join(tmp, "decisions.json"), "utf8"));
    t.eq([ledger.appliedRounds, ledger.entries.length, ledger.entries[0].state], [[1], 1, "accepted"], "exactly one accepted decision was applied");
    t.eq(f.steps(), ["constraints", "ask q1", "check f1"], "no model is called during the reply");
    await checkScrubbedReply(t);
  });
  async function checkScrubbedReply(t) {
    const { f, tmp, args, file, run } = fixture(t, "flow-research-scrubbed-reply");
    const items = Array.from({ length: 30 }, (_, i) => ({ text: `Shelf ${i + 1}`, group: "Supports", replaces: [] }));
    f.answer("ask q1", { items, assumptions: [], facts: [] });
    const ready = await run(["research", "--args", args]);
    t.eq([ready.code, ready.json?.status], [2, "waiting"], "all thirty proposals reach the owner");
    const id = ready.json.runId;
    const reply = file("owner.json");
    const full = "🪵".repeat(600);
    fs.writeFileSync(reply, JSON.stringify([{ n: 1, verdict: "fix", text: full + "x" }]));
    t.ok((await run(["reply", id, "--file", reply])).code !== 0, "reject a 601-character owner correction");
    const raw = "DENY-THIS-WORD-62\n".repeat(30) + "Use oak.";
    const expected = "[private text removed]\n".repeat(30) + "Use oak.";
    const fixes = items.map((_, i) => ({ n: i + 1, verdict: "fix", text: i ? full : raw }));
    fs.writeFileSync(reply, JSON.stringify(fixes));
    t.eq((await run(["reply", id, "--file", reply])).code, 0, "record every bounded correction");
    const events = fs.readFileSync(path.join(f.w.zhome, "flows", id, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const recorded = JSON.parse(events.find(e => e.ownerAnswer).ownerAnswer);
    t.eq(recorded[0].text, expected, "the journal contains the expanded, scrubbed correction");
    t.eq((await run(["research", "--resume", id])).code, 0, "resume applies the recorded reply");
    const ledger = JSON.parse(fs.readFileSync(path.join(tmp, "decisions.json"), "utf8"));
    t.eq(ledger.entries.map(e => e.text), recorded.map(a => a.text), "all thirty corrections are applied verbatim");
  }
  scenario("flow-research-contradicted", "stop on a checked contradiction before presenting any list", async t => {
    const { f, args, run } = fixture(t, "flow-research-contradicted");
    f.answer("check f1", { verdicts: [{ id: "F1.1", verdict: "contradicted", note: "A different line is needed." }] });
    const stopped = await run(["research", "--args", args]);
    t.eq([stopped.code, stopped.json?.stoppedAt], [2, "facts contradicted"], "a contradiction is a mechanical stop");
    const journal = path.join(f.w.zhome, "flows", stopped.json.runId);
    t.ok(!fs.existsSync(path.join(journal, "list.json")), "no decision list was built");
    const resume = await run(["research", "--resume", stopped.json.runId]);
    t.eq([resume.code, f.steps()], [2, ["constraints", "ask q1", "check f1"]], "no stopped model step is repeated");

    const many = fixture(t, "flow-research-fact-wave");
    const spec = JSON.parse(fs.readFileSync(many.args, "utf8"));
    spec.questions = Array.from({ length: 3 }, (_, i) => ({ ...spec.questions[0], title: `Shelf ${i + 1}` }));
    fs.writeFileSync(many.args, JSON.stringify(spec));
    const ids = [];
    for (let q = 1; q <= 3; q++) {
      const facts = Array.from({ length: 12 }, (_, i) => {
        ids.push(`F${q}.${i + 1}`);
        return { claim: "The drawing shows two supports.", source: "1-tools.txt:2" };
      });
      many.f.answer(`ask q${q}`, { items: [{ text: "Use two supports.", group: "Supports", replaces: [] }], assumptions: [], facts });
    }
    for (let i = 0; i < 2; i++) {
      many.f.answer(`check f${i + 1}`, { verdicts: ids.slice(i * 15, (i + 1) * 15).map(id => ({
        id, verdict: id === ids[0] ? "contradicted" : "supported", note: "Checked the cited line.",
      })) });
    }
    const wave = await many.run(["research", "--args", many.args]);
    t.eq([wave.code, wave.json?.stoppedAt], [2, "facts contradicted"], "a contradiction stops the next fact wave");
    const events = fs.readFileSync(path.join(many.f.w.zhome, "flows", wave.json.runId, "events.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    t.eq(events.filter(e => e.step?.startsWith("check f") && ["submitted", "done"].includes(e.kind))
      .map(e => [e.kind, e.step]), [["submitted", "check f1"], ["submitted", "check f2"], ["done", "check f1"], ["done", "check f2"]],
      "both fact jobs are submitted before either result is collected");
    const verdicts = JSON.parse(fs.readFileSync(wave.json.facts, "utf8")).verdicts;
    t.eq(verdicts.filter(v => v.verdict === "unchecked").map(v => v.id), ids.slice(30), "only facts in the unstarted wave are unchecked");
  });
  scenario("flow-research-unchecked", "keep a report when the fact checker omits a verdict", async t => {
    const { f, args, run } = fixture(t, "flow-research-unchecked");
    f.answer("check f1", { verdicts: [] });
    const stopped = await run(["research", "--args", args]);
    t.eq([stopped.code, stopped.json?.stoppedAt], [2, "facts"], "an unchecked fact stops the round");
    t.ok(!fs.existsSync(path.join(f.w.zhome, "flows", stopped.json.runId, "list.json")), "no owner list is built");
    const report = JSON.parse(fs.readFileSync(stopped.json.facts, "utf8"));
    t.eq([report.verdicts[0].id, report.verdicts[0].verdict], ["F1.1", "unchecked"], "the report identifies the unchecked fact");
    t.ok(report.verdicts[0].note.includes("one verdict"), "the report explains why it is unchecked");
    await checkReplannedBatch(t);
  });
  async function checkReplannedBatch(t) {
    const { f, args, file, run } = fixture(t, "flow-research-replan");
    const spec = JSON.parse(fs.readFileSync(args, "utf8"));
    spec.allowNoScrub = true;
    fs.writeFileSync(args, JSON.stringify(spec));
    fs.writeFileSync(path.join(f.w.zhome, "private-words.txt"), "");
    // Four excerpts leave less than one remark's worth of room in the prompt.
    fs.writeFileSync(spec.attachments[0], "w".repeat(130800));
    const facts = Array.from({ length: 8 }, () => ({ claim: "Width.", source: "1-tools.txt:1" }));
    f.answer("ask q1", { items: [{ text: "Measure it.", group: "Width", replaces: [] }], assumptions: [], facts });
    const verdicts = facts.map((_, i) => ({ id: `F1.${i + 1}`, verdict: "supported", note: "Measured." }));
    f.answer("check f1", { verdicts: verdicts.slice(0, 4) });
    f.answer("check f2", { verdicts: verdicts.slice(4, 7) });
    f.answer("check f3", { verdicts: verdicts.slice(7) });
    const cut = await run(["research", "--args", args], { ZODCHI_FLOW_CUT: "submit check f1" });
    t.eq(cut.code, 75, "cut after the first fact submission");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const remark = file("remark.txt");
    fs.writeFileSync(remark, "r".repeat(1800));
    t.eq((await run(["remark", id, "--file", remark])).code, 0, "owner context grows before resume");
    const ready = await run(["research", "--resume", id]);
    t.eq([ready.code, ready.json?.status], [2, "waiting"], "all three batches fit after replanning");
    t.eq(JSON.parse(fs.readFileSync(ready.json.facts, "utf8")).verdicts, verdicts, "all eight IDs get their expected verdict");
    t.eq(f.steps().filter(step => step.startsWith("check f")).sort(), ["check f1", "check f2", "check f3"], "each batch ran once");
  }
  scenario("flow-research-unknown", "retain an unknown key and retry only a before-turn failure", async t => {
    async function cutWithFinal(name, status) {
      const x = fixture(t, name);
      const args = JSON.parse(fs.readFileSync(x.args, "utf8"));
      const model = { provider: "codex", model: "fixture-expert", effort: "medium" };
      args.models = { researchExpert: { candidates: [model] } };
      args.questions.push({ file: args.questions[0].file, title: "Second" }, { file: args.questions[0].file, title: "Third" });
      fs.writeFileSync(x.args, JSON.stringify(args));
      // Lose just the original expert transport, either before initialize or
      // during its held turn. The gateway itself records both final outcomes.
      const release = x.file("disconnect");
      x.f.w.env.ZODCHI_CODEX_BIN = x.file("disconnect-expert.mjs");
      fs.writeFileSync(x.f.w.env.ZODCHI_CODEX_BIN, `
        import fs from "node:fs";
        import path from "node:path";
        if (path.basename(process.cwd()).endsWith("-ask-q1")) {
          if (${status === "failed"}) process.exit(1);
          setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(1); }, 25).unref();
        }
        await import(${JSON.stringify(pathToFileURL(FAKE_FLOW).href)});
      `);
      if (status === "unknown") {
        x.f.answer("ask q1", { flowHang: true });
        t.cleanups.push(() => fs.writeFileSync(release, ""));
      }
      x.f.answer("ask q2", { items: [{ text: "Add a bracket.", group: "Supports", replaces: [] }], assumptions: [], facts: [] });
      const cut = await x.run(["research", "--args", x.args], { ZODCHI_FLOW_CUT: "submit ask q2" });
      t.eq(cut.code, 75, "cut after the second expert submission");
      const [id] = fs.readdirSync(path.join(x.f.w.zhome, "flows"));
      const key = `flow-${id}-ask-q1`;
      const events = () => fs.readFileSync(path.join(x.f.w.zhome, "flows", id, "events.jsonl"), "utf8")
        .trim().split("\n").map(line => JSON.parse(line));
      const before = events();
      t.eq(before.filter(e => e.kind === "intent" && e.step.startsWith("ask q")).map(e => e.key),
        [key, `flow-${id}-ask-q2`], "each expert has a separate durable key");
      t.ok(before.some(e => e.kind === "submitted" && e.key === key)
        && !before.some(e => e.kind === "done" && e.step === "ask q1"),
        "the second submission precedes collection of the first answer");
      t.ok(before.filter(e => e.kind === "intent" && e.step.startsWith("ask q")).every(e =>
        e.model === model.model && e.effort === model.effort), "both expert intents use the operator's model selection");
      await t.until("the peer's fake expert turn started", () => x.f.steps().includes("ask q2"));
      const finalPath = path.join(x.f.r, ".agent-tmp", "gateway", key, "final.json");
      if (status === "unknown") {
        await t.until("the first expert entered its held turn", () => x.f.steps().includes("ask q1"));
        t.ok(!fs.existsSync(finalPath), "both experts received turns before the first job ended");
        fs.writeFileSync(release, "");
      }
      await t.until("the fake expert job is final", () => fs.existsSync(finalPath));
      const final = JSON.parse(fs.readFileSync(finalPath, "utf8"));
      if (status === "failed") {
        t.eq([final.status, final.turnRequestedAt, final.turnStartedAt], ["failed", null, null],
          "the gateway recorded a transport failure before requesting a turn");
        t.ok(!x.f.steps().includes("ask q1"), "the failed transport never received a turn");
      } else {
        t.ok(final.status === "unknown" && final.turnRequestedAt, "losing the live transport leaves the gateway outcome unknown");
      }
      return { ...x, id, key, events };
    }
    const unknown = await cutWithFinal("flow-research-unknown-outcome", "unknown");
    fs.appendFileSync(path.join(unknown.f.w.zhome, "private-words.txt"), "Second\n");
    const stopped = await unknown.run(["research", "--resume", unknown.id]);
    t.eq([stopped.code, stopped.json?.jobKey], [2, unknown.key], "the unknown outcome retains its key");
    t.ok(stopped.json.reason.includes("unknown"), "the recorded result identifies the unknown outcome");
    t.ok(unknown.events().some(e => e.kind === "done" && e.step === "ask q2"), "the peer's successful result is durable");
    t.ok(!unknown.events().some(e => e.step === "ask q3"), "no later wave starts");
    const receipt = unknown.events();
    const resumed = await unknown.run(["research", "--resume", unknown.id]);
    t.eq(resumed.json, stopped.json, "resume returns the recorded terminal outcome");
    t.ok((await unknown.run(["research", "--resume", unknown.id, "--rerun", "ask q1"])).code !== 0, "rerun is refused");
    t.eq(unknown.events(), receipt, "resume and rerun leave the stopped journal intact");
    t.eq(unknown.f.steps().sort(), ["ask q1", "ask q2", "constraints"], "neither expert is asked again");
    const retry = await cutWithFinal("flow-research-before-turn", "failed");
    retry.f.answer("ask q3", { items: [{ text: "Use a level.", group: "Supports", replaces: [] }], assumptions: [], facts: [] });
    const ready = await retry.run(["research", "--resume", retry.id]);
    t.eq([ready.code, ready.json?.status], [2, "waiting"], "a before-turn failure may be retried");
    t.ok(fs.existsSync(path.join(retry.f.r, ".agent-tmp", "gateway", `${retry.key}-r2`)), "the retry uses a new key");
    t.eq(retry.events().filter(e => e.kind === "intent" && e.step === "ask q1").map(e => e.key),
      [retry.key, `${retry.key}-r2`], "only the eligible failed attempt receives a retry");
    t.eq(retry.f.steps().filter(step => step === "ask q2").length, 1, "recovery collects the original peer");
  });
  scenario("flow-research-legacy", "refuse a pending legacy round before a model turn", async t => {
    const { f, tmp, args, run } = fixture(t, "flow-research-legacy");
    fs.mkdirSync(path.join(tmp, "rounds", "1"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "rounds", "1", "list.json"), "{}\n");
    const stopped = await run(["research", "--args", args]);
    t.eq(stopped.code, 2, "a pending list prevents a new round");
    t.ok(stopped.json?.refused?.includes("pending legacy list"), "the refusal explains the legacy list");
    t.eq(f.steps(), [], "no model turn was submitted");
    const old = fixture(t, "flow-research-legacy-inconsistent-reply");
    fs.mkdirSync(path.join(old.tmp, "rounds", "1"), { recursive: true });
    fs.writeFileSync(path.join(old.tmp, "decisions.json"), JSON.stringify({ version: 1, appliedRounds: [1], entries: [] }));
    fs.writeFileSync(path.join(old.tmp, "decisions.md"), "Prior decisions\n");
    fs.writeFileSync(path.join(old.tmp, "rounds", "1", "reply.json"), JSON.stringify({ outcome: { decisionsSha256: "different", decisionsMdSha256: "different" } }));
    const inconsistent = await old.run(["research", "--args", old.args]);
    t.eq(inconsistent.code, 2, "an inconsistent legacy reply prevents opening a new round");
    t.ok(inconsistent.json?.refused?.includes("legacy reply"), "the refusal identifies the inconsistent receipt");
    t.eq(old.f.steps(), [], "the receipt is checked before any model turn");
    const ledger = fs.readFileSync(path.join(old.tmp, "decisions.json"));
    const markdown = fs.readFileSync(path.join(old.tmp, "decisions.md"));
    const sha = bytes => createHash("sha256").update(bytes).digest("hex");
    const receipt = JSON.stringify({ outcome: { decisionsSha256: sha(ledger), decisionsMdSha256: sha(markdown) } });
    const receiptPath = path.join(old.tmp, "rounds", "1", "reply.json");
    fs.writeFileSync(receiptPath, receipt);
    const resumed = await old.run(["research", "--args", old.args]);
    t.eq([resumed.code, resumed.json?.status, resumed.json?.round], [2, "waiting", 2], "a matching legacy reply allows the next round");
    t.eq(fs.readFileSync(receiptPath, "utf8"), receipt, "the legacy owner reply is preserved");
  });
  scenario("flow-research-lock-cuts", "recover the research lock after a cut during publication", async t => {
    for (const cut of ["research lock prepared", "research lock published"]) {
      const { f, args, run } = fixture(t, `flow-research-lock-${cut.replaceAll(" ", "-")}`);
      const first = await run(["research", "--args", args], { ZODCHI_FLOW_CUT: cut });
      t.eq(first.code, 75, `cut at ${cut}`);
      const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
      const ready = await run(["research", "--resume", id]);
      t.eq([ready.code, ready.json?.status], [2, "waiting"], `resume after ${cut}`);
      t.eq(f.steps(), ["constraints", "ask q1", "check f1"], "each model turn runs once");
    }
    const { f, args, run, file, tmp } = fixture(t, "flow-research-lock-release");
    const ready = await run(["research", "--args", args]);
    t.eq([ready.code, ready.json?.status], [2, "waiting"], "the list is ready for a reply");
    const id = ready.json.runId;
    const reply = file("reply.json");
    fs.writeFileSync(reply, JSON.stringify([{ n: 1, verdict: "accept" }]));
    t.eq((await run(["reply", id, "--file", reply])).code, 0, "record the decision");
    const cut = await run(["research", "--resume", id], { ZODCHI_FLOW_CUT: "research lock released" });
    t.eq(cut.code, 75, "cut after releasing the lock and recording the result");
    const done = await run(["research", "--resume", id]);
    t.eq([done.code, done.json?.runId], [0, id], "recover the recorded result after lock removal");
    const ledger = JSON.parse(fs.readFileSync(path.join(tmp, "decisions.json"), "utf8"));
    t.eq([ledger.appliedRounds, ledger.entries.length], [[1], 1], "the decision is applied exactly once");
    t.eq(f.steps(), ["constraints", "ask q1", "check f1"], "no model turn is repeated");
  });
  scenario("flow-research-config-pin", "stop before another turn if the local executor changes", async t => {
    const { f, args, run, file } = fixture(t, "flow-research-config-pin");
    const first = await run(["research", "--args", args], { ZODCHI_FLOW_CUT: "submit constraints" });
    t.eq(first.code, 75, "cut after the first submission");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const changed = await run(["research", "--resume", id], { ZODCHI_CODEX_BIN: file("different-codex") });
    t.eq([changed.code, changed.json?.stoppedAt], [2, "constraints"], "a different executor stops the run");
    t.ok(String(changed.json?.reason).includes("configuration changed"), "the stop explains the configuration change");
    t.ok(!f.steps().includes("ask q1"), "no later model turn receives the saved material");
  });
}
