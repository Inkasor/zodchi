import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export default function register({ scenario, flowWorld, zodchi, ROOT, FAKE_FLOW }) {
  for (const name of ["bad-adapter", "access-in-gap", "agent-capability", "stale-no-deploy"]) {
    scenario(`flow-incident-triage-fixture-${name}`, "exercise a synthetic incident adapter and classification fixture", async (t) => {
      const f = flowWorld(t, `incident-fixture-${name}`);
      const cases = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage", "cases");
      const spec = JSON.parse(fs.readFileSync(path.join(cases, name, "case.json"), "utf8"));
      const sourceDir = path.join(cases, spec.adapterFrom || name);
      const localDir = path.join(f.w.dir, "fixture");
      fs.cpSync(sourceDir, localDir, { recursive: true });
      const adapterPath = path.join(localDir, "adapter.json");
      const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf8"));
      for (const operation of Object.values(adapter.operations || {})) {
        if (operation.argv?.[0] === "node" && operation.argv[1] === "../../product.mjs") {
          operation.argv[0] = process.execPath;
          operation.argv[1] = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage", "product.mjs");
        }
      }
      fs.writeFileSync(adapterPath, JSON.stringify(adapter));
      const fake = path.join(f.w.dir, "incident-fake-codex.mjs");
      fs.writeFileSync(fake, fs.readFileSync(FAKE_FLOW, "utf8").replace("(?:code-package|branch-review|design-brief)", "(?:code-package|branch-review|design-brief|incident-triage)"));
      if (!spec.expect.noRevision) f.answer("classify", JSON.parse(fs.readFileSync(path.join(cases, name, "classification.json"), "utf8")));
      const tmp = path.join(f.w.dir, "incident");
      const input = path.join(f.w.dir, "args.json");
      fs.writeFileSync(input, JSON.stringify({ repo: f.r, incident: `case-${name}`, adapter: adapterPath, tmp, report: spec.report, params: spec.params,
        models: { architect: { candidates: [{ provider: "codex", model: "fake-architect", effort: "high" }] } } }));
      const run = await zodchi(t, f.w, ["flow", "incident-triage", "--args", input], { cwd: f.w.dir, env: { ...f.w.env, ZODCHI_CODEX_BIN: fake } });
      if (spec.expect.noRevision) {
        t.eq(run.code, 2, "invalid fixture adapter is refused");
        t.ok(!fs.existsSync(tmp) && f.steps().length === 0, "refusal precedes reads and model calls");
        return;
      }
      t.eq(run.json?.state, spec.expect.state, "fixture reaches its expected state");
      if (spec.expect.route) t.eq(run.json?.route, spec.expect.route, "fixture reaches its expected route");
      const revision = path.join(tmp, "rev-1");
      const evidence = JSON.parse(fs.readFileSync(path.join(revision, "evidence.json"), "utf8"));
      const classification = JSON.parse(fs.readFileSync(path.join(revision, "classification.json"), "utf8"));
      const draft = fs.readFileSync(path.join(revision, "draft.md"), "utf8");
      for (const [id, outcome] of Object.entries(spec.expect.outcomes || {})) t.eq(evidence.items.find(item => item.id === id)?.outcome, outcome, `${id} outcome`);
      if (name === "access-in-gap") t.ok(classification.refused.some(reason => reason.includes("asks for access")), "the access request is refused");
      else for (const text of spec.expect.refusedIncludes || []) t.ok(classification.refused.some(reason => reason.includes(text)), `refusal includes ${text}`);
      for (const text of spec.expect.draftIncludes || []) t.ok(draft.includes(text), `draft includes ${text}`);
      for (const id of spec.expect.gapFor || []) t.ok(classification.gaps.some(gap => gap.evidence.includes(id)), `gap covers ${id}`);
      t.eq(f.steps(), ["classify"], "one classifier call and no follow-on dispatch");
      t.ok(!fs.existsSync(path.join(tmp, ".lock")), "final revision releases its lock");
    });
  }

  scenario("flow-incident-triage-oversized-failure", "oversized output is truncated and dependencies follow the real exit status", async (t) => {
    const f = flowWorld(t, "flow-incident-triage-oversized-failure");
    const program = path.join(f.w.dir, "oversized.mjs");
    const secret = "opaqueSyntheticCredential123";
    fs.writeFileSync(program, `
const mode = process.argv[2];
const noisy = "x".repeat(32768);
if (mode === "fail") {
  process.stdout.write("permission denied\\nAuthorization: Bearer ${secret}\\n" + noisy);
  process.exitCode = 1;
} else if (mode === "stdout") {
  process.stdout.write("status\\n" + noisy);
} else if (mode === "stderr") {
  process.stdout.write("status\\n");
  process.stderr.write("permission denied\\n" + noisy);
} else {
  process.stdout.write("dependent status\\n");
}
`);
    const adapter = path.join(f.w.dir, "adapter.json");
    fs.writeFileSync(adapter, JSON.stringify({ adapterVersion: 1, product: "Catalog", owner: "owner", operations: {
      first: { description: "read status", argv: [process.execPath, program, "fail"], maxBytes: 256 },
      second: { description: "dependent read", argv: [process.execPath, program], after: ["first"] },
      stdout: { description: "read noisy stdout", argv: [process.execPath, program, "stdout"], maxBytes: 256 },
      stderr: { description: "read noisy stderr", argv: [process.execPath, program, "stderr"], maxBytes: 1024, after: ["stdout"] },
      dependent: { description: "read after both successes", argv: [process.execPath, program], after: ["stdout", "stderr"] },
    } }));
    const fake = path.join(f.w.dir, "incident-fake-codex.mjs");
    fs.writeFileSync(fake, fs.readFileSync(FAKE_FLOW, "utf8").replace("(?:code-package|branch-review|design-brief)", "(?:code-package|branch-review|design-brief|incident-triage)"));
    const args = path.join(f.w.dir, "args.json");
    fs.writeFileSync(args, JSON.stringify({ repo: f.r, incident: "case", adapter, tmp: path.join(f.w.dir, "incident"), report: `Authorization: Bearer ${secret}`, models: {
      architect: { candidates: [{ provider: "codex", model: "fake-architect", effort: "high" }] },
    } }));
    await zodchi(t, f.w, ["flow", "incident-triage", "--args", args], { cwd: f.w.dir, env: { ...f.w.env, ZODCHI_CODEX_BIN: fake } });
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const reads = path.join(f.w.zhome, "flows", id, "reads");
    const receipt = id => JSON.parse(fs.readFileSync(path.join(reads, id + ".json"), "utf8")).result;
    const first = receipt("E2");
    const second = receipt("E3");
    t.ok(first.outcome === "refused" || first.outcome === "failed", "oversized failing output is not successful");
    t.eq(first.exitCode, 1, "oversized output preserves the real nonzero exit code");
    t.eq(first.outcome, "refused", "the permission denial is still recognized");
    t.eq(first.truncated, true, "capture limit is reported");
    t.eq(second.outcome, "skipped", "dependent read is not executed");
    const stdout = receipt("E4");
    const stderr = receipt("E5");
    t.eq([stdout.outcome, stdout.exitCode, stdout.truncated], ["ok", 0, true], "large stdout is truncated and stays successful");
    t.eq([stderr.outcome, stderr.exitCode, stderr.truncated], ["ok", 0, true], "large stderr is truncated and stays successful");
    t.eq([Buffer.byteLength(stdout.excerpt), Buffer.byteLength(stderr.stderrExcerpt)], [256, 2000], "both excerpts are clipped to their byte limits");
    t.eq(receipt("E6").outcome, "ok", "the read depending on both successes runs");
    const runDir = path.join(f.w.zhome, "flows", id);
    const requestFiles = fs.readdirSync(path.join(runDir, "requests"));
    t.ok(requestFiles.length > 0, "classifier request was recorded");
    for (const file of requestFiles) t.ok(!fs.readFileSync(path.join(runDir, "requests", file), "utf8").includes(secret), "classifier request excludes the credential");
    for (const file of fs.readdirSync(reads)) t.ok(!fs.readFileSync(path.join(reads, file), "utf8").includes(secret), "saved evidence excludes the credential");
  });

  scenario("flow-incident-triage-recovery", "read receipts and a classifier job survive interruption without repeating work", async (t) => {
    const f = flowWorld(t, "flow-incident-triage-recovery");
    const fixture = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage");
    const fake = path.join(f.w.dir, "incident-fake-codex.mjs");
    fs.writeFileSync(fake, fs.readFileSync(FAKE_FLOW, "utf8").replace("(?:code-package|branch-review|design-brief)", "(?:code-package|branch-review|design-brief|incident-triage)"));
    const env = { ...f.w.env, ZODCHI_CODEX_BIN: fake };
    const answer = JSON.parse(fs.readFileSync(path.join(fixture, "cases", "plain-wait", "classification.json"), "utf8"));
    answer.gaps = [];
    f.answer("classify", answer);
    const adapterDir = path.join(f.w.dir, "adapter");
    fs.mkdirSync(path.join(adapterDir, "data"), { recursive: true });
    const statusFile = path.join(adapterDir, "data", "status.txt");
    fs.writeFileSync(statusFile, "original status\n");
    const adapter = path.join(adapterDir, "adapter.json");
    fs.writeFileSync(adapter, JSON.stringify({ adapterVersion: 1, product: "Catalog", owner: "owner", operations: {
      status: { description: "read status", argv: [process.execPath, path.join(fixture, "product.mjs"), "status"] },
    } }));
    const tmp = path.join(f.w.dir, "incident");
    const args = path.join(f.w.dir, "args.json");
    fs.writeFileSync(args, JSON.stringify({ repo: f.r, incident: "case", adapter, tmp, report: "waiting", models: {
      architect: { candidates: [{ provider: "codex", model: "fake-architect", effort: "high" }] },
    } }));
    const cli = (argv, extra = {}) => zodchi(t, f.w, ["flow", "incident-triage", ...argv], { cwd: f.w.dir, env: { ...env, ...extra } });
    const stage = await cli(["--args", args], { ZODCHI_FLOW_CUT: "incident lock stage" });
    t.eq(stage.code, 75, "the run stops after creating its private staging directory");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const owner = await cli(["--resume", id], { ZODCHI_FLOW_CUT: "incident lock owner" });
    t.eq(owner.code, 75, "the run stops after syncing its staged owner");
    const locked = await cli(["--resume", id], { ZODCHI_FLOW_CUT: "incident lock published" });
    t.eq(locked.code, 75, "the run stops after publishing the complete lock");
    const receipt = await cli(["--resume", id], { ZODCHI_FLOW_CUT: "incident receipt published E1" });
    t.eq(receipt.code, 75, "the run stops between receipt publication and its completion event");
    const cut = await cli(["--resume", id], { ZODCHI_FLOW_CUT: "incident receipt synced E2" });
    t.eq(cut.code, 75, "the run stops after syncing the external read before publication");
    fs.writeFileSync(statusFile, "changed status\n");
    const submit = await cli(["--resume", id], { ZODCHI_FLOW_CUT: "submit classify" });
    t.eq(submit.code, 75, "the run stops after submitting the classifier");
    const published = await cli(["--resume", id], { ZODCHI_FLOW_CUT: "publish incident" });
    t.eq(published.code, 75, "the run stops after publishing the incident pointer");
    const release = await cli(["--resume", id], { ZODCHI_FLOW_CUT: "incident lock released" });
    t.eq(release.code, 75, "the run stops after moving its lock to the tombstone");
    const foreignDir = path.join(tmp, ".lock");
    const foreign = JSON.stringify({ token: "0123456789abcdef0123456789abcdef" });
    fs.mkdirSync(foreignDir);
    fs.writeFileSync(path.join(foreignDir, "owner"), foreign);
    const synced = await cli(["--resume", id], { ZODCHI_FLOW_CUT: "incident lock release synced" });
    t.eq(synced.code, 75, "resume syncs the incident directory before finishing");
    const events = fs.readFileSync(path.join(f.w.zhome, "flows", id, "events.jsonl"), "utf8");
    t.ok(!events.split("\n").filter(Boolean).some((line) => JSON.parse(line).kind === "finished"), "the journal is unfinished at the sync boundary");
    t.eq(fs.readFileSync(path.join(foreignDir, "owner"), "utf8"), foreign, "sync preserves a later run's lock");
    const cleanup = await cli(["--resume", id], { ZODCHI_FLOW_CUT: "incident lock cleanup" });
    t.eq(cleanup.code, 75, "the run stops while cleaning its released lock");
    const result = await cli(["--resume", id]);
    t.eq(result.code, 0, "the same run completes");
    t.eq(fs.readFileSync(path.join(foreignDir, "owner"), "utf8"), foreign, "resume preserves a later run's lock");
    const evidence = fs.readFileSync(result.json.files.evidence, "utf8");
    t.ok(evidence.includes("original status") && !evidence.includes("changed status"), "the saved read is reused");
    const classification = JSON.parse(fs.readFileSync(result.json.files.classification, "utf8"));
    t.eq(classification.classifier.key, result.json.jobKey, "the classification retains the submitted key");
    t.eq(f.steps(), ["classify"], "the classifier is not called again");
  });

  scenario("flow-incident-triage-unresolved-read", "only an explicit rerun repeats an interrupted read", async (t) => {
    const f = flowWorld(t, "flow-incident-triage-unresolved-read");
    const fixture = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage");
    const answer = JSON.parse(fs.readFileSync(path.join(fixture, "cases", "plain-wait", "classification.json"), "utf8"));
    answer.gaps = [];
    f.answer("classify", answer);
    const adapterDir = path.join(f.w.dir, "adapter");
    fs.mkdirSync(path.join(adapterDir, "data"), { recursive: true });
    const statusFile = path.join(adapterDir, "data", "status.txt");
    const logsFile = path.join(adapterDir, "data", "logs.txt");
    fs.writeFileSync(statusFile, "original status\n");
    fs.writeFileSync(logsFile, "original log\n");
    const product = path.join(fixture, "product.mjs");
    const adapter = path.join(adapterDir, "adapter.json");
    fs.writeFileSync(adapter, JSON.stringify({ adapterVersion: 1, product: "Catalog", owner: "owner", operations: {
      status: { description: "read status", argv: [process.execPath, product, "status"] },
      logs: { description: "read logs", argv: [process.execPath, product, "logs"], after: ["status"] },
    } }));
    const tmp = path.join(f.w.dir, "incident");
    const args = path.join(f.w.dir, "args.json");
    fs.writeFileSync(args, JSON.stringify({ repo: f.r, incident: "case", adapter, tmp, report: "waiting", models: {
      architect: { candidates: [{ provider: "codex", model: "fake-architect", effort: "high" }] },
    } }));
    const cli = (argv, extra = {}) => zodchi(t, f.w, ["flow", "incident-triage", ...argv], { cwd: f.w.dir, env: { ...f.w.env, ...extra } });
    const saved = await cli(["--args", args], { ZODCHI_FLOW_CUT: "incident receipt E2" });
    t.eq(saved.code, 75, "the first external read has a receipt");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const runDir = path.join(f.w.zhome, "flows", id);
    const reads = path.join(runDir, "reads");
    const boundary = process.platform === "win32" ? "incident read contained" : "incident intent E3";
    const cut = await cli(["--resume", id], { ZODCHI_FLOW_CUT: boundary });
    t.eq(cut.code, 75, "cut follows the read intent at the earliest contained launch boundary");
    const reportReceipt = fs.readFileSync(path.join(reads, "E1.json"));
    const statusReceipt = fs.readFileSync(path.join(reads, "E2.json"));
    const pending = path.join(reads, "E3.pending");
    const tooEarly = await cli(["--resume", id, "--rerun", "read E3"]);
    t.ok(tooEarly.code === 1 && tooEarly.err.includes("--rerun must name"), "the interrupted step must first be reported by a resume");
    const missing = await cli(["--resume", id]);
    t.eq([missing.code, missing.json?.reason, missing.json?.stoppedAt], [2, "unresolved read", "read E3"], "resume reports the unresolved read");
    fs.writeFileSync(pending, '{"id":');
    const resumed = await cli(["--resume", id]);
    t.eq([resumed.code, resumed.json?.reason, resumed.json?.stoppedAt], [2, "unresolved read", "read E3"], "a partial receipt still stops the read");
    t.ok(resumed.json?.next?.includes(`--resume ${id} --rerun "read E3"`), "the stop gives the exact rerun command");
    t.ok(fs.readFileSync(path.join(reads, "E1.json")).equals(reportReceipt), "the earlier receipt is retained unchanged");
    t.ok(!fs.existsSync(path.join(reads, "E3.json")), "there is no receipt from a repeated read");
    t.eq(fs.readFileSync(pending, "utf8"), '{"id":', "plain resume preserves the partial receipt");
    t.eq(f.steps(), [], "no classifier was submitted");
    t.ok(fs.existsSync(path.join(tmp, ".lock")), "the unresolved revision stays locked");

    const wrong = await cli(["--resume", id, "--rerun", "read E2"]);
    t.ok(wrong.code === 1 && wrong.err.includes("--rerun must name"), "rerun refuses a different step");
    fs.writeFileSync(statusFile, "changed status\n");
    fs.writeFileSync(logsFile, "updated log\n");
    const repeat = await cli(["--resume", id, "--rerun", "read E3"]);
    t.eq([repeat.code, repeat.json?.revision, repeat.json?.accepted], [0, 1, true], "explicit rerun completes the same revision");
    t.ok(!fs.existsSync(path.join(tmp, ".lock")), "completed rerun releases the incident lock");
    t.ok(!fs.existsSync(pending), "the partial pending receipt was discarded");
    t.ok(fs.readFileSync(path.join(reads, "E1.json")).equals(reportReceipt), "the report receipt is reused");
    t.ok(fs.readFileSync(path.join(reads, "E2.json")).equals(statusReceipt), "the completed external read receipt is reused");
    const evidence = JSON.parse(fs.readFileSync(repeat.json.files.evidence, "utf8"));
    t.eq(evidence.items.map((item) => item.excerpt), ["waiting", "original status", "updated log"], "only the interrupted read collects new evidence");
    const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    t.eq(events.filter(event => event.kind === "rerun").map(event => event.step), ["read E3"], "the journal records only the named rerun");
    t.eq(events.filter(event => event.kind === "read intent").map(event => [event.step, event.attempt]),
      [["read E1", 1], ["read E2", 1], ["read E3", 1], ["read E3", 2]], "only the interrupted read gets a second intent");
    t.eq(f.steps(), ["classify"], "classification runs once after collection");
  });

  scenario("flow-incident-triage-foreign-lock", "a resumed run refuses a lock belonging to another run", async (t) => {
    const f = flowWorld(t, "flow-incident-triage-foreign-lock");
    const fixture = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage");
    const adapterDir = path.join(f.w.dir, "adapter");
    fs.mkdirSync(path.join(adapterDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(adapterDir, "data", "status.txt"), "status\n");
    const adapter = path.join(adapterDir, "adapter.json");
    fs.writeFileSync(adapter, JSON.stringify({ adapterVersion: 1, product: "Catalog", owner: "owner", operations: {
      status: { description: "read status", argv: [process.execPath, path.join(fixture, "product.mjs"), "status"] },
    } }));
    const tmp = path.join(f.w.dir, "incident");
    const args = path.join(f.w.dir, "args.json");
    fs.writeFileSync(args, JSON.stringify({ repo: f.r, incident: "case", adapter, tmp, report: "waiting", models: {
      architect: { candidates: [{ provider: "codex", model: "fake-architect", effort: "high" }] },
    } }));
    const cli = (argv, extra = {}) => zodchi(t, f.w, ["flow", "incident-triage", ...argv], { cwd: f.w.dir, env: { ...f.w.env, ...extra } });
    const cut = await cli(["--args", args], { ZODCHI_FLOW_CUT: "incident receipt E2" });
    t.eq(cut.code, 75, "cut follows the status receipt");
    const [id] = fs.readdirSync(path.join(f.w.zhome, "flows"));
    const owner = path.join(tmp, ".lock", "owner");
    const foreign = JSON.stringify({ token: "0123456789abcdef0123456789abcdef" });
    fs.writeFileSync(owner, foreign);
    const resumed = await cli(["--resume", id]);
    t.ok(resumed.code !== 0, "resume refuses the foreign lock");
    t.eq(fs.readFileSync(owner, "utf8"), foreign, "foreign ownership is preserved");
    t.eq(f.steps(), [], "no classifier was submitted");
  });

  scenario("flow-incident-triage-refusals", "unsafe adapters and unavailable classifier models stop before reads", async (t) => {
    const f = flowWorld(t, "flow-incident-triage-refusals");
    const adapter = path.join(f.w.dir, "adapter.json");
    const input = path.join(f.w.dir, "args.json");
    const tmp = path.join(f.w.dir, "incident");
    const program = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage", "product.mjs");
    const settings = { repo: f.r, incident: "case", adapter, tmp, report: "a report", models: { architect: { candidates: [{ provider: "codex", model: "unsupported-model", effort: "high" }] } } };
    const writeAdapter = argv => fs.writeFileSync(adapter, JSON.stringify({ adapterVersion: 1, product: "Catalog", owner: "owner", operations: { status: { description: "read status", argv } } }));
    const cli = env => zodchi(t, f.w, ["flow", "incident-triage", "--args", input], { cwd: f.w.dir, env });
    fs.writeFileSync(input, JSON.stringify(settings));
    writeAdapter([process.execPath, "-e", "process.exit(0)"]);
    const refused = await cli(f.w.env);
    t.eq(refused.code, 2, "an adapter with a code flag is refused");
    t.ok(!fs.existsSync(tmp) && f.steps().length === 0, "no incident read or model call ran");
    for (const ext of ["cmd", "bat"]) {
      const batch = path.join(f.w.dir, `read.${ext}`);
      fs.writeFileSync(batch, "@exit /b 0\r\n");
      writeAdapter([batch]);
      const result = await cli(f.w.env);
      t.eq(result.code, 2, `an existing .${ext} entry point is refused`);
      t.ok(!fs.existsSync(tmp) && f.steps().length === 0, "batch refusal precedes all reads");
    }
    const source = fs.readFileSync(FAKE_FLOW, "utf8");
    const marker = 'case "thread/start":';
    t.ok(source.includes(marker), "the fake gateway thread handler is available");
    const fake = path.join(f.w.dir, "reject-model.mjs");
    fs.writeFileSync(fake, source.replace(marker, `${marker}\n      if (p.model === "unsupported-model") return send({ id: msg.id, error: { code: -32602, message: "unsupported model" } });`));
    writeAdapter([process.execPath, program, "status"]);
    const unavailable = await cli({ ...f.w.env, ZODCHI_CODEX_BIN: fake });
    t.eq(unavailable.code, 2, "an unavailable model is refused by preflight");
    t.ok(!fs.existsSync(tmp) && f.steps().length === 0, "model preflight precedes external incident reads");
  });

  scenario("flow-incident-triage-answer-refused", "answers with unknown evidence IDs or actual credentials are refused", async (t) => {
    const f = flowWorld(t, "flow-incident-triage-answer-refused");
    const fixture = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage");
    const fake = path.join(f.w.dir, "incident-fake-codex.mjs");
    fs.writeFileSync(fake, fs.readFileSync(FAKE_FLOW, "utf8").replace("(?:code-package|branch-review|design-brief)", "(?:code-package|branch-review|design-brief|incident-triage)"));
    const env = { ...f.w.env, ZODCHI_CODEX_BIN: fake };
    const answer = JSON.parse(fs.readFileSync(path.join(fixture, "cases", "plain-wait", "classification.json"), "utf8"));
    answer.findings[0].evidence = ["E999"];
    f.answer("classify", answer);
    const adapterDir = path.join(f.w.dir, "adapter");
    fs.mkdirSync(path.join(adapterDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(adapterDir, "data", "status.txt"), "waiting\n");
    const adapter = path.join(adapterDir, "adapter.json");
    fs.writeFileSync(adapter, JSON.stringify({ adapterVersion: 1, product: "Catalog", owner: "owner", operations: {
      status: { description: "read status", argv: [process.execPath, path.join(fixture, "product.mjs"), "status"] },
    } }));
    const tmp = path.join(f.w.dir, "incident");
    const args = path.join(f.w.dir, "args.json");
    fs.writeFileSync(args, JSON.stringify({ repo: f.r, incident: "case", adapter, tmp, report: "waiting", models: {
      architect: { candidates: [{ provider: "codex", model: "fake-architect", effort: "high" }] },
    } }));
    const run = await zodchi(t, f.w, ["flow", "incident-triage", "--args", args], { cwd: f.w.dir, env });
    t.eq([run.code, run.json?.state, run.json?.accepted], [2, "failed", false], "the answer is refused and the revision is failed");
    const classification = JSON.parse(fs.readFileSync(path.join(tmp, "rev-1", "classification.json"), "utf8"));
    t.ok(classification.refused.length > 0, "the refused classification records the reason");
    t.eq(f.steps(), ["classify"], "the refusal starts no further model or workflow");
    t.ok(!fs.existsSync(path.join(tmp, ".lock")), "the failed final revision released its lock");

    answer.findings[0].evidence = ["E2"];
    answer.gaps = [];
    answer.reply = "The log contains password=hunter2xyz.";
    f.answer("classify", answer);
    const secret = await zodchi(t, f.w, ["flow", "incident-triage", "--args", args], { cwd: f.w.dir, env });
    t.eq([secret.code, secret.json?.stoppedAt, secret.json?.lockLeft], [2, "invalid answer at classify", true], "a real credential stops classification");
    const privateRevision = path.join(tmp, "rev-2");
    t.ok(!fs.existsSync(path.join(privateRevision, "classification.raw.json")) && !fs.existsSync(path.join(privateRevision, "draft.md")),
      "the private answer is not published");
    const resumed = await zodchi(t, f.w, ["flow", "incident-triage", "--resume", secret.json.runId], { cwd: f.w.dir, env });
    t.eq([resumed.code, resumed.json?.stoppedAt, resumed.json?.jobKey],
      [2, "invalid answer at classify", secret.json.jobKey], "resume rechecks the same private answer");
    t.eq(f.steps(), ["classify", "classify"], "each run submits one classifier");
  });

  scenario("flow-incident-triage-ordinary-words", "ordinary privacy-related words and identifiers pass screening", async (t) => {
    const f = flowWorld(t, "flow-incident-triage-ordinary-words");
    const fixture = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage");
    const answer = JSON.parse(fs.readFileSync(path.join(fixture, "cases", "plain-wait", "classification.json"), "utf8"));
    answer.gaps = [];
    answer.facts = "The API token expired during a disk-full incident.";
    answer.findings[0].summary = answer.facts;
    answer.reply = "Run a basic check and never paste credentials.\r\n";
    f.answer("classify", answer);
    const adapterDir = path.join(f.w.dir, "adapter");
    fs.mkdirSync(path.join(adapterDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(adapterDir, "data", "status-task-123.txt"), "status for task-123\n");
    const adapter = path.join(adapterDir, "adapter.json");
    fs.writeFileSync(adapter, JSON.stringify({ adapterVersion: 1, product: "Catalog", owner: "owner", operations: {
      status: { description: "read status", argv: [process.execPath, path.join(fixture, "product.mjs"), "status", "{id}"], args: { id: "task-[0-9]+" } },
    } }));
    const tmp = path.join(f.w.dir, "token-service", "task-7");
    const repo = path.join(f.w.dir, "task-7-repo");
    fs.renameSync(f.r, repo);
    const args = path.join(f.w.dir, "args.json");
    fs.writeFileSync(args, JSON.stringify({ repo, incident: "disk-full-2026", adapter, tmp,
      report: "Disk full. The API token expired.", params: { id: "task-123" }, models: {
        architect: { candidates: [{ provider: "codex", model: "fake-architect", effort: "high" }] },
      } }));
    const run = await zodchi(t, f.w, ["flow", "incident-triage", "--args", args], { cwd: f.w.dir });
    t.eq([run.code, run.json?.incident, run.json?.state], [0, "disk-full-2026", "drafted"], "ordinary words and paths do not stop the run");
    const evidence = JSON.parse(fs.readFileSync(run.json.files.evidence, "utf8"));
    t.eq(evidence.items[1].outcome, "ok", "a task identifier fills the operation's placeholder");
    t.ok(!evidence.items[0].excerpt.includes("API token expired"), "the inbound report is still redacted");
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, "rev-1", "classification.raw.json"), "utf8"));
    t.eq([saved.facts, saved.reply], [answer.facts, answer.reply], "classifier wording and trailing line ending are retained");
    t.eq(f.steps(), ["classify"], "the classifier is called once");
    t.ok(!fs.existsSync(path.join(tmp, ".lock")), "completion releases the incident lock");
  });

  scenario("flow-incident-triage-detached", "a detached incident collects bounded reads and resumes with one classifier call", async (t) => {
    const f = flowWorld(t, "flow-incident-triage-detached");
    const fake = path.join(f.w.dir, "incident-fake-codex.mjs");
    const source = fs.readFileSync(FAKE_FLOW, "utf8");
    fs.writeFileSync(fake, source);
    const env = { ...f.w.env, ZODCHI_CODEX_BIN: fake };
    const fixture = path.join(ROOT, "scripts", "e2e", "fixtures", "incident-triage");
    const answer = JSON.parse(fs.readFileSync(path.join(fixture, "cases", "plain-wait", "classification.json"), "utf8"));
    f.answer("classify", answer);
    const adapterDir = path.join(f.w.dir, "adapter");
    fs.mkdirSync(path.join(adapterDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(adapterDir, "data", "status.txt"), "The release is waiting for a process.\n");
    fs.writeFileSync(path.join(adapterDir, "data", "processes.refused"), "refused by policy\n");
    const product = path.join(fixture, "product.mjs");
    const adapterFile = path.join(adapterDir, "adapter.json");
    fs.writeFileSync(adapterFile, JSON.stringify({
      adapterVersion: 1, product: "Example Catalog", owner: "product owner", operator: "operator",
      operations: {
        status: { description: "read release status", argv: [process.execPath, product, "status"], provides: ["status"] },
        processes: { description: "read the process", argv: [process.execPath, product, "processes"], provides: ["other"] },
      },
    }));
    const incident = path.join(f.w.dir, "incident");
    const input = path.join(f.w.dir, "incident-args.json");
    fs.writeFileSync(input, JSON.stringify({ repo: f.r, incident: "release-1", adapter: adapterFile, tmp: incident,
      report: "Release is waiting. password=hunter2-secret", models: { architect: { candidates: [{ provider: "codex", model: "fake-architect", effort: "high" }] } } }));
    const cli = (...args) => zodchi(t, f.w, ["flow", ...args], { cwd: f.w.dir, env });
    const start = await cli("incident-triage", "--args", input, "--detach");
    t.eq(start.code, 0, "the detached run starts");
    const id = start.json?.runId;
    t.ok(Boolean(id), "the detached result has a run ID");
    const resumed = await cli("incident-triage", "--resume", id);
    t.ok([0, 2].includes(resumed.code), "another CLI can inspect or resume the same run");
    const status = await t.until("the incident run finishes", async () => {
      const result = await cli("status", id);
      if (["stopped", "interrupted"].includes(result.json?.status)) throw new Error(`incident stopped: ${JSON.stringify(result.json)}`);
      return result.json?.status === "finished" && result.json;
    });
    const result = status.result;
    t.eq([result.runId, result.state, result.route], [id, "drafted", "reply"], "the original run publishes a draft");
    const evidence = fs.readFileSync(result.files.evidence);
    const bundle = JSON.parse(evidence);
    const classificationBytes = fs.readFileSync(result.files.classification);
    const draftBytes = fs.readFileSync(result.files.draft);
    const rawBytes = fs.readFileSync(path.join(incident, "rev-1", "classification.raw.json"));
    const classification = JSON.parse(classificationBytes);
    const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
    t.eq(bundle.items.map(item => item.outcome), ["ok", "ok", "refused"], "actual product reads and a refusal are recorded");
    t.eq([sha(evidence), sha(classificationBytes), sha(draftBytes), sha(rawBytes)],
      [result.evidenceSha256, result.classificationSha256, result.draftSha256, classification.rawSha256], "the artifact hashes match their bytes");
    t.ok(!evidence.toString().includes("hunter2-secret"), "the report secret is not saved in evidence");
    t.ok(!fs.readFileSync(path.join(f.w.zhome, "flows", id, "run.json"), "utf8").includes("hunter2-secret"), "the raw report is not saved in run arguments");
    for (const name of ["material.json", "events.jsonl"]) {
      t.ok(!fs.readFileSync(path.join(f.w.zhome, "flows", id, name), "utf8").includes("hunter2-secret"), `${name} contains no report secret`);
    }
    t.eq(f.steps(), ["classify"], "exactly one classifier call ran");
    t.ok(!fs.existsSync(path.join(incident, ".lock")), "the final revision released its own incident lock");
  });
}
