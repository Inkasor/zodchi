import fs from "node:fs";
import path from "node:path";
import { utf8Prefix } from "./utf8.mjs";
import { Runtime, recordLint } from "./runtime.mjs";
import { ExecutionQueue } from "./execution-queue.mjs";
import { RUN_PROFILE_CONFIRMATION_KIND, classificationCatalog, classificationJsonSchema, classifierPrompt, parseClassificationReceipt, resolveWorkflowRoute, validateClassificationDecision } from "./classifier.mjs";
import { buildPrompt } from "./prompt-builder.mjs";
import { callGateway } from "./gateway.mjs";
import { workflowLint } from "./lint.mjs";
import { classifierStateContext, compactProjectSnapshot, readProjectContext, selectProjectContext } from "./document-context.mjs";
import { formatClassification, formatQuestions, workflowMessage } from "./response-formatter.mjs";
import { languageName, resolveResponseLanguage } from "./language.mjs";
import { id, now } from "./db.mjs";
import { appendEvent } from "./state-machine.mjs";
import { CLARIFICATION_KINDS, EXTERNAL_EVIDENCE_KIND, cancelInteraction, deliverEvidence, expireInteractions, openClarification, readInteraction } from "./interactions.mjs";
import { resolveWorkflowSettings } from "./paths.mjs";
import { bindProject, bindingEvidence } from "./project-binding.mjs";
import { inside } from "./project-roots.mjs";
import { parseRootedPath } from "./source-context.mjs";
import { recordRunEvidence } from "./run-evidence.mjs";
import { continueApprovedRun, continueExternalOperationResult, executeStructuredWork, pausedRunObjective, resumeObjective } from "./work-executor.mjs";
import { chargeDirectReceipt, effectiveQualityMode, initializeQualityRun, operationalLevel, ownerQualityFloor, reserveDirectModelCall } from "./quality-contracts.mjs";
import { approveBoundInteraction, assertApprovalStillCurrent } from "./approval-binding.mjs";
import { acceptExternalControlEvidenceResult, acceptExternalControlResult, validateExternalOperationResultForRequest } from "./external-control-plane.mjs";
import { normalizeRunProfile, resolveRunProfile, storeRunProfile } from "./run-profile.mjs";
import { assertProjectRuntimeReady, assertWorkflowRuntimeReady } from "./runtime-readiness.mjs";
import { normalizeSemanticScope } from "./semantic-scope.mjs";
import { collectSourceFiles, expandTerms, isSourceCodePath, RESEARCH_SOURCE_RANKING, researchSourceRankingOptions, searchSources, sourceScope } from "./source-context.mjs";
import { executorCapabilityRequirementsForProject } from "./executor-capabilities.mjs";
import { reconcileRoleToolUsage } from "./tool-usage.mjs";

export function loadWorkflow(id, workflowsRoot = resolveWorkflowSettings().workflowsRoot) {
  if (!id) throw new Error("workflow id is required");
  return JSON.parse(fs.readFileSync(path.join(workflowsRoot, `${id}.json`), "utf8"));
}

function registryDefinition(db, projectId, workflowId) {
  const roles = {};
  for (const row of db.prepare(`SELECT rpa.role_id,p.provider,p.name,rpa.operational_level,
      rc.id AS contract_id,rc.context_limit_bytes,rc.result_schema_key,rc.boundaries_json,rc.allowed_tools_json,rc.allowed_skills_json,rc.allowed_mcp_servers_json,rc.native_instruction_files_json
    FROM role_profile_assignments rpa JOIN profiles p ON p.id=rpa.profile_id
    JOIN role_contracts rc ON rc.project_id=rpa.project_id AND rc.role_id=rpa.role_id AND rc.status='active'
    WHERE rpa.project_id=? AND rpa.enabled=1 AND rpa.role_id IN ('classifier','researcher')
    ORDER BY rpa.role_id,CASE rpa.operational_level WHEN 'prototype' THEN 0 WHEN 'mvp' THEN 1 ELSE 2 END`).all(projectId)) {
    if (!roles[row.role_id]) roles[row.role_id] = {
      provider: row.provider, profile: row.name, role: row.role_id,
      contract: {
        id: row.contract_id,
        context_limit_bytes: row.context_limit_bytes,
        result_schema_key: row.result_schema_key,
        boundaries: parsedJson(row.boundaries_json) ?? {},
        allowed_tools: parsedJson(row.allowed_tools_json) ?? [],
        allowed_skills: parsedJson(row.allowed_skills_json) ?? [],
        allowed_mcp_servers: parsedJson(row.allowed_mcp_servers_json) ?? [],
        native_instruction_files: parsedJson(row.native_instruction_files_json) ?? []
      }
    };
  }
  return { id: workflowId, authority: "registered portable package and project documents", roles, gates: [] };
}

function parsedJson(text) { try { return JSON.parse(String(text).trim()); } catch { return null; } }
function reconcileAndLinkDirectReceipt(runtime, runId, receipt, contract) {
  let mismatch = null;
  try { reconcileRoleToolUsage(receipt, contract); } catch (error) { mismatch = error; }
  runtime.linkGateway(runId, receipt);
  if (mismatch) throw mismatch;
}
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

// The direct-research envelope is 64 KiB by default. Reserve 12 KiB for controlled documents,
// 8 KiB for the path inventory and 32 KiB for selected source excerpts, leaving the rest for the
// objective, contract, schema and result instructions. These are packet partitions, not model limits.
const RESEARCH_CONTEXT_BUDGETS = Object.freeze({ documents_bytes: 12_000, inventory_bytes: 8_000, source_bytes: 32_000 });
// The legacy prepare-only planner receives document text in one field; cap that field at half of the
// standard 64 KiB role envelope so the plan, constraints and output contract retain equal room.
const PLANNER_DOCUMENT_CONTEXT_BYTES = 32 * 1024;

function boundedDocuments(discovery, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("RESEARCH_DOCUMENT_BUDGET_REQUIRED");
  const result = [];
  let used = 0;
  for (const document of discovery.documents) {
    const remaining = maxBytes - used;
    if (remaining <= 0) break;
    const text = utf8Prefix(document.text, remaining);
    result.push({ path: document.path, authority: document.authority, text });
    used += Buffer.byteLength(text);
  }
  return result;
}

function boundedResearchInventory(discovery, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("RESEARCH_INVENTORY_BUDGET_REQUIRED");
  const roots = (discovery.roots ?? []).map(root => ({ key: root.key, path: root.path, access: "read", primary: root.primary }));
  const files = [];
  let used = Buffer.byteLength(JSON.stringify(roots));
  for (const source of discovery.sources ?? []) for (const file of source.files ?? []) {
    const item = { path: file.path, bytes: file.bytes };
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (used + bytes > maxBytes) return { roots, files, truncated: true };
    files.push(item); used += bytes;
  }
  return { roots, files, truncated: (discovery.sources ?? []).some(source => source.truncated) };
}

// These disciplines can make implementation claims over source-bearing project scopes. A controlled
// document may explain the implementation, but it cannot by itself prove the current code, data
// pipeline, game, infrastructure, test, security or technical-art behavior.
const SOURCE_RESEARCH_DISCIPLINES = new Set([
  "software", "one-c-development", "data_engineering", "game_design",
  "devops", "technical_art", "testing", "security"
]);
function requiresSourceEvidence(classification) { return SOURCE_RESEARCH_DISCIPLINES.has(classification?.discipline); }

