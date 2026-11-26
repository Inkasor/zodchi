import fs from "node:fs";
import path from "node:path";

const report = (status, flowWrites, questions = []) => ({
  status, flowWrites, summary: status, criteria: [], questions, changedFiles: [], checks: [],
});
const turns = (f) => fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));

export default function register({ scenario, flowWorld, gitOut, zodchi, STUB, FIXED, samePath }) {
  scenario("flow-agent-browser-input", "the writer browser input is pinned across continuation and resume", async (t) => {
    const f = flowWorld(t, "flow-agent-browser-input");
    const browser = path.join(f.w.dir, "chromium-fixture");
    fs.writeFileSync(browser, "browser fixture");
    const input = { executable: browser };
    const variable = "ZODCHI_ACCEPTANCE_CHROMIUM";
    const invalid = await f.flow(["--args", f.args({ mode: "agent", browser: { ...input, variable: "PATH" } })]);
    t.eq(invalid.code, 2, "protected environment variables are refused");
    const expert = await f.flow(["--args", f.args({ browser: input })]);
    t.eq(expert.code, 2, "expert mode refuses the browser input");
    const relative = await f.flow(["--args", f.args({ mode: "agent", browser: { ...input, executable: "chromium" } })]);
    t.eq(relative.code, 2, "relative browser paths are refused");
    const directory = await f.flow(["--args", f.args({ mode: "agent", browser: { ...input, executable: f.w.zhome } })]);
    t.eq(directory.code, 2, "a directory is not a browser file");
    const role = path.join(f.r, ".zodchi", "roles", "flow-work.json");
    fs.mkdirSync(path.dirname(role), { recursive: true });
    fs.writeFileSync(role, JSON.stringify({ extends: "flow-work", config: {
      model_context_window: 272000, "shell_environment_policy.set": { EXISTING_FIXTURE: "kept", [variable]: "old" },
      "shell_environment_policy.set.OTHER_FIXTURE": "also kept", "shell_environment_policy.set.zodchi_acceptance_chromium": "wrong browser",
    } }));
    f.answer("write", { ...report("more", { "src/math.mjs": FIXED }), summary: `launch failed at ${browser}` });
    f.answer("write continue 1", report("more", {}));
    f.answer("write continue 2", { ...report("done", {}), summary: `failed at ${browser}`, checks: [{ command: "test", exitCode: 1, result: `browserType.launch: ${browser}` }] });
    f.answer("review 1", f.review("approved"));
    const cut = await f.flow(["--args", f.args({ mode: "agent", browser: input })], { ZODCHI_FLOW_CUT: "submit write continue 1" });
    t.eq(cut.code, 75, "cut after submitting the continuation");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    fs.writeFileSync(browser, "changed browser fixture");
    const changed = await f.flow(["--resume", id]);
    t.eq(changed.json?.stoppedAt, "browser prerequisite at write continue 2", "submitted continuation replays, then changed bytes stop the next writer");
    const changedEvents = fs.readFileSync(path.join(changed.json.journal, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    t.ok(changedEvents.some(e => e.kind === "done" && e.step === "write continue 1"), "submitted continuation has a done receipt before the stop");
    t.ok(changedEvents.some(e => e.kind === "stop" && e.step === "write continue 2" && /browser prerequisite/.test(e.stoppedAt)), "the changed pin stops write continue 2");
    const remarkFile = path.join(f.w.dir, "browser-remark.txt");
    const canonicalBrowser = fs.realpathSync(browser);
    const remarkText = `Keep the output integer. Browser paths: ${browser} and ${canonicalBrowser}`;
    fs.writeFileSync(remarkFile, remarkText);
    const remark = await zodchi(t, f.w, ["flow", "remark", id, "--file", remarkFile], { cwd: f.w.dir, env: f.w.env });
    t.eq(remark.code, 0, "the owner remark is recorded before review");
    const receipt = JSON.parse(fs.readFileSync(path.join(f.w.zhome, "flows", id, "remarks", remark.json.remarkId + ".json"), "utf8"));
    t.eq(receipt.text, remarkText, "the local remark receipt remains unchanged");
    fs.writeFileSync(browser, "browser fixture");
    const res = await f.flow(["--resume", id]);
    t.eq([res.code, res.json?.approved], [0, true], "resume completes");
    const calls = turns(f);
    for (const step of ["write", "write continue 1", "write continue 2"]) {
      const call = calls.find(c => c.step === step);
      t.ok(samePath(call.config["shell_environment_policy.set"][variable], fs.realpathSync(browser)), `${step} receives the pinned path`);
      t.eq([call.config.model_context_window, call.config["shell_environment_policy.set"].EXISTING_FIXTURE], [272000, "kept"], "writer role settings survive the override");
      t.eq(call.config["shell_environment_policy.set"].OTHER_FIXTURE, "also kept", "dotted leaf survives the merge");
      if (process.platform === "win32") t.ok(!Object.hasOwn(call.config["shell_environment_policy.set"], "zodchi_acceptance_chromium"), "Windows removes a differently cased competing variable");
      t.ok(call.prompt.includes(variable), "writer instructions name the available variable");
      t.eq(calls.filter(c => c.step === step).length, 1, `${step} runs only once`);
    }
    t.ok(!calls.find(c => c.step === "write continue 1").prompt.includes(browser), "continuation handoff redacts the browser path");
    t.ok(!calls.find(c => c.step === "review 1").config["shell_environment_policy.set"], "review does not receive the browser");
    const reviewPrompt = calls.find(c => c.step === "review 1").prompt;
    t.ok(reviewPrompt.includes("Keep the output integer.") && reviewPrompt.includes("<browser>")
      && !reviewPrompt.includes(browser) && !reviewPrompt.includes(canonicalBrowser), "review receives the owner remark with both browser paths sanitized");
    const attached = reviewPrompt.match(/<attachment path="writer-checks.json">\n([\s\S]*?)\n<\/attachment>/)?.[1];
    t.ok(attached, "review receives writer check receipts");
    const { checks } = JSON.parse(attached);
    t.ok(checks.some(check => check.result.includes("browserType.launch") && !check.result.includes(browser)), "review check attachment redacts the browser path");
  });
  scenario("flow-agent-browser-reply-redaction", "an owner reply receives a redacted writer handoff", async (t) => {
    const f = flowWorld(t, "flow-agent-browser-reply-redaction");
    const browser = path.join(f.w.zhome, "chromium-fixture");
    fs.writeFileSync(browser, "browser fixture");
    const summary = `Launch failed at ${browser}`;
    f.answer("write", { ...report("blocked", {}), summary });
    const first = await f.flow(["--args", f.args({ mode: "agent", browser: { executable: browser } })]);
    t.eq(first.json?.status, "waiting", "the writer waits for a reply");
    const events = fs.readFileSync(path.join(first.json.journal, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    t.eq(events.find(e => e.kind === "done" && e.step === "write").result.summary, summary, "the original journal receipt is preserved");
    const input = path.join(f.w.dir, "reply.txt");
    fs.writeFileSync(input, "Continue the work.");
    const reply = await zodchi(t, f.w, ["flow", "reply", first.json.runId, "--file", input], { cwd: f.w.dir, env: f.w.env });
    t.eq(reply.code, 0, "the owner reply is recorded");
    f.answer("write", report("done", { "src/math.mjs": FIXED }));
    f.answer("review 1", f.review("approved"));
    const resumed = await f.flow(["--resume", first.json.runId]);
    t.eq([resumed.code, resumed.json?.approved], [0, true], "the reply resumes the writer");
    const prompt = turns(f)[1].prompt;
    t.ok(prompt.includes("Launch failed at") && !prompt.includes(browser), "the reply handoff redacts the browser path");
  });
  scenario("flow-agent-browser-alternate", "an alternate browser variable is passed only to the writer", async (t) => {
    const f = flowWorld(t, "flow-agent-browser-alternate");
    const browser = path.join(f.w.zhome, "chromium-fixture");
    const variable = "APP_TEST_CHROME";
    fs.writeFileSync(browser, "browser fixture");
    f.answer("write", report("done", { "src/math.mjs": FIXED }));
    f.answer("review 1", f.review("approved"));
    const res = await f.flow(["--args", f.args({ mode: "agent", browser: { executable: browser, variable } })]);
    t.eq([res.code, res.json?.approved], [0, true], "alternate variable is accepted");
    const calls = turns(f);
    t.ok(samePath(calls.find(c => c.step === "write").config["shell_environment_policy.set"][variable], fs.realpathSync(browser)), "writer receives the alternate variable");
    t.ok(!JSON.stringify(calls.find(c => c.step === "review 1").config).includes(variable), "review does not receive the alternate variable");
  });
  scenario("flow-agent-prerequisite-superseded", "earlier prerequisite evidence does not explain a later block", async (t) => {
    const f = flowWorld(t, "flow-agent-prerequisite-superseded");
    f.answer("write", { ...report("more", {}), checks: [{ command: "node test.mjs", exitCode: 1, result: "ERR_MODULE_NOT_FOUND" }] });
    f.answer("write continue 1", { ...report("blocked", {}), summary: "junction refused", checks: [{ command: "test", exitCode: 1, result: "Executable doesn't exist at /unrelated" }] });
    const res = await f.flow(["--args", f.args({ mode: "agent" })]);
    t.eq([res.json?.status, Boolean(res.json?.prerequisiteHint)], ["waiting", false], "only the blocked turn's browser-specific evidence counts");
  });
  for (const [name, output, hint] of [
    ["module", "Error [ERR_MODULE_NOT_FOUND]: missing package", "ERR_MODULE_NOT_FOUND"],
    ["browser", "browserType.launch: Executable doesn't exist at /missing/chromium", "missing browser executable"],
    ["junction", "EPERM: junction creation refused", null],
    ["separate-errors", "browserType.launch: Permission denied\nOther tool: Executable doesn't exist at /unrelated", null],
  ]) {
    scenario(`flow-agent-prerequisite-${name}`, "a blocked writer reports only explicit prerequisite evidence", async (t) => {
      const f = flowWorld(t, `flow-agent-prerequisite-${name}`);
      const check = { command: "node test.mjs", exitCode: 1, result: output };
      f.answer("write", { ...report("blocked", {}), summary: "Unable to continue", checks: [check] });
      const res = await f.flow(["--args", f.args({ mode: "agent" })]);
      t.eq([res.code, res.json?.status], [2, "waiting"], "the original blocked outcome is retained");
      t.eq(Boolean(res.json?.prerequisiteHint), Boolean(hint), "only explicit prerequisite evidence gets a hint");
      if (hint) t.ok(res.json.prerequisiteHint.includes(hint), "the hint identifies the prerequisite");
      const events = fs.readFileSync(path.join(res.json.journal, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      t.eq(events.find(e => e.kind === "done" && e.step === "write").result.checks[0], check, "the check receipt remains unchanged");
      t.eq(turns(f).length, 1, "the failed check does not trigger another model turn");
    });
  }
  scenario("flow-agent-setup", "write, continuation, fix and close can start a server with a dependency in the writer copy", async (t) => {
    const f = flowWorld(t, "flow-agent-setup");
    const test = "test/server.test.mjs";
    const setup = "node install-fixture.mjs";
    const config = path.join(f.r, ".zodchi", "verify.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ setup: [setup] }));
    fs.appendFileSync(path.join(f.r, ".gitignore"), "\nnode_modules/\n");
    fs.writeFileSync(path.join(f.r, "install-fixture.mjs"), `import fs from "node:fs";
      fs.mkdirSync("node_modules/fixture-runtime", { recursive: true });
      fs.writeFileSync("node_modules/fixture-runtime/index.js", 'module.exports = "ready";');
      fs.appendFileSync("node_modules/install-count", "1");
    `);
    fs.writeFileSync(path.join(f.r, "server.mjs"), `import { createServer } from "node:http";
      import body from "fixture-runtime";
      const server = createServer((_req, res) => res.end(body));
      server.listen(0, "127.0.0.1", async () => {
        try { console.log(await (await fetch("http://127.0.0.1:" + server.address().port)).text()); }
        finally { server.close(); }
      });
    `);
    fs.writeFileSync(path.join(f.r, test), `import { execFileSync } from "node:child_process";
      import fs from "node:fs";
      import assert from "node:assert/strict";
      import test from "node:test";
      test("server resolves a workspace dependency", () => {
        const result = execFileSync(process.execPath, ["server.mjs"], { encoding: "utf8", timeout: 8000, windowsHide: true });
        assert.equal(result.trim(), "ready");
        assert.equal(fs.readFileSync("node_modules/install-count", "utf8"), "1");
      });
    `);
    gitOut(f.r, ["add", "--", ".zodchi/verify.json", ".gitignore", "server.mjs", "install-fixture.mjs", test]);
    gitOut(f.r, ["commit", "-qm", "Add server and an offline dependency fixture"]);
    f.answer("write", { ...report("more", { "src/math.mjs": "// The range still needs to be enforced.\n" + STUB }), flowNodeTest: test });
    f.answer("write continue 1", { ...report("done", {}), flowNodeTest: test });
    f.answer("fix 1.1", { ...report("done", { "src/math.mjs": FIXED }), flowNodeTest: test });
    f.answer("review 1", f.review("changes_requested", [f.finding("F1")]));
    f.answer("close 1", { ...report("done", { "src/math.mjs": "// clamp keeps x in range.\n" + FIXED }), flowNodeTest: test });
    f.answer("review 2", f.review("approved"));
    const cut = await f.flow(["--args", f.args({ mode: "agent", checks: [setup, "node test/math.test.mjs"], verify: [`node --test ${test}`] })],
      { ZODCHI_FLOW_CUT: "submit write continue 1" });
    t.eq(cut.code, 75, "the run is cut after submitting the continuation");
    fs.writeFileSync(config, JSON.stringify({ setup: ["exit 93"] }));
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const res = await f.flow(["--resume", id]);
    t.eq([res.code, res.json?.approved], [0, true], "the separate engine checks pass and the package is approved");
    const events = fs.readFileSync(path.join(res.json.journal, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const authorChecks = events.filter(e => e.kind === "done" && e.result?.checks?.length).map(e => [e.step, e.result.checks[0]]);
    t.eq(authorChecks.map(([step, check]) => [step, check.exitCode, check.result.includes("ERR_MODULE_NOT_FOUND")]),
      [["write", 0, false], ["write continue 1", 0, false], ["fix 1.1", 0, false], ["close 1", 0, false]],
      "the writer runs the server test before handing off each step");
    const preparations = events.filter(e => e.kind === "writer prepared");
    t.eq(preparations.map(e => [e.step, ...e.setup.evidence.map(command => [command.source, command.command, command.exitCode])]),
      ["write", "fix 1.1", "close 1"].map(step => [step, ["project.setup", setup, 0]]),
      "each fresh writer copy is prepared once from the recorded base plan, even across resume");
    t.eq(res.json.verification.evidence.map(e => e.source), ["checks", "checks", "args.verify"],
      "writer setup never counts as candidate verification");
    for (const [round, expected] of [[1, ["write", "write continue 1", "fix 1.1"]], [2, ["close 1"]]]) {
      const reviewer = turns(f).find(turn => turn.step === `review ${round}`);
      const attached = reviewer.prompt.match(/<attachment path="writer-checks.json">\n([\s\S]*?)\n<\/attachment>/)?.[1];
      t.ok(attached, "review receives the writer's workspace checks");
      const { checks } = JSON.parse(attached);
      t.eq(checks.map(entry => [entry.step, entry.command, entry.exitCode]),
        expected.map(step => [step, `node --test ${test}`, 0]),
        "review receives the writer checks for this round, including their commands and exit codes");
    }
    t.ok(!fs.existsSync(path.join(f.r, "node_modules")), "setup leaves the source checkout untouched");
  });

  scenario("flow-agent-setup-failure", "a failed setup stops before the writer and an explicit retry prepares a fresh copy", async (t) => {
    const f = flowWorld(t, "flow-agent-setup-failure");
    const config = path.join(f.r, ".zodchi", "verify.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ setup: ["exit 93"] }));
    fs.writeFileSync(path.join(f.r, "setup.mjs"), `import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      const flag = path.join(os.homedir(), "tool-ready");
      if (!fs.existsSync(flag)) {
        console.error("fixture tool missing");
        process.exit(23);
      }
      if (fs.readFileSync(flag, "utf8") === "dirty") fs.appendFileSync("src/math.mjs", "// setup touched source\\n");
    `);
    gitOut(f.r, ["add", "--", ".zodchi/verify.json", "setup.mjs"]);
    gitOut(f.r, ["commit", "-qm", "Add setup required by the fixture"]);
    const setup = ["node setup.mjs", "node --version"];
    const expert = await f.flow(["--args", f.args({ setup })]);
    t.ok(expert.code === 2 && /args.setup applies to agent mode/.test(expert.json?.refused ?? ""), "setup requires agent mode");
    const failed = await f.flow(["--args", f.args({ mode: "agent", setup })]);
    const id = failed.json?.runId;
    const expected = [2, "setup write", [["args.setup", 23]], []];
    const state = result => [result.code, result.json?.setupFailure?.step,
      result.json?.setupFailure?.evidence.map(e => [e.source, e.exitCode]), f.steps()];
    t.eq(state(failed), expected, "the first failure records its real exit code and stops before any later command or model turn");
    t.ok(fs.readFileSync(failed.json.setupFailure.evidence[0].log, "utf8").includes("fixture tool missing"), "the log explains the failure");
    const flag = path.join(f.w.home, "tool-ready");
    fs.writeFileSync(flag, "dirty");
    t.eq(state(await f.flow(["--resume", id])), expected, "a plain resume retains the failure");
    const dirty = await f.flow(["--resume", id, "--rerun", "setup write"]);
    t.ok(dirty.code === 2 && dirty.json?.setupFailure?.why.includes("src/math.mjs") && !f.steps().length,
      "even a zero exit code cannot admit a setup that changed source files");
    fs.writeFileSync(flag, "ready");
    f.answer("write", report("done", { "src/math.mjs": FIXED }));
    f.answer("review 1", f.review("approved"));
    const result = await f.flow(["--resume", id, "--rerun", "setup write"]);
    t.eq([result.code, result.json?.runId, result.json?.approved, f.steps()], [0, id, true, ["write", "review 1"]],
      "the same run succeeds with the explicit args setup and a clean writer copy");
  });

  scenario("flow-agent-continue", "a cut during the next ephemeral writer turn preserves the working copy and handoff summary", async (t) => {
    const f = flowWorld(t, "flow-agent-continue");
    const binary = [8, 0, 255];
    const fromOtherPackage = path.join(f.r, "src", "other.mjs");
    fs.writeFileSync(fromOtherPackage, "local work outside this package\n");
    const limits = {
      model_context_window: 272000,
      model_auto_compact_token_limit: 244800,
      model_auto_compact_token_limit_scope: "total",
    };
    const role = path.join(f.r, ".zodchi", "roles", "flow-work.json");
    fs.mkdirSync(path.dirname(role), { recursive: true });
    fs.writeFileSync(role, JSON.stringify({ extends: "flow-work", sandbox: "read-only" }));
    const noTools = await f.flow(["--args", f.args({ mode: "agent" })]);
    t.ok(noTools.code === 2 && /work role with workspace-write/.test(noTools.json?.refused ?? "") && !noTools.json?.runId,
      "an incompatible role fails the gate before a run can ask the writer");
    fs.writeFileSync(role, JSON.stringify({ extends: "flow-work", config: limits }));
    const badPermission = await f.flow(["--args", f.args({ mode: "agent", allowCheckChanges: true })]);
    t.ok(badPermission.code === 2 && /exact paths.*tests\/math\.mjs/.test(badPermission.json?.refused ?? ""),
      "the gate explains the protected path array");
    const summary = "The math change and binary output are in the private workspace.";
    f.answer("write", { ...report("more", { "src/math.mjs": FIXED, "output.bin": { bytes: binary } }), summary });
    f.answer("write continue 1", report("more", {}));
    f.answer("write continue 2", report("more", {}));
    f.answer("write continue 3", report("done", {}));
    f.answer("review 1", f.review("approved"));
    const badContext = await f.flow(["--args", f.args({ mode: "agent", reviewContext: ["src/missing.mjs"] })]);
    t.ok(badContext.code === 2 && /review context file src\/missing\.mjs/.test(badContext.json?.refused ?? "") && !badContext.json?.runId,
      "an absent review context file is refused before a model turn");
    const first = await f.flow(["--args", f.args({
      mode: "agent", continuations: 12, files: ["src/math.mjs", "output.bin"], reviewContext: ["src/other.mjs"],
    })], {
      ZODCHI_FLOW_CUT: "submit write continue 1",
    });
    t.eq(first.code, 75, "the engine cut after submitting the continuation");
    t.eq(fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8").replaceAll("\r\n", "\n"), STUB, "the live checkout has yet to be written");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const result = await f.flow(["--resume", id]);
    t.eq([result.code, result.json?.approved, f.claim()?.status, f.commits().length], [0, true, "done", 1], "the original run applies and reviews once");
    const observed = turns(f);
    t.eq(observed.map(turn => turn.step), ["write", "write continue 1", "write continue 2", "write continue 3", "review 1"],
      "a declared limit beyond the default continues without another owner answer");
    t.ok(observed[0].prompt.includes("Use local tools and the shell") && !observed[0].prompt.includes("no tools and no shell"),
      "the writer receives the workspace contract rather than expert patch instructions");
    const journal = path.join(result.json.journal, "requests");
    const requestFor = step => JSON.parse(fs.readFileSync(path.join(journal, `flow-${id}-${step}.json`), "utf8"));
    t.eq(requestFor("write").role.config, limits, "the writer receives the live project's role even though it is untracked");
    t.eq(requestFor("write-continue-1").role.config, limits, "the resumed writer keeps the project window");
    t.ok(requestFor("review-1").role.config === undefined, "the expert review uses its model window");
    const reviewPrompt = requestFor("review-1").prompt;
    t.ok(reviewPrompt.includes('<attachment path="src/other.mjs">')
      && reviewPrompt.includes("export const other = 1;") && !reviewPrompt.includes("local work outside this package"),
    "the reviewer sees pinned read-only context without the adjacent local edits");
    const receivedLimits = observed.map(turn => Object.fromEntries(Object.entries(turn.config).filter(([key]) => key in limits)));
    t.eq(receivedLimits, [limits, limits, limits, limits, {}], "Codex receives context overrides only for the worker turns");
    t.eq(observed.map(turn => [turn.ephemeral, turn.resumed ?? null]),
      Array.from({ length: 5 }, () => [true, null]), "each writer and review turn starts an ephemeral Codex thread");
    t.ok(observed[1].prompt.includes(summary), "the continuation sees the recorded writer summary");
    t.ok(samePath(observed[0].cwd, observed[1].cwd) && !samePath(f.r, observed[0].cwd), "the writer turns use the same isolated copy");
    t.eq([...fs.readFileSync(path.join(f.r, "output.bin"))], binary, "the engine copies binary output without a text round trip");
    t.eq(fs.readFileSync(fromOtherPackage, "utf8"), "local work outside this package\n", "the other work in the checkout is preserved");
    const files = gitOut(f.r, ["diff", "--name-only", f.base, "HEAD"]).split("\n");
    t.eq(files, ["output.bin", "src/math.mjs"], "only the scope is committed");
  });

  scenario("flow-agent-scope", "outside changes pause before application, and a reply continues in the same private workspace", async (t) => {
    const f = flowWorld(t, "flow-agent-scope");
    const summary = "The math change is ready and outside.txt was added in the private workspace.";
    f.answer("write", { ...report("done", { "src/math.mjs": FIXED, "outside.txt": "out\n" }), summary });
    const first = await f.flow(["--args", f.args({ mode: "agent" })]);
    const id = first.json?.runId;
    t.eq([first.code, first.json?.status, first.json?.outsideClaim, f.commits().length],
      [2, "waiting", ["outside.txt"], 0], "the owner has a decision before the claim publishes any file");
    t.eq(fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8").replaceAll("\r\n", "\n"), STUB, "the claimed original stays intact");
    const inspected = await zodchi(t, f.w, ["flow", "status", id], { cwd: f.w.dir, env: f.w.env });
    t.ok(inspected.json?.question?.includes("outside.txt"), "status exposes the pending decision");
    const input = path.join(f.w.dir, "reply.txt");
    fs.writeFileSync(input, "Drop the extra file and continue with the original scope.");
    const reply = await zodchi(t, f.w, ["flow", "reply", id, "--file", input], { cwd: f.w.dir, env: f.w.env });
    t.eq(reply.code, 0, "the owner can resume the existing code package");
    f.answer("write", report("done", { "outside.txt": null }));
    f.answer("review 1", f.review("approved"));
    const resumed = await f.flow(["--resume", id]);
    t.eq([resumed.code, resumed.json?.runId, resumed.json?.approved, fs.existsSync(path.join(f.r, "outside.txt"))],
      [0, id, true, false], "the package approves only its declared change");
    const observed = turns(f);
    t.eq([observed[1].ephemeral, observed[1].resumed ?? null], [true, null], "the owner reply opens a new ephemeral thread");
    t.ok(samePath(observed[0].cwd, observed[1].cwd), "the owner reply preserves the private workspace");
    t.ok(observed[1].prompt.includes(summary) && observed[1].prompt.includes("Drop the extra file"),
      "the new thread receives the prior summary and the owner's reply");
  });

  scenario("flow-agent-timeout", "a timed-out ephemeral writer leaves its completed edits for the next turn", async (t) => {
    const f = flowWorld(t, "flow-agent-timeout");
    const roles = path.join(f.w.dir, "roles");
    fs.cpSync(f.w.env.ZODCHI_ROLES, roles, { recursive: true });
    const role = path.join(roles, "flow-work.json");
    const settings = JSON.parse(fs.readFileSync(role, "utf8"));
    fs.writeFileSync(role, JSON.stringify({ ...settings, timeoutMin: 0.025, keepThread: true }));
    f.w.env.ZODCHI_ROLES = roles;

    f.answer("write", { ...report("more", { "src/math.mjs": FIXED }), flowHang: true });
    f.answer("write continue 1", report("done", {}));
    f.answer("review 1", f.review("approved"));
    const result = await f.flow(["--args", f.args({ mode: "agent" })]);
    t.eq([result.code, result.json?.approved, f.commits().length], [0, true, 1], "the saved edit is applied once");
    const observed = turns(f);
    t.eq(observed.map(turn => [turn.step, turn.ephemeral, turn.resumed ?? null]),
      [["write", true, null], ["write continue 1", true, null], ["review 1", true, null]],
      "the Flow overrides a role requesting a kept thread and opens ephemeral threads throughout");
    t.ok(samePath(observed[0].cwd, observed[1].cwd) && observed[1].prompt.includes("writer's turn timed out"),
      "the continuation gets the timeout handoff and reuses the original writable copy");
  });

  scenario("flow-agent-scope-approved", "the proposed paths can be approved without starting another writer turn", async (t) => {
    const f = flowWorld(t, "flow-agent-scope-approved");
    f.answer("write", report("done", { "src/math.mjs": FIXED, "src/other.mjs": "export const other = 2;\n" }));
    f.answer("review 1", f.review("approved"));
    const initial = await f.flow(["--args", f.args({ mode: "agent" })]);
    t.eq(initial.json?.outsideClaim, ["src/other.mjs"], "the detected scope change is named");
    const allowed = path.join(f.w.dir, "approved.json");
    fs.writeFileSync(allowed, JSON.stringify(["src/other.mjs"]));
    const reply = await zodchi(t, f.w, ["flow", "reply", initial.json.runId, "--allow-files", allowed], { cwd: f.w.dir, env: f.w.env });
    t.eq(reply.code, 0, "the owner approves the exact extra path");
    const result = await f.flow(["--resume", initial.json.runId]);
    t.eq([result.code, result.json?.claimAdded, f.steps()], [0, ["src/other.mjs"], ["write", "review 1"]],
      "the engine applies the recorded workspace changes and reviews them in the original run");
  });
}
