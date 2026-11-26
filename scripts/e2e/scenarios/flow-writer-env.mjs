import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, gitOut, FIXED, samePath }) {
  scenario("flow-writer-env", "agent setup and writer turns use the pinned writer environment while checks and review stay isolated", async (t) => {
    const f = flowWorld(t, "flow-writer-env");
    const config = path.join(f.r, ".zodchi", "verify.json");
    const writerEnv = { CARGO_TARGET_DIR: "{writerCache}/target", CARGO_BUILD_JOBS: "4" };
    const privateWord = "fixturewriterlabel";
    const privateName = `${privateWord.toUpperCase()}_BUILD_MODE`;
    const privateValue = "fixture-mode";
    const setup = "node writer-env-fixture.mjs setup";
    const verify = "node writer-env-fixture.mjs verify";
    fs.writeFileSync(path.join(f.w.zhome, "private-words.txt"), `${privateWord}\n`);
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({
      env: { FLOW_CHECK_CACHE: "{cache}", CARGO_BUILD_JOBS: "6" },
      writerEnv: { ...writerEnv, [privateName]: privateValue },
      setup: [setup],
    }));
    fs.writeFileSync(path.join(f.r, "writer-env-fixture.mjs"), `import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      const { CARGO_BUILD_JOBS: jobs, CARGO_TARGET_DIR: target, FLOW_CHECK_CACHE: checkCache } = process.env;
      assert.ok(path.isAbsolute(checkCache));
      if (process.argv[2] === "setup") {
        assert.equal(jobs, "4");
        assert.equal(path.normalize(target), path.join(checkCache, "writer", "target"));
        assert.ok(fs.statSync(path.dirname(target)).isDirectory());
        fs.writeFileSync(path.join(path.dirname(target), "setup-ready"), "ready");
      } else {
        assert.equal(jobs, "6");
        assert.equal(target, undefined);
      }
    `);
    gitOut(f.r, ["add", "--", ".zodchi/verify.json", "writer-env-fixture.mjs"]);
    gitOut(f.r, ["commit", "-qm", "Declare the writer environment and a setup fixture"]);

    const report = (status, flowWrites) => ({
      status, flowWrites, summary: "Clamp implementation", criteria: [], questions: [], changedFiles: [], checks: [],
    });
    f.answer("write", report("more", { "src/math.mjs": FIXED }));
    f.answer("write continue 1", report("done", {}));
    f.answer("review 1", f.review("approved"));
    const cut = await f.flow(["--args", f.args({ mode: "agent", verify: [verify] })], { ZODCHI_FLOW_CUT: "submit write" });
    t.eq(cut.code, 75, "the package reaches its first writer turn after setup");
    fs.writeFileSync(config, JSON.stringify({ writerEnv: { CARGO_BUILD_JOBS: "1" } }));
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const result = await f.flow(["--resume", id]);
    t.eq([result.code, result.json?.approved], [0, true], "the resumed package finishes with passing checks");
    const verified = result.json.verification.evidence.filter(e => e.source === "args.verify");
    t.eq(verified.map(e => [e.command, e.exitCode]), [[verify, 0]], "engine verification runs with the check environment");

    const run = JSON.parse(fs.readFileSync(path.join(result.json.journal, "run.json"), "utf8"));
    const checkCache = run.verificationPlan.env.FLOW_CHECK_CACHE;
    const cache = path.join(checkCache, "writer");
    t.ok(samePath(path.dirname(checkCache), path.join(f.w.zhome, "flow-cache")), "the check cache is under the Zodchi home");
    t.ok(samePath(run.verificationPlan.writerCache, cache), "the pinned writer cache uses the same repo slug");
    t.eq(fs.readFileSync(path.join(cache, "setup-ready"), "utf8"), "ready", "setup writes to the resolved writer cache");

    const turns = fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    t.eq(turns.map(turn => turn.step), ["write", "write continue 1", "review 1"], "each turn runs once");
    for (const turn of turns.slice(0, 2)) {
      const env = turn.config["shell_environment_policy.set"];
      const roots = turn.config["sandbox_workspace_write.writable_roots"];
      t.eq(Object.keys(env).sort(), [...Object.keys(writerEnv), privateName].sort(), `${turn.step} receives the writer variables`);
      t.eq(env.CARGO_BUILD_JOBS, "4", `${turn.step} receives the pinned job limit`);
      t.ok(samePath(env.CARGO_TARGET_DIR, path.join(cache, "target")), `${turn.step} receives the pinned Cargo target`);
      t.ok(roots.length === 1 && samePath(roots[0], cache), `${turn.step} has exactly one configured writable root`);
      t.ok(Object.keys(writerEnv).every(name => turn.prompt.includes(name)) && !turn.prompt.includes(cache),
        `${turn.step} names the variables in the prompt`);
      t.eq(env[privateName], privateValue, `${turn.step} keeps the screened variable in the shell configuration`);
      t.ok(!turn.prompt.toLowerCase().includes(privateWord), `${turn.step} omits the private prefix from the prompt`);
    }
    t.eq(turns[2].config, {}, "the review turn receives neither the writer variables nor the writable root");
  });
}
