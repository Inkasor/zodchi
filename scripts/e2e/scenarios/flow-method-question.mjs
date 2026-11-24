import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, zodchi }) {
  const names = ["real 1", "games 1", "fold"];
  const answer = (claim, page) => ({
    answer: claim, findings: [{ claim, source: "https://example.org/" + page, quote: claim }], notFound: [],
  });
  const row = (text, kind, findings) => ({ text, kind, findings });
  function fixture(t, name) {
    const f = flowWorld(t, name);
    const flow = (args, env = {}) => zodchi(t, f.w, ["flow", ...args], {
      cwd: f.w.dir, env: { ...f.w.env, ...env },
    });
    f.answer("real 1", { ...answer("Two supports carry the shelf.", "structure"), notFound: ["The clearance above the shelf is open."] });
    f.answer("games 1", answer("Repeated shelves share one mesh.", "runtime"));
    const sheet = {
      realFacts: [row("Two supports carry the shelf.", "documented", ["real-1.1"])],
      constructions: [
        { ...row("Share one shelf mesh.", "documented", ["games-1.1"]), cost: "One mesh", strength: "Low memory", limit: "Fixed silhouette" },
        { ...row("Reuse the mesh with variants.", "inferred", ["games-1.1"]), cost: "Two variants", strength: "Flexible sizing", limit: "Extra setup" },
      ],
      constructionGap: "",
      follows: [row("Model both supports first.", "inferred", ["real-1.1", "games-1.1"])],
      unsettled: [row("The silhouette from behind is still open.", "inferred", [])],
    };
    f.answer("fold", sheet);
    const input = {
      repo: f.r, tmp: path.join(f.w.dir, "method output"), label: "shelf",
      context: "A workshop shelf for a small first-person room.\nINTERNAL-LABEL-174",
      realLife: ["How is the shelf supported?"], games: ["How do game implementations reuse this shelf?"],
    };
    const file = path.join(f.w.dir, "method-args.json");
    fs.writeFileSync(file, JSON.stringify(input));
    fs.writeFileSync(path.join(f.w.zhome, "private-words.txt"), "INTERNAL-LABEL-174\n");
    return { f, flow, file, input, sheet };
  }

  scenario("flow-method-question-resume", "resume the research and synthesis across processes with pinned inputs and citations", async t => {
    const { f, flow, file, input } = fixture(t, "flow-method-question-resume");
    const start = await flow(["method-question", "--args", file], { ZODCHI_FLOW_CUT: "start method question" });
    t.eq(start.code, 75, "the worker was cut as soon as the run became visible");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const cut = await flow(["method-question", "--resume", id], { ZODCHI_FLOW_CUT: "submit games 1" });
    t.eq(cut.code, 75, "the next process continued and cut after the second submission");
    const journal = path.join(f.w.zhome, "flows", id);
    t.ok(!fs.readFileSync(path.join(journal, "run.json"), "utf8").includes("INTERNAL-LABEL-174"), "the journal holds scrubbed input");
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(input).reverse())));
    const done = await flow(["method-question", "--resume", id, "--args", file]);
    t.eq([done.code, done.json?.runId, done.json?.outcome], [0, id, "drafted"], "the next CLI continues the same run");
    t.eq(f.steps(), names, "each step ran once");
    t.eq(done.json.answers.length, 2, "both research answers are available");
    const sheet = fs.readFileSync(done.json.file, "utf8");
    t.ok(sheet.includes("**documented** Two supports") && sheet.includes("**inferred** Model both"), "the sheet labels evidence and inference");
    t.ok(sheet.includes("https://example.org/structure") && sheet.includes("https://example.org/runtime"), "the sheet names its sources");
    t.ok(sheet.includes("> Two supports carry the shelf.") && sheet.includes("The clearance above the shelf is open."), "the draft includes direct evidence and unresolved research");
    t.ok(sheet.includes("Fixed silhouette") && sheet.includes("Extra setup"), "the draft prints the trade-offs for the two choices");
    const status = await flow(["status", id]);
    t.eq([status.json?.status, status.json?.result?.sha256], ["finished", done.json.sha256], "status returns the exact receipt");
    const replay = await flow(["method-question", "--resume", id]);
    t.eq([replay.code, replay.json?.sha256, f.steps()], [0, done.json.sha256, names], "completed run is read without new calls");
  });

  scenario("flow-method-question-source-and-sheet", "a missing source or empty synthesis stops before publication", async t => {
    const { f, flow, file } = fixture(t, "flow-method-question-source-and-sheet");
    f.answer("real 1", {
      answer: "A loose claim.",
      findings: [{ claim: "A loose claim.", quote: "It might work.", source: "unknown" }],
      notFound: [],
    });
    const invalidSource = await flow(["method-question", "--args", file]);
    t.eq([invalidSource.code, invalidSource.json?.stoppedAt, f.steps()], [2, "invalid answer at real 1", ["real 1"]], "the run stops before synthesis when a citation is untraceable");
    f.answer("real 1", answer("Two supports carry the shelf.", "structure"));
    f.answer("fold", { realFacts: [], constructions: [], follows: [], unsettled: [] });
    const empty = await flow(["method-question", "--args", file]);
    t.eq([empty.code, empty.json?.stoppedAt, f.steps()], [2, "invalid answer at fold", ["real 1", ...names]], "an empty answer cannot publish a sheet");
  });

  scenario("flow-method-question-validation", "the domain gate and citation checks refuse incomplete or unsupported output", async t => {
    const { f, flow, file, sheet } = fixture(t, "flow-method-question-validation");
    const config = path.join(f.r, ".zodchi", "workflows.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const select = domains => {
      fs.writeFileSync(config, JSON.stringify({ domains }));
      gitOut(f.r, ["add", "--", ".zodchi/workflows.json"]);
      gitOut(f.r, ["commit", "-qm", "configure workflow domains"]);
    };
    select([]);
    const refused = await flow(["method-question", "--args", file]);
    t.eq([refused.code, f.steps()], [2, []], "a disabled domain spends no turns");
    select(["gamedev-unity"]);
    f.answer("fold", { ...sheet, realFacts: [row("Unsupported claim", "documented", ["missing.1"])] });
    const blocked = await flow(["method-question", "--args", file]);
    t.eq([blocked.code, blocked.json?.stoppedAt, f.steps()], [2, "invalid answer at fold", names], "an invented citation blocks publication");
    t.ok(!fs.existsSync(path.join(f.w.dir, "method output", "method-" + blocked.json.runId, "options.md")), "the unsupported draft stays out of the output");
  });
}