function researchSourceContext(discovery, objective, { sourceBytes = RESEARCH_CONTEXT_BUDGETS.source_bytes, maxFiles = RESEARCH_SOURCE_RANKING.selected_files, sourceRequired = false } = {}) {
  const scope = sourceScope(discovery.source_scope);
  const ranking = researchSourceRankingOptions(maxFiles);
  const expanded = expandTerms(discovery.roots ?? [], scope, objective, ranking.expansion);
  const locatorTerms = [...new Set([...expanded.terms, ...expanded.subject])];
  const located = searchSources(discovery.roots ?? [], scope, locatorTerms, {
    ...ranking.search, indexedTerms: expanded.code,
    sourceCodeOnly: sourceRequired, preferSourceCode: sourceRequired
  });
  let selectedPaths = located.files.slice(0, maxFiles).map(file => file.path);
  let strategy = selectedPaths.length ? (sourceRequired ? "ranked_source_matches" : "ranked_objective_matches") : "no_relevant_match";
  const inventoryFiles = (discovery.sources ?? []).flatMap(source => source.files ?? []);
  const eligibleInventoryFiles = sourceRequired ? inventoryFiles.filter(file => isSourceCodePath(file.path)) : inventoryFiles;
  const completeSmallCorpus = (discovery.sources ?? []).every(source => source.enumeration_complete && !source.truncated) && eligibleInventoryFiles.length > 0 && eligibleInventoryFiles.length <= maxFiles;
  if (!selectedPaths.length && completeSmallCorpus) {
    selectedPaths = eligibleInventoryFiles.map(file => file.path);
    strategy = sourceRequired ? "complete_small_source_corpus" : "complete_small_corpus";
  }
  const collected = collectSourceFiles(discovery.roots ?? [], selectedPaths, scope, sourceBytes, { query: objective });
  const files = collected.files;
  const suppliedPaths = files.filter(file => file.status === "read").map(file => file.path);
  return {
    supplied_paths: suppliedPaths,
    files,
    bytes: collected.bytes,
    budget_bytes: collected.budget_bytes,
    selection: {
      strategy,
      source_required: sourceRequired,
      request_terms: expanded.subject,
      discovered_identifiers: expanded.harvested,
      explicit_identifiers: expanded.code,
      searched_files: located.searched_files,
      search_truncated: located.truncated,
      selected_paths: selectedPaths,
      supplied_paths: suppliedPaths,
      source_excerpts_truncated: files.some(file => file.status === "read" && file.truncated),
      inventory_complete: (discovery.sources ?? []).every(source => source.enumeration_complete && !source.truncated)
    }
  };
}

function researchContext(discovery, objective, classification) {
  const documents = boundedDocuments(discovery, RESEARCH_CONTEXT_BUDGETS.documents_bytes);
  const sourceRequired = requiresSourceEvidence(classification);
  const sources = researchSourceContext(discovery, objective, { sourceRequired });
  const readableDocuments = new Set((discovery.documents ?? []).filter(document => document.exists && document.text).map(document => document.path));
  const documentPaths = documents.filter(document => readableDocuments.has(document.path) && document.text).map(document => document.path);
  return {
    documents,
    inventory: boundedResearchInventory(discovery, RESEARCH_CONTEXT_BUDGETS.inventory_bytes),
    sources,
    document_paths: documentPaths,
    source_paths: sources.supplied_paths,
    source_required: sourceRequired,
    supplied_paths: [...new Set([...documentPaths, ...sources.supplied_paths])]
  };
}

function researchJsonSchema() {
  return {
    type: "object", additionalProperties: false,
    properties: {
      schema_version: { type: "integer", const: 1 },
      status: { type: "string", enum: ["answered", "insufficient"] },
      answer: { type: "string", minLength: 1, maxLength: 20_000 },
      inspected_paths: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 512 } },
      limitations: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1_000 } }
    },
    required: ["schema_version", "status", "answer", "inspected_paths", "limitations"]
  };
}

function assertGatewayReceiptCompleted(receipt, role) {
  const exitCode = receipt?.exitCode ?? receipt?.exit_code ?? null;
  if (receipt?.status === "completed" && (exitCode === null || Number(exitCode) === 0)) return;
  const failure = receipt?.failureCategory ?? receipt?.failure_category ?? (receipt?.status === "timed_out" ? "timeout" : null);
  const suffix = failure === "provider_exit" ? "PROVIDER_EXIT"
    : failure === "timeout" ? "TIMEOUT"
      : failure === "adapter_configuration" ? "ADAPTER_CONFIGURATION"
        : "GATEWAY_FAILED";
  throw new Error(`${String(role).toUpperCase()}_${suffix}`);
}

function validateResearchResult(receipt, discovery, { suppliedPaths = [], sourcePaths = [], sourceRequired = false } = {}) {
  const raw = extractModelText(receipt.output);
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("RESEARCH_RESULT_INVALID_JSON"); }
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const expected = ["answer", "inspected_paths", "limitations", "schema_version", "status"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected) || value.schema_version !== 1 || !["answered", "insufficient"].includes(value.status)) throw new Error("RESEARCH_RESULT_SCHEMA_INVALID");
  if (typeof value.answer !== "string" || !value.answer.trim() || value.answer.length > 20_000) throw new Error("RESEARCH_RESULT_ANSWER_INVALID");
  if (!Array.isArray(value.inspected_paths) || value.inspected_paths.length > 40 || !Array.isArray(value.limitations) || value.limitations.length > 20) throw new Error("RESEARCH_RESULT_SCHEMA_INVALID");
  const allowed = new Set((suppliedPaths ?? []).map(file => file.replaceAll("\\", "/")));
  const inspected = [];
  for (const supplied of value.inspected_paths) {
    const normalized = String(supplied).replaceAll("\\", "/").replace(/^\.\//, "");
    if (!allowed.has(normalized)) throw new Error(`RESEARCH_PATH_NOT_SUPPLIED: ${normalized}`);
    const parsed = parseRootedPath(discovery.roots ?? [], normalized);
    const target = path.resolve(parsed.root.path, parsed.relative);
    const realRoot = fs.realpathSync(parsed.root.path), realTarget = fs.realpathSync(target);
    if (!inside(realRoot, realTarget) || !fs.statSync(realTarget).isFile()) throw new Error(`RESEARCH_PATH_INVALID: ${normalized}`);
    inspected.push(normalized);
  }
  if (new Set(inspected).size !== inspected.length) throw new Error("RESEARCH_PATH_DUPLICATE");
  if (value.status === "answered" && inspected.length === 0) throw new Error("RESEARCH_ANSWER_WITHOUT_INSPECTED_SOURCE");
  const suppliedSources = new Set(sourcePaths.map(file => file.replaceAll("\\", "/")));
  if (value.status === "answered" && sourceRequired && !inspected.some(file => suppliedSources.has(file))) throw new Error("RESEARCH_SOURCE_EVIDENCE_REQUIRED");
  if (value.limitations.some(item => typeof item !== "string" || !item.trim() || item.length > 1_000)) throw new Error("RESEARCH_LIMITATION_INVALID");
  return Object.freeze({ schema_version: 1, status: value.status, answer: value.answer.trim(), inspected_paths: inspected, limitations: value.limitations.map(item => item.trim()) });
}

