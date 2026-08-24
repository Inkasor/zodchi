import fs from "node:fs";
import path from "node:path";
import { Runtime, recordLint } from "./runtime.mjs";
import { classificationCatalog, classifierPrompt, parseClassificationReceipt, resolveWorkflowRoute, validateClassificationDecision } from "./classifier.mjs";
import { buildPrompt } from "./prompt-builder.mjs";
import { callGateway } from "./gateway.mjs";
import { workflowLint } from "./lint.mjs";
import { compactProjectSnapshot, conversationContext, readProjectContext, selectProjectContext } from "./document-context.mjs";
import { formatClassification, formatQuestions } from "./response-formatter.mjs";
import { id, now } from "./db.mjs";
import { appendEvent } from "./state-machine.mjs";
import { resolveWorkflowSettings } from "./paths.mjs";
import { executeStructuredWork } from "./work-executor.mjs";
import { chargeDirectReceipt, initializeQualityRun, operationalLevel, reserveDirectModelCall } from "./quality-contracts.mjs";

export function loadWorkflow(id, workflowsRoot = resolveWorkflowSettings().workflowsRoot) {
  if (!id) throw new Error("workflow id is required");
  return JSON.parse(fs.readFileSync(path.join(workflowsRoot, `${id}.json`), "utf8"));
}

function registryDefinition(db, projectId, workflowId) {
  const roles = {};
  for (const row of db.prepare(`SELECT rpa.role_id,p.provider,p.name,rpa.operational_level FROM role_profile_assignments rpa JOIN profiles p ON p.id=rpa.profile_id
    WHERE rpa.project_id=? AND rpa.enabled=1 AND rpa.role_id IN ('classifier','researcher')
    ORDER BY rpa.role_id,CASE rpa.operational_level WHEN 'prototype' THEN 0 WHEN 'mvp' THEN 1 ELSE 2 END`).all(projectId)) {
    if (!roles[row.role_id]) roles[row.role_id] = { provider: row.provider, profile: row.name, role: row.role_id };
  }
  return { id: workflowId, authority: "registered portable package and project documents", roles, gates: [] };
}

function parsedJson(text) { try { return JSON.parse(String(text).trim()); } catch { return null; } }
function extractModelText(text) {
  const direct = parsedJson(text);
  if (typeof direct?.result === "string") return direct.result;
  if (typeof direct?.text === "string") return direct.text;
  if (typeof direct?.item?.text === "string") return direct.item.text;
  for (const line of String(text ?? "").split(/\r?\n/).reverse()) {
    const value = parsedJson(line);
    if (typeof value?.result === "string") return value.result;
    if (typeof value?.text === "string") return value.text;
    if (typeof value?.item?.text === "string") return value.item.text;
  }
  return String(text ?? "").trim();
}

function boundedDocuments(discovery, maxBytes = 32_000) {
  const result = [];
  let used = 0;
  for (const document of discovery.documents) {
    const remaining = maxBytes - used;
    if (remaining <= 0) break;
    const text = String(document.text ?? "").slice(0, remaining);
    result.push({ path: document.path, authority: document.authority, text });
    used += Buffer.byteLength(text);
  }
  return result;
}

function researchPrompt({ message, project, discovery }) {
  return [
    "WORKFLOW RESEARCH REQUEST v2",
    "Answer the current question from only the registered readable documents below. Do not edit files, invoke other agents, or invent facts.",
    "Return a concise human-readable Russian answer without internal IDs, profiles, levels, prompts or JSON.",
    `PROJECT:${project.name}`,
    `REGISTERED_CONTEXT:${JSON.stringify(boundedDocuments(discovery))}`,
    `CURRENT_USER_MESSAGE:${JSON.stringify(message)}`
  ].join("\n");
}

function recordClassificationFailure(runtime, runId, error) {
  const taskId = runtime.get(runId).task_id;
  const payload = { category: String(error.message).split(":")[0].slice(0, 120) };
  runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,'classification','INVALID','classifier',?,1,?)")
    .run(id("decision"), taskId, runId, JSON.stringify(payload), now());
  appendEvent(runtime.db, { entityType: "workflow_run", entityId: runId, kind: "contract_error", payload });
}

