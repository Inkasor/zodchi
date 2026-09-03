import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { RUN_PROFILE_CONFIRMATION_ID, RUN_PROFILE_CONFIRMATION_KIND, classificationCatalog, classificationJsonSchema, classifierPrompt, parseClassificationReceipt, validateClassificationDecision } from "../src/classifier.mjs";
import { classifierStateContext, compactProjectSnapshot, readProjectContext, selectProjectContext } from "../src/document-context.mjs";
import { processMessage as scopedProcessMessage } from "../src/workflow-app.mjs";
import { onboardProject, registerProject } from "../src/onboarding.mjs";
import { Runtime } from "../src/runtime.mjs";
import { activateChatSession, setPendingMessage } from "../src/chat-session.mjs";
import { registerControlledDocument } from "../src/document-registry.mjs";

const statelessProcessMessage = input => scopedProcessMessage({ semanticScope: { mode: "stateless" }, ...input });

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function definition() {
  return {
    id: "workflow", domain: "workflow", authority: "registered test documents", gates: [],
    roles: {
      classifier: { provider: "codex", profile: "test-classifier", role: "classifier", contract: { context_limit_bytes: 8192 } },
      researcher: { provider: "codex", profile: "test-researcher", role: "researcher" },
      conversation_responder: { provider: "codex", profile: "test-conversation-responder", role: "conversation_responder", contract: { context_limit_bytes: 8192 } },
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
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json) VALUES('workflow','Workflow','project','mvp','L2','active','{\"git\":false}')").run();
  for (const row of db.prepare("SELECT id FROM work_types ORDER BY id").all()) db.prepare("INSERT INTO workflow_routes(project_id,work_type_id,workflow_id,enabled,priority) VALUES('project',?,'workflow',1,0)").run(row.id);
  return { root, project, dbFile, db };
}

function decision(overrides = {}) {
  return {
    schema_version: 1, work_type: "implementation", artifact_type: "code", domain: "workflow", discipline: "software",
    risk: "low", planning_level: "L2", quality_mode: "mvp", planning_required: true, human_required: false,
    needs_questions: false, document_required: false, reply_mode: "work", pending_interaction_id: null, pending_interaction_response: null,
    resolved_objective: "Выполнить ограниченный пакет реализации.", reason: "Нужен ограниченный пакет реализации.", questions: [], human_response: null, ...overrides
  };
}

function receipt(output, receiptId = "receipt", overrides = {}) {
  const timestamp = now();
  return { receiptId, taskId: `${receiptId}-task`, provider: "codex", profile: overrides.profile ?? "test-classifier", role: overrides.role ?? "classifier", status: "completed", exitCode: 0, startedAt: timestamp, finishedAt: timestamp, usage: {}, output, error: "" };
}

test("workflow intake requires one exact semantic scope", async () => {
  await assert.rejects(() => scopedProcessMessage({ message: "hello" }), /ZODCHI_SEMANTIC_SCOPE_REQUIRED/);
  await assert.rejects(() => scopedProcessMessage({ message: "hello", semanticScope: { mode: "stateless", client: "codex" } }), /ZODCHI_SEMANTIC_SCOPE_INVALID/);
  await assert.rejects(() => scopedProcessMessage({ message: "hello", semanticScope: { mode: "session", client: "codex", session_id: "" } }), /ZODCHI_SEMANTIC_SCOPE_INVALID/);
});

test("classification schema accepts only exact registered values and known provider envelopes", () => {
  const { root, db } = fixture("workflow-classification-schema-");
  const catalog = classificationCatalog(db, "project", { mode: "stateless" });
  const valid = validateClassificationDecision(decision(), catalog);
  assert.equal(valid.kind, "implementation");
  assert.equal(valid.level, "L2");
  assert.throws(() => validateClassificationDecision({ ...decision(), surprise: true }, catalog), /CLASSIFICATION_SCHEMA_INVALID/);
  assert.throws(() => validateClassificationDecision(decision({ discipline: "invented" }), catalog), /CLASSIFICATION_VALUE_UNREGISTERED/);
  assert.throws(() => validateClassificationDecision(decision({ needs_questions: true }), catalog), /needs_questions mismatch/);
  const envelope = JSON.stringify({ type: "item.completed", item: { text: JSON.stringify(decision()) } });
  assert.equal(parseClassificationReceipt(receipt(`{"type":"turn.started"}\n${envelope}`), catalog).work_type, "implementation");
  assert.throws(() => parseClassificationReceipt(receipt("prefix { not accepted as JSON }"), catalog), /CLASSIFICATION_OUTPUT_INVALID_JSON/);
  const schema = classificationJsonSchema(catalog);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), Object.keys(decision()).sort());
  assert.deepEqual(schema.properties.work_type.enum, catalog.work_types);
  assert.deepEqual(schema.properties.pending_interaction_id, { type: "null" });
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("invalid classifier output fails closed before any productive role", async () => {
  const { root, project, dbFile, db } = fixture("workflow-classification-fail-closed-");
  db.close();
  let calls = 0;
  const result = await statelessProcessMessage({
    message: "Implement a package", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => { calls += 1; assert.match(request.outputSchemaFile, /classifier-output\.schema\.json$/); return receipt(JSON.stringify({ ...decision(), surprise: true })); }
  });
  assert.equal(calls, 1);
  assert.equal(result.route, "classification_failed");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "classification_failed");
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps").get().count, 0);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM gateway_calls").get().count, 1);
  const invalid = JSON.parse(verified.prepare("SELECT structured_json FROM decisions WHERE outcome='INVALID'").get().structured_json);
  assert.deepEqual(invalid, { category: "CLASSIFICATION_SCHEMA_INVALID", detail: "missing= extra=surprise" });
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("classifier output is rejected when its structured trace used a contract-forbidden tool", async () => {
  const { root, project, dbFile, db } = fixture("workflow-classifier-tool-mismatch-");
  db.close();
  const conversation = decision({ work_type: "conversation", artifact_type: "none", discipline: "general", planning_level: "L0", planning_required: false, reply_mode: "conversation", reason: "Answer.", human_response: "Hello." });
  const result = await statelessProcessMessage({
    message: "Hello", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async () => ({ ...receipt(JSON.stringify(conversation)), environment: { tool_usage: { status: "complete", enforcement: "technical", source: "fixture", native_tools: [{ native_name: "Write", canonical_tool: "apply_patch", count: 1 }], canonical_tools: ["apply_patch"], unknown_native_tools: [] } } })
  });
  assert.equal(result.route, "classification_failed");
  const verified = openDb(dbFile);
  const call = verified.prepare("SELECT environment_json FROM gateway_calls WHERE run_id=?").get(result.run_id);
  assert.equal(JSON.parse(call.environment_json).tool_usage.contract_check.status, "mismatch");
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "classification_failed");
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("classification-only execution calls the classifier without dispatching a productive role", async () => {
  const { root, project, dbFile, db } = fixture("workflow-classification-only-");
  db.close();
  const calls = [];
  const conversation = decision({
    work_type: "conversation", artifact_type: "none", discipline: "general", planning_level: "L0",
    planning_required: false, reply_mode: "conversation", reason: "Внутреннее решение маршрутизации.", human_response: null
  });
  const result = await statelessProcessMessage({
    message: "Объясни границы общего движка и проектов-потребителей.", project, dbFile,
    workflowDefinition: definition(), classifyOnly: true,
    gatewayCall: async request => {
      calls.push(request.role);
      return receipt(JSON.stringify(conversation), "classifier-receipt");
    }
  });
  assert.deepEqual(calls, ["classifier"]);
  assert.equal(result.route, "classification_dry_run");
  assert.equal(result.workflow, "workflow");
  assert.deepEqual(result.productive_roles, []);
  assert.equal(result.gateway.mode, "executed");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "completed");
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=?").get(result.run_id).count, 0);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM gateway_calls WHERE run_id=?").get(result.run_id).count, 1);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM conversation_messages WHERE run_id=? AND role='assistant'").get(result.run_id).count, 0);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("ordinary conversation invokes the classifier and responder and returns the responder answer", async () => {
  const { root, project, dbFile, db } = fixture("workflow-conversation-");
  db.close();
  const calls = [];
  const conversation = decision({
    work_type: "conversation", artifact_type: "none", discipline: "general", planning_level: "L0",
    planning_required: false, reply_mode: "conversation", reason: "Пользователь здоровается.", human_response: "Привет! Чем помочь?"
  });
  const result = await statelessProcessMessage({
    message: "Привет", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => {
      calls.push(request.role);
      assert.equal(request.project, project);
      if (request.role === "classifier") return receipt(JSON.stringify(conversation), "classifier-receipt");
      assert.equal(request.role, "conversation_responder");
      assert.match(fs.readFileSync(request.taskFile, "utf8"), /CURRENT_USER_MESSAGE/);
      return receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: "Ответ по существу от отвечающей роли." }), "responder-receipt", { profile: "test-conversation-responder", role: "conversation_responder" });
    }
  });
  assert.deepEqual(calls, ["classifier", "conversation_responder"]);
  assert.equal(result.route, "conversation");
  assert.equal(result.response, "Ответ по существу от отвечающей роли.");
  assert.equal(result.response_language, "ru");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps").get().count, 0);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "completed");
  assert.equal(verified.prepare("SELECT response_language FROM workflow_runs WHERE id=?").get(result.run_id).response_language, "ru");
  assert.deepEqual(verified.prepare("SELECT DISTINCT language FROM conversation_messages WHERE run_id=?").all(result.run_id).map(row => row.language), ["ru"]);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("conversation responder receives the preceding turns of the same active session", async () => {
  const { root, project, dbFile, db } = fixture("workflow-conversation-history-");
  const semanticScope = { mode: "session", client: "codex", session_id: "conversation-history" };
  activateChatSession(db, { client: semanticScope.client, sessionId: semanticScope.session_id, origin: project, turnKey: "turn-1" });
  db.close();
  const conversation = decision({
    work_type: "conversation", artifact_type: "none", discipline: "general", planning_level: "L0",
    planning_required: false, reply_mode: "conversation", reason: "Internal routing reason", human_response: null
  });
  const answer = value => receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: value }), "responder-receipt", { profile: "test-conversation-responder", role: "conversation_responder" });
  await scopedProcessMessage({
    message: "Первый вопрос про архитектуру", project, dbFile, workflowDefinition: definition(), execute: true,
    semanticScope, classificationResult: conversation, gatewayCall: async request => answer("Первый ответ с опорным контекстом")
  });
  const next = openDb(dbFile);
  activateChatSession(next, { client: semanticScope.client, sessionId: semanticScope.session_id, origin: project, turnKey: "turn-2" });
  next.close();
  let responderPrompt = "";
  const result = await scopedProcessMessage({
    message: "А что ты имел в виду?", project, dbFile, workflowDefinition: definition(), execute: true,
    semanticScope, classificationResult: conversation,
    gatewayCall: async request => { responderPrompt = fs.readFileSync(request.taskFile, "utf8"); return answer("Второй ответ с учётом истории"); }
  });
  assert.equal(result.route, "conversation");
  assert.match(responderPrompt, /Первый вопрос про архитектуру/);
  assert.match(responderPrompt, /Первый ответ с опорным контекстом/);
  assert.match(responderPrompt, /А что ты имел в виду\?/);
  assert.doesNotMatch(responderPrompt, /Internal routing reason/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("empty or null classifier human_response never leaks reason into the conversation", async () => {
  for (const humanResponse of [null, ""]) {
    const { root, project, dbFile, db } = fixture(`workflow-conversation-no-reason-${humanResponse === null ? "null" : "empty"}-`);
    db.close();
    const conversation = decision({
      work_type: "conversation", artifact_type: "none", discipline: "general", planning_level: "L0",
      planning_required: false, reply_mode: "conversation", reason: "INTERNAL_CLASSIFIER_REASON_MUST_NOT_REACH_OWNER", human_response: humanResponse
    });
    const result = await statelessProcessMessage({
      message: "Что ты думаешь?", project, dbFile, workflowDefinition: definition(), execute: true,
      gatewayCall: async request => request.role === "classifier"
        ? receipt(JSON.stringify(conversation), "classifier-receipt")
        : receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: "Ответ без внутренней мотивировки." }), "responder-receipt", { profile: "test-conversation-responder", role: "conversation_responder" })
    });
    assert.equal(result.route, "conversation");
    const verified = openDb(dbFile);
    const messages = verified.prepare("SELECT role,content FROM conversation_messages WHERE run_id=? ORDER BY created_at,id").all(result.run_id);
    assert.equal(messages.filter(item => item.role === "assistant").length, 1);
    assert.equal(messages.find(item => item.role === "assistant").content, "Ответ без внутренней мотивировки.");
    assert.equal(messages.some(item => item.content.includes("INTERNAL_CLASSIFIER_REASON_MUST_NOT_REACH_OWNER")), false);
    verified.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the classifier is offered only routed work types plus the direct answers that never enter a workflow", () => {
  const { root, db } = fixture("workflow-classification-catalog-");
  db.prepare("DELETE FROM workflow_routes WHERE project_id='project' AND work_type_id NOT IN ('narrative','decision')").run();
  const catalog = classificationCatalog(db, "project", { mode: "stateless" });
  assert.deepEqual(catalog.work_types, ["clarification", "conversation", "decision", "narrative", "research"]);
  assert.throws(() => validateClassificationDecision(decision({ work_type: "implementation" }), catalog), /CLASSIFICATION_VALUE_UNREGISTERED: work_type=implementation/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a registered work type is accepted even when it postdates the platform's fallback list", async () => {
  const { root, project, dbFile, db } = fixture("workflow-registered-work-type-");
  const { CLASSIFICATION_KINDS } = await import("../contracts/schemas.mjs");
  // A package registers the work types its routes need, so the registry is what a run is judged
  // against. Judged against the frozen list instead, a route the catalog still offered could never run.
  const registered = db.prepare("SELECT id FROM work_types WHERE id NOT IN (SELECT value FROM json_each(?))").all(JSON.stringify(CLASSIFICATION_KINDS)).map(row => row.id);
  db.prepare("INSERT OR IGNORE INTO work_types(id,name,category) VALUES('data_collection','Data collection','work')").run();
  db.prepare("INSERT OR IGNORE INTO workflow_routes(project_id,work_type_id,workflow_id,enabled,priority) VALUES('project','data_collection','workflow',1,0)").run();
  db.close();
  assert.equal(CLASSIFICATION_KINDS.includes("data_collection"), false, `precondition: ${registered.join(",")}`);
  const runtime = new Runtime(dbFile);
  const runId = runtime.accept("Собери разрешённые данные", { project_id: "project", workflow_id: "workflow", client: "codex" }).runId;
  runtime.classify(runId, { ...decision({ work_type: "data_collection", artifact_type: "document" }), kind: "data_collection", level: "L2", quality: "mvp" });
  assert.equal(runtime.db.prepare("SELECT kind FROM classifications WHERE run_id=?").get(runId).kind, "data_collection");
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a project without a conversation route still answers a conversation instead of failing classification", async () => {
  const { root, project, dbFile, db } = fixture("workflow-conversation-unrouted-");
  db.prepare("DELETE FROM workflow_routes WHERE project_id='project' AND work_type_id NOT IN ('narrative','decision')").run();
  db.close();
  const conversation = decision({
    work_type: "conversation", artifact_type: "none", discipline: "general", planning_level: "L0",
    planning_required: false, reply_mode: "conversation", reason: "Пользователь спрашивает о проекте.", human_response: "Отвечаю по существу."
  });
  const result = await statelessProcessMessage({
    message: "Как дела с каноном?", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => request.role === "classifier"
      ? receipt(JSON.stringify(conversation), "classifier-receipt")
      : receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: "Отвечаю по существу." }), "responder-receipt", { profile: "test-conversation-responder", role: "conversation_responder" })
  });
  assert.equal(result.route, "conversation");
  assert.equal(result.response, "Отвечаю по существу.");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "completed");
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("research invokes classifier then researcher without planner, worker or reviewer", async () => {
  const { root, project, dbFile, db } = fixture("workflow-research-route-");
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(path.join(project, "src", "engine.ts"), "export const engine = 'shared';\n", "utf8");
  db.close();
  const roles = [];
  let researcherPrompt = null;
  const research = decision({
    work_type: "research", artifact_type: "test_report", discipline: "general", planning_required: false,
    reply_mode: "research", reason: "Нужно проверить зарегистрированные источники."
  });
  const result = await statelessProcessMessage({
    message: "Что известно?", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => {
      assert.equal(request.project, project);
      roles.push(request.role);
      if (request.role === "classifier") return receipt(JSON.stringify(research), "classifier-receipt");
      researcherPrompt = fs.readFileSync(request.taskFile, "utf8");
      const schema = JSON.parse(fs.readFileSync(request.outputSchemaFile, "utf8"));
      assert.deepEqual(schema.properties.status.enum, ["answered", "insufficient"]);
      assert.deepEqual(schema.properties.schema_version, { type: "integer", const: 1 });
      assert.equal(Object.hasOwn(schema.properties.inspected_paths, "uniqueItems"), false);
      return receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: "Исходник движка прочитан.", inspected_paths: ["src/engine.ts"], limitations: [] }), "research-receipt");
    }
  });
  assert.deepEqual(roles, ["classifier", "researcher"]);
  assert.equal(result.route, "research");
  assert.equal(result.response, "Исходник движка прочитан.");
  assert.deepEqual(result.research, { status: "answered", inspected_paths: ["src/engine.ts"], limitations: [] });
  assert.match(researcherPrompt, /WORKFLOW RESEARCH REQUEST v4/);
  assert.match(researcherPrompt, /Do not run commands or read files directly/);
  assert.match(researcherPrompt, /REGISTERED_SOURCE_EVIDENCE/);
  assert.match(researcherPrompt, /REGISTERED_PROJECT_CORPUS/);
  assert.match(researcherPrompt, /src\/engine\.ts/);
  assert.match(researcherPrompt, /export const engine = 'shared'/);
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps").get().count, 0);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "completed");
  const evidence = JSON.parse(verified.prepare("SELECT evidence_json FROM run_evidence WHERE run_id=? AND kind='research_inspection'").get(result.run_id).evidence_json);
  assert.equal(evidence.status, "answered");
  assert.deepEqual(evidence.inspected_paths, ["src/engine.ts"]);
  assert.deepEqual(evidence.limitations, []);
  assert.equal(evidence.source_selection.strategy, "complete_small_corpus");
  assert.deepEqual(evidence.source_selection.supplied_paths, ["src/engine.ts"]);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("insufficient research is recorded but cannot complete as an answered result", async () => {
  const { root, project, dbFile, db } = fixture("workflow-research-insufficient-");
  fs.writeFileSync(path.join(project, "engine.ts"), "export const ready = false;\n", "utf8");
  db.close();
  const research = decision({
    work_type: "research", artifact_type: "test_report", discipline: "software", planning_level: "L0", planning_required: false,
    reply_mode: "research", reason: "Нужно исследовать исходники без изменений."
  });
  const result = await statelessProcessMessage({
    message: "Как внешний сервис использует этот проект?", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => request.role === "classifier"
      ? receipt(JSON.stringify(research), "classifier-receipt")
      : receipt(JSON.stringify({ schema_version: 1, status: "insufficient", answer: "В зарегистрированных источниках нет данных о внешнем сервисе.", inspected_paths: [], limitations: ["External service configuration is not in the registered project corpus."] }), "research-receipt")
  });
  assert.equal(result.route, "research");
  assert.equal(result.research.status, "insufficient");
  assert.deepEqual(result.research.limitations, ["External service configuration is not in the registered project corpus."]);
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "blocked");
  const evidence = JSON.parse(verified.prepare("SELECT evidence_json FROM run_evidence WHERE run_id=? AND kind='research_inspection'").get(result.run_id).evidence_json);
  assert.equal(evidence.status, "insufficient");
  assert.deepEqual(evidence.inspected_paths, []);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("research preserves a failed provider receipt instead of parsing its empty output", async () => {
  const { root, project, dbFile, db } = fixture("workflow-research-provider-failure-");
  fs.writeFileSync(path.join(project, "engine.ts"), "export const ready = false;\n", "utf8");
  db.close();
  const research = decision({
    work_type: "research", artifact_type: "test_report", discipline: "software", planning_level: "L0", planning_required: false,
    reply_mode: "research", reason: "Нужно исследовать исходники без изменений."
  });
  const result = await statelessProcessMessage({
    message: "Проанализируй репозиторий", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => request.role === "classifier"
      ? receipt(JSON.stringify(research), "classifier-receipt")
      : { ...receipt("", "research-receipt"), status: "failed", exitCode: 1, failureCategory: "provider_exit" }
  });
  assert.equal(result.route, "failed");
  assert.equal(result.error, "RESEARCHER_PROVIDER_EXIT");
  assert.equal(result.research, undefined);
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "failed");
  assert.equal(verified.prepare("SELECT payload_json FROM events WHERE entity_id=? AND kind='execution_error' ORDER BY created_at DESC LIMIT 1").get(result.run_id).payload_json.includes("RESEARCHER_PROVIDER_EXIT"), true);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("research cannot claim an answered repository analysis without inspected inventory paths", async () => {
  const { root, project, dbFile, db } = fixture("workflow-research-evidence-required-");
  fs.writeFileSync(path.join(project, "engine.ts"), "export const ready = false;\n", "utf8");
  db.close();
  const research = decision({
    work_type: "research", artifact_type: "test_report", discipline: "software", planning_level: "L0", planning_required: false,
    reply_mode: "research", reason: "Нужно исследовать исходники без изменений."
  });
  const result = await statelessProcessMessage({
    message: "Проанализируй репозиторий", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => request.role === "classifier"
      ? receipt(JSON.stringify(research), "classifier-receipt")
      : receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: "Репозиторий готов.", inspected_paths: [], limitations: [] }), "research-receipt")
  });
  assert.equal(result.route, "failed");
  assert.equal(result.error, "RESEARCH_ANSWER_WITHOUT_INSPECTED_SOURCE");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "failed");
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM run_evidence WHERE run_id=? AND kind='research_inspection'").get(result.run_id).count, 0);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("research cannot cite an inventory path whose contents were not supplied", async () => {
  const { root, project, dbFile, db } = fixture("workflow-research-supplied-source-required-");
  fs.mkdirSync(path.join(project, "src"));
  for (let index = 0; index < 10; index += 1) fs.writeFileSync(path.join(project, "src", `noise-${index}.ts`), `export const noise${index} = ${index};\n`, "utf8");
  fs.writeFileSync(path.join(project, "src", "target.ts"), "export const uniqueResearchNeedle = 'evidence';\n", "utf8");
  db.close();
  const research = decision({
    work_type: "research", artifact_type: "test_report", discipline: "software", planning_level: "L0", planning_required: false,
    reply_mode: "research", resolved_objective: "Explain uniqueResearchNeedle from the registered source.", reason: "Нужно исследовать конкретный символ."
  });
  let researcherPrompt = null;
  const result = await statelessProcessMessage({
    message: "Что делает uniqueResearchNeedle?", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => {
      if (request.role === "classifier") return receipt(JSON.stringify(research), "classifier-receipt");
      researcherPrompt = fs.readFileSync(request.taskFile, "utf8");
      return receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: "Ответ якобы получен из другого файла.", inspected_paths: ["src/noise-0.ts"], limitations: [] }), "research-receipt");
    }
  });
  assert.equal(result.route, "failed");
  assert.equal(result.error, "RESEARCH_PATH_NOT_SUPPLIED");
  assert.match(researcherPrompt, /export const uniqueResearchNeedle = 'evidence'/);
  assert.equal(researcherPrompt.includes("export const noise0 = 0"), false, "inventory-only files do not leak into supplied source content");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "failed");
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM run_evidence WHERE run_id=? AND kind='research_inspection'").get(result.run_id).count, 0);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("software research cannot answer from a controlled document without supplied source evidence", async () => {
  const { root, project, dbFile, db } = fixture("workflow-research-source-evidence-required-");
  fs.mkdirSync(path.join(project, "docs"));
  fs.mkdirSync(path.join(project, "WorkflowPlatform", "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "docs", "Research.md"), "WorkflowPlatform передаёт исследователю содержимое исходников.\n", "utf8");
  fs.writeFileSync(path.join(project, "WorkflowPlatform", "src", "workflow-app.mjs"), "export function researchSourceContext() { return 'source packet'; }\n", "utf8");
  db.prepare("INSERT OR IGNORE INTO roles(id,name) VALUES('researcher','Researcher')").run();
  db.prepare(`INSERT INTO role_contracts(id,project_id,role_id,version,purpose,boundaries_json,allowed_work_types_json,allowed_artifact_types_json,allowed_tools_json,allowed_skills_json,required_checks_json,allowed_transitions_json,allowed_profiles_json,context_limit_bytes,max_calls,max_correction_cycles,timeout_seconds,result_schema_key,prompt_template_version,escalation_json,status)
    VALUES('role-researcher','project','researcher','1','research','{}','[]','[]','[]','[]','[]','[]','[]',65536,1,0,60,'research.v1','1','{}','active')`).run();
  registerControlledDocument(db, { projectId: "project", path: "docs/Research.md", authority: "owner", readRoles: "researcher" });
  db.close();
  const research = decision({
    work_type: "research", artifact_type: "test_report", discipline: "software", planning_level: "L0", planning_required: false,
    reply_mode: "research", resolved_objective: "Как WorkflowPlatform передаёт исследователю содержимое исходников?", reason: "Нужно проверить реализацию по исходникам."
  });
  let researcherPrompt = null;
  const result = await statelessProcessMessage({
    message: "Как WorkflowPlatform передаёт исследователю содержимое исходников?", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => {
      if (request.role === "classifier") return receipt(JSON.stringify(research), "classifier-receipt");
      researcherPrompt = fs.readFileSync(request.taskFile, "utf8");
      return receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: "Ответ только по описанию.", inspected_paths: ["docs/Research.md"], limitations: [] }), "research-receipt");
    }
  });
  assert.equal(result.route, "failed");
  assert.equal(result.error, "RESEARCH_SOURCE_EVIDENCE_REQUIRED");
  assert.match(researcherPrompt, /REGISTERED_DOCUMENT_CONTEXT:.*docs\/Research\.md/);
  assert.match(researcherPrompt, /REGISTERED_SOURCE_EVIDENCE:.*WorkflowPlatform\/src\/workflow-app\.mjs/);
  assert.match(researcherPrompt, /researchSourceContext/);
  const sourcePacket = researcherPrompt.split("REGISTERED_SOURCE_EVIDENCE:")[1].split("\nREGISTERED_PROJECT_CORPUS:")[0];
  assert.equal(sourcePacket.includes("docs/Research.md"), false, "controlled documents stay outside the source packet");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a code-bearing non-software discipline also requires supplied source evidence", async () => {
  const { root, project, dbFile, db } = fixture("workflow-game-research-source-required-");
  fs.mkdirSync(path.join(project, "docs"));
  fs.mkdirSync(path.join(project, "game"));
  fs.writeFileSync(path.join(project, "docs", "Rules.md"), "Описание правила появления spawnEncounter.\n", "utf8");
  fs.writeFileSync(path.join(project, "game", "encounter.ts"), "export function spawnEncounter() { return 'current source'; }\n", "utf8");
  db.prepare("INSERT OR IGNORE INTO roles(id,name) VALUES('researcher','Researcher')").run();
  db.prepare(`INSERT INTO role_contracts(id,project_id,role_id,version,purpose,boundaries_json,allowed_work_types_json,allowed_artifact_types_json,allowed_tools_json,allowed_skills_json,required_checks_json,allowed_transitions_json,allowed_profiles_json,context_limit_bytes,max_calls,max_correction_cycles,timeout_seconds,result_schema_key,prompt_template_version,escalation_json,status)
    VALUES('role-researcher','project','researcher','1','research','{}','[]','[]','[]','[]','[]','[]','[]',65536,1,0,60,'research.v1','1','{}','active')`).run();
  registerControlledDocument(db, { projectId: "project", path: "docs/Rules.md", authority: "owner", readRoles: "researcher" });
  db.close();
  const research = decision({
    work_type: "research", artifact_type: "test_report", discipline: "game_design", planning_level: "L0", planning_required: false,
    reply_mode: "research", resolved_objective: "Как устроен spawnEncounter?", reason: "Нужно проверить игровое правило по исходникам."
  });
  const result = await statelessProcessMessage({
    message: "Как устроен spawnEncounter?", project, dbFile, workflowDefinition: definition(), execute: true,
    gatewayCall: async request => request.role === "classifier"
      ? receipt(JSON.stringify(research), "classifier-receipt")
      : receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: "Ответ только по документу.", inspected_paths: ["docs/Rules.md"], limitations: [] }), "research-receipt")
  });
  assert.equal(result.route, "failed");
  assert.equal(result.error, "RESEARCH_SOURCE_EVIDENCE_REQUIRED");
  fs.rmSync(root, { recursive: true, force: true });
});

