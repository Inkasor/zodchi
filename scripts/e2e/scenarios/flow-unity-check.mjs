import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export default function register({ scenario, ROOT, flowWorld, zodchi, scratch }) {
  let fake;
  function tool(t) {
    if (fake) return fake;
    fake = path.join(scratch, process.platform === "win32" ? "unity-fixture.exe" : "unity-fixture");
    const built = spawnSync("rustc", ["--edition=2021",
      path.join(ROOT, "scripts", "e2e", "fixtures", "unity-cli.rs"), "-o", fake,
    ], { windowsHide: true, encoding: "utf8" });
    t.eq([built.status, built.error?.message ?? built.stderr], [0, ""], "build the isolated Unity CLI fixture");
    return fake;
  }
  function fixture(t, name) {
    const f = flowWorld(t, name);
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
    fs.writeFileSync(args, JSON.stringify({ repo: f.r, cli: tool(t), tmp: path.join(f.w.dir, "output"), steps: planFile }));
    const run = (argv, env = {}) => zodchi(t, f.w, ["flow", ...argv], {
      cwd: f.r, env: { ...f.w.env, ZODCHI_FIXTURE_UNITY_TRACE: trace,
        ZODCHI_FIXTURE_UNITY_PNG: "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63e8a908f80f00053c02545f6c61f20000000049454e44ae426082", ...env },
    });
    const calls = () => fs.readFileSync(trace, "utf8").trim().split(/\r?\n/);
    return { args, f, run, write, plan, calls };
  }

  scenario("flow-unity-check-resume", "refresh and run the exact pinned Unity steps once across CLI processes", async t => {
    const { args, f, run, write, plan, calls } = fixture(t, "flow-unity-check-resume");
    const cut = await run(["unity-check", "--args", args], { ZODCHI_FLOW_CUT: "done unity editor 1" });
    t.eq(cut.code, 75, "the first receipt is durable before the cut");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    plan.steps[1].capture = "changed.png";
    write();
    const done = await run(["unity-check", "--resume", id]);
    t.eq([done.code, done.json?.runId, done.json?.editor?.pid], [0, id, 1234], "resume targets the same Editor");
    t.eq(calls().filter(call => ["find_gameobjects", "screenshot", "refresh"].includes(call)),
      ["refresh", "find_gameobjects", "screenshot"], "refresh and completed checks are reused");
    t.ok(done.json.steps[1].capture.endsWith("yard.png") && fs.existsSync(done.json.steps[1].capture),
      "the capture belongs to the recorded plan");
  });

  scenario("flow-unity-check-stop", "stop on a foreign dirty scene or an incomplete editor effect", async t => {
    const { args, f, run, calls } = fixture(t, "flow-unity-check-stop");
    const dirty = await run(["unity-check", "--args", args], { ZODCHI_FIXTURE_UNITY_DIRTY: "1" });
    t.eq(dirty.code, 2, "a dirty scene stops the run");
    t.ok(String(dirty.json?.infra).includes("unsaved"), "the reason identifies the scene guard");
    t.ok(!calls().includes("refresh"), "no refresh or user step ran");
    const before = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const cut = await run(["unity-check", "--args", args], { ZODCHI_FLOW_CUT: "unity editor 1" });
    t.eq(cut.code, 75, "the worker was cut after the Editor operation without a durable result");
    const id = fs.readdirSync(path.join(f.w.zhome, "flows")).find(name => !before.includes(name));
    const stopped = await run(["unity-check", "--resume", id]);
    t.eq([stopped.code, stopped.json?.unknown], [2, true], "the next CLI surfaces the uncertain step");
    t.eq(calls().filter(call => call === "find_gameobjects").length, 1, "resume did not issue a second Editor command");
    t.ok(!calls().includes("screenshot"), "later steps remain pending");
  });
}
