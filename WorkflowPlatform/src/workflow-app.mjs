import fs from "node:fs";
import path from "node:path";
import { Runtime, recordLint } from "./runtime.mjs";
import { classificationCatalog, classificationJsonSchema, classifierPrompt, parseClassificationReceipt, resolveWorkflowRoute, validateClassificationDecision } from "./classifier.mjs";
import { buildPrompt } from "./prompt-builder.mjs";
import { callGateway } from "./gateway.mjs";
import { workflowLint } from "./lint.mjs";
import { compactProjectSnapshot, conversationContext, readProjectContext, selectProjectContext } from "./document-context.mjs";
import { formatClassification, formatQuestions, workflowMessage } from "./response-formatter.mjs";
import { languageName, resolveResponseLanguage } from "./language.mjs";
import { id, now } from "./db.mjs";
import { appendEvent } from "./state-machine.mjs";
import { resolveWorkflowSettings } from "./paths.mjs";
import { continueApprovedRun, executeStructuredWork, pausedRunObjective } from "./work-executor.mjs";
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

function researchPrompt({ message, project, discovery, responseLanguage }) {
  return [
    "WORKFLOW RESEARCH REQUEST v2",
    "Answer the current question from only the registered readable documents below. Do not edit files, invoke other agents, or invent facts.",
    `Return a concise human-readable answer in ${languageName(responseLanguage)} without internal IDs, profiles, levels, prompts or JSON.`,
    `PROJECT:${project.name}`,
    `REGISTERED_CONTEXT:${JSON.stringify(boundedDocuments(discovery))}`,
    `CURRENT_USER_MESSAGE:${JSON.stringify(message)}`
  ].join("\n");
}

function recordClassificationFailure(runtime, runId, error) {
  const taskId = runtime.get(runId).task_id;
  const message = String(error.message).replace(/[\r\n\t]+/g, " ").trim();
  const [head, ...tail] = message.split(":");
  const payload = { category: head.slice(0, 120), detail: tail.join(":").trim().slice(0, 500) || null };
  runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,'classification','INVALID','classifier',?,1,?)")
    .run(id("decision"), taskId, runId, JSON.stringify(payload), now());
  appendEvent(runtime.db, { entityType: "workflow_run", entityId: runId, kind: "contract_error", payload });
  return payload;
}

function executionMessage(execution, responseLanguage) {
  return execution.status === "completed"
    ? execution.reviewer ? workflowMessage("completedReviewed", responseLanguage) : workflowMessage("completed", responseLanguage)
    : execution.status === "rejected" ? workflowMessage("rejected", responseLanguage)
      : execution.status === "changes_requested" ? workflowMessage("changesRequested", responseLanguage)
        : execution.status === "approval_required" ? formatQuestions({ summary: responseLanguage === "ru" ? "Следующий шаг требует отдельного решения владельца." : "The next step requires a separate owner decision.", questions: execution.questions, nextStep: responseLanguage === "ru" ? "продолжить выбранный маршрут" : "continue with the selected workflow", language: responseLanguage })
          : execution.status === "clarification_required" ? formatQuestions({ summary: responseLanguage === "ru" ? "План требует уточнения." : "The plan needs clarification.", questions: execution.questions, nextStep: responseLanguage === "ru" ? "продолжить исполнение" : "continue execution", language: responseLanguage })
            : workflowMessage("controlledStop", responseLanguage);
}

function classificationFailure(runtime, runId, error, finish, responseLanguage = "en") {
  const failure = recordClassificationFailure(runtime, runId, error);
  if (runtime.get(runId).state !== "classification_failed") runtime.setState(runId, "classification_failed", { reason: "classifier contract rejected" });
  // Naming the category matters more here than anywhere else: the run is over, the call is paid for, and
  // a message that blames the request or the project settings sends the person to look where the fault
  // is not. The category is already recorded; it belongs in the answer too.
  const category = failure.category;
  const diagnostic = failure.detail ? `${category}: ${failure.detail}` : category;
  return finish({ route: "classification_failed", response: `${workflowMessage("classificationFailed", responseLanguage)} (${diagnostic})`, error: category });
}

function executionFailure(runtime, runId, error, finish, responseLanguage = "en") {
  const category = String(error.message).split(":")[0].slice(0, 120);
  appendEvent(runtime.db, { entityType: "workflow_run", entityId: runId, kind: "execution_error", payload: { category } });
  runtime.setState(runId, "failed", { reason: category });
  return finish({ route: "failed", response: workflowMessage("executionFailed", responseLanguage), error: category });
}

