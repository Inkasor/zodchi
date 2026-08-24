import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { classificationCatalog, classifierPrompt, parseClassificationReceipt, validateClassificationDecision } from "../src/classifier.mjs";
import { compactProjectSnapshot, conversationContext, readProjectContext, selectProjectContext } from "../src/document-context.mjs";
import { processMessage } from "../src/workflow-app.mjs";
import { onboardProject, registerProject } from "../src/onboarding.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function definition() {
  return {
    id: "workflow", domain: "workflow", authority: "registered test documents", gates: [],
    roles: {
      classifier: { provider: "codex", profile: "test-classifier", role: "classifier" },
      researcher: { provider: "codex", profile: "test-researcher", role: "researcher" },
      planner: { provider: "codex", profile: "test-planner", role: "planner" },
      worker: { provider: "codex", profile: "test-worker", role: "worker" },
      reviewer: { provider: "codex", profile: "test-reviewer", role: "reviewer" },
      documentator: { provider: "codex", profile: "test-documentator", role: "documentator" }
    }
  };
}

function fixture(prefix = "workflow-classification-") {
  const root = temporaryRoot(prefix);
  const project = path.join(root, "project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project);
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, now());
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES('workflow','Workflow','project','mvp','L2','active','{\"git\":false}',4096)").run();
  for (const row of db.prepare("SELECT id FROM work_types ORDER BY id").all()) db.prepare("INSERT INTO workflow_routes(project_id,work_type_id,workflow_id,enabled,priority) VALUES('project',?,'workflow',1,0)").run(row.id);
  return { root, project, dbFile, db };
}

function decision(overrides = {}) {
  return {
    schema_version: 1, work_type: "implementation", artifact_type: "code", domain: "workflow", discipline: "software",
    risk: "low", planning_level: "L2", quality_mode: "mvp", planning_required: true, human_required: false,
    needs_questions: false, document_required: false, reply_mode: "work", pending_interaction_id: null,
    reason: "Нужен ограниченный пакет реализации.", questions: [], human_response: null, ...overrides
  };
}

function receipt(output, receiptId = "receipt") {
  const timestamp = now();
  return { receiptId, taskId: `${receiptId}-task`, provider: "codex", profile: "test-classifier", role: "classifier", status: "completed", exitCode: 0, startedAt: timestamp, finishedAt: timestamp, usage: {}, output, error: "" };
}

