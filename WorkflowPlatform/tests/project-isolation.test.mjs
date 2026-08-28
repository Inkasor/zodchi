import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { now, openDb } from "../src/db.mjs";
import { bindProject, bindingEvidence } from "../src/project-binding.mjs";
import { parseHookEvent } from "../src/hook-entry.mjs";
import { applyHookInstallation, hookInstallationStatus, planHookInstallation } from "../src/hook-installation.mjs";
import { processMessage } from "../src/workflow-app.mjs";
import { resolveWorkflowSettings, workflowPlatformRoot } from "../src/paths.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

const configsRoot = path.join(path.dirname(workflowPlatformRoot), "configs");

test("an installation configured for one project refuses a message from another", () => {
  const root = temporaryRoot("zodchi-binding-");
  const configured = path.join(root, "configured-project"), other = path.join(root, "other-project");
  fs.mkdirSync(configured); fs.mkdirSync(other);
  const settings = { project: configured, configFile: path.join(root, "runtime.json"), sources: { project: "installation" } };

  // The whole point: the configuration says one project, the message came from another, and nothing about
  // the two paths says they are related. Answering it would classify the message against the wrong
  // documents and write the run into the wrong database with nothing recording that it happened.
  assert.throws(() => bindProject({ settings, origin: other }), /PROJECT_BINDING_MISMATCH/);
  assert.throws(() => bindProject({ settings, origin: other }), new RegExp(path.join(root, "runtime.json").replaceAll("\\", "\\\\")));

  // A session opened at a repository root, or a hook fired from a subdirectory, is the same installation
  // seen from a different depth.
  assert.equal(bindProject({ settings, origin: path.join(configured, "src", "deep") }).project, configured);
  assert.equal(bindProject({ settings, origin: root }).project, configured);
  assert.equal(bindProject({ settings, origin: configured }).binding, "installation");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an environment variable left over in a shell is named as the source of the mismatch", () => {
  const root = temporaryRoot("zodchi-binding-env-");
  const settings = { project: path.join(root, "a"), configFile: path.join(root, "runtime.json"), sources: { project: "environment", database: "environment" } };
  assert.throws(() => bindProject({ settings, origin: path.join(root, "b") }), /WORKFLOW_PROJECT binds/);
  const evidence = bindingEvidence(bindProject({ settings, origin: path.join(root, "a") }), settings);
  assert.equal(evidence.binding, "installation");
  assert.deepEqual(evidence.inherited, ["WORKFLOW_DB", "WORKFLOW_PROJECT"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a project named on the command line is explicit, and an unconfigured installation follows the message", () => {
  const root = temporaryRoot("zodchi-binding-named-");
  const settings = { project: path.join(root, "configured"), configFile: path.join(root, "runtime.json"), sources: { project: "installation" } };
  assert.equal(bindProject({ settings, origin: path.join(root, "elsewhere"), project: "named-project" }).project, "named-project");
  assert.equal(bindProject({ settings: { sources: {} }, origin: path.join(root, "elsewhere") }).binding, "origin");
  assert.equal(bindProject({ settings: { sources: {} } }).project, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the real hook path refuses a message from another project instead of restating the declaration", async () => {
  const root = temporaryRoot("zodchi-hook-binding-");
  const configured = path.join(root, "configured"), other = path.join(root, "other");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(configured); fs.mkdirSync(other);
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('configured','Configured',?,?)").run(configured, now());
  db.close();

  // A hook event carries where the message came from. It must not carry the installation's declaration:
  // handing that on as the caller's own project made the binding check compare the declaration with
  // itself, so a hook inheriting project A's configuration answered project B's message as project A.
  const event = { prompt_id: "p-1", cwd: other, user_input: "hello" };
  const entry = parseHookEvent(event, { env: {}, argv: [], settings: { project: configured } });
  assert.equal(entry.project, undefined);
  assert.equal(entry.origin, other);

  const declared = resolveWorkflowSettings().project;
  try {
    process.env.WORKFLOW_PROJECT = configured;
    // Exactly the call `hooks/user-prompt-submit.mjs` makes, with exactly the fields it passes.
    await assert.rejects(() => processMessage({ message: entry.message, origin: entry.origin, dbFile, eventSource: entry.eventSource, eventKey: entry.eventKey, eventFields: entry.eventFields, client: entry.client }), /PROJECT_BINDING_MISMATCH/);
    const opened = openDb(dbFile);
    assert.equal(opened.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 0);

    // A directory the declaration does not cover is not automatically nobody's: registered as a project
    // of its own, it is the project the message belongs to, and the run is charged there.
    opened.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('other','Other',?,?)").run(other, now());
    opened.close();
    await assert.rejects(() => processMessage({ message: entry.message, origin: entry.origin, dbFile }), /WORKFLOW_NOT_REGISTERED: other/);
  } finally {
    delete process.env.WORKFLOW_PROJECT;
    assert.equal(resolveWorkflowSettings().project, declared);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a message from an unrelated directory never reaches the configured project's database", async () => {
  const root = temporaryRoot("zodchi-isolation-run-");
  const configured = path.join(root, "configured"), other = path.join(root, "other");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(configured); fs.mkdirSync(other);
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('configured','Configured',?,?)").run(configured, now());
  db.close();

  const settings = resolveWorkflowSettings();
  const declared = settings.project;
  try {
    // `resolveWorkflowSettings` reads the process environment, which is exactly the inheritance this
    // guards against, so the environment is what the test sets.
    process.env.WORKFLOW_PROJECT = configured;
    await assert.rejects(() => processMessage({ message: "hello", origin: other, dbFile }), /PROJECT_BINDING_MISMATCH/);
    const opened = openDb(dbFile);
    assert.equal(opened.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 0);
    opened.close();
  } finally {
    delete process.env.WORKFLOW_PROJECT;
    assert.equal(resolveWorkflowSettings().project, declared);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installing a hook keeps every other hook and setting the project already had", () => {
  const root = temporaryRoot("zodchi-hook-install-");
  const file = path.join(root, ".claude", "settings.local.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const foreign = { hooks: [{ type: "command", command: "node other-tool/hook.mjs" }] };
  fs.writeFileSync(file, JSON.stringify({
    permissions: { allow: ["Bash(gh pr merge:*)"] },
    hooks: { UserPromptSubmit: [foreign], SessionStart: [{ hooks: [{ type: "command", command: "node other-tool/start.mjs" }] }] }
  }, null, 2));

  const plan = planHookInstallation({ projectRoot: root, harness: "claude-code", configsRoot });
  assert.equal(plan.status, "install");
  // Someone else's entry is present and the file was not written by Zodchi: both are stated, and merging
  // rather than writing is what follows from them.
  assert.deepEqual(plan.conflicts.map(item => item.kind).sort(), ["foreign_hooks", "unowned_file"]);
  assert.equal(plan.mode, "merge");

  const applied = applyHookInstallation(plan);
  assert.equal(applied.status, "install");
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(written.permissions, { allow: ["Bash(gh pr merge:*)"] });
  assert.equal(written.hooks.SessionStart.length, 1);
  assert.equal(written.hooks.UserPromptSubmit.length, 2);
  assert.deepEqual(written.hooks.UserPromptSubmit[0], foreign);
  assert.match(JSON.stringify(written.hooks.UserPromptSubmit[1]), /user-prompt-submit\.mjs/);

  const status = hookInstallationStatus({ projectRoot: root, harness: "claude-code" });
  assert.equal(status.owned, true);
  assert.equal(status.changed, false);

  // Installing again replaces only the entry Zodchi owns; it never appends a second copy of itself.
  const again = applyHookInstallation(planHookInstallation({ projectRoot: root, harness: "claude-code", configsRoot }));
  assert.equal(again.status, "current");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hooks.UserPromptSubmit.length, 2);

  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}\n`);
  assert.equal(hookInstallationStatus({ projectRoot: root, harness: "claude-code" }).changed, true);
  assert.equal(planHookInstallation({ projectRoot: root, harness: "claude-code", configsRoot }).conflicts.some(item => item.kind === "edited_since_install"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a generated settings file is proxied instead of written into", () => {
  const root = temporaryRoot("zodchi-hook-generated-");
  fs.mkdirSync(path.join(root, ".rulesync"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  const file = path.join(root, ".codex", "hooks.json");
  fs.writeFileSync(file, JSON.stringify({ hooks: {} }, null, 2));

  const plan = planHookInstallation({ projectRoot: root, harness: "codex", configsRoot });
  assert.equal(plan.mode, "proxy");
  assert.equal(plan.conflicts.some(item => item.kind === "generated_file"), true);
  const applied = applyHookInstallation(plan);
  assert.equal(applied.status, "proxy");
  assert.equal(applied.event, "UserPromptSubmit");
  assert.match(JSON.stringify(applied.entry), /user-prompt-submit\.mjs/);
  // Nothing was written: the file that decides this one belongs to another tool.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { hooks: {} });
  assert.equal(fs.existsSync(path.join(root, ".codex", ".zodchi-hook.json")), false);

  // The owner can still insist, and merging then leaves the generator's own keys alone.
  applyHookInstallation(planHookInstallation({ projectRoot: root, harness: "codex", configsRoot, mode: "merge" }));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hooks.UserPromptSubmit.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
