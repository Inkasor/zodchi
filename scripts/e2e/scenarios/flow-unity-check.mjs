import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export default function register({ scenario, ROOT, flowWorld, zodchi, scratch }) {
  scenario("flow-unity-check-resume", "stop before unsafe Editor work and resume only from durable receipts", async t => {
    const f = flowWorld(t, "flow-unity-check-resume");
    const fake = path.join(scratch, process.platform === "win32" ? "unity-fixture.exe" : "unity-fixture");
    const built = spawnSync("rustc", ["--edition=2021",
      path.join(ROOT, "scripts", "e2e", "fixtures", "unity-cli.rs"), "-o", fake,
    ], { windowsHide: true, encoding: "utf8" });
    t.eq([built.status, built.error?.message ?? built.stderr], [0, ""], "build the isolated Unity CLI fixture");
    const project = path.join(f.r, "Unity Project");
    fs.mkdirSync(path.join(project, "ProjectSettings"), { recursive: true });
    const planFile = path.join(f.w.dir, "steps.json");
    const args = path.join(f.w.dir, "args.json");
    const trace = path.join(f.w.dir, "unity-fixture.log");
    const plan = { project, steps: [
      { command: "find_gameobjects", args: [], expect: { "/count": 3 } },
      { command: "screenshot", args: ["--output", "{capture}"], expect: { "/width": 1 }, capture: "yard.png" },
    ] };
    const write = () => fs.writeFileSync(planFile, JSON.stringify(plan));
    write();
    fs.writeFileSync(args, JSON.stringify({ repo: f.r, cli: fake, tmp: path.join(f.w.dir, "output"), steps: planFile }));
    const run = (argv, env = {}) => zodchi(t, f.w, ["flow", ...argv], {
      cwd: f.r, env: { ...f.w.env, ZODCHI_FIXTURE_UNITY_TRACE: trace,
        ZODCHI_FIXTURE_UNITY_PNG: "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63e8a908f80f00053c02545f6c61f20000000049454e44ae426082", ...env },
    });
    const calls = () => fs.readFileSync(trace, "utf8").trim().split(/\r?\n/);
    const runs = () => fs.readdirSync(path.join(f.w.zhome, "flows"));

    const dirty = await run(["unity-check", "--args", args], { ZODCHI_FIXTURE_UNITY_DIRTY: "1" });
    t.eq(dirty.code, 2, "a dirty scene stops the run");
    t.ok(String(dirty.json?.infra).includes("unsaved"), "the reason identifies the scene guard");
    t.ok(!calls().includes("refresh"), "no refresh or user step ran");
    const before = runs();
    const cut = await run(["unity-check", "--args", args], { ZODCHI_FLOW_CUT: "unity editor 1" });
    t.eq(cut.code, 75, "the worker was cut after the Editor operation without a durable result");
    const interrupted = runs().find(name => !before.includes(name));
    const stopped = await run(["unity-check", "--resume", interrupted]);
    t.eq([stopped.code, stopped.json?.unknown], [2, true], "the next CLI surfaces the uncertain step");
    t.eq(calls().filter(call => call === "find_gameobjects").length, 1, "resume did not issue a second Editor command");
    t.ok(!calls().includes("screenshot"), "later steps remain pending");

    const priorRuns = runs();
    const priorCalls = calls().length;
    const durableCut = await run(["unity-check", "--args", args], { ZODCHI_FLOW_CUT: "done unity editor 1" });
    t.eq(durableCut.code, 75, "the first receipt is durable before the cut");
    const id = runs().find(name => !priorRuns.includes(name));
    plan.steps[1].capture = "changed.png";
    write();
    const done = await run(["unity-check", "--resume", id]);
    t.eq([done.code, done.json?.runId, done.json?.editor?.pid], [0, id, 1234], "resume targets the same Editor");
    t.eq(calls().slice(priorCalls).filter(call => ["find_gameobjects", "screenshot", "refresh"].includes(call)),
      ["refresh", "find_gameobjects", "screenshot"], "refresh and completed checks are reused");
    t.ok(done.json.steps[1].capture.endsWith("yard.png") && fs.existsSync(done.json.steps[1].capture),
      "the capture belongs to the recorded plan");
  });
}