function classificationFailure(runtime, runId, error, finish) {
  recordClassificationFailure(runtime, runId, error);
  if (runtime.get(runId).state !== "classification_failed") runtime.setState(runId, "classification_failed", { reason: "classifier contract rejected" });
  return finish({ route: "classification_failed", response: "Не удалось надёжно определить маршрут задачи. Рабочие роли не запускались; нужно уточнить запрос или настройки проекта.", error: String(error.message).split(":")[0].slice(0, 120) });
}

function executionFailure(runtime, runId, error, finish) {
  const category = String(error.message).split(":")[0].slice(0, 120);
  appendEvent(runtime.db, { entityType: "workflow_run", entityId: runId, kind: "execution_error", payload: { category } });
  runtime.setState(runId, "failed", { reason: category });
  return finish({ route: "failed", response: "Исполнительный этап не завершился. Повтор или эскалация будут выполнены только по правилам маршрута.", error: category });
}

export async function processMessage({
  message, project, dbFile, workflow, workflowDefinition, execute = false, eventSource = "user", eventKey = null,
  classificationResult = null, gatewayCall = callGateway, gateRunner = undefined
}) {
  const settings = resolveWorkflowSettings();
  project ??= settings.project;
  dbFile ??= settings.databasePath;
  workflow ??= settings.workflow ?? workflowDefinition?.id;
  if (!project) throw new Error("PROJECT_REQUIRED: configure a project during onboarding or pass project explicitly");
  let definition = workflowDefinition ?? null;
  if (!definition && workflow) {
    try { definition = loadWorkflow(workflow, settings.workflowsRoot); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const projectSlug = path.basename(project).toLowerCase().replaceAll(" ", "-");
  const runtime = new Runtime(dbFile);
  const registeredProject = runtime.db.prepare("SELECT id,root_path FROM projects WHERE id=? OR lower(root_path)=lower(?) LIMIT 1").get(project, path.resolve(project));
  if (!registeredProject) { runtime.db.close(); throw new Error(`PROJECT_NOT_REGISTERED: ${project}`); }
  const projectRoot = registeredProject.root_path;
  project = registeredProject.id;
  workflow ??= definition?.id ?? runtime.db.prepare(`SELECT w.id FROM workflow_routes wr JOIN workflows w ON w.id=wr.workflow_id
    WHERE wr.project_id=? AND wr.enabled=1 AND w.status='active' ORDER BY wr.priority DESC,w.id LIMIT 1`).get(project)?.id;
  if (!workflow) { runtime.db.close(); throw new Error(`WORKFLOW_NOT_REGISTERED: ${project}`); }
  const accepted = runtime.accept(message, { project_id: project, workflow_id: workflow, client: "codex", event_source: eventSource, event_key: eventKey });
  const runId = accepted.runId;
  const run = runtime.get(runId);
  const taskDirectory = path.join(settings.tempRoot, projectSlug, runId);
  const finish = value => {
    runtime.db.close();
    fs.rmSync(taskDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return { run_id: runId, ...value };
  };
  if (accepted.duplicate) {
    const saved = runtime.db.prepare("SELECT content FROM conversation_messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 1").get(runId)?.content ?? "Это сообщение уже принято и не будет запущено повторно.";
    runtime.db.close();
    return { run_id: runId, route: "duplicate", duplicate: true, response: saved };
  }

  const workflowRow = runtime.db.prepare("SELECT * FROM workflows WHERE id=? AND project_id=? AND status='active'").get(workflow, run.project_id);
  if (!workflowRow) return classificationFailure(runtime, runId, new Error(`DISCOVERY_WORKFLOW_NOT_REGISTERED: ${workflow}`), finish);
  definition ??= registryDefinition(runtime.db, run.project_id, workflow);
  const historyContext = conversationContext(runtime.db, run.project_id, workflowRow.history_budget_bytes);
  const discovery = readProjectContext(project, runtime.db);
  const catalog = classificationCatalog(runtime.db, run.project_id);
  runtime.db.prepare("INSERT INTO conversation_messages(id,project_id,run_id,role,content,created_at) VALUES(?,?,?,'user',?,?)")
    .run(`${runId}:user`, run.project_id, runId, String(message), now());
  const saveAssistant = response => {
    runtime.db.prepare("INSERT INTO conversation_messages(id,project_id,run_id,role,content,created_at) VALUES(?,?,?,'assistant',?,?)")
      .run(`${runId}:assistant`, run.project_id, runId, response, now());
    return response;
  };
  fs.mkdirSync(taskDirectory, { recursive: true });
  const classifierTaskFile = path.join(taskDirectory, "classifier-task.md");
  fs.writeFileSync(classifierTaskFile, classifierPrompt({ message, catalog, projectSnapshot: compactProjectSnapshot(discovery), acceptedDecisions: historyContext.accepted_decisions, history: historyContext.history }), "utf8");
  runtime.setState(runId, "classifying", { reason: "deterministic discovery complete" });

  let classifierReceipt = null;
  let classification;
  try {
    if (classificationResult) classification = validateClassificationDecision(classificationResult, catalog);
    else {
      if (!execute) throw new Error("CLASSIFICATION_EXECUTION_REQUIRED: supply a validated contract result for dry-run tests");
      const role = definition.roles?.classifier;
      if (!role?.provider || !role.profile || !role.role) throw new Error("CLASSIFIER_ROLE_NOT_CONFIGURED");
      classifierReceipt = await gatewayCall({ provider: role.provider, profile: role.profile, level: "prototype", role: role.role, taskFile: classifierTaskFile, project: projectRoot, taskId: `${runId}:classifier` });
      runtime.linkGateway(runId, classifierReceipt);
      classification = parseClassificationReceipt(classifierReceipt, catalog);
    }
    const routedWorkflow = resolveWorkflowRoute(catalog, classification.work_type);
    if (routedWorkflow !== workflow) {
      runtime.db.prepare("UPDATE workflow_runs SET workflow_id=?,updated_at=? WHERE id=?").run(routedWorkflow, now(), runId);
      workflow = routedWorkflow;
    }
    runtime.classify(runId, classification);
    initializeQualityRun(runtime, runId, classification, classifierReceipt);
  } catch (error) {
    return classificationFailure(runtime, runId, error, finish);
  }

  if (classification.needs_questions) {
    const taskId = runtime.get(runId).task_id;
    for (const question of classification.questions) runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'clarification',?,'pending',?)")
      .run(id("approval"), taskId, runId, question, now());
    runtime.setState(runId, "clarification_required", { reason: "classifier requested missing information" });
    const response = saveAssistant(formatQuestions({ summary: classification.reason, questions: classification.questions, nextStep: "продолжить по выбранному маршруту" }));
    return finish({ route: "clarification", classification, response, gateway: classifierReceipt ? { mode: "executed", receipts: [{ step: "classifier", receipt: classifierReceipt }] } : { mode: "contract-test" } });
  }

  if (classification.reply_mode === "conversation") {
    runtime.setState(runId, "completed", { reason: "conversation response delivered" });
    const response = saveAssistant(classification.human_response?.trim() || classification.reason);
    return finish({ route: "conversation", classification, response, gateway: classifierReceipt ? { mode: "executed", receipts: [{ step: "classifier", receipt: classifierReceipt }] } : { mode: "contract-test" } });
  }

  if (classification.reply_mode === "research") {
    const selected = selectProjectContext(discovery, classification, [], runtime.db, run.project_id, "researcher");
    if (!execute) return finish({ route: "research", classification, response: formatClassification({ summary: classification.reason, nextStep: "выполнить ограниченное исследование по зарегистрированным источникам" }), gateway: { mode: "dry-run", steps: [{ role: "researcher", readable_documents: selected.documents.map(item => item.path) }] } });
    runtime.setState(runId, "executing", { reason: "research route authorized" });
    const researchFile = path.join(taskDirectory, "research-task.md");
    fs.writeFileSync(researchFile, researchPrompt({ message, project: discovery.project, discovery: selected }), "utf8");
    const role = definition.roles?.researcher;
    if (!role?.provider || !role.profile || !role.role) return executionFailure(runtime, runId, new Error("RESEARCHER_ROLE_NOT_CONFIGURED"), finish);
    let researcher;
    try {
      reserveDirectModelCall(runtime, runId, "researcher");
      researcher = await gatewayCall({ provider: role.provider, profile: role.profile, level: operationalLevel(classification.quality_mode), role: role.role, taskFile: researchFile, project: projectRoot, taskId: `${runId}:researcher` });
      chargeDirectReceipt(runtime, runId, researcher, "researcher");
    }
    catch (error) { return executionFailure(runtime, runId, error, finish); }
    runtime.linkGateway(runId, researcher);
    runtime.setState(runId, "verifying", { reason: "research response received" });
    runtime.setState(runId, "completed", { reason: "research response delivered" });
    const response = saveAssistant(extractModelText(researcher.output));
    return finish({ route: "research", classification, response, gateway: { mode: "executed", receipts: [{ step: "classifier", receipt: classifierReceipt }, { step: "researcher", receipt: researcher }] } });
  }

  if (execute) {
    try {
      const execution = await executeStructuredWork({ runtime, runId, classification, definition, discovery, message, taskRoot: taskDirectory, gatewayCall, ...(gateRunner ? { gateRunner } : {}) });
      const response = execution.status === "completed"
        ? execution.reviewer
          ? "Работа выполнена: программные проверки прошли, независимая проверка подтвердила результат, обязательная документация обновлена."
          : "Работа выполнена: программные проверки прошли, обязательная документация обновлена. Отдельная независимая проверка для этого уровня и риска не требовалась."
        : execution.status === "rejected" ? "Независимая проверка отклонила результат. Задача не завершена и не будет продолжена без нового решения."
          : execution.status === "changes_requested" ? "Результат требует исправлений. Задача не завершена; повтор будет ограничен правилами маршрута."
            : execution.status === "approval_required" ? formatQuestions({ summary: "Следующий шаг требует отдельного решения владельца.", questions: execution.questions, nextStep: "продолжить выбранный маршрут" })
            : execution.status === "clarification_required" ? formatQuestions({ summary: "План требует уточнения.", questions: execution.questions, nextStep: "продолжить исполнение" })
              : "Исполнение остановлено в контролируемом состоянии; автоматическое завершение не выполнено.";
      saveAssistant(response);
      return finish({ route: "work", classification, response, execution });
    } catch (error) {
      const state = runtime.get(runId).state;
      const response = "Структурированный исполнительный контракт не прошёл проверку. Задача не завершена; повтор или эскалация возможны только по правилам маршрута.";
      saveAssistant(response);
      return finish({ route: "execution_failed", classification, response, execution: { status: state, error: String(error.message).split(":")[0].slice(0, 120) } });
    }
  }

  const plan = {
    objective: message, workflow, project: discovery.project.name, level: classification.planning_level, quality: classification.quality_mode,
    authority: definition.authority ?? "registered project documents",
    steps: [{ key: "planning" }, { key: "execution" }, { key: "verification" }, { key: "review" }, { key: "documentation" }],
    gates: definition.gates ?? []
  };
  recordLint(runtime.db, runId, workflowLint({ state: "planning", classification }));
  runtime.plan(runId, plan);
  const selected = selectProjectContext(discovery, classification, [], runtime.db, run.project_id, "planner");
  const plannerFile = path.join(taskDirectory, "planner-task.md");
  fs.writeFileSync(plannerFile, buildPrompt({ role: "planner", stage: "planning", intent: message, classification, quality: classification.quality_mode, plan, document: JSON.stringify(boundedDocuments(selected)), constraints: ["use registered context only", "do not edit files", "return a bounded structured package"], format: "JSON plan contract" }), "utf8");
  const response = saveAssistant(formatClassification({ summary: classification.reason, quality: classification.quality_mode, nextStep: "подготовить проверяемый план выполнения" }));
  return finish({ route: "work", classification, plan, response, gateway: { mode: execute ? "planned" : "dry-run", steps: [
    { role: "planner", profile: definition.roles?.planner?.profile ?? null, task_file: plannerFile },
    { role: "worker", profile: definition.roles?.worker?.profile ?? null, condition: "after valid plan" },
    { role: "project-gate", runner: "workflow-platform", condition: "after worker" },
    { role: "reviewer", profile: definition.roles?.reviewer?.profile ?? null, condition: "only after green gate/lints" },
    { role: "documentator", profile: definition.roles?.documentator?.profile ?? null, condition: "when required" }
  ] } });
}
