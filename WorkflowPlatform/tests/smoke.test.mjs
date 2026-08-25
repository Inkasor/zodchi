import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "../src/runtime.mjs";
import { applyPatch } from "../src/documentator.mjs";
import { buildPrompt } from "../src/prompt-builder.mjs";
import { processMessage } from "../src/workflow-app.mjs";
import { openDb } from "../src/db.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function workflowDefinition() {
  return {
    id: "test-workflow",
    domain: "workflow",
    authority: "registered test documents",
    roles: {
      classifier: { provider: "test", profile: "local-classifier", role: "classifier" },
      researcher: { provider: "test", profile: "local-researcher", role: "researcher" },
      documentator: { provider: "test", profile: "local-documentator", role: "documentator" },
      planner: { provider: "test", profile: "local-planner", role: "planner" },
      worker: { provider: "test", profile: "local-worker", role: "worker" },
      reviewer: { provider: "test", profile: "local-reviewer", role: "reviewer" }
    },
    gates: []
  };
}

function classificationDecision(overrides = {}) {
  return {
    schema_version: 1, work_type: "implementation", artifact_type: "code", domain: "workflow", discipline: "software",
    risk: "low", planning_level: "L2", quality_mode: "mvp", planning_required: true, human_required: false,
    needs_questions: false, document_required: false, reply_mode: "work", pending_interaction_id: null, pending_interaction_response: null,
    reason: "Нужен ограниченный пакет реализации.", questions: [], human_response: null, ...overrides
  };
}

function registerTestProject(db, { projectId = "test-project", projectRoot, workflowId = "test-workflow" } = {}) {
  const root = projectRoot ?? path.join(os.tmpdir(), projectId);
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(projectId, projectId, root, timestamp);
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status) VALUES(?,?,?,?,?,?)").run(workflowId, workflowId, projectId, "mvp", "L2", "active");
  for (const workType of ["conversation", "continuation", "clarification", "task", "decision", "research", "implementation", "documentation", "review", "verification", "testing", "planning", "fix", "content", "marketing", "release", "game_design", "narrative", "map_design", "technical_art", "art_direction", "audio", "asset", "prototype", "producer"])
    db.prepare("INSERT INTO workflow_routes(project_id,work_type_id,workflow_id,enabled,priority) VALUES(?,?,?,1,0)").run(projectId, workType, workflowId);
}