test("classification schema accepts only exact registered values and known provider envelopes", () => {
  const { root, db } = fixture("workflow-classification-schema-");
  const catalog = classificationCatalog(db, "project");
  const valid = validateClassificationDecision(decision(), catalog);
  assert.equal(valid.kind, "implementation");
  assert.equal(valid.level, "L2");
  assert.throws(() => validateClassificationDecision({ ...decision(), surprise: true }, catalog), /CLASSIFICATION_SCHEMA_INVALID/);
  assert.throws(() => validateClassificationDecision(decision({ discipline: "invented" }), catalog), /CLASSIFICATION_VALUE_UNREGISTERED/);
  assert.throws(() => validateClassificationDecision(decision({ needs_questions: true }), catalog), /needs_questions mismatch/);
  const envelope = JSON.stringify({ type: "item.completed", item: { text: JSON.stringify(decision()) } });
  assert.equal(parseClassificationReceipt(receipt(`{"type":"turn.started"}\n${envelope}`), catalog).work_type, "implementation");
  assert.throws(() => parseClassificationReceipt(receipt("prefix { not accepted as JSON }"), catalog), /CLASSIFICATION_OUTPUT_INVALID_JSON/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("invalid classifier output fails closed before any productive role", async () => {
  const { root, project, dbFile, db } = fixture("workflow-classification-fail-closed-");
  db.close();
  let calls = 0;
  const result = await processMessage({
    message: "Implement a package", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async () => { calls += 1; return receipt("not-json"); }
  });
  assert.equal(calls, 1);
  assert.equal(result.route, "classification_failed");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "classification_failed");
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps").get().count, 0);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM gateway_calls").get().count, 1);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM decisions WHERE outcome='INVALID'").get().count, 1);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("ordinary conversation invokes only the classifier and returns a plain human response", async () => {
  const { root, project, dbFile, db } = fixture("workflow-conversation-");
  db.close();
  let calls = 0;
  const conversation = decision({
    work_type: "conversation", artifact_type: "none", discipline: "general", planning_level: "L0",
    planning_required: false, reply_mode: "conversation", reason: "Пользователь здоровается.", human_response: "Привет! Чем помочь?"
  });
  const result = await processMessage({
    message: "Привет", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => { calls += 1; assert.equal(request.project, project); return receipt(JSON.stringify(conversation)); }
  });
  assert.equal(calls, 1);
  assert.equal(result.route, "conversation");
  assert.equal(result.response, "Привет! Чем помочь?");
  assert.equal(result.response_language, "ru");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps").get().count, 0);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "completed");
  assert.equal(verified.prepare("SELECT response_language FROM workflow_runs WHERE id=?").get(result.run_id).response_language, "ru");
  assert.deepEqual(verified.prepare("SELECT DISTINCT language FROM conversation_messages WHERE run_id=?").all(result.run_id).map(row => row.language), ["ru"]);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("research invokes classifier then researcher without planner, worker or reviewer", async () => {
  const { root, project, dbFile, db } = fixture("workflow-research-route-");
  db.close();
  const roles = [];
  const research = decision({
    work_type: "research", artifact_type: "test_report", discipline: "general", planning_required: false,
    reply_mode: "research", reason: "Нужно проверить зарегистрированные источники."
  });
  const result = await processMessage({
    message: "Что известно?", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => {
      assert.equal(request.project, project);
      roles.push(request.role);
      return request.role === "classifier" ? receipt(JSON.stringify(research), "classifier-receipt") : receipt("Проверенные источники пока пусты.", "research-receipt");
    }
  });
  assert.deepEqual(roles, ["classifier", "researcher"]);
  assert.equal(result.route, "research");
  assert.equal(result.response, "Проверенные источники пока пусты.");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps").get().count, 0);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "completed");
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("clarification produces plain questions and does not start productive roles", async () => {
  const { root, project, dbFile, db } = fixture("workflow-clarification-route-");
  db.close();
  const clarification = decision({
    work_type: "clarification", artifact_type: "none", discipline: "general", planning_required: false, human_required: true,
    needs_questions: true, reply_mode: "clarification", reason: "Не указан целевой документ.", questions: ["Какой документ нужно изменить?"]
  });
  const result = await processMessage({ message: "Измени это", project, dbFile, workflowDefinition: definition(), classificationResult: clarification });
  assert.equal(result.route, "clarification");
  assert.match(result.response, /Какой документ нужно изменить\?/);
  assert.equal(result.response.includes(result.run_id), false);
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps").get().count, 0);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM approvals WHERE run_id=? AND status='pending'").get(result.run_id).count, 1);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "clarification_required");
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("registered contract covers decision, documentation, implementation, verification, material and continuation intents", () => {
  const { root, db } = fixture("workflow-classification-intents-");
  const catalog = classificationCatalog(db, "project");
  const cases = [
    decision({ work_type: "decision", artifact_type: "decision" }),
    decision({ work_type: "documentation", artifact_type: "document", discipline: "documentation", document_required: true }),
    decision({ work_type: "implementation", artifact_type: "code" }),
    decision({ work_type: "verification", artifact_type: "test_report", discipline: "testing" }),
    decision({ work_type: "asset", artifact_type: "visual_asset", discipline: "art_direction" }),
    decision({ work_type: "continuation", artifact_type: "none", discipline: "general", planning_required: false, reply_mode: "conversation" })
  ];
  assert.deepEqual(cases.map(item => validateClassificationDecision(item, catalog).work_type), ["decision", "documentation", "implementation", "verification", "asset", "continuation"]);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unpinned project hook lets the classifier select the registered workflow route", async () => {
  const { root, project, dbFile, db } = fixture("workflow-classification-route-selection-");
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES('implementation-workflow','Implementation','project','mvp','L2','active','{\"git\":false}',4096)").run();
  db.prepare("UPDATE workflow_routes SET workflow_id='implementation-workflow',priority=100 WHERE project_id='project' AND work_type_id='implementation'").run();
  db.close();
  const result = await processMessage({ message: "Исправь ошибку", project, dbFile, classificationResult: decision() });
  assert.equal(result.route, "work");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT workflow_id FROM workflow_runs WHERE id=?").get(result.run_id).workflow_id, "implementation-workflow");
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("discovery and role context read only registered documents and explicit permissions", () => {
  const { root, project, db } = fixture("workflow-discovery-");
  fs.mkdirSync(path.join(project, "docs"));
  fs.writeFileSync(path.join(project, "docs", "research.md"), "# Research\n<point status=\"open\">One</point>");
  fs.writeFileSync(path.join(project, "docs", "planner.md"), "# Planner\nPlan");
  fs.writeFileSync(path.join(project, "docs", "unregistered-secret.md"), "must not be discovered");
  db.prepare("INSERT INTO project_documents(id,project_id,path,document_type,authority,status,active) VALUES('research-doc','project','docs/research.md','authority','owner','active',1)").run();
  db.prepare("INSERT INTO project_documents(id,project_id,path,document_type,authority,status,active) VALUES('planner-doc','project','docs/planner.md','plan','owner','active',1)").run();
  db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES('project','researcher','research-doc',1,0,'research',10)").run();
  db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES('project','planner','planner-doc',1,0,'planning',10)").run();
  const discovery = readProjectContext(project, db, [], { workflowId: "workflow" });
  assert.deepEqual(discovery.documents.map(item => item.path), ["docs/planner.md", "docs/research.md"]);
  assert.equal(JSON.stringify(discovery).includes("unregistered-secret"), false);
  assert.equal(discovery.git.status, "not_requested");
  const selected = selectProjectContext(discovery, decision(), [], db, "project", "researcher");
  assert.deepEqual(selected.documents.map(item => item.path), ["docs/research.md"]);
  const snapshot = compactProjectSnapshot(discovery);
  assert.equal(JSON.stringify(snapshot).includes("must not be discovered"), false);
  assert.equal(JSON.stringify(snapshot).includes("<point"), false);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("classifier context keeps accepted decisions, ordered bounded history, pending interactions and current message last", () => {
  const { root, db } = fixture("workflow-context-order-");
  const runtimeTask = "task-history";
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES(?,'project','History','completed',?,?)").run(runtimeTask, now(), now());
  db.prepare("INSERT INTO decisions(id,task_id,kind,outcome,source,structured_json,active,created_at) VALUES('accepted-decision',?,'owner','APPROVE','owner','{\"value\":1}',1,?)").run(runtimeTask, now());
  db.prepare("INSERT INTO decisions(id,task_id,kind,outcome,source,structured_json,active,created_at) VALUES('classifier-decision',?,'classification','conversation','classifier','{\"value\":2}',1,?)").run(runtimeTask, now());
  db.prepare("INSERT INTO approvals(id,task_id,kind,question,status,created_at) VALUES('pending-approval',?,'owner','Продолжить?','pending',?)").run(runtimeTask, now());
  for (let index = 0; index < 8; index += 1) db.prepare("INSERT INTO conversation_messages(id,project_id,role,content,created_at) VALUES(?,'project',?,?,?)")
    .run(`message-${index}`, index % 2 ? "assistant" : "user", `history-${index}-${"x".repeat(120)}`, `2026-01-01T00:00:0${index}.000Z`);
  const context = conversationContext(db, "project", 500);
  assert.equal(context.accepted_decisions[0].id, "accepted-decision");
  assert.equal(context.accepted_decisions.some(item => item.id === "classifier-decision"), false);
  assert.equal(context.history.at(-1).id, "message-7");
  assert.ok(context.history.length < 8);
  const catalog = classificationCatalog(db, "project");
  const snapshot = { project: { id: "project", name: "Project" } };
  const first = classifierPrompt({ message: "Да", catalog, projectSnapshot: snapshot, acceptedDecisions: context.accepted_decisions, history: context.history });
  const second = classifierPrompt({ message: "Продолжай", catalog, projectSnapshot: snapshot, acceptedDecisions: context.accepted_decisions, history: context.history });
  assert.match(first, /pending-approval/);
  assert.match(first, /FIXED_OUTPUT_VALUES:\{"schema_version":1\}/);
  assert.equal(first.split("CURRENT_USER_MESSAGE:")[0], second.split("CURRENT_USER_MESSAGE:")[0]);
  assert.ok(first.endsWith('CURRENT_USER_MESSAGE:"Да"'));
  const source = `${fs.readFileSync(new URL("../src/classifier.mjs", import.meta.url), "utf8")}\n${fs.readFileSync(new URL("../src/workflow-app.mjs", import.meta.url), "utf8")}`;
  assert.equal(source.includes("classifyMessage"), false);
  assert.equal(source.includes("/^(да|"), false);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("onboarding registers workflow routes, documents and role permissions as data", () => {
  const root = temporaryRoot("workflow-onboarding-registry-");
  const project = path.join(root, "project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "authority.md"), "# Authority");
  const result = onboardProject(dbFile, {
    project: { id: "project", name: "Project", root_path: project },
    workflow: { id: "workflow", name: "Workflow", discovery: { git: false }, history_budget_bytes: 8192 },
    documents: [{ id: "authority", path: "authority.md", document_type: "authority", authority: "owner" }],
    role_documents: [{ role_id: "classifier", document_id: "authority", read_access: true, write_access: false }],
    routes: [{ work_type_id: "conversation" }, { work_type_id: "implementation" }]
  });
  assert.equal(result.status, "onboarded");
  const db = openDb(dbFile);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_routes WHERE project_id='project'").get().count, 2);
  assert.equal(db.prepare("SELECT path FROM project_documents WHERE id='authority'").get().path, "authority.md");
  assert.equal(db.prepare("SELECT read_access FROM role_documents WHERE project_id='project' AND role_id='classifier'").get().read_access, 1);
  db.close();
  assert.throws(() => onboardProject(path.join(root, "invalid.sqlite"), { project: { id: "invalid", name: "Invalid", root_path: project }, workflow: { id: "workflow" }, documents: [{ id: "outside", path: "../outside.md" }] }), /document path must be/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("project registration is idempotent and rejects conflicting identity", () => {
  const root = temporaryRoot("workflow-project-register-");
  const project = path.join(root, "project"), dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project);
  assert.equal(registerProject(dbFile, { id: "project", name: "Project", root_path: project }).status, "registered");
  assert.equal(registerProject(dbFile, { id: "project", name: "Project", root_path: project }).status, "already_registered");
  assert.throws(() => registerProject(dbFile, { id: "other", name: "Project", root_path: path.join(root, "other") }), /belongs to another project/);
  fs.rmSync(root, { recursive: true, force: true });
});
