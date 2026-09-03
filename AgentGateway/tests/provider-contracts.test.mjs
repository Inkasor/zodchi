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
  if (options.outputSchema) args.push("--output-schema", path.join(root, "result.schema.json"));
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot, encoding: "utf8", windowsHide: true,
    env: { ...process.env, AGENT_GATEWAY_POLICY: path.join(root, `policy-${mode}.json`), AGENT_GATEWAY_DATA: path.join(root, "data"), AGENT_GATEWAY_DB: path.join(root, "data", "gateway.sqlite"), AGENT_GATEWAY_TEMP: path.join(root, "temp"), CODEX_SOURCE_HOME: path.join(root, "provider-homes", "codex"), CLAUDE_SOURCE_MCP_CONFIG: path.join(root, "provider-homes", "claude.json"), KIMI_SOURCE_HOME: path.join(root, "provider-homes", "kimi") }
  });
  return { result, receipt: result.stdout.trim() ? JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)) : null };
}

test("CLI harness adapters preserve identity, usage and never fall back", () => {
  const root = temporaryRoot("gateway-provider-contracts-");
  fs.mkdirSync(path.join(root, "provider-homes", "codex"), { recursive: true }); fs.mkdirSync(path.join(root, "provider-homes", "kimi"), { recursive: true });
  fs.writeFileSync(path.join(root, "provider-homes", "claude.json"), JSON.stringify({ mcpServers: { playwright: { command: "fixture-playwright" }, personal: { command: "fixture-personal" } } }));
  fs.writeFileSync(path.join(root, "task.md"), "bounded provider contract fixture", "utf8");
  fs.writeFileSync(path.join(root, "result.schema.json"), JSON.stringify({ type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["ok"] } } }), "utf8");
  const harnesses = ["codex", "claude", "kimi", "opencode", "cursor"];
  const policy = mode => ({ schemaVersion: 1, levels: { mvp: { maxCalls: 1, maxCorrectionCycles: 0, timeoutSec: 10 } }, pricing: { schemaVersion: 1, unit: "usd_per_million_tokens", models: Object.fromEntries(harnesses.map(provider => [`${provider}-fixture-model`, { input_usd_per_million: 1, cached_input_usd_per_million: 0.1, output_usd_per_million: 2 }])) }, providers: Object.fromEntries(harnesses.map(provider => [provider, { command: process.execPath, args: [fakeProvider, provider, mode], ...(provider === "claude" ? { outputSchemaArg: "--json-schema", outputSchemaFormat: "json" } : {}), profiles: {
    [`${provider}-contract`]: { model: `${provider}-fixture-model`, modelProvider: `${provider}-model-provider`, reasoningEffort: "low", readOnly: true, capabilities: { project_write: { status: "unavailable", enforcement: "technical", access: "none", evidenceRef: `fixture:${provider}-readonly` } } },
    [`${provider}-writable`]: { model: `${provider}-fixture-model`, modelProvider: `${provider}-model-provider`, reasoningEffort: "low", readOnly: false },
    ...(provider === "claude" ? {
      "claude-browser-mcp": { model: "claude-fixture-model", modelProvider: "claude-model-provider", reasoningEffort: "low", readOnly: true, allowedMcpServers: ["playwright"], browserMcpServer: "playwright", capabilities: { project_write: { status: "unavailable", enforcement: "technical", access: "none", evidenceRef: "fixture:claude-readonly" } } },
      "claude-browser-missing": { model: "claude-fixture-model", modelProvider: "claude-model-provider", reasoningEffort: "low", readOnly: true, allowedMcpServers: ["missing"], browserMcpServer: "missing", capabilities: { project_write: { status: "unavailable", enforcement: "technical", access: "none", evidenceRef: "fixture:claude-readonly" } } }
    } : {}),
    ...(provider === "kimi" ? {
      "kimi-declarative-reviewer": { model: "kimi-fixture-model", modelProvider: "kimi-model-provider", reasoningEffort: "low", readOnly: true, acceptedDeclarativeBoundaries: [{ capability: "project_write", roles: ["evidence_reviewer", "strategy_reviewer"], reason: "Owner accepted Kimi's declarative boundary for reviewer roles." }] }
    } : {})
  } }])) });
  const pluginSkill = path.join(root, "plugins", "game-production", "0.1.0", "skills", "shared-map-engine");
  const pluginVersion = path.join(pluginSkill, "..", "..");
  fs.mkdirSync(path.join(pluginVersion, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(pluginVersion, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "game-production" }));
  fs.mkdirSync(pluginSkill, { recursive: true });
  fs.writeFileSync(path.join(pluginSkill, "SKILL.md"), "---\nname: shared-map-engine\n---\nBounded namespaced skill", "utf8");
  const passPolicy = policy("pass"), failPolicy = policy("fail");
  for (const currentPolicy of [passPolicy, failPolicy]) currentPolicy.providers.codex.profiles["codex-plugin-skill"] = {
    model: "codex-fixture-model", modelProvider: "codex-model-provider", reasoningEffort: "low", readOnly: true, allowedSkills: [pluginSkill]
  };
  fs.writeFileSync(path.join(root, "policy-pass.json"), JSON.stringify(passPolicy, null, 2));
  fs.writeFileSync(path.join(root, "policy-fail.json"), JSON.stringify(failPolicy, null, 2));

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
      if (provider === "opencode") assert.equal(call.receipt.usage.cost_usd, 0.001);
      else {
        assert.equal(call.receipt.usage.cost_source, "configured_model_pricing");
        assert.ok(call.receipt.usage.cost_usd > 0);
      }
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
  const namespacedSkill = execute(root, "codex", "namespaced-skill", "pass", { profile: "codex-plugin-skill", capabilityRequirements: { required: ["context_input", "skills"], forbidden: ["project_write"], allowed_skills: ["game-production:shared-map-engine"] } });
  assert.equal(namespacedSkill.result.status, 0, namespacedSkill.result.stderr);
  assert.equal(namespacedSkill.receipt.environment.profile_capabilities.skills.status, "available");
  assert.equal(namespacedSkill.receipt.environment.profile_capabilities.skills.enforcement, "technical");
  assert.deepEqual(namespacedSkill.receipt.environment.input_manifest.skills.map(item => item.name), ["game-production:shared-map-engine"]);
  assert.equal(namespacedSkill.receipt.environment.input_manifest.skills[0].files[0].sha256.length, 64);
  const kimiReviewer = execute(root, "kimi", "accepted-declarative-reviewer", "pass", { profile: "kimi-declarative-reviewer", role: "evidence_reviewer" });
  assert.equal(kimiReviewer.result.status, 0, kimiReviewer.result.stderr);
  assert.equal(kimiReviewer.receipt.environment.profile_capabilities.project_write.boundary_acceptance.status, "accepted_declarative");
  assert.equal(kimiReviewer.receipt.environment.profile_capabilities.project_write.boundary_acceptance.reason, "Owner accepted Kimi's declarative boundary for reviewer roles.");
  const kimiWrongRole = execute(root, "kimi", "rejected-declarative-worker", "pass", { profile: "kimi-declarative-reviewer", role: "worker" });
  assert.equal(kimiWrongRole.result.status, 77);
  const claudeBrowser = execute(root, "claude", "claude-browser-mcp", "pass", { profile: "claude-browser-mcp", outputSchema: true, capabilityRequirements: { required: ["context_input"], forbidden: ["project_write"], allowed_mcp_servers: ["playwright"] } });
  assert.equal(claudeBrowser.result.status, 0, claudeBrowser.result.stderr);
  assert.match(claudeBrowser.receipt.output, /--strict-mcp-config/);
  assert.match(claudeBrowser.receipt.output, /--mcp-config/);
  assert.match(claudeBrowser.receipt.output, /--json-schema/);
  assert.match(claudeBrowser.receipt.output, /additionalProperties/);
  assert.deepEqual(claudeBrowser.receipt.environment.provider_environment.mcp_servers.carried, [{ scope: "home", name: "playwright" }]);
  assert.deepEqual(claudeBrowser.receipt.environment.provider_environment.mcp_servers.withheld, [{ scope: "home", name: "personal" }]);
  const missingClaudeBrowser = execute(root, "claude", "claude-browser-missing", "pass", { profile: "claude-browser-missing", capabilityRequirements: { required: ["context_input"], forbidden: ["project_write"], allowed_mcp_servers: ["missing"] } });
  assert.equal(missingClaudeBrowser.result.status, 77);
  assert.match(missingClaudeBrowser.receipt.error, /PROFILE_CAPABILITY_MISMATCH/);
  assert.match(missingClaudeBrowser.receipt.error, /BROWSER_MCP_SERVER_NOT_CARRIED: missing/);

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
  const acceptedPreflight = spawnSync(process.execPath, [cli, "profiles-check"], {
    cwd: repositoryRoot, encoding: "utf8", windowsHide: true,
    input: JSON.stringify([{ provider: "kimi", profile: "kimi-declarative-reviewer", role: "strategy_reviewer", capability_requirements: { required: ["context_input"], forbidden: ["project_write"] } }]),
    env: { ...process.env, AGENT_GATEWAY_POLICY: path.join(root, "policy-pass.json") }
  });
  assert.equal(acceptedPreflight.status, 0, acceptedPreflight.stderr);
  const acceptedPreflightResult = JSON.parse(acceptedPreflight.stdout);
  assert.equal(acceptedPreflightResult.status, "accepted_declarative");
  assert.equal(acceptedPreflightResult.checks[0].status, "accepted_declarative");
  assert.equal(acceptedPreflightResult.checks[0].accepted_declarative[0].reason, "Owner accepted Kimi's declarative boundary for reviewer roles.");
  const boundaryPreflight = spawnSync(process.execPath, [cli, "profiles-check"], {
    cwd: repositoryRoot, encoding: "utf8", windowsHide: true,
    input: JSON.stringify([
      { provider: "codex", profile: "codex-contract", role: "researcher", capability_requirements: { required: ["context_input", "skills"], forbidden: ["project_write"], allowed_skills: ["missing-info"] } },
      { provider: "claude", profile: "claude-browser-mcp", role: "worker", capability_requirements: { required: ["context_input", "mcp"], forbidden: ["external_mutation", "project_write"], allowed_mcp_servers: ["playwright"], external_tools: [{ name: "playwright", transport: "stdio", endpoint: "playwright", pinned_version: "1", arbitrary_execution: true, contains_model: false, self_liftable_boundary: false, read_only_mode: null }] } }
    ]),
    env: { ...process.env, AGENT_GATEWAY_POLICY: path.join(root, "policy-pass.json") }
  });
  assert.equal(boundaryPreflight.status, 77);
  const boundaryResult = JSON.parse(boundaryPreflight.stdout);
  assert.deepEqual(boundaryResult.conflicts.map(item => item.code), ["PROFILE_SKILL_MISSING", "PROFILE_EXTERNAL_TOOL_CONTRADICTORY"]);
  const db = openGatewayDb(path.join(root, "data", "gateway.sqlite"));
  assert.equal(db.prepare("SELECT COUNT(*) count FROM receipts WHERE task_id='write-mismatch'").get().count, 0);
  assert.deepEqual(db.prepare("SELECT provider,status FROM receipts WHERE task_id='fail-codex'").all().map(row => ({ ...row })), [{ provider: "codex", status: "failed" }]);
  assert.deepEqual(db.prepare("SELECT provider,model_provider,COUNT(*) count FROM receipts WHERE task_id LIKE 'pass-%' GROUP BY provider,model_provider ORDER BY provider").all().map(row => ({ ...row })), harnesses.sort().map(provider => ({ provider, model_provider: `${provider}-model-provider`, count: 1 })));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});
