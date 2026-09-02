import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { callGateway } from "../src/gateway.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function temporaryRoot(prefix) { const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, prefix)); }

test("Workflow receives the transient structured output from AgentGateway while Gateway DB retains metadata only", async () => {
  const root = temporaryRoot("workflow-gateway-integration-"), taskFile = path.join(root, "task.md"), schemaFile = path.join(root, "output.schema.json"), policyFile = path.join(root, "policy.json"), gatewayDb = path.join(root, "gateway.sqlite"), sourceHome = path.join(root, "source-home"); fs.mkdirSync(sourceHome); fs.writeFileSync(taskFile, "bounded contract"); fs.writeFileSync(schemaFile, JSON.stringify({ type: "object" }));
  fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, levels: { mvp: { maxCalls: 1, maxCorrectionCycles: 0, timeoutSec: 30 } }, providers: { codex: { command: process.execPath, args: ["-e", "console.log(JSON.stringify({usage:{input_tokens:3,output_tokens:2}}));console.log(JSON.stringify({result:'TRANSIENT_STRUCTURED_MARKER',schema:process.argv.at(-1)}))", "--"], outputSchemaArg: "--output-schema", profiles: { integration: { model: "fixture", reasoningEffort: "low", readOnly: true }, writable: { model: "fixture", reasoningEffort: "low", readOnly: false } } } } }));
  const previousTemp = process.env.AGENT_GATEWAY_TEMP, previousHome = process.env.CODEX_SOURCE_HOME; process.env.AGENT_GATEWAY_TEMP = path.join(root, "gateway-temp"); process.env.CODEX_SOURCE_HOME = sourceHome;
  try {
    const receipt = await callGateway({ gateway: path.resolve(repositoryRoot, "..", "AgentGateway", "src", "cli.mjs"), gatewayDatabase: gatewayDb, gatewayPolicy: policyFile, provider: "codex", profile: "integration", level: "mvp", role: "worker", requiresWrite: false, taskFile, outputSchemaFile: schemaFile, taskId: "integration-task" });
    assert.match(receipt.output, /TRANSIENT_STRUCTURED_MARKER/); assert.match(receipt.output, /output\.schema\.json/); assert.equal(receipt.usage.input_tokens, 3);
    assert.equal(receipt.privacyMode, "no_source_persistence");
    const db = new DatabaseSync(gatewayDb, { readOnly: true }), row = db.prepare("SELECT * FROM receipts WHERE task_id='integration-task'").get(); db.close(); assert.equal(JSON.stringify(row).includes("TRANSIENT_STRUCTURED_MARKER"), false); assert.equal(row.privacy_mode, "no_source_persistence");
    await assert.rejects(callGateway({ gateway: path.resolve(repositoryRoot, "..", "AgentGateway", "src", "cli.mjs"), gatewayDatabase: gatewayDb, gatewayPolicy: policyFile, provider: "codex", profile: "writable", level: "mvp", role: "documentator", requiresWrite: false, taskFile, taskId: "write-mismatch" }), /PROFILE_WRITE_REQUIREMENT_MISMATCH: role=documentator; profile=writable/);
  } finally {
    if (previousTemp === undefined) delete process.env.AGENT_GATEWAY_TEMP; else process.env.AGENT_GATEWAY_TEMP = previousTemp;
    if (previousHome === undefined) delete process.env.CODEX_SOURCE_HOME; else process.env.CODEX_SOURCE_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