export async function processMessage({
  message, project, dbFile, workflow, workflowDefinition, execute = false, eventSource = "user", eventKey = null, eventFields = [],
  classificationResult = null, gatewayCall = callGateway, gateRunner = undefined, preferredLanguage = null, client = "codex"
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
  const accepted = runtime.accept(message, { project_id: project, workflow_id: workflow, client, event_source: eventSource, event_key: eventKey, event_fields: eventFields });
  const runId = accepted.runId;
  const run = runtime.get(runId);
  let responseLanguage = resolveResponseLanguage({ message, preferredLanguage: preferredLanguage ?? settings.responseLanguage });
  const taskDirectory = path.join(settings.tempRoot, projectSlug, runId);
  const finish = value => {
    runtime.db.close();
    fs.rmSync(taskDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return { run_id: runId, response_language: responseLanguage, ...value };
  };
  if (accepted.duplicate) {
    responseLanguage = run.response_language ?? responseLanguage;
    const saved = runtime.db.prepare("SELECT content FROM conversation_messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 1").get(runId)?.content ?? workflowMessage("duplicate", responseLanguage);
    runtime.db.close();
    return { run_id: runId, response_language: responseLanguage, route: "duplicate", duplicate: true, response: saved };
  }

  const workflowRow = runtime.db.prepare("SELECT * FROM workflows WHERE id=? AND project_id=? AND status='active'").get(workflow, run.project_id);
  if (!workflowRow) return classificationFailure(runtime, runId, new Error(`DISCOVERY_WORKFLOW_NOT_REGISTERED: ${workflow}`), finish, responseLanguage);
  definition ??= registryDefinition(runtime.db, run.project_id, workflow);
  const historyContext = conversationContext(runtime.db, run.project_id, workflowRow.history_budget_bytes);
  responseLanguage = resolveResponseLanguage({ message, preferredLanguage: preferredLanguage ?? settings.responseLanguage, history: historyContext.history });
  runtime.db.prepare("UPDATE workflow_runs SET response_language=?,updated_at=? WHERE id=?").run(responseLanguage, now(), runId);
  const discovery = readProjectContext(project, runtime.db);
  const catalog = classificationCatalog(runtime.db, run.project_id);
  runtime.db.prepare("INSERT INTO conversation_messages(id,project_id,run_id,role,content,created_at,language) VALUES(?,?,?,'user',?,?,?)")
    .run(`${runId}:user`, run.project_id, runId, String(message), now(), responseLanguage);
  const saveAssistant = response => {
    runtime.db.prepare("INSERT INTO conversation_messages(id,project_id,run_id,role,content,created_at,language) VALUES(?,?,?,'assistant',?,?,?)")
      .run(`${runId}:assistant`, run.project_id, runId, response, now(), responseLanguage);
    return response;
  };
  fs.mkdirSync(taskDirectory, { recursive: true });
  const classifierTaskFile = path.join(taskDirectory, "classifier-task.md");
  const classifierSchemaFile = path.join(taskDirectory, "classifier-output.schema.json");
  fs.writeFileSync(classifierTaskFile, classifierPrompt({ message, catalog, projectSnapshot: compactProjectSnapshot(discovery), acceptedDecisions: historyContext.accepted_decisions, history: historyContext.history, responseLanguage }), "utf8");
  fs.writeFileSync(classifierSchemaFile, `${JSON.stringify(classificationJsonSchema(catalog), null, 2)}\n`, "utf8");
  runtime.setState(runId, "classifying", { reason: "deterministic discovery complete" });

  let classifierReceipt = null;
  let classification;
  try {
    if (classificationResult) classification = validateClassificationDecision(classificationResult, catalog);
    else {
      if (!execute) throw new Error("CLASSIFICATION_EXECUTION_REQUIRED: supply a validated contract result for dry-run tests");
      const role = definition.roles?.classifier;
      if (!role?.provider || !role.profile || !role.role) throw new Error("CLASSIFIER_ROLE_NOT_CONFIGURED");
      classifierReceipt = await gatewayCall({ provider: role.provider, profile: role.profile, level: "prototype", role: role.role, taskFile: classifierTaskFile, outputSchemaFile: classifierSchemaFile, project: projectRoot, taskId: `${runId}:classifier`, workflowRunId: runId });
      runtime.linkGateway(runId, classifierReceipt);
      classification = parseClassificationReceipt(classifierReceipt, catalog);
    }
    if (classification.reply_mode === "work") {
      const routedWorkflow = resolveWorkflowRoute(catalog, classification.work_type);
      if (routedWorkflow !== workflow) {
        runtime.db.prepare("UPDATE workflow_runs SET workflow_id=?,updated_at=? WHERE id=?").run(routedWorkflow, now(), runId);
        workflow = routedWorkflow;
      }
    }
    runtime.classify(runId, classification);
    initializeQualityRun(runtime, runId, classification, classifierReceipt);
  } catch (error) {
    return classificationFailure(runtime, runId, error, finish, responseLanguage);
  }

  // An owner decision is not a clarification: it authorizes an action that has not happened yet. The run
  // that asked holds the objective and the plan, and the confirming message classifies as a conversation,
  // so a yes continues that run instead of starting a new one. A refusal ends it. Anything else — doubt,
  // a question back, a condition — leaves the decision open and answers the person, because reading
  // hesitation as consent would take the action they were still deciding about.
  const ownerDecision = classification.pending_interaction_response && classification.pending_interaction_response !== "undecided"
    ? runtime.db.prepare("SELECT id,run_id FROM approvals WHERE id=? AND status='pending'").get(classification.pending_interaction_id)
    : null;
  if (ownerDecision) {
    const receipts = classifierReceipt ? { mode: "executed", receipts: [{ step: "classifier", receipt: classifierReceipt }] } : { mode: "contract-test" };
    if (classification.pending_interaction_response === "decline") {
      runtime.db.prepare("UPDATE approvals SET status='rejected',resolved_at=? WHERE id=?").run(now(), ownerDecision.id);
      runtime.setState(ownerDecision.run_id, "cancelled", { reason: "owner declined the requested action" });
      runtime.setState(runId, "completed", { reason: "owner decision recorded" });
      const response = saveAssistant(workflowMessage("approvalDeclined", responseLanguage));
      return finish({ route: "owner_decision", classification, response, gateway: receipts });
    }
    runtime.db.prepare("UPDATE approvals SET status='approved',resolved_at=? WHERE id=?").run(now(), ownerDecision.id);
    // Where the decision sits decides how the run continues. A decision before the work re-enters the run
    // from its objective, because nothing has been done yet. A decision after the work must not: doing so
    // would repeat, and pay for again, every step already completed. That run resumes from its recorded
    // plan, gate and review, and only the phases the decision was blocking still run.
    const worked = runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND state='completed' AND result_schema_key='worker.v1'").get(ownerDecision.run_id).count;
    runtime.setState(runId, "completed", { reason: "owner approval delivered to the waiting run" });
    try {
      const paused = worked ? null : pausedRunObjective(runtime.db, ownerDecision.run_id);
      const execution = worked
        ? await continueApprovedRun({ runtime, runId: ownerDecision.run_id, discovery, responseLanguage, taskRoot: taskDirectory, gatewayCall })
        : await executeStructuredWork({ runtime, runId: ownerDecision.run_id, classification: paused.classification, definition, discovery, message: paused.message, responseLanguage, taskRoot: taskDirectory, gatewayCall, approvalGranted: true, ...(gateRunner ? { gateRunner } : {}) });
      const response = saveAssistant(executionMessage(execution, responseLanguage));
      return finish({ route: "work", classification, response, execution, gateway: receipts });
    } catch (error) {
      const response = saveAssistant(workflowMessage("contractRejected", responseLanguage));
      return finish({ route: "execution_failed", classification, response, execution: { status: runtime.get(ownerDecision.run_id).state, error: String(error.message).split(":")[0].slice(0, 120) } });
    }
  }

  if (classification.needs_questions) {
    const taskId = runtime.get(runId).task_id;
    for (const question of classification.questions) runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'clarification',?,'pending',?)")
      .run(id("approval"), taskId, runId, question, now());
    runtime.setState(runId, "clarification_required", { reason: "classifier requested missing information" });
    const response = saveAssistant(formatQuestions({ summary: classification.reason, questions: classification.questions, nextStep: responseLanguage === "ru" ? "продолжить по выбранному маршруту" : "continue with the selected workflow", language: responseLanguage }));
    return finish({ route: "clarification", classification, response, gateway: classifierReceipt ? { mode: "executed", receipts: [{ step: "classifier", receipt: classifierReceipt }] } : { mode: "contract-test" } });
  }

  if (classification.reply_mode === "conversation") {
    runtime.setState(runId, "completed", { reason: "conversation response delivered" });
    const response = saveAssistant(classification.human_response?.trim() || classification.reason);
    return finish({ route: "conversation", classification, response, gateway: classifierReceipt ? { mode: "executed", receipts: [{ step: "classifier", receipt: classifierReceipt }] } : { mode: "contract-test" } });
  }

  if (classification.reply_mode === "research") {
    const selected = selectProjectContext(discovery, classification, [], runtime.db, run.project_id, "researcher");
    if (!execute) return finish({ route: "research", classification, response: formatClassification({ summary: classification.reason, nextStep: responseLanguage === "ru" ? "выполнить ограниченное исследование по зарегистрированным источникам" : "run bounded research over the registered sources", language: responseLanguage }), gateway: { mode: "dry-run", steps: [{ role: "researcher", readable_documents: selected.documents.map(item => item.path) }] } });
    runtime.setState(runId, "executing", { reason: "research route authorized" });
    const researchFile = path.join(taskDirectory, "research-task.md");
    fs.writeFileSync(researchFile, researchPrompt({ message, project: discovery.project, discovery: selected, responseLanguage }), "utf8");
    const role = definition.roles?.researcher;
    if (!role?.provider || !role.profile || !role.role) return executionFailure(runtime, runId, new Error("RESEARCHER_ROLE_NOT_CONFIGURED"), finish, responseLanguage);
    let researcher;
    try {
      reserveDirectModelCall(runtime, runId, "researcher");
      researcher = await gatewayCall({ provider: role.provider, profile: role.profile, level: operationalLevel(classification.quality_mode), role: role.role, taskFile: researchFile, project: projectRoot, taskId: `${runId}:researcher`, workflowRunId: runId });
      chargeDirectReceipt(runtime, runId, researcher, "researcher");
    }
    catch (error) { return executionFailure(runtime, runId, error, finish, responseLanguage); }
    runtime.linkGateway(runId, researcher);
    runtime.setState(runId, "verifying", { reason: "research response received" });
    runtime.setState(runId, "completed", { reason: "research response delivered" });
    const response = saveAssistant(extractModelText(researcher.output));
    return finish({ route: "research", classification, response, gateway: { mode: "executed", receipts: [{ step: "classifier", receipt: classifierReceipt }, { step: "researcher", receipt: researcher }] } });
  }

  if (execute) {
    try {
      const execution = await executeStructuredWork({ runtime, runId, classification, definition, discovery, message, responseLanguage, taskRoot: taskDirectory, gatewayCall, ...(gateRunner ? { gateRunner } : {}) });
      const response = executionMessage(execution, responseLanguage);
      saveAssistant(response);
      return finish({ route: "work", classification, response, execution });
    } catch (error) {
      const category = String(error.message).split(":")[0].slice(0, 120);
      // A run that failed on its way into execution has to end. Where the failure already put the run
      // somewhere meaningful — waiting for a person, scheduled to retry, blocked — that state is the
      // truth and is left alone; anywhere else the run is finished as failed, because a run reported as
      // rejected while it sits in a live state is a run nothing will ever pick up or clean away.
      const settled = new Set(["failed", "blocked", "cancelled", "rejected", "completed", "documented", "approval_required", "clarification_required", "retry_scheduled", "paused"]);
      if (!settled.has(runtime.get(runId).state)) {
        try { runtime.setState(runId, "failed", { reason: category }); } catch { /* the original failure is what matters */ }
      }
      const state = runtime.get(runId).state;
      const response = `${workflowMessage("contractRejected", responseLanguage)} (${category})`;
      saveAssistant(response);
      return finish({ route: "execution_failed", classification, response, execution: { status: state, error: category } });
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
  fs.writeFileSync(plannerFile, buildPrompt({ role: "planner", stage: "planning", intent: message, classification, quality: classification.quality_mode, plan, document: JSON.stringify(boundedDocuments(selected)), constraints: ["use registered context only", "do not edit files", "return a bounded structured package"], format: "JSON plan contract", responseLanguage }), "utf8");
  const response = saveAssistant(formatClassification({ summary: classification.reason, quality: classification.quality_mode, nextStep: responseLanguage === "ru" ? "подготовить проверяемый план выполнения" : "prepare a verifiable execution plan", language: responseLanguage }));
  return finish({ route: "work", classification, plan, response, gateway: { mode: execute ? "planned" : "dry-run", steps: [
    { role: "planner", profile: definition.roles?.planner?.profile ?? null, task_file: plannerFile },
    { role: "worker", profile: definition.roles?.worker?.profile ?? null, condition: "after valid plan" },
    { role: "project-gate", runner: "workflow-platform", condition: "after worker" },
    { role: "reviewer", profile: definition.roles?.reviewer?.profile ?? null, condition: "only after green gate/lints" },
    { role: "documentator", profile: definition.roles?.documentator?.profile ?? null, condition: "when required" }
  ] } });
}
