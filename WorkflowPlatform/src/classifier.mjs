const REQUIRED_FIELDS = Object.freeze([
  "schema_version", "work_type", "artifact_type", "domain", "discipline", "risk", "planning_level", "quality_mode",
  "planning_required", "human_required", "needs_questions", "document_required", "reply_mode", "pending_interaction_id", "pending_interaction_response",
  "reason", "questions", "human_response"
]);
const BOOLEAN_FIELDS = Object.freeze(["planning_required", "human_required", "needs_questions", "document_required"]);
const RISKS = new Set(["low", "medium", "high"]);
const REPLY_MODES = new Set(["conversation", "research", "clarification", "work"]);
const OWNER_RESPONSES = new Set(["approve", "decline", "undecided", null]);
// These answers are delivered directly and never enter a workflow, so they stay classifiable
// even when a project registers no route for them.
const DIRECT_REPLY_WORK_TYPES = Object.freeze(["clarification", "conversation", "research"]);

function ids(db, table) { return db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id); }

export function classificationCatalog(db, projectId) {
  const routes = db.prepare(`SELECT wr.work_type_id,wr.workflow_id,wr.priority
    FROM workflow_routes wr JOIN workflows w ON w.id=wr.workflow_id
    WHERE wr.project_id=? AND wr.enabled=1 AND w.status='active'
    ORDER BY wr.work_type_id,wr.priority DESC,wr.workflow_id`).all(projectId);
  const pending = [
    // The kind is what separates a question from a decision on an action, and collapsing every approval
    // into one label left the classifier unable to tell them apart in the very list it reads.
    ...db.prepare("SELECT id,kind,question AS summary FROM approvals WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND status='pending' ORDER BY created_at,id").all(projectId),
    ...db.prepare("SELECT id,'document_proposal' AS kind,target AS summary FROM document_proposals WHERE project_id=? AND status='pending' ORDER BY created_at,id").all(projectId)
  ].sort((a, b) => a.id.localeCompare(b.id, "en"));
  return Object.freeze({
    schema_version: 1,
    work_types: [...new Set([...routes.map(route => route.work_type_id), ...DIRECT_REPLY_WORK_TYPES])].sort(),
    artifact_types: ids(db, "artifact_types"), domains: ids(db, "domains"),
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
  // A person answering a request for consent can also be neither agreeing nor refusing: doubting,
  // asking back, thinking aloud. Read as agreement that is an action taken without consent, so the
  // three outcomes are named separately and anything short of an unambiguous yes is still undecided.
  const answered = catalog.pending_interactions.find(item => item.id === value.pending_interaction_id) ?? null;
  const decides = Boolean(answered) && answered.kind !== "clarification";
  if (!OWNER_RESPONSES.has(value.pending_interaction_response)) throw new Error(`CLASSIFICATION_SCHEMA_INVALID: pending_interaction_response=${value.pending_interaction_response}`);
  if (decides !== (value.pending_interaction_response !== null)) throw new Error("CLASSIFICATION_SCHEMA_INVALID: pending_interaction_response belongs to a decision, and every decision needs one");
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

export function classifierPrompt({ message, catalog, projectSnapshot, acceptedDecisions = [], history = [], responseLanguage = "en" }) {
  // Everything above the run state is identical between runs of the same project, and providers only
  // reuse a cached prompt prefix once it passes their minimum length, so the whole invariant contract
  // is stated here and every field that carries run state is kept below it.
  const invariant = [
    "WORKFLOW CLASSIFICATION CONTRACT v4",
    "You classify the current user message. Do not plan work, edit files, invoke tools, or invent registry values.",
    "Return exactly one JSON object and no Markdown.",
    `OUTPUT_FIELDS:${JSON.stringify(REQUIRED_FIELDS)}`,
    "FIXED_OUTPUT_VALUES:{\"schema_version\":1}",
    "The contract revision in the heading is not the output schema version. schema_version must be the integer 1.",
    "FIELD_SEMANTICS:",
    "- work_type, artifact_type, domain, discipline, quality_mode, planning_level: one registry value each, taken from ALLOWED_VALUES and never invented.",
    "- risk: low when the message cannot damage anything, medium when it changes registered material, high when it is irreversible or touches production.",
    "- reply_mode: conversation for ordinary talk, research for a bounded question answered from registered sources, clarification when required information is missing, work when a registered route must run.",
    "- work_type=conversation forces artifact_type=none, planning_required=false and reply_mode=conversation.",
    "- reply_mode=work requires planning_required=true and a work_type that REGISTERED_ROUTES actually routes.",
    "- planning_required: the answer needs ordered steps rather than a single response.",
    "- human_required: a person must decide or approve before the result can stand.",
    "- document_required: the result belongs in a registered document, not only in the reply.",
    "- needs_questions must equal questions.length > 0, and must be true exactly when reply_mode is clarification.",
    "- questions: 0 to 5 plain-language questions, each one a real choice only the user can make. Never ask what the registry or the project files already answer.",
    "- pending_interaction_id: the id from PENDING_INTERACTIONS that this message answers, or null. A short confirmation is resolved from pending interactions and ordered history, never from a keyword rule.",
    "- pending_interaction_response: null when pending_interaction_id is null or names an interaction of kind clarification. When it names any other kind, the user is being asked to decide whether an action may happen, and this field says what they decided: approve only for an unambiguous yes to that exact action, decline for a refusal, undecided for anything else. Doubt, a question back, a condition, a partial agreement and thinking aloud are all undecided: the decision stays open and the user is answered. Treating hesitation as approval takes an action the user never authorized, so undecided is the answer whenever both readings are possible.",
    "- reason: why this classification, in RESPONSE_LANGUAGE.",
    "- human_response: the reply text when reply_mode is conversation, otherwise null.",
    "LEVEL_SELECTION:",
    "- planning_level measures how much ordered work the answer needs, not how important it is. L0 one response with no steps. L1 one bounded step. L2 a few dependent steps inside one area. L3 work crossing areas, releases, or anything irreversible. L4 a full audit.",
    "- clarification and conversation are always L0 unless the pending work already has a level.",
    "- quality_mode measures how much verification the result must survive. prototype throwaway or exploratory, mvp the normal registered change, production irreversible or user-visible, security an audit of access or secrets.",
    "- Choose the lowest level and mode the message honestly needs, and choose the same ones for the same message: identical input must produce identical values.",
    "Write reason, questions and human_response in RESPONSE_LANGUAGE; keep field names and registry values in English.",
    `ALLOWED_VALUES:${JSON.stringify({ work_type: catalog.work_types, artifact_type: catalog.artifact_types, domain: catalog.domains, discipline: catalog.disciplines, quality_mode: catalog.quality_modes, planning_level: catalog.planning_levels, risk: [...RISKS], reply_mode: [...REPLY_MODES] })}`,
    `REGISTERED_ROUTES:${JSON.stringify(catalog.routes)}`
  ].join("\n");
  const runState = [
    `RESPONSE_LANGUAGE:${JSON.stringify(responseLanguage)}`,
    `PROJECT_SNAPSHOT:${JSON.stringify(projectSnapshot)}`,
    `ACCEPTED_DECISIONS:${JSON.stringify(acceptedDecisions)}`,
    `PENDING_INTERACTIONS:${JSON.stringify(catalog.pending_interactions)}`,
    `ORDERED_HISTORY:${JSON.stringify(history)}`,
    `CURRENT_USER_MESSAGE:${JSON.stringify(String(message))}`
  ].join("\n");
  return `${invariant}\n${runState}`;
}