test("clarification produces plain questions and does not start productive roles", async () => {
  const { root, project, dbFile, db } = fixture("workflow-clarification-route-");
  db.close();
  const clarification = decision({
    work_type: "clarification", artifact_type: "none", discipline: "general", planning_required: false, human_required: true,
    needs_questions: true, reply_mode: "clarification", reason: "Не указан целевой документ.", questions: ["Какой документ нужно изменить?"]
  });
  const result = await statelessProcessMessage({ message: "Измени это", project, dbFile, workflowDefinition: definition(), classificationResult: clarification });
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
  const catalog = classificationCatalog(db, "project", { mode: "stateless" });
  const cases = [
    decision({ work_type: "decision", artifact_type: "decision" }),
    decision({ work_type: "documentation", artifact_type: "document", discipline: "documentation", document_required: true }),
    decision({ work_type: "implementation", artifact_type: "code" }),
    decision({ work_type: "verification", artifact_type: "test_report", discipline: "testing" }),
    decision({ work_type: "asset", artifact_type: "visual_asset", discipline: "art_direction" }),
    decision({ work_type: "continuation", artifact_type: "none", discipline: "general", planning_required: false, reply_mode: "conversation" })
  ];
  assert.deepEqual(cases.map(item => validateClassificationDecision(item, catalog).work_type), ["decision", "documentation", "implementation", "verification", "asset", "continuation"]);
  const detailedDocumentContinuation = decision({ work_type: "continuation", artifact_type: "document", discipline: "documentation", document_required: true });
  assert.equal(validateClassificationDecision(detailedDocumentContinuation, catalog).work_type, "documentation");
  assert.throws(() => validateClassificationDecision(decision({ work_type: "continuation", artifact_type: "code" }), catalog), /continuation contract/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unpinned project hook lets the classifier select the registered workflow route", async () => {
  const { root, project, dbFile, db } = fixture("workflow-classification-route-selection-");
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json) VALUES('implementation-workflow','Implementation','project','mvp','L2','active','{\"git\":false}')").run();
  db.prepare("UPDATE workflow_routes SET workflow_id='implementation-workflow',priority=100 WHERE project_id='project' AND work_type_id='implementation'").run();
  db.close();
  const result = await statelessProcessMessage({ message: "Исправь ошибку", project, dbFile, classificationResult: decision() });
  assert.equal(result.route, "work");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT workflow_id FROM workflow_runs WHERE id=?").get(result.run_id).workflow_id, "implementation-workflow");
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a registered manifest is not held to the semantic document format", () => {
  const { root, project, db } = fixture("workflow-reference-document-");
  fs.writeFileSync(path.join(project, "package.json"), `{ "name": "example" }`);
  fs.mkdirSync(path.join(project, "docs"));
  fs.writeFileSync(path.join(project, "docs", "plan.md"), `<document id="plan">
# Plan
</document>`);
  db.prepare("INSERT INTO project_documents(id,project_id,path,document_type,authority,status,active) VALUES('manifest','project','package.json','reference','owner','active',1)").run();
  db.prepare("INSERT INTO project_documents(id,project_id,path,document_type,authority,status,active) VALUES('plan-doc','project','docs/plan.md','plan','owner','active',1)").run();
  const discovery = readProjectContext(project, db, [], { workflowId: "workflow" });
  const manifest = discovery.documents.find(item => item.path === "package.json");
  const plan = discovery.documents.find(item => item.path === "docs/plan.md");
  // The manifest belongs to the tool that reads it, so the semantic format does not apply and no
  // permanent failure is reported; a plan is a document the platform writes and is still checked.
  assert.equal(manifest.lint.status, "not_applicable");
  assert.deepEqual(manifest.lint.errors, []);
  assert.equal(plan.lint.status, "passed");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("discovery and role context read only registered documents and explicit permissions", () => {
  const { root, project, db } = fixture("workflow-discovery-");
  fs.mkdirSync(path.join(project, "docs"));
  fs.writeFileSync(path.join(project, "docs", "research.md"), "# Research\n<point status=\"open\">One</point>");
  fs.writeFileSync(path.join(project, "docs", "planner.md"), "# Planner\nPlan");
  fs.writeFileSync(path.join(project, "docs", "unregistered.md"), "must not be discovered");
  fs.writeFileSync(path.join(project, ".env"), "TOKEN=must-not-be-discovered");
  db.prepare("INSERT INTO project_documents(id,project_id,path,document_type,authority,status,active) VALUES('research-doc','project','docs/research.md','authority','owner','active',1)").run();
  db.prepare("INSERT INTO project_documents(id,project_id,path,document_type,authority,status,active) VALUES('planner-doc','project','docs/planner.md','plan','owner','active',1)").run();
  db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES('project','researcher','research-doc',1,0,'research',10)").run();
  db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES('project','planner','planner-doc',1,0,'planning',10)").run();
  const discovery = readProjectContext(project, db, [], { workflowId: "workflow" });
  assert.deepEqual(discovery.documents.map(item => item.path), ["docs/planner.md", "docs/research.md"]);
  // Registration decides which files are documents: a file nobody registered has no authority, no role
  // may write it, and its text is never read into the context. Collection still names it, because the
  // project directory is what registration registered. A credential-shaped name is not named at all.
  assert.equal(JSON.stringify(discovery.documents).includes("unregistered"), false);
  assert.equal(JSON.stringify(discovery).includes("must not be discovered"), false);
  assert.equal(JSON.stringify(discovery).includes(".env"), false);
  assert.equal(discovery.git.status, "not_requested");
  const selected = selectProjectContext(discovery, decision(), [], db, "project", "researcher");
  assert.deepEqual(selected.documents.map(item => item.path), ["docs/research.md"]);
  const snapshot = compactProjectSnapshot(discovery);
  assert.equal(JSON.stringify(snapshot).includes("must not be discovered"), false);
  assert.equal(JSON.stringify(snapshot).includes("<point"), false);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("classifier context keeps accepted decisions and one bounded current session state instead of a message trail", () => {
  const { root, db } = fixture("workflow-context-order-");
  const runtimeTask = "task-history";
  const semanticScope = { mode: "session", client: "codex", session_id: "history-chat" };
  activateChatSession(db, { client: semanticScope.client, sessionId: semanticScope.session_id, origin: path.join(root, "project"), turnKey: "turn-1" });
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES(?,'project','History','completed',?,?)").run(runtimeTask, now(), now());
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,user_message,created_at,updated_at,completed_at) VALUES('history-run',?,'project','workflow','completed','History',?,?,?)").run(runtimeTask, now(), now(), now());
  db.prepare("INSERT INTO zodchi_chat_session_runs(run_id,client,session_id,bound_at) VALUES('history-run',?,?,?)").run(semanticScope.client, semanticScope.session_id, now());
  db.prepare("INSERT INTO decisions(id,task_id,kind,outcome,source,structured_json,active,created_at) VALUES('accepted-decision',?,'owner','APPROVE','owner','{\"value\":1}',1,?)").run(runtimeTask, now());
  db.prepare("INSERT INTO decisions(id,task_id,kind,outcome,source,structured_json,active,created_at) VALUES('classifier-decision',?,'classification','conversation','classifier','{\"value\":2}',1,?)").run(runtimeTask, now());
  db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES('pending-approval',?,'history-run','owner','Продолжить?','pending',?)").run(runtimeTask, now());
  setPendingMessage(db, { client: semanticScope.client, sessionId: semanticScope.session_id, message: "Провести архитектурный анализ репозитория.", profile: { quality_mode: "mvp", execution_mode: "standard", verification_mode: "baseline", planning_mode: "single" } });
  for (let index = 0; index < 8; index += 1) db.prepare("INSERT INTO conversation_messages(id,project_id,run_id,role,content,created_at) VALUES(?,'project','history-run',?,?,?)")
    .run(`message-${index}`, index % 2 ? "assistant" : "user", `history-${index}-${"x".repeat(120)}`, `2026-01-01T00:00:0${index}.000Z`);
  assert.throws(() => classifierStateContext(db, "project", undefined, semanticScope), /STATE_CONTEXT_BUDGET_REQUIRED/);
  assert.throws(() => classifierStateContext(db, "project", 500), /ZODCHI_SEMANTIC_SCOPE_REQUIRED/);
  assert.throws(() => classificationCatalog(db, "project"), /ZODCHI_SEMANTIC_SCOPE_REQUIRED/);
  assert.equal(classifierStateContext(db, "project", 500, { mode: "stateless" }).current_session_state, null);
  assert.deepEqual(classificationCatalog(db, "project", { mode: "stateless" }).pending_interactions, []);
  const context = classifierStateContext(db, "project", 4096, semanticScope);
  assert.equal(context.accepted_decisions[0].id, "accepted-decision");
  assert.equal(context.accepted_decisions.some(item => item.id === "classifier-decision"), false);
  assert.equal(context.current_session_state.owner_objective.verbatim, "History");
  assert.match(context.current_session_state.last_response, /^history-7-/);
  assert.equal(JSON.stringify(context).includes("history-5-"), false);
  const catalog = classificationCatalog(db, "project", semanticScope);
  const profileInteraction = catalog.pending_interactions.find(item => item.kind === RUN_PROFILE_CONFIRMATION_KIND);
  assert.equal(profileInteraction.id, RUN_PROFILE_CONFIRMATION_ID);
  assert.equal(profileInteraction.objective, "Провести архитектурный анализ репозитория.");
  assert.equal(profileInteraction.profile.verification_mode, "baseline");
  const snapshot = { project: { id: "project", name: "Project" } };
  const first = classifierPrompt({ message: "Да", catalog, projectSnapshot: snapshot, acceptedDecisions: context.accepted_decisions, currentState: context.current_session_state });
  const second = classifierPrompt({ message: "Продолжай", catalog, projectSnapshot: snapshot, acceptedDecisions: context.accepted_decisions, currentState: context.current_session_state });
  assert.match(first, /pending-approval/);
  assert.match(first, /pending_run_profile/);
  assert.match(first, /run_profile_confirmation/);
  assert.match(first, /FIXED_OUTPUT_VALUES:\{"schema_version":1\}/);
  assert.equal(first.split("CURRENT_USER_MESSAGE:")[0], second.split("CURRENT_USER_MESSAGE:")[0]);
  assert.ok(first.endsWith('CURRENT_USER_MESSAGE:"Да"'));
  const source = `${fs.readFileSync(new URL("../src/classifier.mjs", import.meta.url), "utf8")}\n${fs.readFileSync(new URL("../src/workflow-app.mjs", import.meta.url), "utf8")}\n${fs.readFileSync(new URL("../src/session-router.mjs", import.meta.url), "utf8")}`;
  assert.equal(source.includes("classifyMessage"), false);
  assert.equal(source.includes("/^(да|"), false);
  assert.equal(source.includes("EXECUTION_CONFIRMATION"), false);
  assert.equal(source.includes("isExecutionConfirmation"), false);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("model-classified profile approval executes the canonical pending objective without router keyword rules", async () => {
  const { root, project, dbFile, db } = fixture("workflow-profile-confirmation-");
  const semanticScope = { mode: "session", client: "codex", session_id: "profile-chat" };
  activateChatSession(db, { client: semanticScope.client, sessionId: semanticScope.session_id, origin: project, turnKey: "turn-1" });
  setPendingMessage(db, { client: semanticScope.client, sessionId: semanticScope.session_id, message: "Провести архитектурный анализ репозитория.", profile: { quality_mode: "mvp", execution_mode: "standard", verification_mode: "baseline", planning_mode: "single" } });
  db.close();
  const result = await scopedProcessMessage({
    message: "Хорошо, делай", project, dbFile, workflowDefinition: definition(), execute: false, prepareOnly: true, semanticScope,
    classificationResult: decision({ pending_interaction_id: RUN_PROFILE_CONFIRMATION_ID, pending_interaction_response: "approve", resolved_objective: "Неверная формулировка из текущей короткой реплики." })
  });
  assert.equal(result.route, "work");
  assert.equal(result.session_profile_action, "consume");
  assert.equal(result.classification.resolved_objective, "Провести архитектурный анализ репозитория.");
  assert.deepEqual({
    quality_mode: result.run_profile.quality_mode,
    execution_mode: result.run_profile.execution_mode,
    verification_mode: result.run_profile.verification_mode,
    planning_mode: result.run_profile.planning_mode
  }, { quality_mode: "mvp", execution_mode: "standard", verification_mode: "baseline", planning_mode: "single" });
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
    workflow: { id: "workflow", name: "Workflow", discovery: { git: false } },
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

test("the classifier prompt keeps run state below an invariant head long enough for a provider to cache", () => {
  const { root, db } = fixture("workflow-classification-prefix-");
  const catalog = classificationCatalog(db, "project", { mode: "stateless" });
  const build = (message, head) => classifierPrompt({ message, catalog, projectSnapshot: { git: { head } }, acceptedDecisions: [], currentState: null, responseLanguage: "ru" });
  const first = build("first message", "aaa"), second = build("second message", "bbb");
  let shared = 0;
  while (shared < first.length && shared < second.length && first[shared] === second[shared]) shared += 1;
  // Providers reuse a cached prefix only past a minimum length, so the invariant head has to clear it
  // with room to spare on the narrowest project in the registry.
  assert.equal(first.indexOf("PROJECT_SNAPSHOT") > 3800, true, `invariant head is only ${first.indexOf("PROJECT_SNAPSHOT")} bytes`);
  assert.equal(shared >= first.indexOf("PROJECT_SNAPSHOT"), true, `two runs share only ${shared} bytes`);
  assert.match(first, /Never ask the user to paste source files/);
  assert.match(first, /inspect registered project code and write the findings/);
  for (const field of ["PROJECT_SNAPSHOT", "ACCEPTED_DECISIONS", "PENDING_INTERACTIONS", "CURRENT_SESSION_STATE", "CURRENT_USER_MESSAGE"]) {
    assert.equal(first.indexOf(field) > first.indexOf("REGISTERED_ROUTES"), true, `${field} must follow the invariant head`);
  }
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a clarification stops being pending once the next message answers or supersedes it", async () => {
  const { root, project, dbFile, db } = fixture("workflow-clarification-settle-");
  const semanticScope = { mode: "session", client: "codex", session_id: "clarification-chat" };
  activateChatSession(db, { client: semanticScope.client, sessionId: semanticScope.session_id, origin: project, turnKey: "turn-1" });
  db.close();
  const asking = decision({
    work_type: "clarification", artifact_type: "none", discipline: "general", planning_level: "L0",
    planning_required: false, reply_mode: "clarification", needs_questions: true,
    questions: ["Какие документы проверить первыми?"], reason: "Не указаны исходные документы."
  });
  const first = await scopedProcessMessage({
    message: "Разберись со старыми материалами", project, dbFile, workflowDefinition: definition(), execute: true, semanticScope,
    gatewayCall: async () => receipt(JSON.stringify(asking))
  });
  const opened = openDb(dbFile);
  const pendingId = opened.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(first.run_id).id;
  opened.close();

  const answered = await scopedProcessMessage({
    message: "Начни с бестиария", project, dbFile, workflowDefinition: definition(), execute: true, semanticScope,
    gatewayCall: async () => receipt(JSON.stringify({ ...asking, questions: ["Только классифицировать или готовить предложение?"], pending_interaction_id: pendingId }))
  });
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT status FROM approvals WHERE id=?").get(pendingId).status, "approved");
  // Only the question asked by the newest run is still open; nothing older survives to be re-asked.
  const open = verified.prepare("SELECT run_id FROM approvals WHERE status='pending'").all();
  assert.equal(open.length, 1);
  assert.equal(open[0].run_id, answered.run_id);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("two chats in one project keep current state and interactions isolated while downstream receives resolved objectives", async () => {
  const { root, project, dbFile, db } = fixture("workflow-session-semantic-context-");
  activateChatSession(db, { client: "codex", sessionId: "chat-a", origin: project, turnKey: "a-1" });
  activateChatSession(db, { client: "codex", sessionId: "chat-b", origin: project, turnKey: "b-1" });
  db.close();

  const askingA = decision({
    work_type: "clarification", artifact_type: "none", discipline: "general", planning_level: "L0",
    planning_required: false, human_required: true, needs_questions: true, reply_mode: "clarification",
    resolved_objective: "Уточнить, какой из трёх аспектов анализировать первым.",
    reason: "Нужно выбрать порядок анализа.",
    questions: ["Что проанализировать первым: архитектуру, заявленную универсальность или готовность к дальнейшей разработке?"]
  });
  const askingB = decision({
    work_type: "clarification", artifact_type: "none", discipline: "general", planning_level: "L0",
    planning_required: false, human_required: true, needs_questions: true, reply_mode: "clarification",
    resolved_objective: "Уточнить формат отчёта.", reason: "Не выбран формат.", questions: ["Нужен Markdown или JSON?"]
  });
  const firstA = await scopedProcessMessage({ message: "Начнём анализ", project, dbFile, workflowDefinition: definition(), classificationResult: askingA, semanticScope: { mode: "session", client: "codex", session_id: "chat-a" } });
  const firstB = await scopedProcessMessage({ message: "Подготовь отчёт", project, dbFile, workflowDefinition: definition(), classificationResult: askingB, semanticScope: { mode: "session", client: "codex", session_id: "chat-b" } });

  const state = openDb(dbFile);
  const pendingA = state.prepare("SELECT id FROM approvals WHERE run_id=?").get(firstA.run_id).id;
  const pendingB = state.prepare("SELECT id FROM approvals WHERE run_id=?").get(firstB.run_id).id;
  const contextA = classifierStateContext(state, "project", 65_536, { mode: "session", client: "codex", session_id: "chat-a" });
  const contextB = classifierStateContext(state, "project", 65_536, { mode: "session", client: "codex", session_id: "chat-b" });
  assert.equal(JSON.stringify(contextA.current_session_state).includes("Markdown или JSON"), false);
  assert.equal(JSON.stringify(contextB.current_session_state).includes("архитектуру"), false);
  assert.deepEqual(classificationCatalog(state, "project", { mode: "session", client: "codex", session_id: "chat-a" }).pending_interactions.map(item => item.id), [pendingA]);
  assert.deepEqual(classificationCatalog(state, "project", { mode: "session", client: "codex", session_id: "chat-b" }).pending_interactions.map(item => item.id), [pendingB]);
  state.close();

  const resolved = "Проанализировать по порядку: текущую архитектуру движка, соответствие заявленной универсальности и готовность к дальнейшей разработке.";
  fs.writeFileSync(path.join(project, "architecture.md"), "# Architecture\n\nCurrent engine boundaries.\n", "utf8");
  let classifierInput = null, researcherInput = null;
  const research = decision({
    work_type: "research", artifact_type: "test_report", discipline: "general", planning_required: false,
    reply_mode: "research", pending_interaction_id: pendingA, resolved_objective: resolved,
    reason: "Пользователь выбрал все три ранее перечисленных аспекта в указанном порядке."
  });
  const secondA = await scopedProcessMessage({
    message: "давай все три в порядке который ты указал", project, dbFile, workflowDefinition: definition(), execute: true,
    semanticScope: { mode: "session", client: "codex", session_id: "chat-a" },
    gatewayCall: async request => {
      const prompt = fs.readFileSync(request.taskFile, "utf8");
      if (request.role === "classifier") { classifierInput = prompt; return receipt(JSON.stringify(research), "classifier-context"); }
      researcherInput = prompt;
      return receipt(JSON.stringify({ schema_version: 1, status: "answered", answer: "Анализ выполнен по трём аспектам.", inspected_paths: ["architecture.md"], limitations: [] }), "researcher-context");
    }
  });
  assert.equal(secondA.route, "research");
  assert.match(classifierInput, /архитектуру, заявленную универсальность или готовность/);
  assert.equal(classifierInput.includes("Markdown или JSON"), false);
  assert.match(researcherInput, /RESOLVED_OBJECTIVE.*authoritative standalone task/);
  assert.equal(researcherInput.includes(resolved), true);
  assert.match(researcherInput, /REGISTERED_PROJECT_CORPUS/);
  assert.match(researcherInput, /architecture\.md/);
  assert.match(researcherInput, /VERBATIM_CURRENT_USER_MESSAGE:"давай все три/);

  const afterA = openDb(dbFile);
  assert.equal(afterA.prepare("SELECT status FROM approvals WHERE id=?").get(pendingA).status, "approved");
  assert.equal(afterA.prepare("SELECT status FROM approvals WHERE id=?").get(pendingB).status, "pending");
  afterA.close();

  const plannerObjective = "Подготовить Markdown-отчёт по зарегистрированным материалам проекта.";
  const planned = await scopedProcessMessage({
    message: "Markdown", project, dbFile, workflowDefinition: definition(), execute: false,
    semanticScope: { mode: "session", client: "codex", session_id: "chat-b" },
    classificationResult: decision({ artifact_type: "document", discipline: "documentation", document_required: true, pending_interaction_id: pendingB, resolved_objective: plannerObjective })
  });
  assert.equal(planned.route, "work");
  assert.equal(planned.plan.objective, plannerObjective);
  const final = openDb(dbFile);
  assert.equal(final.prepare("SELECT resolved_objective FROM workflow_runs WHERE id=?").get(planned.run_id).resolved_objective, plannerObjective);
  final.close();
  fs.rmSync(root, { recursive: true, force: true });
});
