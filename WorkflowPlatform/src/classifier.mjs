const REQUIRED_FIELDS = Object.freeze([
  "schema_version", "work_type", "artifact_type", "domain", "discipline", "risk", "planning_level", "quality_mode",
  "planning_required", "human_required", "needs_questions", "document_required", "reply_mode", "pending_interaction_id",
  "reason", "questions", "human_response"
]);
const BOOLEAN_FIELDS = Object.freeze(["planning_required", "human_required", "needs_questions", "document_required"]);
const RISKS = new Set(["low", "medium", "high"]);
const REPLY_MODES = new Set(["conversation", "research", "clarification", "work"]);

function ids(db, table) { return db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id); }

export function classificationCatalog(db, projectId) {
  const routes = db.prepare(`SELECT wr.work_type_id,wr.workflow_id,wr.priority
    FROM workflow_routes wr JOIN workflows w ON w.id=wr.workflow_id
    WHERE wr.project_id=? AND wr.enabled=1 AND w.status='active'
    ORDER BY wr.work_type_id,wr.priority DESC,wr.workflow_id`).all(projectId);
  const pending = [
    ...db.prepare("SELECT id,'approval' AS kind,question AS summary FROM approvals WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND status='pending' ORDER BY created_at,id").all(projectId),
    ...db.prepare("SELECT id,'document_proposal' AS kind,target AS summary FROM document_proposals WHERE project_id=? AND status='pending' ORDER BY created_at,id").all(projectId)
  ].sort((a, b) => a.id.localeCompare(b.id, "en"));
  return Object.freeze({
    schema_version: 1,
    work_types: ids(db, "work_types"), artifact_types: ids(db, "artifact_types"), domains: ids(db, "domains"),
    disciplines: ids(db, "disciplines"), quality_modes: ids(db, "quality_modes"), planning_levels: ids(db, "planning_levels"),
    routes, pending_interactions: pending
  });
}

export function assertCatalogComplete(catalog) {
  for (const key of ["work_types", "artifact_types", "domains", "disciplines", "quality_modes", "planning_levels"]) {
    if (!Array.isArray(catalog?.[key]) || !catalog[key].length) throw new Error(`CLASSIFICATION_CATALOG_INCOMPLETE: ${key}`);
  }
  return catalog;
}

function assertRegistered(catalog, field, catalogField, value) {
  if (!catalog[catalogField].includes(value)) throw new Error(`CLASSIFICATION_VALUE_UNREGISTERED: ${field}=${value}`);
}

export function validateClassificationDecision(value, catalog) {
  assertCatalogComplete(catalog);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("CLASSIFICATION_SCHEMA_INVALID: object required");
  const keys = Object.keys(value).sort();
  const expected = [...REQUIRED_FIELDS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    const missing = expected.filter(key => !keys.includes(key));
    const extra = keys.filter(key => !expected.includes(key));
    throw new Error(`CLASSIFICATION_SCHEMA_INVALID: missing=${missing.join(",")} extra=${extra.join(",")}`);
  }
  if (value.schema_version !== 1) throw new Error(`CLASSIFICATION_SCHEMA_VERSION_UNSUPPORTED: ${value.schema_version}`);
  assertRegistered(catalog, "work_type", "work_types", value.work_type);
  assertRegistered(catalog, "artifact_type", "artifact_types", value.artifact_type);
  assertRegistered(catalog, "domain", "domains", value.domain);
  assertRegistered(catalog, "discipline", "disciplines", value.discipline);
  assertRegistered(catalog, "quality_mode", "quality_modes", value.quality_mode);
  assertRegistered(catalog, "planning_level", "planning_levels", value.planning_level);
  if (!RISKS.has(value.risk)) throw new Error(`CLASSIFICATION_SCHEMA_INVALID: risk=${value.risk}`);
  if (!REPLY_MODES.has(value.reply_mode)) throw new Error(`CLASSIFICATION_SCHEMA_INVALID: reply_mode=${value.reply_mode}`);
  for (const field of BOOLEAN_FIELDS) if (typeof value[field] !== "boolean") throw new Error(`CLASSIFICATION_SCHEMA_INVALID: ${field} must be boolean`);
  if (!Array.isArray(value.questions) || value.questions.length > 5 || value.questions.some(question => typeof question !== "string" || !question.trim() || question.length > 1000)) throw new Error("CLASSIFICATION_SCHEMA_INVALID: questions");
  if (value.needs_questions !== (value.questions.length > 0)) throw new Error("CLASSIFICATION_SCHEMA_INVALID: needs_questions mismatch");
  if (value.needs_questions !== (value.reply_mode === "clarification")) throw new Error("CLASSIFICATION_SCHEMA_INVALID: clarification mode mismatch");
  if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 2000) throw new Error("CLASSIFICATION_SCHEMA_INVALID: reason");
  if (value.human_response !== null && (typeof value.human_response !== "string" || value.human_response.length > 4000)) throw new Error("CLASSIFICATION_SCHEMA_INVALID: human_response");
  const pendingIds = catalog.pending_interactions.map(item => item.id);
  if (value.pending_interaction_id !== null && !pendingIds.includes(value.pending_interaction_id)) throw new Error(`CLASSIFICATION_PENDING_INTERACTION_UNKNOWN: ${value.pending_interaction_id}`);
  if (value.work_type === "conversation" && (value.planning_required || value.artifact_type !== "none" || value.reply_mode !== "conversation")) throw new Error("CLASSIFICATION_SCHEMA_INVALID: conversation contract");
  if (value.reply_mode === "work" && !value.planning_required) throw new Error("CLASSIFICATION_SCHEMA_INVALID: work requires planning");
  return Object.freeze({ ...value, kind: value.work_type, artifact: value.artifact_type, level: value.planning_level, quality: value.quality_mode });
}

function parsedJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try { return JSON.parse(text.trim()); } catch { return null; }
}

function candidateFromEnvelope(value) {
  if (!value || typeof value !== "object") return null;
  if (value.schema_version === 1 && value.work_type) return value;
  if (value.classification && typeof value.classification === "object") return value.classification;
  for (const field of [value.result, value.text, value.content, value.item?.text, value.message?.content]) {
    const parsed = parsedJson(field);
    if (parsed) return candidateFromEnvelope(parsed) ?? parsed;
  }
  return null;
}

export function parseClassificationReceipt(receipt, catalog) {
  const output = String(receipt?.output ?? "");
  let candidate = candidateFromEnvelope(parsedJson(output));
  if (!candidate) {
    for (const line of output.split(/\r?\n/)) {
      const found = candidateFromEnvelope(parsedJson(line));
      if (found) candidate = found;
    }
  }
  if (!candidate) throw new Error("CLASSIFICATION_OUTPUT_INVALID_JSON");
  return validateClassificationDecision(candidate, catalog);
}

export function resolveWorkflowRoute(catalog, workType, requestedWorkflowId = null) {
  const matches = catalog.routes.filter(route => route.work_type_id === workType);
  if (!matches.length) throw new Error(`CLASSIFICATION_ROUTE_UNREGISTERED: ${workType}`);
  if (requestedWorkflowId) {
    const requested = matches.find(route => route.workflow_id === requestedWorkflowId);
    if (!requested) throw new Error(`CLASSIFICATION_ROUTE_NOT_ALLOWED: ${workType} -> ${requestedWorkflowId}`);
    return requested.workflow_id;
  }
  return matches[0].workflow_id;
}

export function classifierPrompt({ message, catalog, projectSnapshot, acceptedDecisions = [], history = [] }) {
  const stablePrefix = [
    "WORKFLOW CLASSIFICATION CONTRACT v3",
    "You classify the current user message. Do not plan work, edit files, invoke tools, or invent registry values.",
    `ALLOWED_VALUES:${JSON.stringify({ work_type: catalog.work_types, artifact_type: catalog.artifact_types, domain: catalog.domains, discipline: catalog.disciplines, quality_mode: catalog.quality_modes, planning_level: catalog.planning_levels, risk: [...RISKS], reply_mode: [...REPLY_MODES] })}`,
    `REGISTERED_ROUTES:${JSON.stringify(catalog.routes)}`,
    `PROJECT_SNAPSHOT:${JSON.stringify(projectSnapshot)}`,
    `ACCEPTED_DECISIONS:${JSON.stringify(acceptedDecisions)}`,
    `PENDING_INTERACTIONS:${JSON.stringify(catalog.pending_interactions)}`,
    `OUTPUT_FIELDS:${JSON.stringify(REQUIRED_FIELDS)}`,
    "FIXED_OUTPUT_VALUES:{\"schema_version\":1}",
    "The contract revision in the heading is not the output schema version. schema_version must be the integer 1.",
    "Return exactly one JSON object and no Markdown. Use null for pending_interaction_id and human_response when absent. questions must contain 0-5 plain-language Russian questions. A short confirmation is classified from pending interactions and ordered history, never from a keyword rule. Ordinary conversation uses work_type=conversation, artifact_type=none, planning_required=false and reply_mode=conversation. Productive work uses a registered route and a concrete result."
  ].join("\n");
  return `${stablePrefix}\nORDERED_HISTORY:${JSON.stringify(history)}\nCURRENT_USER_MESSAGE:${JSON.stringify(String(message))}`;
}
