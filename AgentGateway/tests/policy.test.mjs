import assert from "node:assert/strict";
import test from "node:test";
import { mergeGatewayPolicies } from "../src/policy.mjs";

test("local policy overlays profiles while inheriting new universal harnesses", () => {
  const universal = {
    schemaVersion: 1,
    levels: { mvp: { maxCalls: 2 } },
    providers: {
      codex: { command: "codex", windowsCommand: "codex.exe", profiles: {} },
      opencode: { command: "opencode", windowsCommand: "opencode.exe", profiles: {} },
      openrouter: { type: "openai-compatible", profileDefaults: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" }, profiles: {} }
    }
  };
  const local = {
    schemaVersion: 1,
    providers: { codex: { profiles: { classifier: { model: "local-model", readOnly: true } } } }
  };
  const merged = mergeGatewayPolicies(universal, local);
  assert.equal(merged.providers.codex.windowsCommand, "codex.exe");
  assert.equal(merged.providers.codex.profiles.classifier.model, "local-model");
  assert.equal(merged.providers.opencode.windowsCommand, "opencode.exe");
  assert.equal(merged.providers.openrouter.profileDefaults.apiKeyEnv, "OPENROUTER_API_KEY");
});

test("policy schema mismatch fails closed", () => {
  assert.throws(() => mergeGatewayPolicies({ schemaVersion: 2 }, { schemaVersion: 1 }), /POLICY_SCHEMA_MISMATCH/);
});
