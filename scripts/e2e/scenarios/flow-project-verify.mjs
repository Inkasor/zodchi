import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, STUB, FIXED }) {
  function configure(f, value) {
    const file = path.join(f.r, ".zodchi", "verify.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    gitOut(f.r, ["add", "--", ".zodchi/verify.json"]);
    gitOut(f.r, ["commit", "-qm", "Declare project verification"]);
    return file;
  }

  scenario("flow-project-verify", "targeted project commands replay from the base plan and the full suite runs once on the approved tree", async (t) => {
    const f = flowWorld(t, "flow-project-verify");
    const file = configure(f, {
      checks: ["node --check src/math.mjs"],
      verify: ["node test/math.test.mjs"],
      full: { run: "local", commands: ["node smoke.mjs"] },
    });
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, FIXED)]));
    f.answer("review 1", f.review("changes_requested", [f.finding("F1")]));
    f.answer("close 1", f.patch([f.modify("src/math.mjs", FIXED, "// The result stays inside the range.\n" + FIXED)]));
    f.answer("review 2", f.review("approved"));
    const cut = await f.flow(["--args", f.args({ checks: [], verify: [] })], { ZODCHI_FLOW_CUT: "apply write" });
    t.eq(cut.code, 75, "the package has pinned the verification plan");
    fs.writeFileSync(file, JSON.stringify({ verify: ["node smoke.mjs --fail"] }));
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const result = await f.flow(["--resume", id]);
    t.eq([result.code, result.json.verdict, result.json.verifiedBy], [0, "approved", "project.verify"], "uses the plan from the recorded base");
    for (const round of result.json.rounds) {
      t.eq(round.checks.evidence.map((command) => command.source), ["project.checks", "project.verify"],
        "each round runs only the two targeted lists");
    }
    t.eq(result.json.fullVerification.evidence.map((command) => [command.source, command.exitCode]),
      [["project.full", 0]], "the accepted tree receives one full check receipt");
    t.eq(result.json.fullVerification.tree, result.json.rounds[1].commit.tree, "full checks use the exact commit tree");
    t.eq(f.steps(), ["write", "review 1", "close 1", "review 2"], "the cut and verification add no model calls");
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
