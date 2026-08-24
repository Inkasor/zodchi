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

function execute(root, provider, task, mode = "pass") {
  const result = spawnSync(process.execPath, [cli, "run", "--provider", provider, "--profile", `${provider}-contract`, "--level", "mvp", "--task-file", path.join(root, "task.md"), "--task", task], {
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
  const policy = mode => ({ schemaVersion: 1, levels: { mvp: { maxCalls: 1, maxCorrectionCycles: 0, timeoutSec: 10 } }, providers: Object.fromEntries(harnesses.map(provider => [provider, { command: process.execPath, args: [fakeProvider, provider, mode], profiles: { [`${provider}-contract`]: { model: `${provider}-fixture-model`, modelProvider: `${provider}-model-provider`, reasoningEffort: "low", readOnly: true } } }])) });
  fs.writeFileSync(path.join(root, "policy-pass.json"), JSON.stringify(policy("pass"), null, 2));
  fs.writeFileSync(path.join(root, "policy-fail.json"), JSON.stringify(policy("fail"), null, 2));

  const expectedInput = { codex: 11, claude: 22, kimi: 33, opencode: 44 };
  for (const provider of harnesses) {
    const call = execute(root, provider, `pass-${provider}`);
    assert.equal(call.result.status, 0, call.result.stderr); assert.equal(call.receipt.provider, provider);
    assert.equal(call.receipt.profile, `${provider}-contract`); assert.equal(call.receipt.model, `${provider}-fixture-model`);
    assert.equal(call.receipt.modelProvider, `${provider}-model-provider`);
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
  const db = openGatewayDb(path.join(root, "data", "gateway.sqlite"));
  assert.deepEqual(db.prepare("SELECT provider,status FROM receipts WHERE task_id='fail-codex'").all().map(row => ({ ...row })), [{ provider: "codex", status: "failed" }]);
  assert.deepEqual(db.prepare("SELECT provider,model_provider,COUNT(*) count FROM receipts WHERE task_id LIKE 'pass-%' GROUP BY provider,model_provider ORDER BY provider").all().map(row => ({ ...row })), harnesses.sort().map(provider => ({ provider, model_provider: `${provider}-model-provider`, count: 1 })));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});
