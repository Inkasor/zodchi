import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { openGatewayDb } from "../src/db.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.AGENT_GATEWAY_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

test("CLI returns provider output transiently but persists only whitelisted technical receipt data", () => {
  const root = temporaryRoot("gateway-cli-receipt-");
  const policyPath = path.join(root, "policy.json");
  const databasePath = path.join(root, "data", "gateway.sqlite");
  const taskPath = path.join(root, "task.md");
  const sourceHome = path.join(root, "source-home");
  fs.mkdirSync(sourceHome);
  fs.writeFileSync(taskPath, "SECRET_PROMPT_MARKER русский исходник 😀\nSELECT card_number, token FROM private_rows;\nBINARY_LIKE_0001_FFEE_AA55");
  fs.writeFileSync(policyPath, JSON.stringify({
    schemaVersion: 1,
    levels: { mvp: { maxCalls: 1, maxCorrectionCycles: 0, timeoutSec: 10 } },
    providers: {
      codex: {
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify({usage:{input_tokens:4,output_tokens:2,private_field:'SECRET_USAGE_MARKER'}}));console.log('SECRET_OUTPUT_MARKER ответ 😀 SELECT private_value');console.error('SECRET_STDERR_MARKER пароль-секрет')"],
        profiles: { test: { reasoningEffort: "low", readOnly: true } }
      }
    }
  }, null, 2));
  const result = spawnSync(process.execPath, [path.resolve("src/cli.mjs"), "run", "--provider", "codex", "--profile", "test", "--level", "mvp", "--capability-requirements", JSON.stringify({ required: ["context_input"], forbidden: ["project_write"] }), "--task-file", taskPath, "--task", "receipt-test"], {
    cwd: path.dirname(path.resolve("src/cli.mjs")),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_GATEWAY_POLICY: policyPath,
      AGENT_GATEWAY_DATA: path.dirname(databasePath),
      AGENT_GATEWAY_DB: databasePath,
      AGENT_GATEWAY_TEMP: path.join(root, "temp"),
      CODEX_SOURCE_HOME: sourceHome
    }
  });
  assert.equal(result.status, 0, JSON.stringify({ stderr: result.stderr, stdout: result.stdout, signal: result.signal, error: result.error?.message }));
  const transientReceipt = JSON.parse(result.stdout.trim());
  assert.match(transientReceipt.output, /SECRET_OUTPUT_MARKER/);
  assert.match(transientReceipt.error, /SECRET_STDERR_MARKER/);
  const db = openGatewayDb(databasePath);
  const receipt = db.prepare("SELECT * FROM receipts WHERE task_id='receipt-test'").get();
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.input_tokens, 4);
  assert.equal(receipt.output_tokens, 2);
  assert.equal(receipt.privacy_mode, "no_source_persistence");
  assert.deepEqual(JSON.parse(receipt.persistence_attestation_json), { raw_prompt: false, raw_output: false, raw_error: false, source_samples: false, secret_samples: false });
  assert.equal(transientReceipt.privacyMode, "no_source_persistence");
  assert.match(receipt.contract_hash, /^[0-9a-f]{64}$/);
  assert.match(receipt.result_hash, /^[0-9a-f]{64}$/);
  const storedText = JSON.stringify(receipt);
  for (const secret of ["SECRET_PROMPT_MARKER", "русский исходник", "SELECT card_number", "BINARY_LIKE_0001", "SECRET_OUTPUT_MARKER", "SELECT private_value", "SECRET_STDERR_MARKER", "пароль-секрет", "SECRET_USAGE_MARKER"]) assert.equal(storedText.includes(secret), false, `stored ${secret}`);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
