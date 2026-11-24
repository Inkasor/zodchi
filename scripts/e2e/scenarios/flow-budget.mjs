import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, zodchi, STUB, FIXED }) {
  const cli = (t, f, args) => zodchi(t, f.w, ["flow", ...args], { cwd: f.r, env: f.w.env });

  scenario("flow-package-budget", "the package budget covers automatic continuation and a resumed submission", async (t) => {
    const f = flowWorld(t, "flow-package-budget");
    const report = (status, flowWrites = {}) => ({ status, flowWrites, summary: status, criteria: [], questions: [], changedFiles: [], checks: [] });
    f.answer("write", report("more", { "src/math.mjs": FIXED }));
    f.answer("write continue 1", report("more"));
    f.answer("write continue 2", report("done"));
    f.answer("review 1", f.review("approved"));
    const first = await f.flow(["--args", f.args({ mode: "agent", continuations: 0, budget: { calls: 3 } })], {
      ZODCHI_FLOW_CUT: "submit write continue 1",
    });
    t.eq(first.code, 75, "the first automatic continuation has a submitted key");
    const [run] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const pause = await f.flow(["--resume", run]);
    t.eq([pause.code, pause.json?.budget?.writerCalls, pause.json?.budget?.reviewerCalls, f.claim()?.status],
      [2, 3, 0, "open"], "the next unsent call waits for a budget decision");
    t.eq((await cli(t, f, ["status", run])).json?.reason ?? null, "budget", "status explains why it is waiting");
    const extension = await cli(t, f, ["budget", run, "--add-calls", "1"]);
    t.eq([extension.code, extension.json?.budget?.callLimit], [0, 4], "one decision extends the package budget");
    const finished = await f.flow(["--resume", run]);
    t.eq([finished.code, finished.json?.approved, finished.json?.budget?.reviewerCalls, f.steps()],
      [0, true, 1, ["write", "write continue 1", "write continue 2", "review 1"]], "resuming reuses earlier keys and runs the pending review once");
  });

  scenario("flow-package-no-progress", "the same failed command on an unchanged tree stops a repair loop", async (t) => {
    const f = flowWorld(t, "flow-package-no-progress");
    f.answer("write", f.patch([f.modify("src/math.mjs", STUB, "export const clamp = () => 9;\n")]));
    f.answer("fix 1.1", f.patch([], "No tree changes"));
    const result = await f.flow(["--args", f.args({ fixes: 3, budget: { calls: 10 } })]);
    t.ok(result.json?.stoppedAt?.includes("same failure on unchanged candidate"), "the stop names the lack of progress");
    t.eq([result.code, result.json?.budget?.checkRuns, f.steps()], [2, 2, ["write", "fix 1.1"]], "the remaining fixes are spared");
  });
}