test("end-to-end contracts, runtime and documentator", () => {
  const root = temporaryRoot("workflow-smoke-");
  const db = path.join(root, "workflow.sqlite");
  const doc = path.join(root, "doc.md");
  fs.writeFileSync(doc, fs.readFileSync(new URL("../docs/WorkflowPlatform.md", import.meta.url)));
  const runtime = new Runtime(db);
  registerTestProject(runtime.db);
  const run = runtime.create("standardize documents", { project_id: "test-project", workflow_id: "test-workflow" });
  const classification = { kind: "task", domain: "workflow", discipline: "architecture", risk: "low", level: "L2", quality: "mvp", human_required: false };
  runtime.classify(run, classification);
  runtime.plan(run, { objective: "document standard", steps: ["discovery", "planning", "document"] });
  const prompt = buildPrompt({ role: "planner", stage: "planning", intent: "standardize", classification, quality: "mvp", format: "json" });
  assert.match(prompt, /<role id="planner" stage="planning"\/>/);
  const result = applyPatch({ file: doc, projectRoot: root, runId: run, db: runtime.db, patch: { operation: "append_evidence", authority: "test-authority", content: "smoke" } });
  assert.equal(result.lint.status, "passed");
  assert.equal(runtime.db.prepare("select count(*) n from document_operations where run_id=?").get(run).n, 1);
  assert.equal(runtime.db.prepare("select count(*) n from lint_results where run_id=?").get(run).n, 1);
  assert.equal(runtime.get(run).state, "planning");
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("documentator applies supported operations", () => {
  const root = temporaryRoot("workflow-documentator-");
  const file = path.join(root, "control.md");
  const plan = path.join(root, "plan.md");
  const runtime = new Runtime(path.join(root, "workflow.sqlite"));
  registerTestProject(runtime.db);
  const run = runtime.create("document operations", { project_id: "test-project", workflow_id: "test-workflow" });
  fs.writeFileSync(file, "<document id=\"d\" status=\"working\"><section id=\"s\" status=\"working\">old</section></document>");
  assert.equal(applyPatch({ file, projectRoot: root, runId: run, db: runtime.db, patch: { operation: "update_section", authority: "a", section_id: "s", content: "new" } }).status, "applied");
  assert.match(fs.readFileSync(file, "utf8"), /new/);
  applyPatch({ file, projectRoot: root, runId: run, db: runtime.db, patch: { operation: "change_status", authority: "a", status: "accepted" } });
  applyPatch({ file, projectRoot: root, runId: run, db: runtime.db, patch: { operation: "append_decision", authority: "a", decision_id: "dec1", content: "accepted" } });
  applyPatch({ file: plan, projectRoot: root, runId: run, db: runtime.db, patch: { operation: "create_document", authority: "a", content: "<document id=\"p\" status=\"working\"></document>" } });
  assert.throws(() => applyPatch({ file: plan, projectRoot: root, runId: run, db: runtime.db, patch: { operation: "create_plan", authority: "a", content: "<document></document>" } }), /create_plan requires/);
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("documentator rejects invalid operations, lint failures and outside paths", () => {
  const root = temporaryRoot("workflow-documentator-reject-");
  const file = path.join(root, "doc.md");
  const outside = path.join(root, "..", `${path.basename(root)}-outside.md`);
  const runtime = new Runtime(path.join(root, "workflow.sqlite"));
  registerTestProject(runtime.db);
  const run = runtime.create("reject", { project_id: "test-project", workflow_id: "test-workflow" });
  fs.writeFileSync(file, "<document id=\"d\" status=\"working\"></document>");
  assert.throws(() => applyPatch({ file, projectRoot: root, runId: run, db: runtime.db, patch: { operation: "unknown", authority: "a", content: "x" } }), /unsupported operation/);
  assert.throws(() => applyPatch({ file, projectRoot: root, runId: run, db: runtime.db, patch: { operation: "append_evidence", authority: "a", content: "<broken>" } }), /document lint failed/);
  assert.equal(fs.readFileSync(file, "utf8"), "<document id=\"d\" status=\"working\"></document>");
  assert.throws(() => applyPatch({ file: outside, projectRoot: root, runId: run, db: runtime.db, patch: { operation: "create_document", authority: "a", content: "<document id=\"x\"></document>" } }), /outside project root/);
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("generic workflow dry-run exposes a bounded chain", async () => {
  const root = temporaryRoot("workflow-app-");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const dbFile = path.join(root, "workflow.sqlite");
  const db = openDb(dbFile);
  registerTestProject(db, { projectRoot: project });
  db.close();
  const result = await processMessage({ message: "Implement a bounded package", project, dbFile, workflowDefinition: workflowDefinition(), classificationResult: classificationDecision() });
  assert.equal(result.route, "work");
  assert.deepEqual(result.gateway.steps.map(step => step.role), ["planner", "worker", "project-gate", "reviewer", "documentator"]);
  assert.equal(result.gateway.steps[0].profile, "local-planner");
  assert.equal(result.gateway.steps[1].profile, "local-worker");
  assert.equal(result.gateway.steps[2].runner, "workflow-platform");
  assert.equal(result.gateway.steps[3].condition, "only after green gate/lints");
  fs.rmSync(root, { recursive: true, force: true });
});

test("repeating one hook event does not create a second workflow run", async () => {
  const root = temporaryRoot("workflow-hook-idempotency-");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const dbFile = path.join(root, "workflow.sqlite");
  const db = openDb(dbFile);
  registerTestProject(db, { projectRoot: project });
  db.close();
  const input = { message: "Implement one bounded package", project, dbFile, workflowDefinition: workflowDefinition(), eventSource: "codex-hook", eventKey: "hook-event-1", classificationResult: classificationDecision() };
  const first = await processMessage(input);
  const duplicate = await processMessage(input);
  assert.equal(first.route, "work");
  assert.equal(duplicate.route, "duplicate");
  assert.equal(duplicate.run_id, first.run_id);
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 1);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps").get().count, 5);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("Claude Code hook events preserve prompt id and client identity", async () => {
  const root = temporaryRoot("workflow-claude-hook-");
  const project = path.join(root, "project"), dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project, { recursive: true });
  const setup = openDb(dbFile);
  registerTestProject(setup, { projectRoot: project });
  setup.close();
  const input = { message: "Implement one bounded package", project, dbFile, workflowDefinition: workflowDefinition(), eventSource: "claude-code-hook", eventKey: "550e8400-e29b-41d4-a716-446655440000", client: "claude-code", classificationResult: classificationDecision() };
  const result = await processMessage(input);
  const db = openDb(dbFile);
  assert.equal(db.prepare("SELECT client FROM workflow_runs WHERE id=?").get(result.run_id).client, "claude-code");
  assert.equal(db.prepare("SELECT run_id FROM inbox_events WHERE source=? AND event_key=?").get("claude-code-hook", "550e8400-e29b-41d4-a716-446655440000").run_id, result.run_id);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("runtime advances an executed no-document workflow beyond planned", () => {
  const root = temporaryRoot("workflow-state-");
  const runtime = new Runtime(path.join(root, "workflow.sqlite"));
  registerTestProject(runtime.db);
  const run = runtime.create("state test", { project_id: "test-project", workflow_id: "test-workflow" });
  runtime.classify(run, { kind: "conversation", domain: "workflow", discipline: "general", risk: "low", level: "L0", quality: "prototype", planning_required: false, human_required: false, document_required: false });
  runtime.setState(run, "completed", { reason: "conversation response delivered" });
  assert.equal(runtime.get(run).state, "completed");
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
