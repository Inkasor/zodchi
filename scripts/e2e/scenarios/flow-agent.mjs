import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const report = (status, flowWrites, questions = []) => ({
  status, flowWrites, summary: status, criteria: [], questions, changedFiles: [], checks: [],
});
const turns = (f) => fs.readFileSync(path.join(f.w.codex, "fake-turns.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));

export default function register({ scenario, flowWorld, gitOut, zodchi, STUB, FIXED, samePath, FAKE }) {
  function authRpcFixture(dir) {
    const fake = path.join(dir, "fake-codex-auth-rpc.mjs");
    fs.writeFileSync(fake, `import path from "node:path";
import readline from "node:readline";

if (process.argv[2] !== "app-server") process.exit(0);
const expired = path.basename(process.env.CODEX_HOME) === "expired-codex";
const results = {
  initialize: {},
  "account/read": { account: { type: "chatgpt" } },
  "account/rateLimits/read": { ordinaryUsageAllowed: true },
  "config/read": { config: {} },
};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id == null) continue;
  const denied = (expired && method === "account/read") || method === "thread/start";
  const error = denied
    ? { code: -32000, message: "Expired private-token-fixture", data: { codexErrorInfo: "unauthorized" } }
    : { code: -32601, message: "Unexpected fixture method " + method };
  const response = !denied && Object.hasOwn(results, method) ? { id, result: results[method] } : { id, error };
  console.log(JSON.stringify(response));
}
`);
    return fake;
  }

  async function checkSignIn(t) {
    const f = flowWorld(t, "flow-agent-cli-sign-in");
    const auth = path.join(f.w.codex, "fake-auth.json");
    const agent = { ZODCHI_AGENT: "1" };
    const invoke = (args, override = {}) => zodchi(t, f.w, args, { cwd: f.r, env: { ...f.w.env, ...agent, ...override } });
    const assertSignIn = (result, note) => {
      t.ok(/^[^\r\n]+\r?\n$/.test(result.err), `${note}: stderr has one line`);
      const { error } = JSON.parse(result.err);
      t.eq([result.code, error.kind, error.exitCode], [3, "sign-in", 3], `${note}: code 3 is a sign-in failure`);
      t.ok(error.hint.includes("codex login") && !result.err.includes("private-token-fixture"),
        `${note}: the sign-in hint omits provider diagnostics`);
    };
    const run = (key, seconds, file = f.brief, role = "text") =>
      ["run", "--role", role, "--key", key, "--prompt", file, "--wait-sec", seconds];
    const start = ["--args", f.args({ mode: "agent" })];

    fs.unlinkSync(auth);
    const unsigned = await invoke(run("unsigned-codex", "60"));
    assertSignIn(unsigned, "unsigned Codex job");
    t.eq(unsigned.json?.job?.status, "auth_required", "run still prints the terminal job record");
    for (const command of ["wait", "job"]) {
      const observation = await invoke([command, "--key", "unsigned-codex"]);
      t.eq([observation.code, observation.json?.job?.status, observation.err],
        [2, "auth_required", ""], `${command} reports a terminal job status`);
    }
    const refused = await f.flow(start, agent);
    assertSignIn(refused, "unsigned Flow start");
    t.ok(refused.json?.refused?.includes("Codex is not signed in"), "the Flow gate still prints its refusal result");
    const plain = await f.flow(start, { ZODCHI_AGENT: "0" });
    t.eq([plain.code, plain.out, plain.err], [2, refused.out, ""], "plain mode keeps the existing Flow refusal and exit code");
    t.eq([f.claim(), f.steps()], [null, []], "no claim or model turn without sign-in");

    fs.writeFileSync(auth, "{}");
    f.answer("write", { flowError: { codexErrorInfo: "unauthorized", message: "Expired private-token-fixture" } });
    const stopped = await f.flow(start, agent);
    assertSignIn(stopped, "sign-in expires during a Flow run");
    t.eq(stopped.json?.stoppedAt, "gateway auth_required at write", "the Flow result keeps the gateway stop");
    const waited = await invoke(["flow", "wait", stopped.json.runId, "--timeout-min", "0"]);
    assertSignIn(waited, "wait observes a Flow run stopped for auth_required");
    t.eq(waited.json?.runId, stopped.json.runId, "wait still prints the observed run");

    const accounts = path.join(f.w.zhome, "accounts.json");
    const expiredHome = path.join(f.w.dir, "expired-codex");
    fs.mkdirSync(expiredHome);
    fs.writeFileSync(accounts, JSON.stringify({ accounts: [
      { name: "expired", codexHome: expiredHome },
      { name: "default", codexHome: f.w.codex },
    ] }));
    const rpc = await invoke(run("codex-auth-rpc", "60"), { ZODCHI_CODEX_BIN: authRpcFixture(f.w.dir) });
    assertSignIn(rpc, "Codex RPC authentication failure");
    t.eq([rpc.json?.job?.status, rpc.json?.job?.account, rpc.json?.job?.accountsSkipped],
      ["auth_required", "default", [{ account: "expired", reason: "not signed in to a ChatGPT subscription" }]],
      "the gateway skips an unauthorized account/read and records unauthorized thread/start as auth_required");
    t.eq(rpc.json?.job?.error, "thread/start: Expired private-token-fixture", "the job result retains its provider diagnostic");
    fs.unlinkSync(accounts);

    // A real pending job holds at the fake model until released, so even a slow runner sees code 3 here.
    const prompt = path.join(f.w.dir, "held-prompt.txt");
    fs.writeFileSync(prompt, "HOLD:agent-exit-code");
    const role = path.join(f.w.dir, "kept-thread.json");
    fs.writeFileSync(role, JSON.stringify({ mode: "work", model: "fake-model", effort: "low", sandbox: "read-only" }));
    const fake = { ZODCHI_CODEX_BIN: FAKE };
    const key = "held-codex";
    const release = () => fs.writeFileSync(path.join(f.w.codex, "fake-release-agent-exit-code"), "");
    try {
      const pending = await invoke([...run(key, "0", prompt, role), "--keep-thread"], fake);
      t.eq([pending.code, pending.err], [3, ""], "a live job returns code 3 with no sign-in envelope");
      t.ok(["queued", "running"].includes(pending.json?.job?.status), "the stdout job record is pending");
      for (const args of [["job", "--key", key], ["wait", "--key", key, "--wait-sec", "0"]]) {
        const observed = await invoke(args);
        t.eq([observed.code, observed.err], [3, ""], `${args[0]} retains code 3 for a pending job`);
        t.ok(["queued", "running"].includes(observed.json?.job?.status), `${args[0]} prints the pending job record`);
      }
    } finally {
      release();
    }
    const finished = await invoke(["wait", "--key", key, "--wait-sec", "60"]);
    t.eq([finished.code, finished.json?.job?.account, finished.json?.job?.threadId],
      [0, "default", "thread-1"], "the pending job finishes and keeps its thread on the selected account");

    fs.writeFileSync(accounts, JSON.stringify({ accounts: [{ name: "replacement", codexHome: f.w.codex }] }));
    const missingAccount = await invoke([...run("removed-thread-account", "60", f.brief, role), "--resume", key], fake);
    t.eq([missingAccount.code, missingAccount.json?.job?.status, missingAccount.err],
      [2, "auth_required", ""], "a removed resume account retains the terminal status without a sign-in envelope");
    t.ok(missingAccount.json?.job?.error?.includes("accounts.json no longer lists"), "the job result explains how the account is missing");
  }

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
  scenario("flow-agent-browser-reply-redaction", "an alternate browser variable reaches the writer and its path is redacted from the reply handoff", async (t) => {
    const f = flowWorld(t, "flow-agent-browser-reply-redaction");
    const browser = path.join(f.w.zhome, "chromium-fixture");
    const variable = "APP_TEST_CHROME";
    fs.writeFileSync(browser, "browser fixture");
    const summary = `Launch failed at ${browser}`;
    f.answer("write", { ...report("blocked", {}), summary });
    const first = await f.flow(["--args", f.args({ mode: "agent", browser: { executable: browser, variable } })]);
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
    const calls = turns(f);
    t.ok(samePath(calls.find(c => c.step === "write").config["shell_environment_policy.set"][variable], fs.realpathSync(browser)), "writer receives the alternate variable");
    t.ok(!JSON.stringify(calls.find(c => c.step === "review 1").config).includes(variable), "review does not receive the alternate variable");
    const prompt = calls[1].prompt;
    t.ok(prompt.includes("Launch failed at") && !prompt.includes(browser), "the reply handoff redacts the browser path");
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
    const screened = flowWorld(t, "flow-agent-continue-screening");
    const privateBrief = "fixture-brief-internal-shorthand";
    const privateFile = "fixture-file-internal-shorthand";
    const shapedValue = "ghp_" + "fixturevalue".repeat(3);
    const apiValue = ["sk", "live", "fixturevalue".repeat(3)].join("-");
    const urlValue = "fixture-url-inline-value";
    const credentialUrl = ["https", `fixture:${urlValue}@example.invalid/`].join("://");
    const keyType = ["PRIVATE", "KEY"].join(" ");
    const keyBody = "fixture-key-body";
    const cleanBrief = fs.readFileSync(screened.brief, "utf8");
    const runScreened = (files = ["src/math.mjs"], env = {}, extra = {}) => screened.flow([
      "--args", screened.args({ mode: "agent", files, checks: [], verify: [], ...extra }),
    ], env);
    const assertRefused = (result, locations, hidden) => {
      t.ok(result.code === 2 && locations.every(location => result.json?.refused?.includes(location)),
        "the gate refuses with the file, line, and reason for each omission");
      t.ok(hidden.every(value => !result.out.includes(value) && !result.err.includes(value)),
        "the refusal leaves the matched text out of its diagnostics");
      t.eq([
        fs.existsSync(path.join(screened.w.zhome, "flows")),
        fs.existsSync(path.join(screened.w.home, ".zodchi", "packages")), screened.steps(),
      ], [false, false, []], "the refusal creates no journal or claim and submits no model call");
    };
    fs.writeFileSync(path.join(screened.w.zhome, "private-words.txt"), privateBrief + "\n");
    fs.writeFileSync(screened.brief, `# Screening fixture\n${privateBrief}\n`);
    assertRefused(await runScreened(), ["the brief:2 (private-word)"], [privateBrief]);
    fs.writeFileSync(screened.brief, cleanBrief);

    const denylist = path.join(screened.w.dir, "omit.txt");
    fs.writeFileSync(denylist, privateFile + "\n");
    const baseFiles = ["src/notes.txt", "src/settings.txt"];
    fs.writeFileSync(path.join(screened.r, baseFiles[0]), `Notes\n${privateFile}\n`);
    fs.writeFileSync(path.join(screened.r, baseFiles[1]), [
      "Settings", shapedValue, credentialUrl,
      `-----BEGIN ${keyType}-----`, keyBody, `-----END ${keyType}-----`,
      ["api_key", JSON.stringify(apiValue)].join(" = "), "Visible footer", "",
    ].join("\n"));
    const baseBinary = "src/task-list.bin";
    fs.writeFileSync(path.join(screened.r, baseBinary), Buffer.from([0, ...Buffer.from(shapedValue), 255]));
    gitOut(screened.r, ["add", "--", ...baseFiles, baseBinary]);
    gitOut(screened.r, ["commit", "-qm", "Add screening fixtures"]);
    assertRefused(await runScreened(baseFiles, { ZODCHI_DENYLIST: denylist }), [
      `${baseFiles[0]}:2 (private-word)`, ...[2, 3, 4, 5, 6, 7].map(line => `${baseFiles[1]}:${line} (credential)`),
    ], [privateFile, shapedValue, apiValue, urlValue, keyBody]);
    for (const entry of ["src/missing.txt:1", `${baseFiles[1]}:99`, `${baseFiles[1]}:1`, `${baseFiles[0]}:2`, `${baseFiles[1]}:5`]) {
      const invalid = await runScreened(baseFiles, { ZODCHI_DENYLIST: denylist }, { allowInputLines: [entry] });
      t.ok(invalid.code === 1 && invalid.err.includes("allowInputLines"), `the allowance ${entry} is a wrong call`);
      t.ok(![invalid.out, invalid.err].some(text => text.includes(privateFile) || text.includes(keyBody)),
        "the allowance error leaves private text out of its diagnostics");
    }
    t.eq([screened.claim(), screened.steps()], [null, []], "a wrong allowance creates no claim and submits no model call");

    const inlineValue = ["fixture-added", "9X3f7D2e"].join("-");
    const inlineSetting = ["token", JSON.stringify(inlineValue)].join(" = ");
    screened.answer("write", report("done", { "src/math.mjs": `${FIXED}\nconst ${inlineSetting};\n` }));
    screened.answer("review 1", screened.review("approved"));
    const withheld = await runScreened(["src/math.mjs", baseBinary]);
    t.eq([withheld.code, withheld.json?.verdict, screened.steps()], [2, "blocked", ["write"]],
      "a writer-created credential stops the package before calling the reviewer");
    t.ok(withheld.json?.runId && !withheld.json?.refused,
      "the credential-shaped bytes in the claimed base binary pass the gate");
    const stoppedCommit = gitOut(screened.r, ["rev-parse", "HEAD"]);
    const stoppedBranch = gitOut(screened.r, ["symbolic-ref", "HEAD"]);
    t.eq(withheld.json?.rounds?.map(round => [round.n, round.commit?.commit]), [[1, stoppedCommit]],
      "the blocked round retains the receipt for the commit on the branch");
    t.ok(["round 1", stoppedCommit, "src/math.mjs:3 (credential)"].every(text => withheld.json?.question?.includes(text)),
      "the owner question names the round, commit, and candidate line");
    t.ok([stoppedCommit, stoppedBranch].every(text => withheld.json?.next?.includes(text)),
      "the next step tells the owner which branch contains the commit");
    const events = fs.readFileSync(path.join(withheld.json.journal, "events.jsonl"), "utf8");
    t.ok(!fs.existsSync(path.join(withheld.json.journal, "requests", `flow-${withheld.json.runId}-review-1.json`))
      && ![withheld.out, withheld.err, events].some(text => text.includes(inlineValue)),
      "the stop creates no review request and keeps the value out of diagnostics and events");

    const allowed = flowWorld(t, "flow-agent-continue-allowed-line");
    const source = "src/math.mjs";
    const fixtureValue = ["8d2f097c", "7b3a512e", "b1fc5098", "7e463ad2"].join("");
    const fixtureLine = ["const lockToken", JSON.stringify(fixtureValue)].join(" = ") + ";";
    const seeded = `${STUB}${fixtureLine}\n`;
    const moved = `// Keep clamp in range.\n${FIXED}`;
    fs.writeFileSync(path.join(allowed.r, source), seeded);
    gitOut(allowed.r, ["add", "--", source]);
    gitOut(allowed.r, ["commit", "-qm", "Add the lock fixture"]);
    const needsAllowance = await allowed.flow(["--args", allowed.args()]);
    t.ok(needsAllowance.code === 2 && [`${source}:2 (credential)`, "or list the lines in allowInputLines after checking they are not secrets"]
      .every(part => needsAllowance.json?.refused?.includes(part)), "the base fixture is refused with the allowance hint");
    allowed.answer("write", allowed.patch([{
      ...allowed.modify(source, seeded, null), edits: [{ old: STUB, new: moved }],
    }]));
    allowed.answer("review 1", allowed.review("approved"));
    const allowedArgs = allowed.args({ allowInputLines: [`${source}:2`] });
    const allowanceCut = await allowed.flow(["--args", allowedArgs], { ZODCHI_FLOW_CUT: "commit 1" });
    t.eq([allowanceCut.code, allowed.steps()], [75, ["write"]], "the allowance admits the base and the expert writer attachment");
    const allowanceRun = await allowed.flow(["--resume", allowed.claim().run, "--args", allowedArgs]);
    t.eq([allowanceRun.code, allowanceRun.json?.approved, allowed.steps()], [0, true, ["write", "review 1"]],
      "the allowance follows the unchanged fixture line through the resumed review");
    t.eq(fs.readFileSync(path.join(allowed.r, source), "utf8"), `${moved}${fixtureLine}\n`, "the line moved down in the patch");
    const receipt = fs.readFileSync(path.join(allowanceRun.json.journal, "run.json"), "utf8");
    t.eq(JSON.parse(receipt).inputs.allowInputLines, [{
      path: source, line: 2, sha256: createHash("sha256").update(fixtureLine).digest("hex"),
    }], "the allowance receipt pins the base path, line number and content digest");
    const allowanceEvents = fs.readFileSync(path.join(allowanceRun.json.journal, "events.jsonl"), "utf8");
    t.ok(![receipt, allowanceEvents, allowanceRun.out, allowanceRun.err].some(text => text.includes(fixtureValue)),
      "the allowance receipt and result omit the approved content");

    const changedLine = fixtureLine.replace(fixtureValue, "0" + fixtureValue.slice(1));
    allowed.answer("write", report("done", { [source]: `${moved}${changedLine}\n` }));
    const changedFixture = await allowed.flow(["--args", allowed.args({ mode: "agent", allowInputLines: [`${source}:3`] })]);
    t.eq([changedFixture.code, changedFixture.json?.stoppedAt, allowed.steps()],
      [2, "privacy screening at review 1", ["write", "review 1", "write"]], "editing the literal invalidates the allowance");
    t.ok(changedFixture.json?.question?.includes(`${source}:3 (credential)`), "the stop names the changed line");

    const expert = flowWorld(t, "flow-agent-continue-expert");
    const sourcePath = path.join(expert.r, source);
    const sourceFolder = `${expert.r.replaceAll("\\", "/")}/input`;
    const note = `// Read fixtures from ${sourceFolder}`;
    const tasks = 'const tasks = "task-list"; // disk-usage';
    const vault = "Use the API key from the vault";
    const prefix = [note, tasks, `// ${vault}`].join("\r\n");
    const before = `${prefix}\r\n${STUB.trimEnd()}`;
    const after = `${prefix}\r\n${FIXED.trimEnd()}`;
    fs.appendFileSync(expert.brief, `\n${vault}\nKeep the task-list example.\n`);
    gitOut(expert.r, ["config", "core.autocrlf", "false"]);
    fs.writeFileSync(sourcePath, `${before}\r\n`);
    gitOut(expert.r, ["add", "--", source]);
    gitOut(expert.r, ["commit", "-qm", "Record the fixture location"]);
    expert.answer("write", expert.patch([{
      ...expert.modify(source, `${before}\r\n`, null), edits: [{ old: before, new: after }],
    }]));
    expert.answer("review 1", expert.review("approved"));
    const exact = await expert.flow(["--args", expert.args()]);
    t.eq([exact.code, exact.json?.approved, expert.steps()], [0, true, ["write", "review 1"]],
      "the expert's exact edit passes checks and review");
    t.eq(exact.json?.screening, { brief: "screened", files: "screened", agentWorkspace: null },
      "the expert package records screening without an agent workspace");
    const [writeTurn, reviewTurn] = turns(expert);
    t.ok(writeTurn.prompt.includes(`<attachment path="${source}">\n${before}\n</attachment>`),
      "the writer sees the ordinary lines, original path, and CRLF in the editable fragment");
    t.eq(fs.readFileSync(sourcePath, "utf8"), `${after}\r\n`, "the edit preserves the path and line endings on disk");
    t.ok(reviewTurn.prompt.includes("<repo>/input") && !reviewTurn.prompt.includes(sourceFolder),
      "the reviewer still sees the machine path rewritten");
    t.ok(reviewTurn.prompt.includes(`<attachment path="${source}">\n${after.replace(sourceFolder, "<repo>/input")}\n</attachment>`),
      "the reviewer receives the ordinary source lines with the machine path rewritten");
    t.ok(reviewTurn.prompt.includes(` ${tasks}`) && reviewTurn.prompt.includes(` // ${vault}`),
      "the diff keeps the ordinary context lines");
    for (const { prompt } of [writeTurn, reviewTurn]) {
      t.ok(prompt.includes(`\n${vault}\nKeep the task-list example.\n</attachment>`),
        "the brief keeps both ordinary lines");
    }

    expert.answer("write", expert.patch([]));
    const cut = await expert.flow(["--args", expert.args({ checks: ["node smoke.mjs --fail"], verify: [] })],
      { ZODCHI_FLOW_CUT: "checks 1" });
    t.eq(cut.code, 75, "the second expert run cuts after the failing check");
    fs.appendFileSync(sourcePath, `${shapedValue}\r\n`);
    const stopped = await expert.flow(["--resume", expert.claim().run]);
    t.eq([stopped.code, stopped.json?.verdict, stopped.json?.stoppedAt, expert.steps()],
      [2, "blocked", "privacy screening at fix 1.1", ["write", "review 1", "write"]],
      "the expert fix stops before sending a worktree file with a withheld line");
    const stopEvents = fs.readFileSync(path.join(stopped.json.journal, "events.jsonl"), "utf8");
    t.ok(stopped.json?.question?.includes(`${source}:5 (credential)`)
      && ![stopped.out, stopped.err, stopEvents].some(text => text.includes(shapedValue)),
      "the worktree stop reports the location without the matched text");

    const repair = flowWorld(t, "flow-agent-continue-expert-repair");
    gitOut(repair.r, ["config", "core.autocrlf", "false"]);
    const comment = "// Keep this task-list note.";
    const broken = `${comment}\r\n${STUB.trimEnd()}\r\n// ${shapedValue}\r\n`;
    const repaired = `${comment}\r\n${FIXED.trimEnd()}\r\n`;
    const repairChange = repair.modify(source, broken, repaired);
    repair.answer("write", repair.patch([repair.modify(source, STUB, broken)]));
    repair.answer("fix 1.1", repair.patch([repairChange]));
    repair.answer("review 1", repair.review("approved"));
    const fixed = await repair.flow(["--args", repair.args({ fixes: 1 })]);
    t.eq([fixed.code, fixed.json?.approved, repair.steps()], [0, true, ["write", "fix 1.1", "review 1"]],
      "the expert repairs a failed candidate with a withheld line before review");
    const repairTurns = turns(repair);
    t.ok(repairTurns[1].prompt.includes(`- ${source}  blob ${repairChange.baseBlob} (screened preview`)
      && repairTurns[1].prompt.includes(`<attachment path="${source}">\n${comment}\r\n${STUB.trimEnd()}\r\n[private text removed]\n</attachment>`)
      && repairTurns.every(turn => !turn.prompt.includes(shapedValue)),
      "the fixing writer gets the exact base blob and visible lines without the withheld value");
    t.eq(fs.readFileSync(path.join(repair.r, source), "utf8"), repaired, "the fix writes the replacement with its CRLF line endings");

    const f = flowWorld(t, "flow-agent-continue");
    fs.appendFileSync(f.brief, `Workspace folders: ${f.r} and ${f.w.zhome}\n${vault}\nKeep the task-list example.\n`);
    const binaryPath = "task-list.bin";
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
    f.answer("write", { ...report("more", { "src/math.mjs": FIXED, [binaryPath]: { bytes: binary } }), summary });
    f.answer("write continue 1", report("more", {}));
    f.answer("write continue 2", report("more", {}));
    f.answer("write continue 3", report("done", {}));
    f.answer("review 1", f.review("approved"));
    const badContext = await f.flow(["--args", f.args({ mode: "agent", reviewContext: ["src/missing.mjs"] })]);
    t.ok(badContext.code === 2 && /review context file src\/missing\.mjs/.test(badContext.json?.refused ?? "") && !badContext.json?.runId,
      "an absent review context file is refused before a model turn");
    const first = await f.flow(["--args", f.args({
      mode: "agent", continuations: 12, files: ["src/math.mjs", binaryPath], reviewContext: ["src/other.mjs"],
    })], {
      ZODCHI_FLOW_CUT: "submit write continue 1",
    });
    t.eq(first.code, 75, "the engine cut after submitting the continuation");
    t.eq(fs.readFileSync(path.join(f.r, "src", "math.mjs"), "utf8").replaceAll("\r\n", "\n"), STUB, "the live checkout has yet to be written");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const result = await f.flow(["--resume", id]);
    t.eq([result.code, result.json?.approved, f.claim()?.status, f.commits().length], [0, true, "done", 1], "the original run applies and reviews once");
    t.eq(result.json?.screening, { brief: "screened", files: "screened", agentWorkspace: "not screened" },
      "the result discloses the workspace that the agent can read");
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
    for (const prompt of [requestFor("write").prompt, reviewPrompt]) {
      t.ok(prompt.includes("Workspace folders: <repo> and <zodchi-home>") && !prompt.includes(f.w.zhome),
        "machine path rewrites reach both prompts without refusing the brief");
      t.ok(prompt.includes(`${vault}\nKeep the task-list example.`), "agent mode keeps the ordinary brief lines");
    }
    t.ok(reviewPrompt.includes('<attachment path="src/other.mjs">')
      && reviewPrompt.includes("export const other = 1;") && !reviewPrompt.includes("local work outside this package"),
    "the reviewer sees pinned read-only context without the adjacent local edits");
    const receivedLimits = observed.map(turn => Object.fromEntries(Object.entries(turn.config).filter(([key]) => key in limits)));
    t.eq(receivedLimits, [limits, limits, limits, limits, {}], "Codex receives context overrides only for the worker turns");
    t.eq(observed.map(turn => [turn.ephemeral, turn.resumed ?? null]),
      Array.from({ length: 5 }, () => [true, null]), "each writer and review turn starts an ephemeral Codex thread");
    t.ok(observed[1].prompt.includes(summary), "the continuation sees the recorded writer summary");
    t.ok(samePath(observed[0].cwd, observed[1].cwd) && !samePath(f.r, observed[0].cwd), "the writer turns use the same isolated copy");
    t.eq([...fs.readFileSync(path.join(f.r, binaryPath))], binary, "the engine copies binary output without a text round trip");
    t.eq(fs.readFileSync(fromOtherPackage, "utf8"), "local work outside this package\n", "the other work in the checkout is preserved");
    const files = gitOut(f.r, ["diff", "--name-only", f.base, "HEAD"]).split("\n");
    t.eq(files, ["src/math.mjs", binaryPath], "only the scope is committed");
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
    await checkSignIn(t);
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