function researchPrompt({ message, resolvedObjective, project, context, responseLanguage }) {
  return [
    "WORKFLOW RESEARCH REQUEST v4",
    "Answer RESOLVED_OBJECTIVE from the bounded source evidence supplied by WorkflowPlatform. It is the authoritative standalone task; VERBATIM_CURRENT_USER_MESSAGE is provenance only and must not narrow or override it.",
    "REGISTERED_DOCUMENT_CONTEXT contains authoritative project rules and reference material. REGISTERED_SOURCE_EVIDENCE contains deterministically selected source excerpts and exact-term evidence. REGISTERED_PROJECT_CORPUS is inventory and completeness metadata only, not proof that you inspected every listed file.",
    "Do not run commands or read files directly. Do not edit files, invoke other agents, access credentials or dumps, or invent facts. Treat only REGISTERED_DOCUMENT_CONTEXT and files with status=read in REGISTERED_SOURCE_EVIDENCE as inspected content.",
    `For status=answered, rely on at least one supplied relevant file and list every file relied on in inspected_paths using its exact project-relative path. ${context.source_required ? "This is a source-code research request: at least one inspected path must come from REGISTERED_SOURCE_EVIDENCE; documents alone cannot support status=answered." : "A supplied document or source file may support the answer."} Never cite an inventory-only path. If the supplied excerpts are irrelevant, truncated at a required boundary, or otherwise cannot support the answer, return status=insufficient and explain the precise limitation.`,
    `Return JSON matching the supplied schema. Put the concise human-readable answer in ${languageName(responseLanguage)} in answer; do not mention internal IDs, profiles, levels, or prompts.`,
    `PROJECT:${project.name}`,
    `REGISTERED_DOCUMENT_CONTEXT:${JSON.stringify(context.documents)}`,
    `REGISTERED_SOURCE_EVIDENCE:${JSON.stringify(context.sources)}`,
    `REGISTERED_PROJECT_CORPUS:${JSON.stringify(context.inventory)}`,
    `RESOLVED_OBJECTIVE:${JSON.stringify(resolvedObjective)}`,
    `VERBATIM_CURRENT_USER_MESSAGE:${JSON.stringify(message)}`
  ].join("\n");
}

function plannerBindings(db, projectId, level, workType = null) {
  return db.prepare(`SELECT assignment.role_id AS role,p.provider,p.name AS profile,contract.allowed_work_types_json
    FROM role_profile_assignments assignment JOIN profiles p ON p.id=assignment.profile_id
    JOIN role_contracts contract ON contract.project_id=assignment.project_id AND contract.role_id=assignment.role_id AND contract.status='active'
    WHERE assignment.project_id=? AND assignment.enabled=1 AND assignment.role_id IN ('planner','coordinator')
      AND assignment.operational_level=?
    ORDER BY assignment.role_id,p.provider,p.name`).all(projectId, level)
    .filter(binding => {
      let allowed = []; try { allowed = JSON.parse(binding.allowed_work_types_json); } catch { return false; }
      return !workType || !allowed.length || allowed.includes("*") || allowed.includes(workType);
    }).map(({ allowed_work_types_json, ...binding }) => binding);
}

function profileLine(profile, language) {
  if (!profile) return null;
  const prefix = language === "ru" ? "Профиль выполнения" : "Execution profile";
  const warning = profile.warnings?.length
    ? ` ${language === "ru" ? "Ограничения" : "Constraints"}: ${profile.warnings.join("; ")}.`
    : "";
  return `${prefix}: Quality=${profile.quality_mode}; Execution=${profile.execution_mode}; Verification=${profile.verification_mode}; Planning=${profile.planning_mode}.${warning}`;
}

function runProfileAxes(profile = {}) {
  return Object.fromEntries(["quality_mode", "execution_mode", "verification_mode", "planning_mode"]
    .filter(axis => profile[axis] !== undefined).map(axis => [axis, profile[axis]]));
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
          : execution.status === "external_action_required" ? (responseLanguage === "ru" ? "Точная операция одобрена и передана зарегистрированному внешнему исполнителю. Продолжение — после подписанного результата и программной проверки." : "The exact operation was approved and dispatched to the registered external executor. The run continues after a signed result and deterministic verification.")
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
  const failure = structuredExecutionError(error);
  const category = failure.category;
  appendEvent(runtime.db, { entityType: "workflow_run", entityId: runId, kind: "execution_error", payload: { category, diagnostic: failure.diagnostic } });
  runtime.setState(runId, "failed", { reason: category });
  return finish({ route: "failed", response: `${workflowMessage("executionFailed", responseLanguage)} (${failure.diagnostic})`, error: category });
}

function structuredExecutionError(error) {
  const message = String(error?.message ?? error).replace(/[\r\n\t]+/g, " ").trim();
  const category = message.split(":")[0].slice(0, 120);
  const diagnostic = /^(?:(?:planner|worker|reviewer|judge|strategy_review|documentator|release_operation|access_change)\.v1(?:\.|:)|PROFILE_(?:CAPABILITY|CAPABILITIES)_[A-Z_]+:)/u.test(message)
    ? message.slice(0, 500)
    : category;
  return { category, diagnostic };
}

// Where the answer arrives decides how the run continues. A run that had not produced work yet re-enters
// from its objective, now carrying the answer. A run that already has completed worker results must not:
// doing so would repeat, and pay for again, every call already made. That run resumes from its recorded
// plan, gate and review, and only the phases the wait was blocking still run.
async function resumeWaitingRun({ runtime, waitingRunId, definition, discovery, responseLanguage, taskRoot, gatewayCall, gateRunner }) {
  const worked = runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND state='completed' AND result_schema_key IN ('worker.v1','release_operation.v1','access_change.v1')").get(waitingRunId).count;
  if (worked) {
    // Evidence that arrives after the work was done is checked, not re-executed; an answered question
    // resumes the execution it interrupted. Replanning needs neither, and enters planning on its own.
    const waiting = runtime.get(waitingRunId).state;
    if (waiting === "external_evidence_required") runtime.setState(waitingRunId, "verifying", { reason: "external evidence delivered after the work" });
    else if (waiting === "clarification_required") runtime.setState(waitingRunId, "executing", { reason: "clarification answered after the work" });
    return continueApprovedRun({ runtime, runId: waitingRunId, discovery, responseLanguage, taskRoot, gatewayCall });
  }
  // The steps the wait interrupted were planned against information the run did not have. Replanning
  // supersedes them, so they are abandoned rather than left in the queue: a step still waiting there
  // holds up every later phase, and one still runnable would execute the plan the answer replaced.
  const stale = runtime.db.prepare("SELECT id FROM workflow_steps WHERE run_id=? AND state IN ('pending','ready','blocked','retry_scheduled','changes_requested','approval_required')").all(waitingRunId).map(row => row.id);
  if (stale.length) {
    const abandoned = new ExecutionQueue(runtime.db).abandonSteps(waitingRunId, stale, { reason: "replanned after the wait was answered" });
    // A step the new plan replaced is no longer something the run owes: left marked required it would
    // block completion for ever, and the run would finish its work and still be unable to say so.
    for (const stepId of abandoned) runtime.db.prepare("UPDATE workflow_steps SET required=0 WHERE id=?").run(stepId);
  }
  const resumed = resumeObjective(runtime.db, waitingRunId);
  return executeStructuredWork({ runtime, runId: waitingRunId, classification: resumed.classification, definition, discovery, message: resumed.message, responseLanguage, taskRoot, gatewayCall, ...(gateRunner ? { gateRunner } : {}) });
}

