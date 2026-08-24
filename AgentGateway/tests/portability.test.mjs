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
