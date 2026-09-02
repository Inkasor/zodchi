import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openGatewayDb } from "../src/db.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repositoryRoot, "src", "cli.mjs"), fakeProvider = path.join(repositoryRoot, "tests", "fixtures", "fake-provider.mjs");
function temporaryRoot(prefix) { const parent = process.env.AGENT_GATEWAY_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, prefix)); }

function execute(root, provider, task, mode = "pass", options = {}) {
  const profile = options.profile ?? `${provider}-contract`;
  const args = [cli, "run", "--provider", provider, "--profile", profile, "--level", "mvp", "--role", options.role ?? "worker", "--task-file", path.join(root, "task.md"), "--task", task];
  if (options.capabilityRequirements !== null) args.push("--capability-requirements", JSON.stringify(options.capabilityRequirements ?? { required: ["context_input"], forbidden: ["project_write"] }));
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot, encoding: "utf8", windowsHide: true,
    env: { ...process.env, AGENT_GATEWAY_POLICY: path.join(root, `policy-${mode}.json`), AGENT_GATEWAY_DATA: path.join(root, "data"), AGENT_GATEWAY_DB: path.join(root, "data", "gateway.sqlite"), AGENT_GATEWAY_TEMP: path.join(root, "temp"), CODEX_SOURCE_HOME: path.join(root, "provider-homes", "codex"), KIMI_SOURCE_HOME: path.join(root, "provider-homes", "kimi") }
  });
  return { result, receipt: result.stdout.trim() ? JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)) : null };
}

test("CLI harness adapters preserve identity, usage and never fall back", () => {
  const root = temporaryRoot("gateway-provider-contracts-");
  fs.mkdirSync(path.join(root, "provider-homes", "codex"), { recursive: true }); fs.mkdirSync(path.join(root, "provider-homes", "kimi"), { recursive: true });
  fs.writeFileSync(path.join(root, "task.md"), "bounded provider contract fixture", "utf8");
  const harnesses = ["codex", "claude", "kimi", "opencode", "cursor"];
  const policy = mode => ({ schemaVersion: 1, levels: { mvp: { maxCalls: 1, maxCorrectionCycles: 0, timeoutSec: 10 } }, providers: Object.fromEntries(harnesses.map(provider => [provider, { command: process.execPath, args: [fakeProvider, provider, mode], profiles: {
    [`${provider}-contract`]: { model: `${provider}-fixture-model`, modelProvider: `${provider}-model-provider`, reasoningEffort: "low", readOnly: true, capabilities: { project_write: { status: "unavailable", enforcement: "technical", access: "none", evidenceRef: `fixture:${provider}-readonly` } } },
    [`${provider}-writable`]: { model: `${provider}-fixture-model`, modelProvider: `${provider}-model-provider`, reasoningEffort: "low", readOnly: false }
  } }])) });
  fs.writeFileSync(path.join(root, "policy-pass.json"), JSON.stringify(policy("pass"), null, 2));
  fs.writeFileSync(path.join(root, "policy-fail.json"), JSON.stringify(policy("fail"), null, 2));

  const missingRequirement = execute(root, "codex", "missing-capability-requirement", "pass", { capabilityRequirements: null });
  assert.equal(missingRequirement.result.status, 77);
  assert.match(missingRequirement.result.stderr, /PROFILE_CAPABILITY_REQUIREMENTS_INVALID/);
  assert.match(missingRequirement.result.stderr, /value=missing/);

  const expectedInput = { codex: 11, claude: 22, kimi: 33, opencode: 44 };
  for (const provider of harnesses) {
    const call = execute(root, provider, `pass-${provider}`);
    assert.equal(call.result.status, 0, call.result.stderr); assert.equal(call.receipt.provider, provider);
    assert.equal(call.receipt.profile, `${provider}-contract`); assert.equal(call.receipt.model, `${provider}-fixture-model`);
    assert.equal(call.receipt.modelProvider, `${provider}-model-provider`);
    assert.equal(call.receipt.environment.profile_capabilities.context_input.status, "available");
    if (provider === "cursor") {
      assert.equal(call.receipt.usage, null);
      assert.equal(call.receipt.sessionId, "cursor-contract-session");
    } else {
      assert.equal(call.receipt.usage.input_tokens, expectedInput[provider]);
    }
    assert.match(call.receipt.output, new RegExp(`${provider}-contract-result`));
  }
  const failed = execute(root, "codex", "fail-codex", "fail");
  assert.equal(failed.result.status, 9); assert.equal(failed.receipt.provider, "codex"); assert.equal(failed.receipt.status, "failed");
  const mismatched = execute(root, "codex", "write-mismatch", "pass", { profile: "codex-writable", role: "documentator" });
  assert.equal(mismatched.result.status, 77); assert.equal(mismatched.receipt, null);
  assert.match(mismatched.result.stderr, /PROFILE_CAPABILITY_MISMATCH/);
  assert.match(mismatched.result.stderr, /role=documentator; profile=codex-writable/);
  const matched = execute(root, "codex", "write-match", "pass", { role: "documentator" });
  assert.equal(matched.result.status, 0, matched.result.stderr); assert.equal(matched.receipt.status, "completed");
  const writer = execute(root, "codex", "writer-match", "pass", { profile: "codex-writable", capabilityRequirements: { required: ["context_input", "project_write"], forbidden: [] } });
  assert.equal(writer.result.status, 0, writer.result.stderr);

  const preflight = spawnSync(process.execPath, [cli, "profiles-check"], {
    cwd: repositoryRoot, encoding: "utf8", windowsHide: true,
    input: JSON.stringify([
      { provider: "codex", profile: "codex-contract", role: "classifier", capability_requirements: { required: ["context_input"], forbidden: ["project_write"] } },
      { provider: "codex", profile: "codex-writable", role: "documentator", capability_requirements: { required: ["context_input"], forbidden: ["project_write"] } }
    ]),
    env: { ...process.env, AGENT_GATEWAY_POLICY: path.join(root, "policy-pass.json") }
  });
  assert.equal(preflight.status, 77, preflight.stderr);
  const preflightResult = JSON.parse(preflight.stdout);
  assert.equal(preflightResult.status, "incompatible");
  assert.equal(preflightResult.conflicts.length, 1);
  assert.equal(preflightResult.conflicts[0].code, "PROFILE_CAPABILITY_MISMATCH");
  assert.equal(preflightResult.conflicts[0].mismatches[0].capability, "project_write");
  assert.equal(preflightResult.conflicts[0].mismatches[0].expectation, "forbidden");
  const db = openGatewayDb(path.join(root, "data", "gateway.sqlite"));
  assert.equal(db.prepare("SELECT COUNT(*) count FROM receipts WHERE task_id='write-mismatch'").get().count, 0);
  assert.deepEqual(db.prepare("SELECT provider,status FROM receipts WHERE task_id='fail-codex'").all().map(row => ({ ...row })), [{ provider: "codex", status: "failed" }]);
  assert.deepEqual(db.prepare("SELECT provider,model_provider,COUNT(*) count FROM receipts WHERE task_id LIKE 'pass-%' GROUP BY provider,model_provider ORDER BY provider").all().map(row => ({ ...row })), harnesses.sort().map(provider => ({ provider, model_provider: `${provider}-model-provider`, count: 1 })));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});