// The owner's side of an external evidence request. The packet is checked against the contract the
// request declared before anything resumes: a packet from the wrong resource, without a stated origin or
// covering less than the claim needs leaves the request open, which is the whole point of asking for it.
export async function deliverExternalEvidencePacket({
  interactionId, packet, project, dbFile, workflow, workflowDefinition, execute = true,
  gatewayCall = callGateway, gateRunner = undefined, preferredLanguage = null
}) {
  const settings = resolveWorkflowSettings();
  project ??= settings.project;
  dbFile ??= settings.databasePath;
  const runtime = new Runtime(dbFile);
  try {
    const registeredProject = runtime.db.prepare("SELECT id,root_path FROM projects WHERE id=? OR lower(root_path)=lower(?) LIMIT 1").get(project, path.resolve(project));
    if (!registeredProject) throw new Error(`PROJECT_NOT_REGISTERED: ${project}`);
    const interaction = readInteraction(runtime.db, interactionId);
    if (!interaction) throw new Error(`INTERACTION_NOT_FOUND: ${interactionId}`);
    const waitingRunId = interaction.run_id;
    // The named project and the interaction were checked separately and never against each other, so a
    // delivery naming one project settled another project's request, resumed its run and charged its
    // budget on the strength of being a registered project at all. The chain from the interaction to a
    // project is followed here and has to arrive at exactly the project the caller named.
    const waiting = runtime.db.prepare(`SELECT r.id,r.state,r.response_language,r.workflow_id,r.project_id,t.project_id AS task_project_id
      FROM workflow_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?`).get(waitingRunId);
    if (!waiting) throw new Error(`INTERACTION_RUN_MISSING: ${interactionId}`);
    if (waiting.project_id !== waiting.task_project_id) throw new Error(`INTERACTION_PROJECT_INCONSISTENT: ${interactionId}`);
    if (waiting.project_id !== registeredProject.id) throw new Error(`INTERACTION_PROJECT_MISMATCH: ${interactionId} belongs to ${waiting.project_id}, not ${registeredProject.id}`);
    const responseLanguage = preferredLanguage ?? waiting.response_language ?? settings.responseLanguage ?? "en";
    const delivered = deliverEvidence(runtime.db, interactionId, packet, { answeredRunId: waitingRunId });
    // Settling records that the answer arrived and was checked; continuing the run is a separate act that
    // can fail on its own. Reporting a second delivery as a duplicate and stopping there left a run whose
    // first resume failed waiting for evidence it already had, with no way left to deliver it. A repeat
    // delivery of an answered request continues the run from the answer already on record.
    if (!delivered.settled && !(delivered.status === "approved" && waiting.state === "external_evidence_required")) {
      return { interaction_id: interactionId, delivered: false, already: delivered.status, run_id: waitingRunId };
    }
    if (!execute) return { interaction_id: interactionId, delivered: true, run_id: waitingRunId, state: waiting.state };
    const definition = workflowDefinition ?? registryDefinition(runtime.db, registeredProject.id, workflow ?? waiting.workflow_id);
    const discovery = readProjectContext(registeredProject.id, runtime.db);
    const taskRoot = path.join(settings.tempRoot, path.basename(registeredProject.root_path).toLowerCase().replaceAll(" ", "-"), waitingRunId);
    try {
      const execution = await resumeWaitingRun({ runtime, waitingRunId, definition, discovery, responseLanguage, taskRoot, gatewayCall, gateRunner });
      return { interaction_id: interactionId, delivered: true, resumed: delivered.settled ? "delivered" : "retried", run_id: waitingRunId, response_language: responseLanguage, execution };
    } catch (error) {
      // The run stays where it was, holding an answered request, so the same delivery can be sent again.
      appendEvent(runtime.db, { entityType: "workflow_run", entityId: waitingRunId, kind: "external_evidence_resume_failed", payload: { interaction_id: interactionId, error: String(error?.message ?? error).slice(0, 200) } });
      throw error;
    } finally { fs.rmSync(taskRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  } finally { runtime.db.close(); }
}

export async function deliverExternalControlResult({
  packet, project, dbFile, workflow, workflowDefinition, execute = true,
  gatewayCall = callGateway, gateRunner = undefined, preferredLanguage = null
}) {
  const settings = resolveWorkflowSettings();
  project ??= settings.project;
  dbFile ??= settings.databasePath;
  const runtime = new Runtime(dbFile);
  try {
    const registeredProject = runtime.db.prepare("SELECT id,root_path FROM projects WHERE id=? OR lower(root_path)=lower(?) LIMIT 1").get(project, path.resolve(project));
    if (!registeredProject) throw new Error(`PROJECT_NOT_REGISTERED: ${project}`);
    if (packet?.project_id !== registeredProject.id) throw new Error(`EXTERNAL_CONTROL_PROJECT_MISMATCH: ${packet?.project_id ?? "missing"} != ${registeredProject.id}`);
    const request = runtime.db.prepare(`SELECT q.*,a.kind AS interaction_kind FROM external_control_requests q
      LEFT JOIN approvals a ON a.id=q.interaction_id WHERE q.id=?`).get(packet?.request_id);
    if (!request) throw new Error(`EXTERNAL_CONTROL_REQUEST_NOT_FOUND: ${packet?.request_id ?? "missing"}`);
    if (request.interaction_kind === EXTERNAL_EVIDENCE_KIND) {
      const accepted = acceptExternalControlEvidenceResult(runtime.db, packet);
      if (accepted.status !== "completed") return { control: accepted, evidence: null };
      const evidence = await deliverExternalEvidencePacket({
        interactionId: accepted.interaction_id, packet: accepted.payload.evidence_packet,
        project, dbFile, workflow, workflowDefinition, execute, gatewayCall, gateRunner, preferredLanguage
      });
      return { control: accepted, evidence };
    }
    const accepted = acceptExternalControlResult(runtime.db, packet, {
      validatePayload: request.interaction_kind === "workflow_approval" && packet?.status === "completed"
        ? payload => validateExternalOperationResultForRequest(runtime.db, request.id, payload)
        : null
    });
    if (request.interaction_kind !== "workflow_approval" || !execute) return { control: accepted, operation: null };
    const responseLanguage = preferredLanguage ?? runtime.get(request.run_id).response_language ?? settings.responseLanguage ?? "en";
    const discovery = readProjectContext(registeredProject.id, runtime.db);
    const taskRoot = path.join(settings.tempRoot, path.basename(registeredProject.root_path).toLowerCase().replaceAll(" ", "-"), request.run_id);
    try {
      const operation = await continueExternalOperationResult({ runtime, accepted, discovery, responseLanguage, taskRoot, gatewayCall, ...(gateRunner ? { gateRunner } : {}) });
      return { control: accepted, operation };
    } finally { fs.rmSync(taskRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  } finally { runtime.db.close(); }
}

// A directory belongs to the project registered closest above it: with a project registered inside
// another, the deeper root is the one that actually owns the file the message came from.
function registeredRoot(db, candidate) {
  const resolved = path.resolve(candidate);
  const containing = db.prepare("SELECT id,root_path FROM projects").all().filter(row => inside(row.root_path, resolved));
  if (!containing.length) return null;
  return containing.sort((a, b) => path.resolve(b.root_path).length - path.resolve(a.root_path).length)[0].id;
}

export async function processMessage({
  message, project, origin = null, dbFile, workflow, workflowDefinition, execute = false, eventSource = "user", eventKey = null, eventFields = [],
  classificationResult = null, gatewayCall = callGateway, gatewayProfileCheck = undefined, gateRunner = undefined, preferredLanguage = null, client = "codex", semanticScope, prepareOnly = false, runProfileOverrides = {}
}) {
  const resolvedSemanticScope = normalizeSemanticScope(semanticScope);
  const settings = resolveWorkflowSettings();
  dbFile ??= settings.databasePath;
  workflow ??= settings.workflow ?? workflowDefinition?.id;
  let definition = workflowDefinition ?? null;
  if (!definition && workflow) {
    try { definition = loadWorkflow(workflow, settings.workflowsRoot); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const runtime = new Runtime(dbFile);
  let binding;
  try { binding = bindProject({ settings, origin, project, registeredAt: candidate => registeredRoot(runtime.db, candidate) }); }
  catch (error) { runtime.db.close(); throw error; }
  project = binding.project;
  if (!project) { runtime.db.close(); throw new Error("PROJECT_REQUIRED: configure a project during onboarding or pass project explicitly"); }
  const projectSlug = path.basename(project).toLowerCase().replaceAll(" ", "-");
  const registeredProject = runtime.db.prepare("SELECT id,root_path FROM projects WHERE id=? OR lower(root_path)=lower(?) LIMIT 1").get(project, path.resolve(project));
  if (!registeredProject) { runtime.db.close(); throw new Error(`PROJECT_NOT_REGISTERED: ${project}`); }
  const projectRoot = registeredProject.root_path;
  project = registeredProject.id;
  workflow ??= definition?.id ?? runtime.db.prepare(`SELECT w.id FROM workflow_routes wr JOIN workflows w ON w.id=wr.workflow_id
    WHERE wr.project_id=? AND wr.enabled=1 AND w.status='active' ORDER BY wr.priority DESC,w.id LIMIT 1`).get(project)?.id;
  if (!workflow) { runtime.db.close(); throw new Error(`WORKFLOW_NOT_REGISTERED: ${project}`); }
  let registryBackedDefinition = false;
  if (!definition) {
    definition = registryDefinition(runtime.db, project, workflow);
    registryBackedDefinition = true;
  }
  // The classifier can choose bounded research for any message. A project whose researcher was omitted
  // by onboarding therefore is not partly ready: it can spend a classifier call and only then discover
  // that the selected route cannot run. Check both direct runtime roles before accepting a run or calling
  // a model. Explicit test/embedded definitions remain self-contained and are checked where invoked.
  if (execute && registryBackedDefinition && !classificationResult) {
    try { assertProjectRuntimeReady(runtime.db, project, gatewayProfileCheck ? { profileCheck: gatewayProfileCheck } : undefined); }
    catch (error) { runtime.db.close(); throw error; }
  }
  if (execute && !registryBackedDefinition && !classificationResult) {
    const missing = ["classifier", "researcher"].filter(roleId => {
      const role = definition.roles?.[roleId];
      return !role?.provider || !role.profile || !role.role;
    });
    if (missing.length) {
      runtime.db.close();
      throw new Error(`WORKFLOW_RUNTIME_NOT_READY: ${workflow}: missing ${missing.join(",")}`);
    }
  }
  if (!classificationResult && (!Number.isInteger(definition.roles?.classifier?.contract?.context_limit_bytes) || definition.roles.classifier.contract.context_limit_bytes < 1024)) {
    runtime.db.close();
    throw new Error(`WORKFLOW_RUNTIME_NOT_READY: ${workflow}: classifier contract context_limit_bytes is required`);
  }
  const accepted = runtime.accept(message, { project_id: project, workflow_id: workflow, client, chat_session: resolvedSemanticScope.mode === "session" ? resolvedSemanticScope : null, event_source: eventSource, event_key: eventKey, event_fields: eventFields, binding: bindingEvidence(binding, settings) });
  const runId = accepted.runId;
  const run = runtime.get(runId);
  let responseLanguage = resolveResponseLanguage({ message, preferredLanguage: preferredLanguage ?? settings.responseLanguage });
  const taskDirectory = path.join(settings.tempRoot, projectSlug, runId);
  let sessionProfileAction = null;
  const finish = value => {
    runtime.db.close();
    fs.rmSync(taskDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return { run_id: runId, response_language: responseLanguage, ...(sessionProfileAction ? { session_profile_action: sessionProfileAction } : {}), ...value };
  };
  if (accepted.duplicate) {
    responseLanguage = run.response_language ?? responseLanguage;
    const saved = runtime.db.prepare("SELECT content FROM conversation_messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 1").get(runId)?.content ?? workflowMessage("duplicate", responseLanguage);
    runtime.db.close();
    return { run_id: runId, response_language: responseLanguage, route: "duplicate", duplicate: true, response: saved };
  }

  const workflowRow = runtime.db.prepare("SELECT * FROM workflows WHERE id=? AND project_id=? AND status='active'").get(workflow, run.project_id);
  if (!workflowRow) return classificationFailure(runtime, runId, new Error(`DISCOVERY_WORKFLOW_NOT_REGISTERED: ${workflow}`), finish, responseLanguage);
  const classifierContextLimit = definition.roles?.classifier?.contract?.context_limit_bytes;
  // Expiry changes current truth, so apply it before projecting that truth for the classifier.
  expireInteractions(runtime.db, run.project_id);
  // A caller-supplied classification bypasses the classifier entirely. Normal intake receives one
  // current session snapshot bounded by the classifier contract; it never receives a trailing message
  // window. The preceding response is used only as a language hint for an otherwise ambiguous reply.
  const classifierState = classificationResult && !Number.isInteger(classifierContextLimit)
    ? { accepted_decisions: [], current_session_state: null, bytes: 0, budget_bytes: null }
    : classifierStateContext(runtime.db, run.project_id, classifierContextLimit, resolvedSemanticScope, { excludeRunId: runId });
  const languageHistory = classifierState.current_session_state?.last_response
    ? [{ role: "assistant", content: classifierState.current_session_state.last_response }]
    : [];
  responseLanguage = resolveResponseLanguage({ message, preferredLanguage: preferredLanguage ?? settings.responseLanguage, history: languageHistory });
  runtime.db.prepare("UPDATE workflow_runs SET response_language=?,updated_at=? WHERE id=?").run(responseLanguage, now(), runId);
  const discovery = readProjectContext(project, runtime.db);
  const catalog = classificationCatalog(runtime.db, run.project_id, resolvedSemanticScope);
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
  fs.writeFileSync(classifierTaskFile, classifierPrompt({ message, catalog, projectSnapshot: compactProjectSnapshot(discovery), acceptedDecisions: classifierState.accepted_decisions, currentState: classifierState.current_session_state, responseLanguage }), "utf8");
  fs.writeFileSync(classifierSchemaFile, `${JSON.stringify(classificationJsonSchema(catalog), null, 2)}\n`, "utf8");
  runtime.setState(runId, "classifying", { reason: "deterministic discovery complete" });

  let classifierReceipt = null;
  let classification;
  let runProfile = null;
  let effectiveRunProfileOverrides = { ...runProfileOverrides };
  let answeredProfileInteraction = null;
  try {
    // Embedded deterministic callers predate the standalone objective field. Their supplied message is
    // already the complete objective, so it is a safe compatibility value. Model output never receives
    // this fallback: parseClassificationReceipt still requires the field and fails closed when absent.
    if (classificationResult) classification = validateClassificationDecision({ ...classificationResult, resolved_objective: classificationResult.resolved_objective ?? String(message) }, catalog);
    else {
      if (!execute) throw new Error("CLASSIFICATION_EXECUTION_REQUIRED: supply a validated contract result for dry-run tests");
      const role = definition.roles?.classifier;
      if (!role?.provider || !role.profile || !role.role) throw new Error("CLASSIFIER_ROLE_NOT_CONFIGURED");
      classifierReceipt = await gatewayCall({ provider: role.provider, profile: role.profile, level: "prototype", role: role.role, capabilityRequirements: executorCapabilityRequirementsForProject(runtime.db, project, role.contract ?? {}, { direct: true }), requiresWrite: false, taskFile: classifierTaskFile, outputSchemaFile: classifierSchemaFile, project: projectRoot, taskId: `${runId}:classifier`, workflowRunId: runId });
      reconcileAndLinkDirectReceipt(runtime, runId, classifierReceipt, { role_id: role.role, ...(role.contract ?? {}) });
      assertGatewayReceiptCompleted(classifierReceipt, "classifier");
      classification = parseClassificationReceipt(classifierReceipt, catalog);
    }
    answeredProfileInteraction = classification.pending_interaction_id
      ? catalog.pending_interactions.find(item => item.id === classification.pending_interaction_id && item.kind === RUN_PROFILE_CONFIRMATION_KIND) ?? null
      : null;
    if (answeredProfileInteraction && classification.pending_interaction_response === "approve") {
      effectiveRunProfileOverrides = runProfileAxes(answeredProfileInteraction.profile);
      classification = Object.freeze({ ...classification, resolved_objective: answeredProfileInteraction.objective });
      sessionProfileAction = "consume";
    } else if (answeredProfileInteraction && classification.pending_interaction_response === "decline") {
      sessionProfileAction = "consume";
    }
    if (classification.reply_mode === "work") {
      const routedWorkflow = resolveWorkflowRoute(catalog, classification.work_type);
      if (routedWorkflow !== workflow) {
        runtime.db.prepare("UPDATE workflow_runs SET workflow_id=?,updated_at=? WHERE id=?").run(routedWorkflow, now(), runId);
        workflow = routedWorkflow;
      }
    }
    const classifierQualityMode = classification.quality_mode;
    const requestedQualityFloor = ownerQualityFloor(message);
    const workflowQualityFloor = classification.reply_mode === "work"
      ? runtime.db.prepare("SELECT default_quality FROM workflows WHERE id=?").get(workflow)?.default_quality ?? null
      : null;
    const profileQualityFloor = effectiveRunProfileOverrides.quality_mode ? operationalLevel(effectiveRunProfileOverrides.quality_mode) : null;
    const effective = effectiveQualityMode(classifierQualityMode, requestedQualityFloor, workflowQualityFloor, profileQualityFloor);
    classification = Object.freeze({
      ...classification,
      quality_mode: effective,
      quality: effective,
      classifier_quality_mode: classifierQualityMode,
      requested_quality_floor: requestedQualityFloor === "security-audit" ? "security" : requestedQualityFloor,
      workflow_quality_floor: workflowQualityFloor
    });
    const profileQuality = operationalLevel(classification.quality_mode);
    // Only the classifier and researcher are known before classification. Once the classifier has
    // selected a route, fail closed on that route's actual roles and level before any planner, worker,
    // reviewer or documentator is invoked. An incompatible release operator must not disable an
    // unrelated implementation or research route.
    if (execute && registryBackedDefinition && classification.reply_mode === "work" && (!classificationResult || gatewayProfileCheck)) {
      assertWorkflowRuntimeReady(runtime.db, run.project_id, workflow, profileQuality, gatewayProfileCheck ? { profileCheck: gatewayProfileCheck } : undefined);
    }
    runtime.classify(runId, classification);
    initializeQualityRun(runtime, runId, classification, classifierReceipt);
    const bindings = plannerBindings(runtime.db, run.project_id, profileQuality, classification.work_type);
    const resolvedProfile = resolveRunProfile(runtime.db, { projectId: run.project_id, qualityMode: profileQuality, overrides: effectiveRunProfileOverrides, plannerBindings: bindings });
    if (resolvedProfile.status === "resolved") {
      runProfile = resolvedProfile;
      const defaultRow = runtime.db.prepare("SELECT confirmed_by FROM project_run_profile_defaults WHERE project_id=? AND quality_mode=?").get(run.project_id, profileQuality);
      storeRunProfile(runtime.db, runId, runProfile, { status: "fixed", confirmedBy: defaultRow?.confirmed_by ?? null });
    } else {
      const legacy = runtime.get(runId).improvement_strategy === "gauntlet" ? "gauntlet" : "baseline";
      const fallback = {
        quality_mode: profileQuality,
        execution_mode: effectiveRunProfileOverrides.execution_mode ?? "standard",
        verification_mode: effectiveRunProfileOverrides.verification_mode ?? legacy,
        planning_mode: effectiveRunProfileOverrides.planning_mode ?? "single"
      };
      runProfile = { status: "resolved", ...normalizeRunProfile(fallback, { plannerBindings: bindings }), sources: {
        quality_mode: "classification",
        execution_mode: effectiveRunProfileOverrides.execution_mode === undefined ? "legacy_fallback" : "task",
        verification_mode: effectiveRunProfileOverrides.verification_mode === undefined ? "legacy_fallback" : "task",
        planning_mode: effectiveRunProfileOverrides.planning_mode === undefined ? "legacy_fallback" : "task"
      } };
      storeRunProfile(runtime.db, runId, runProfile, { status: "proposed" });
    }
  } catch (error) {
    if (error?.code === "WORKFLOW_RUNTIME_NOT_READY") return executionFailure(runtime, runId, error, finish, responseLanguage);
    return classificationFailure(runtime, runId, error, finish, responseLanguage);
  }

  const receiptsOf = () => classifierReceipt ? { mode: "executed", receipts: [{ step: "classifier", receipt: classifierReceipt }] } : { mode: "contract-test" };
  const resolvedObjective = classification.resolved_objective;
  const profileMismatch = ["quality_mode", "execution_mode", "verification_mode", "planning_mode"]
    .some(axis => effectiveRunProfileOverrides[axis] !== undefined && runProfile[axis] !== effectiveRunProfileOverrides[axis]);
  const approvedPendingProfile = answeredProfileInteraction && classification.pending_interaction_response === "approve";
  if (((prepareOnly && !approvedPendingProfile) || profileMismatch) && classification.reply_mode === "work") {
    runtime.setState(runId, "completed", { reason: "run profile prepared before implementation" });
    const next = responseLanguage === "ru"
      ? "Если профиль подходит, ответьте обычным сообщением — например, «делай». Если нет, опишите, что изменить."
      : "If this profile is right, reply normally, for example “proceed”. Otherwise describe what to change.";
    const changed = profileMismatch
      ? (responseLanguage === "ru" ? "После повторной классификации профиль изменился; работа ещё не началась и новое значение нужно подтвердить." : "Reclassification changed the profile; work has not started and the new value must be confirmed.")
      : null;
    const response = saveAssistant([profileLine(runProfile, responseLanguage), changed, classification.reason, next].filter(Boolean).join("\n\n"));
    return finish({ route: "prepared", classification, run_profile: runProfile, response, gateway: receiptsOf() });
  }
  // Every incoming message gets its own run, so intake stays idempotent whatever the message turns out to
  // be. What that run then does depends on whether it answered something the platform was waiting for —
  // and an ordinary message that answered nothing stays an ordinary new run rather than being attached to
  // an older one because it arrived in the same project soon afterwards.
  const namedInteraction = classification.pending_interaction_id
    ? runtime.db.prepare("SELECT id,run_id,kind FROM approvals WHERE id=?").get(classification.pending_interaction_id) ?? null
    : null;

  // A request for external evidence asks for a fact that lives outside everything the platform can read.
  // It is closed by a delivered packet that satisfies its contract, or by the owner cancelling it —
  // never by a message asserting the fact, because the claim it guards would then pass unproven.
  if (namedInteraction?.kind === EXTERNAL_EVIDENCE_KIND) {
    const waitingRun = runtime.db.prepare("SELECT id,state FROM workflow_runs WHERE id=?").get(namedInteraction.run_id);
    if (classification.pending_interaction_response === "decline") {
      cancelInteraction(runtime.db, namedInteraction.id, "owner cancelled the external evidence request", { answeredRunId: runId });
      if (waitingRun && waitingRun.state === "external_evidence_required") runtime.setState(waitingRun.id, "cancelled", { reason: "owner cancelled the external evidence request" });
      runtime.setState(runId, "completed", { reason: "evidence request cancellation recorded" });
      return finish({ route: "external_evidence_cancelled", classification, response: saveAssistant(workflowMessage("externalEvidenceCancelled", responseLanguage)), gateway: receiptsOf() });
    }
    runtime.setState(runId, "completed", { reason: "external evidence request remains open" });
    return finish({ route: "external_evidence_pending", classification, response: saveAssistant(workflowMessage("externalEvidencePending", responseLanguage)), gateway: receiptsOf() });
  }

  // The answer to a clarification belongs to the run that asked it. Sending that answer through a fresh
  // run would replan work already done and pay for every model call again, so the intake run records the
  // delivery and the waiting run continues from where it stopped. A question asked before anything was
  // planned is the exception: that run was only the question, so it completes and this run does the work.
  const answeredClarification = namedInteraction && CLARIFICATION_KINDS.has(namedInteraction.kind) && namedInteraction.run_id && namedInteraction.run_id !== runId
    ? runtime.db.prepare("SELECT id,state FROM workflow_runs WHERE id=? AND state='clarification_required'").get(namedInteraction.run_id) ?? null
    : null;
  if (answeredClarification) {
    const waitingRunId = answeredClarification.id;
    const planned = runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=?").get(waitingRunId).count;
    if (!planned) runtime.setState(waitingRunId, "completed", { reason: "the question this run asked was answered" });
    else {
      runtime.setState(runId, "completed", { reason: "clarification delivered to the waiting run" });
      try {
        const execution = await resumeWaitingRun({ runtime, waitingRunId, definition, discovery, responseLanguage, taskRoot: taskDirectory, gatewayCall, gateRunner });
        return finish({ route: "work", classification, response: saveAssistant(executionMessage(execution, responseLanguage)), execution, gateway: receiptsOf() });
      } catch (error) {
        const failure = structuredExecutionError(error);
        const response = saveAssistant(`${workflowMessage("contractRejected", responseLanguage)} (${failure.diagnostic})`);
        return finish({ route: "execution_failed", classification, response, execution: { status: runtime.get(waitingRunId).state, error: failure.category } });
      }
    }
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
    const approval = approveBoundInteraction(runtime.db, ownerDecision.id, { answeredRunId: runId });
    if (!approval.approved) {
      runtime.setState(runId, "completed", { reason: approval.stale ? "stale approval replaced with a decision for the current state" : "duplicate owner decision recorded" });
      const response = saveAssistant(workflowMessage(approval.stale ? "approvalStale" : "contractRejected", responseLanguage));
      return finish({ route: approval.stale ? "owner_decision_stale" : "owner_decision", classification, response, gateway: receipts, approval });
    }
    // This is the action boundary. The transaction above checked the binding while recording consent;
    // checking once more before dispatch makes any intervening mutation fail closed as well.
    assertApprovalStillCurrent(runtime.db, ownerDecision.id);
    // Where the decision sits decides how the run continues. A decision before the work re-enters the run
    // from its objective, because nothing has been done yet. A decision after the work must not: doing so
    // would repeat, and pay for again, every step already completed. That run resumes from its recorded
    // plan, gate and review, and only the phases the decision was blocking still run.
    const worked = runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND state='completed' AND result_schema_key IN ('worker.v1','release_operation.v1','access_change.v1')").get(ownerDecision.run_id).count;
    runtime.setState(runId, "completed", { reason: "owner approval delivered to the waiting run" });
    try {
      const paused = worked ? null : pausedRunObjective(runtime.db, ownerDecision.run_id);
      const execution = worked
        ? await continueApprovedRun({ runtime, runId: ownerDecision.run_id, approvalId: ownerDecision.id, discovery, responseLanguage, taskRoot: taskDirectory, gatewayCall })
        : await executeStructuredWork({ runtime, runId: ownerDecision.run_id, classification: paused.classification, definition, discovery, message: paused.message, responseLanguage, taskRoot: taskDirectory, gatewayCall, approvalGranted: true, ...(gateRunner ? { gateRunner } : {}) });
      const response = saveAssistant(executionMessage(execution, responseLanguage));
      return finish({ route: "work", classification, response, execution, gateway: receipts });
    } catch (error) {
      const failure = structuredExecutionError(error);
      const response = saveAssistant(`${workflowMessage("contractRejected", responseLanguage)} (${failure.diagnostic})`);
      return finish({ route: "execution_failed", classification, response, execution: { status: runtime.get(ownerDecision.run_id).state, error: failure.category } });
    }
  }

  if (classification.needs_questions) {
    const taskId = runtime.get(runId).task_id;
    for (const question of classification.questions) openClarification(runtime.db, { taskId, runId, kind: "clarification", question, reason: classification.reason });
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
    if (!execute) return finish({ route: "research", classification, response: formatClassification({ summary: classification.reason, nextStep: responseLanguage === "ru" ? "выполнить ограниченное read-only исследование зарегистрированного репозитория" : "run bounded read-only research over the registered repository", language: responseLanguage }), gateway: { mode: "dry-run", steps: [{ role: "researcher", readable_documents: selected.documents.map(item => item.path), readable_roots: selected.roots.map(item => item.key), source_selection: { status: "deferred_until_execution", source_required: requiresSourceEvidence(classification) } }] } });
    const supplied = researchContext(selected, resolvedObjective, classification);
    runtime.setState(runId, "executing", { reason: "research route authorized" });
    const researchFile = path.join(taskDirectory, "research-task.md");
    const researchSchemaFile = path.join(taskDirectory, "researcher-output.schema.json");
    fs.writeFileSync(researchFile, researchPrompt({ message, resolvedObjective, project: discovery.project, context: supplied, responseLanguage }), "utf8");
    fs.writeFileSync(researchSchemaFile, `${JSON.stringify(researchJsonSchema(), null, 2)}\n`, "utf8");
    const role = definition.roles?.researcher;
    if (!role?.provider || !role.profile || !role.role) return executionFailure(runtime, runId, new Error("RESEARCHER_ROLE_NOT_CONFIGURED"), finish, responseLanguage);
    let researcher;
    try {
      reserveDirectModelCall(runtime, runId, "researcher");
      researcher = await gatewayCall({ provider: role.provider, profile: role.profile, level: operationalLevel(classification.quality_mode), role: role.role, capabilityRequirements: executorCapabilityRequirementsForProject(runtime.db, project, role.contract ?? {}, { direct: true }), requiresWrite: false, taskFile: researchFile, outputSchemaFile: researchSchemaFile, project: projectRoot, taskId: `${runId}:researcher`, workflowRunId: runId });
      chargeDirectReceipt(runtime, runId, researcher, "researcher");
      reconcileAndLinkDirectReceipt(runtime, runId, researcher, { role_id: role.role, ...(role.contract ?? {}) });
    }
    catch (error) { return executionFailure(runtime, runId, error, finish, responseLanguage); }
    let research;
    try {
      assertGatewayReceiptCompleted(researcher, "researcher");
      research = validateResearchResult(researcher, selected, { suppliedPaths: supplied.supplied_paths, sourcePaths: supplied.source_paths, sourceRequired: supplied.source_required });
    }
    catch (error) { return executionFailure(runtime, runId, error, finish, responseLanguage); }
    recordRunEvidence(runtime.db, runId, null, "research_inspection", { status: research.status, inspected_paths: research.inspected_paths, limitations: research.limitations, source_selection: supplied.sources.selection });
    const response = saveAssistant(research.answer);
    if (research.status === "insufficient") runtime.setState(runId, "blocked", { reason: "registered research evidence was insufficient" });
    else {
      runtime.setState(runId, "verifying", { reason: "research answer received with inspected sources" });
      runtime.setState(runId, "completed", { reason: "evidence-backed research answer delivered" });
    }
    return finish({
      route: "research", classification, response,
      research: { status: research.status, inspected_paths: research.inspected_paths, limitations: research.limitations },
      gateway: { mode: "executed", receipts: [{ step: "classifier", receipt: classifierReceipt }, { step: "researcher", receipt: researcher }] }
    });
  }

  if (execute) {
    try {
      const execution = await executeStructuredWork({ runtime, runId, classification, definition, discovery, message: resolvedObjective, responseLanguage, taskRoot: taskDirectory, gatewayCall, ...(gateRunner ? { gateRunner } : {}) });
      const response = [profileLine(runProfile, responseLanguage), executionMessage(execution, responseLanguage)].filter(Boolean).join("\n\n");
      saveAssistant(response);
      return finish({ route: "work", classification, response, execution });
    } catch (error) {
      const failure = structuredExecutionError(error);
      const category = failure.category;
      // A run that failed on its way into execution has to end. Where the failure already put the run
      // somewhere meaningful — waiting for a person, scheduled to retry, blocked — that state is the
      // truth and is left alone; anywhere else the run is finished as failed, because a run reported as
      // rejected while it sits in a live state is a run nothing will ever pick up or clean away.
      const settled = new Set(["failed", "blocked", "cancelled", "rejected", "completed", "documented", "approval_required", "clarification_required", "retry_scheduled", "paused"]);
      if (!settled.has(runtime.get(runId).state)) {
        try { runtime.setState(runId, "failed", { reason: category }); } catch { /* the original failure is what matters */ }
      }
      const state = runtime.get(runId).state;
      const response = `${workflowMessage("contractRejected", responseLanguage)} (${failure.diagnostic})`;
      saveAssistant(response);
      return finish({ route: "execution_failed", classification, response, execution: { status: state, error: category } });
    }
  }

  const plan = {
    objective: resolvedObjective, workflow, project: discovery.project.name, level: classification.planning_level, quality: classification.quality_mode,
    authority: definition.authority ?? "registered project documents",
    steps: [{ key: "planning" }, { key: "execution" }, { key: "verification" }, { key: "review" }, { key: "documentation" }],
    gates: definition.gates ?? []
  };
  recordLint(runtime.db, runId, workflowLint({ state: "planning", classification }));
  runtime.plan(runId, plan);
  const selected = selectProjectContext(discovery, classification, [], runtime.db, run.project_id, "planner");
  const plannerFile = path.join(taskDirectory, "planner-task.md");
  fs.writeFileSync(plannerFile, buildPrompt({ role: "planner", stage: "planning", intent: resolvedObjective, classification, quality: classification.quality_mode, plan, document: JSON.stringify(boundedDocuments(selected, PLANNER_DOCUMENT_CONTEXT_BYTES)), constraints: ["use registered context only", "do not edit files", "return a bounded structured package"], format: "JSON plan contract", responseLanguage }), "utf8");
  const response = saveAssistant([profileLine(runProfile, responseLanguage), formatClassification({ summary: classification.reason, quality: classification.quality_mode, nextStep: responseLanguage === "ru" ? "подготовить проверяемый план выполнения" : "prepare a verifiable execution plan", language: responseLanguage })].filter(Boolean).join("\n\n"));
  return finish({ route: "work", classification, run_profile: runProfile, plan, response, gateway: { mode: execute ? "planned" : "dry-run", steps: [
    { role: "planner", profile: definition.roles?.planner?.profile ?? null, task_file: plannerFile },
    { role: "worker", profile: definition.roles?.worker?.profile ?? null, condition: "after valid plan" },
    { role: "project-gate", runner: "workflow-platform", condition: "after worker" },
    { role: "reviewer", profile: definition.roles?.reviewer?.profile ?? null, condition: "only after green gate/lints" },
    { role: "documentator", profile: definition.roles?.documentator?.profile ?? null, condition: "when required" }
  ] } });
}
