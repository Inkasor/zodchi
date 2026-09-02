import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveGatewayPaths, gatewayRoot } from "../src/paths.mjs";
import { cleanupConfirmedOrphans, createProviderEnvironment, withProviderEnvironment } from "../src/ephemeral.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.AGENT_GATEWAY_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

test("relative configuration resolves from the installation root", () => {
  const paths = resolveGatewayPaths({
    AGENT_GATEWAY_DATA: "local-data",
    AGENT_GATEWAY_POLICY: "config/local-policy.json",
    AGENT_GATEWAY_TEMP: "local-temp"
  });
  assert.equal(paths.dataRoot, path.join(gatewayRoot, "local-data"));
  assert.equal(paths.databasePath, path.join(gatewayRoot, "local-data", "gateway.sqlite"));
  assert.equal(paths.policyPath, path.join(gatewayRoot, "config", "local-policy.json"));
  assert.equal(paths.tempRoot, path.join(gatewayRoot, "local-temp"));
});

test("Codex ephemeral home copies only explicit auth and allowed skills", () => {
  const root = temporaryRoot("agent-gateway-codex-");
  const source = path.join(root, "source");
  const temp = path.join(root, "temp");
  const skill = path.join(root, "skill-a");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(source, "auth.json"), "test-auth");
  fs.writeFileSync(path.join(source, "history.jsonl"), "must-not-copy");
  fs.writeFileSync(path.join(skill, "SKILL.md"), "test");
  const environment = createProviderEnvironment("codex", { tempRoot: temp, sourceHome: source, profileConfig: { model: "gpt-fixture", reasoningEffort: "medium", readOnly: true, allowedSkills: [skill] } });
  try {
    assert.equal(fs.readFileSync(path.join(environment.directory, "auth.json"), "utf8"), "test-auth");
    assert.equal(fs.existsSync(path.join(environment.directory, "history.jsonl")), false);
    assert.equal(fs.existsSync(path.join(environment.directory, "skills", "skill-a", "SKILL.md")), true);
    const config = fs.readFileSync(path.join(environment.directory, "config.toml"), "utf8");
    assert.match(config, /model = "gpt-fixture"/);
    assert.match(config, /model_reasoning_effort = "medium"/);
    assert.match(config, /sandbox_mode = "read-only"/);
    assert.match(config, /memories = false/);
    assert.equal(config.includes("[profiles."), false);
  } finally {
    environment.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex ephemeral home disables every repository skill outside the profile allowlist", () => {
  const root = temporaryRoot("agent-gateway-repository-skills-");
  const source = path.join(root, "source"), temp = path.join(root, "temp"), project = path.join(root, "project");
  const allowed = path.join(project, ".agents", "skills", "allowed"), blocked = path.join(project, ".agents", "skills", "blocked");
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(allowed, { recursive: true }); fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(source, "auth.json"), "test-auth");
  fs.writeFileSync(path.join(allowed, "SKILL.md"), "allowed"); fs.writeFileSync(path.join(blocked, "SKILL.md"), "blocked");
  const environment = createProviderEnvironment("codex", { tempRoot: temp, sourceHome: source, projectRoot: project, profileConfig: { allowedSkills: [allowed] } });
  try {
    const config = fs.readFileSync(path.join(environment.directory, "config.toml"), "utf8");
    assert.equal(config.includes(JSON.stringify(path.join(allowed, "SKILL.md"))), false);
    assert.match(config, /\[\[skills\.config\]\]/);
    assert.ok(config.includes(JSON.stringify(path.join(blocked, "SKILL.md"))));
    assert.match(config, /enabled = false/);
  } finally {
    environment.cleanup(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Kimi ephemeral home uses a minimal allowlist and cleans up", () => {
  const root = temporaryRoot("agent-gateway-kimi-");
  const source = path.join(root, "source");
  const temp = path.join(root, "temp");
  fs.mkdirSync(path.join(source, "credentials"), { recursive: true });
  fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), "[model]\n");
  fs.writeFileSync(path.join(source, "credentials", "account.json"), "test-credential");
  fs.writeFileSync(path.join(source, "sessions", "session.json"), "must-not-copy");
  const environment = createProviderEnvironment("kimi", { tempRoot: temp, sourceHome: source, profileConfig: { maxStepsPerTurn: 7, reservedContextSize: 9000 } });
  const directory = environment.directory;
  assert.equal(fs.existsSync(path.join(directory, "credentials", "account.json")), true);
  assert.equal(fs.existsSync(path.join(directory, "sessions")), false);
  assert.match(fs.readFileSync(path.join(directory, "config.toml"), "utf8"), /max_steps_per_turn = 7/);
  environment.cleanup();
  assert.equal(fs.existsSync(directory), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("OpenCode ephemeral home copies only auth and enforces profile permissions", () => {
  const root = temporaryRoot("agent-gateway-opencode-");
  const source = path.join(root, "source"), temp = path.join(root, "temp");
  fs.mkdirSync(path.join(source, "project"), { recursive: true });
  fs.writeFileSync(path.join(source, "auth.json"), "test-auth");
  fs.writeFileSync(path.join(source, "project", "session.json"), "must-not-copy");
  const environment = createProviderEnvironment("opencode", { tempRoot: temp, sourceHome: source, profileConfig: { readOnly: true } });
  try {
    assert.equal(fs.readFileSync(path.join(environment.directory, ".local", "share", "opencode", "auth.json"), "utf8"), "test-auth");
    assert.equal(fs.existsSync(path.join(environment.directory, ".local", "share", "opencode", "project")), false);
    const config = JSON.parse(environment.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(config.plugin, []);
    assert.equal(config.permission["*"], "deny");
    assert.equal(config.permission.read, "allow");
    assert.equal(environment.env.USERPROFILE, environment.directory);
  } finally {
    environment.cleanup(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("orphan cleanup deletes only confirmed inactive Gateway homes", () => {
  const root = temporaryRoot("agent-gateway-orphans-");
  const orphan = path.join(root, "codex-home-confirmed");
  const unmarked = path.join(root, "codex-home-unmarked");
  fs.mkdirSync(orphan);
  fs.mkdirSync(unmarked);
  fs.writeFileSync(path.join(orphan, ".agent-gateway-ephemeral.json"), JSON.stringify({ owner: "agent-gateway", provider: "codex", pid: 2147483647, createdAt: "2000-01-01T00:00:00.000Z" }));
  const removed = cleanupConfirmedOrphans(root, { now: Date.parse("2026-01-01T00:00:00.000Z"), graceMs: 0 });
  assert.deepEqual(removed, [orphan]);
  assert.equal(fs.existsSync(unmarked), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("provider wrapper cleans homes after success, timeout result and error", async () => {
  const root = temporaryRoot("agent-gateway-cleanup-");
  const source = path.join(root, "source");
  const temp = path.join(root, "temp");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "auth.json"), "test-auth");
  let successDirectory;
  const success = await withProviderEnvironment("codex", { tempRoot: temp, sourceHome: source }, async (_env, directory) => { successDirectory = directory; return { timedOut: false }; });
  assert.equal(success.timedOut, false);
  assert.equal(fs.existsSync(successDirectory), false);
  let timeoutDirectory;
  const timeout = await withProviderEnvironment("codex", { tempRoot: temp, sourceHome: source }, async (_env, directory) => { timeoutDirectory = directory; return { timedOut: true }; });
  assert.equal(timeout.timedOut, true);
  assert.equal(fs.existsSync(timeoutDirectory), false);
  let errorDirectory;
  await assert.rejects(() => withProviderEnvironment("codex", { tempRoot: temp, sourceHome: source }, async (_env, directory) => { errorDirectory = directory; throw new Error("provider failed"); }), /provider failed/);
  assert.equal(fs.existsSync(errorDirectory), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Codex ephemeral home disables project skills registered under .codex as well", () => {
  const root = temporaryRoot("agent-gateway-codex-skills-");
  const source = path.join(root, "source"), temp = path.join(root, "temp"), project = path.join(root, "project");
  const codexSkill = path.join(project, ".codex", "skills", "codex-only");
  const agentSkill = path.join(project, ".agents", "skills", "agent-only");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills", "owner-skill"), { recursive: true });
  fs.mkdirSync(codexSkill, { recursive: true }); fs.mkdirSync(agentSkill, { recursive: true });
  fs.writeFileSync(path.join(codexSkill, "SKILL.md"), "codex");
  fs.writeFileSync(path.join(agentSkill, "SKILL.md"), "agent");
  fs.writeFileSync(path.join(source, "skills", "owner-skill", "SKILL.md"), "owner");
  const environment = createProviderEnvironment("codex", { tempRoot: temp, sourceHome: source, projectRoot: project, profileConfig: {} });
  try {
    const config = fs.readFileSync(path.join(environment.directory, "config.toml"), "utf8");
    // A project skill Codex would have loaded from its own directory used to stay enabled, because only
    // the harness-neutral location was scanned.
    assert.ok(config.includes(JSON.stringify(path.join(codexSkill, "SKILL.md"))));
    assert.ok(config.includes(JSON.stringify(path.join(agentSkill, "SKILL.md"))));
    const withheld = environment.capabilities.skills.withheld;
    assert.deepEqual(withheld.map(item => item.name).sort(), ["agent-only", "codex-only", "owner-skill"]);
    // The owner's own skills disappear with the home they lived in. That is the isolation working, and it
    // is recorded rather than left to be discovered from a worker that could not do the work.
    assert.deepEqual(withheld.filter(item => item.scope === "home").map(item => item.name), ["owner-skill"]);
  } finally {
    environment.cleanup(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex ephemeral home carries only the MCP servers the profile named and records the rest", () => {
  const root = temporaryRoot("agent-gateway-codex-mcp-");
  const source = path.join(root, "source"), temp = path.join(root, "temp"), project = path.join(root, "project");
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), [
    'model = "owner-model"',
    "[mcp_servers.registry]",
    'command = "node"',
    'args = ["registry.mjs"]',
    "[mcp_servers.registry.env]",
    'TOKEN_ENV = "REGISTRY_TOKEN"',
    "[mcp_servers.personal]",
    'command = "node"'
  ].join("\n"));
  fs.writeFileSync(path.join(project, ".codex", "config.toml"), ["[mcp_servers.project-index]", 'command = "node"'].join("\n"));
  const environment = createProviderEnvironment("codex", { tempRoot: temp, sourceHome: source, projectRoot: project, profileConfig: { allowedMcpServers: ["registry", "project-index"] } });
  try {
    const config = fs.readFileSync(path.join(environment.directory, "config.toml"), "utf8");
    assert.match(config, /\[mcp_servers\.registry\]/);
    // The whole table travels, sub-tables included, or the carried server arrives without its environment.
    assert.match(config, /\[mcp_servers\.registry\.env\]/);
    assert.match(config, /\[mcp_servers\.project-index\]/);
    assert.equal(config.includes("[mcp_servers.personal]"), false);
    // The owner's own model is not carried with it: the profile decides the model, the allowlist decides
    // only the servers.
    assert.equal(config.includes("owner-model"), false);
    assert.deepEqual(environment.capabilities.mcp_servers.carried.map(item => item.name).sort(), ["project-index", "registry"]);
    assert.deepEqual(environment.capabilities.mcp_servers.withheld, [{ scope: "home", name: "personal" }]);
    assert.equal(environment.capabilities.mcp_servers.policy, "allowlist");
  } finally {
    environment.cleanup(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an ephemeral home with nothing named withholds every server the owner registered", () => {
  const root = temporaryRoot("agent-gateway-codex-mcp-none-");
  const source = path.join(root, "source"), temp = path.join(root, "temp");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), ["[mcp_servers.one]", 'command = "node"', "[mcp_servers.two]", 'command = "node"'].join("\n"));
  const environment = createProviderEnvironment("codex", { tempRoot: temp, sourceHome: source, profileConfig: {} });
  try {
    assert.deepEqual(environment.capabilities.mcp_servers.carried, []);
    assert.deepEqual(environment.capabilities.mcp_servers.withheld.map(item => item.name), ["one", "two"]);
    assert.equal(fs.readFileSync(path.join(environment.directory, "config.toml"), "utf8").includes("mcp_servers"), false);
  } finally {
    environment.cleanup(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a project MCP server shadows the home server with the same name exactly once", () => {
  const root = temporaryRoot("agent-gateway-codex-mcp-shadow-");
  const source = path.join(root, "source"), temp = path.join(root, "temp"), project = path.join(root, "project");
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(source, "config.toml"), '[mcp_servers.shared]\ncommand = "home-command"\n');
  fs.writeFileSync(path.join(project, ".codex", "config.toml"), '[mcp_servers.shared]\ncommand = "project-command"\n');
  const environment = createProviderEnvironment("codex", { tempRoot: temp, sourceHome: source, projectRoot: project, profileConfig: { allowedMcpServers: ["shared"] } });
  try {
    const config = fs.readFileSync(path.join(environment.directory, "config.toml"), "utf8");
    assert.equal((config.match(/\[mcp_servers\.shared\]/g) ?? []).length, 1);
    assert.equal(config.includes('command = "project-command"'), true);
    assert.equal(config.includes('command = "home-command"'), false);
    assert.deepEqual(environment.capabilities.mcp_servers.carried, [{ scope: "project", name: "shared" }]);
    assert.deepEqual(environment.capabilities.mcp_servers.shadowed, [{ scope: "home", name: "shared", by_scope: "project" }]);
  } finally { environment.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("OpenCode carries named servers from its own configuration and Kimi inherits the file it copies", () => {
  const root = temporaryRoot("agent-gateway-mcp-providers-");
  const temp = path.join(root, "temp");
  const opencodeHome = path.join(root, "opencode-home"), opencodeConfig = path.join(root, "opencode.json");
  fs.mkdirSync(opencodeHome, { recursive: true });
  fs.writeFileSync(opencodeConfig, JSON.stringify({ mcp: { allowed: { type: "local" }, withheld: { type: "local" } } }));
  const opencode = createProviderEnvironment("opencode", { tempRoot: temp, sourceHome: opencodeHome, sourceConfig: opencodeConfig, profileConfig: { allowedMcpServers: ["allowed"] } });
  try {
    const config = JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(Object.keys(config.mcp), ["allowed"]);
    assert.deepEqual(opencode.capabilities.mcp_servers.withheld, [{ scope: "home", name: "withheld" }]);
  } finally { opencode.cleanup(); }

  const kimiHome = path.join(root, "kimi-home");
  fs.mkdirSync(kimiHome, { recursive: true });
  fs.writeFileSync(path.join(kimiHome, "config.toml"), ["[model]", "[mcp_servers.inherited]", 'command = "node"'].join("\n"));
  const kimi = createProviderEnvironment("kimi", { tempRoot: temp, sourceHome: kimiHome, profileConfig: {} });
  try {
    // Kimi's whole configuration file is copied, so its servers come along. The report says inherited
    // rather than implying an allowlist chose them.
    assert.equal(kimi.capabilities.mcp_servers.policy, "inherited");
    assert.deepEqual(kimi.capabilities.mcp_servers.carried, [{ scope: "home", name: "inherited" }]);
  } finally { kimi.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude receives only named MCP servers through one strict ephemeral config", () => {
  const root = temporaryRoot("agent-gateway-claude-mcp-"), temp = path.join(root, "temp"), project = path.join(root, "project"), sourceConfig = path.join(root, "claude.json");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(sourceConfig, JSON.stringify({ mcpServers: { playwright: { command: "home-playwright" }, personal: { command: "personal" } } }));
  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { playwright: { command: "project-playwright" }, projectIndex: { command: "project-index" } } }));
  const environment = createProviderEnvironment("claude", { tempRoot: temp, sourceConfig, projectRoot: project, profileConfig: { allowedMcpServers: ["playwright"], browserMcpServer: "playwright" } });
  try {
    const config = JSON.parse(fs.readFileSync(environment.env.AGENT_GATEWAY_CLAUDE_MCP_CONFIG, "utf8"));
    assert.deepEqual(config, { mcpServers: { playwright: { command: "project-playwright" } } });
    assert.deepEqual(environment.capabilities.mcp_servers.carried, [{ scope: "project", name: "playwright" }]);
    assert.deepEqual(environment.capabilities.mcp_servers.withheld.map(item => item.name).sort(), ["personal", "projectIndex"]);
    assert.deepEqual(environment.capabilities.mcp_servers.shadowed, [{ scope: "home", name: "playwright", by_scope: "project" }]);
    assert.equal(environment.capabilities.mcp_servers.policy, "allowlist");
    assert.equal(environment.capabilities.home, "mcp-config-only");
    assert.equal("HOME" in environment.env, false);
    assert.equal("USERPROFILE" in environment.env, false);
  } finally { environment.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("Codex carries only explicitly allowed browser plugins into the ephemeral home", () => {
  const root = temporaryRoot("gateway-browser-plugin-"), source = path.join(root, "source"), temp = path.join(root, "temp");
  const browserCache = path.join(source, "plugins", "cache", "openai-bundled", "browser", "1.0.0");
  fs.mkdirSync(browserCache, { recursive: true });
  fs.writeFileSync(path.join(source, "auth.json"), "test-auth");
  fs.writeFileSync(path.join(browserCache, "plugin.json"), "{}\n");
  fs.writeFileSync(path.join(source, "config.toml"), [
    '[plugins."browser@openai-bundled"]', "enabled = true",
    '[plugins."unrelated@openai-bundled"]', "enabled = true",
    "[marketplaces.openai-bundled]", 'source_type = "local"', `source = ${JSON.stringify(path.join(source, "marketplace"))}`,
    "[mcp_servers.node_repl]", `command = ${JSON.stringify(path.join(source, "runtime", "node_repl.exe"))}`,
    "[mcp_servers.node_repl.env]", `CODEX_HOME = ${JSON.stringify(source)}`
  ].join("\n"));
  const environment = createProviderEnvironment("codex", { tempRoot: temp, sourceHome: source, profileConfig: { readOnly: false, allowedPlugins: ["browser@openai-bundled"], allowedMcpServers: ["node_repl"] } });
  try {
    const config = fs.readFileSync(path.join(environment.directory, "config.toml"), "utf8");
    assert.match(config, /plugins = true/);
    assert.match(config, /plugins\."browser@openai-bundled"/);
    assert.doesNotMatch(config, /unrelated@openai-bundled/);
    assert.match(config, /mcp_servers\.node_repl/);
    assert.equal(config.includes(JSON.stringify(environment.directory).slice(1, -1)), true);
    assert.equal(fs.existsSync(path.join(environment.directory, "plugins", "cache", "openai-bundled", "browser", "1.0.0", "plugin.json")), true);
    assert.deepEqual(environment.capabilities.plugins.carried, [{ id: "browser@openai-bundled" }]);
  } finally { environment.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});
