import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureInstallation } from "../src/installation.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

test("onboarding writes local runtime and provider assignments without changing universal policy", () => {
  const root = temporaryRoot("workflow-installation-");
  const workflowRoot = path.join(root, "WorkflowPlatform");
  const gatewayRoot = path.join(root, "AgentGateway");
  const projectRoot = path.join(root, "Project");
  fs.mkdirSync(workflowRoot);
  fs.mkdirSync(gatewayRoot);
  fs.mkdirSync(projectRoot);
  const universal = { schemaVersion: 1, levels: { prototype: {} }, providers: { codex: { command: "codex", args: [], profiles: {} } } };
  fs.writeFileSync(path.join(gatewayRoot, "policy.json"), JSON.stringify(universal));
  const result = configureInstallation({ projectRoot, workflow: "test-workflow", responseLanguage: "ru-RU", gatewayProfiles: { codex: { "local-worker": { model: "local-model", reasoningEffort: "low" } } } }, { workflowRoot, gatewayRoot });
  assert.equal(result.status, "configured");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(gatewayRoot, "policy.json"), "utf8")), universal);
  const localPolicy = JSON.parse(fs.readFileSync(result.localPolicyFile, "utf8"));
  assert.equal(localPolicy.kind, "profile-overlay");
  assert.equal(localPolicy.providers.codex.profiles["local-worker"].model, "local-model");
  assert.equal(localPolicy.providers.codex.command, undefined);
  assert.equal(localPolicy.levels, undefined);
  const runtime = JSON.parse(fs.readFileSync(result.runtimeFile, "utf8"));
  assert.equal(runtime.projectRoot, path.resolve(projectRoot));
  assert.equal(runtime.workflow, "test-workflow");
  assert.equal(runtime.responseLanguage, "ru");
  fs.rmSync(root, { recursive: true, force: true });
});

test("onboarding rejects secret-bearing fields", () => {
  const root = temporaryRoot("workflow-installation-secret-");
  fs.mkdirSync(path.join(root, "project"));
  const forbiddenKey = ["api", "Key"].join("");
  assert.throws(() => configureInstallation({ projectRoot: path.join(root, "project"), workflow: "x", [forbiddenKey]: "must-not-be-written" }, { workflowRoot: root, gatewayRoot: root, universalPolicyFile: path.join(root, "missing.json") }), /SECRET_FIELD/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("onboarding allows environment variable references without storing a secret", () => {
  const root = temporaryRoot("workflow-installation-env-reference-");
  const workflowRoot = path.join(root, "WorkflowPlatform"), gatewayRoot = path.join(root, "AgentGateway"), projectRoot = path.join(root, "project");
  fs.mkdirSync(workflowRoot); fs.mkdirSync(gatewayRoot); fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(gatewayRoot, "policy.json"), JSON.stringify({ schemaVersion: 1, levels: { prototype: {} }, providers: { "openai-compatible": { type: "openai-compatible", profiles: {} } } }));
  const result = configureInstallation({ projectRoot, workflow: "test", gatewayProfiles: { "openai-compatible": { classifier: { baseUrl: "https://example.invalid/v1", apiKeyEnv: "EXAMPLE_API_KEY", modelProvider: "example", model: "example-model" } } } }, { workflowRoot, gatewayRoot });
  const localPolicy = JSON.parse(fs.readFileSync(result.localPolicyFile, "utf8"));
  assert.equal(localPolicy.providers["openai-compatible"].profiles.classifier.apiKeyEnv, "EXAMPLE_API_KEY");
  assert.equal(JSON.stringify(localPolicy).includes("actual-secret"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("shared installation keeps mutable configuration and databases outside the replaceable release", () => {
  const root = temporaryRoot("workflow-shared-installation-");
  const workflowRoot = path.join(root, "release", "WorkflowPlatform"), gatewayRoot = path.join(root, "release", "AgentGateway"), localDataRoot = path.join(root, "ZodchiData");
  fs.mkdirSync(workflowRoot, { recursive: true }); fs.mkdirSync(gatewayRoot, { recursive: true });
  fs.writeFileSync(path.join(gatewayRoot, "policy.json"), JSON.stringify({ schemaVersion: 1, levels: { prototype: {} }, providers: { opencode: { command: "opencode", profiles: {} } } }));
  const result = configureInstallation({ scope: "shared", localDataRoot, gatewayProfiles: { opencode: { classifier: { modelProvider: "opencode", model: "opencode/free", readOnly: true } } } }, { workflowRoot, gatewayRoot });
  assert.equal(result.scope, "shared");
  assert.equal(result.projectRoot, null); assert.equal(result.workflow, null);
  assert.equal(result.runtimeFile, path.join(localDataRoot, "config", "runtime.json"));
  assert.equal(result.localPolicyFile, path.join(localDataRoot, "gateway", "policy.local.json"));
  assert.equal(result.environment.WORKFLOW_PLATFORM_CONFIG, result.runtimeFile);
  assert.equal(fs.existsSync(path.join(workflowRoot, "config", "runtime.json")), false);
  assert.equal(fs.existsSync(path.join(gatewayRoot, "data", "policy.local.json")), false);
  const runtime = JSON.parse(fs.readFileSync(result.runtimeFile, "utf8"));
  assert.equal(path.resolve(workflowRoot, runtime.database), path.join(localDataRoot, "workflow", "workflow.sqlite"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("shared installation defaults to the platform data directory instead of the replaceable release", () => {
  const root = temporaryRoot("workflow-platform-default-data-");
  const workflowRoot = path.join(root, "release", "WorkflowPlatform"), gatewayRoot = path.join(root, "release", "AgentGateway"), platformData = path.join(root, "platform-data");
  fs.mkdirSync(workflowRoot, { recursive: true }); fs.mkdirSync(gatewayRoot, { recursive: true });
  fs.writeFileSync(path.join(gatewayRoot, "policy.json"), JSON.stringify({ schemaVersion: 1, levels: { prototype: {} }, providers: { codex: { command: "codex", profiles: {} } } }));
  const result = configureInstallation({ scope: "shared", gatewayProfiles: { codex: { classifier: { model: "fixture", readOnly: true } } } }, { workflowRoot, gatewayRoot, platformPaths: { application: path.join(root, "app"), data: platformData } });
  assert.equal(result.runtimeFile.startsWith(workflowRoot), false);
  assert.equal(result.localPolicyFile.startsWith(gatewayRoot), false);
  assert.equal(result.runtimeFile, path.join(platformData, "config", "runtime.json"));
  fs.rmSync(root, { recursive: true, force: true });
});
