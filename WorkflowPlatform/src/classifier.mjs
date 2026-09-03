import { normalizeSemanticScope } from "./semantic-scope.mjs";

const REQUIRED_FIELDS = Object.freeze([
  "schema_version", "work_type", "artifact_type", "domain", "discipline", "risk", "planning_level", "quality_mode",
  "planning_required", "human_required", "needs_questions", "document_required", "reply_mode", "pending_interaction_id", "pending_interaction_response",
  "resolved_objective", "reason", "questions", "human_response"
]);
const BOOLEAN_FIELDS = Object.freeze(["planning_required", "human_required", "needs_questions", "document_required"]);
const RISKS = new Set(["low", "medium", "high"]);
const REPLY_MODES = new Set(["conversation", "research", "clarification", "work"]);
const OWNER_RESPONSES = new Set(["approve", "decline", "undecided", null]);
const CLARIFICATION_INTERACTION_KINDS = new Set(["clarification", "planner_clarification"]);
const EXTERNAL_EVIDENCE_KIND = "external_evidence";
export const RUN_PROFILE_CONFIRMATION_KIND = "run_profile_confirmation";
export const RUN_PROFILE_CONFIRMATION_ID = "pending_run_profile";
// These answers are delivered directly and never enter a workflow, so they stay classifiable
// even when a project registers no route for them.
const DIRECT_REPLY_WORK_TYPES = Object.freeze(["clarification", "conversation", "research"]);

function ids(db, table) { return db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id); }

export function classificationCatalog(db, projectId, semanticScope = null) {
  const scope = normalizeSemanticScope(semanticScope);
  const sessionBound = scope.mode === "session";
  const routes = db.prepare(`SELECT wr.work_type_id,wr.workflow_id,wr.priority
    FROM workflow_routes wr JOIN workflows w ON w.id=wr.workflow_id
    WHERE wr.project_id=? AND wr.enabled=1 AND w.status='active'
    ORDER BY wr.work_type_id,wr.priority DESC,wr.workflow_id`).all(projectId);
  const approvalRows = sessionBound
    ? db.prepare(`SELECT a.id,a.kind,a.question AS summary,a.detail_json FROM approvals a
        JOIN zodchi_chat_session_runs csr ON csr.run_id=a.run_id
        WHERE a.task_id IN (SELECT id FROM tasks WHERE project_id=?) AND a.status='pending'
          AND csr.client=? AND csr.session_id=? ORDER BY a.created_at,a.id`).all(projectId, scope.client, scope.session_id)
    : [];
  const proposalRows = sessionBound
    ? db.prepare(`SELECT dp.id,'document_proposal' AS kind,dp.target AS summary FROM document_proposals dp
        JOIN zodchi_chat_session_runs csr ON csr.run_id=dp.run_id
        WHERE dp.project_id=? AND dp.status='pending' AND csr.client=? AND csr.session_id=? ORDER BY dp.created_at,dp.id`).all(projectId, scope.client, scope.session_id)
    : [];
  const sessionProfileRow = sessionBound
    ? db.prepare(`SELECT pending_message,pending_profile_json FROM zodchi_chat_sessions
        WHERE client=? AND session_id=? AND project_id=? AND state='active'`).get(scope.client, scope.session_id, projectId) ?? null
    : null;
  let sessionProfileInteraction = null;
  if (sessionProfileRow?.pending_message || sessionProfileRow?.pending_profile_json) {
    if (!sessionProfileRow.pending_message || !sessionProfileRow.pending_profile_json) throw new Error("ZODCHI_PENDING_RUN_PROFILE_INCOMPLETE");
    let profile;
    try { profile = JSON.parse(sessionProfileRow.pending_profile_json); }
    catch { throw new Error("ZODCHI_PENDING_RUN_PROFILE_INVALID"); }
    sessionProfileInteraction = {
      id: RUN_PROFILE_CONFIRMATION_ID,
      kind: RUN_PROFILE_CONFIRMATION_KIND,
      summary: "Decide whether to execute the pending objective with the proposed run profile.",
      objective: sessionProfileRow.pending_message,
      profile,
      possible_responses: ["approve", "decline", "undecided"]
    };
  }
  const pending = [
    // The kind is what separates a question from a decision on an action, and collapsing every approval
    // into one label left the classifier unable to tell them apart in the very list it reads.
    // The evidence contract travels with the request. A person answering "which information base?" is
    // answering a question; a person being asked for a posting log from one named base needs to see which
    // base, over what period, and what the log has to cover, or they cannot tell whether they have it.
    ...approvalRows
      .map(item => {
        const detail = item.kind === EXTERNAL_EVIDENCE_KIND && item.detail_json ? JSON.parse(item.detail_json) : null;
        return detail
          ? { id: item.id, kind: item.kind, summary: item.summary, evidence_contract: { evidence_kind: detail.evidence_kind, resource: detail.resource, expected_completeness: detail.expected_completeness, command: detail.command } }
          : { id: item.id, kind: item.kind, summary: item.summary };
      }),
    ...proposalRows,
    ...(sessionProfileInteraction ? [sessionProfileInteraction] : [])
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

export function classificationJsonSchema(catalog) {
  assertCatalogComplete(catalog);
  const pendingIds = catalog.pending_interactions.map(item => item.id);
  const pendingInteraction = pendingIds.length
    ? {
        anyOf: [
          { type: "string", enum: pendingIds },
          { type: "array", items: { type: "string", enum: pendingIds }, minItems: 1 },
          { type: "null" }
        ]
      }
    : { type: "null" };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: [...REQUIRED_FIELDS],
    properties: {
      schema_version: { type: "integer", enum: [1] },
      work_type: { type: "string", enum: catalog.work_types },
      artifact_type: { type: "string", enum: catalog.artifact_types },
      domain: { type: "string", enum: catalog.domains },
      discipline: { type: "string", enum: catalog.disciplines },
      risk: { type: "string", enum: [...RISKS] },
      planning_level: { type: "string", enum: catalog.planning_levels },
      quality_mode: { type: "string", enum: catalog.quality_modes },
      planning_required: { type: "boolean" },
      human_required: { type: "boolean" },
      needs_questions: { type: "boolean" },
      document_required: { type: "boolean" },
      reply_mode: { type: "string", enum: [...REPLY_MODES] },
      pending_interaction_id: pendingInteraction,
      pending_interaction_response: { enum: [...OWNER_RESPONSES] },
      resolved_objective: { type: "string", minLength: 1, maxLength: 12000 },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      questions: { type: "array", items: { type: "string", minLength: 1, maxLength: 1000 }, maxItems: 5 },
      human_response: { anyOf: [{ type: "string", maxLength: 4000 }, { type: "null" }] }
    }
  };
}

function assertRegistered(catalog, field, catalogField, value) {
  if (!catalog[catalogField].includes(value)) throw new Error(`CLASSIFICATION_VALUE_UNREGISTERED: ${field}=${value}`);
}

export function validateClassificationDecision(value, catalog) {
  assertCatalogComplete(catalog);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("CLASSIFICATION_SCHEMA_INVALID: object required");
  // `continuation` is the conversational route for a short follow-up, not a generic label meaning that
  // the subject appeared earlier in chat. Models naturally call a detailed request "continuation" even
  // when they also correctly identify a required document and work execution. Preserve those substantive
  // fields and route that one unambiguous combination to the registered documentation workflow.
  if (value.work_type === "continuation" && value.reply_mode === "work" && value.artifact_type === "document" && value.document_required && catalog.work_types.includes("documentation")) {
    value = { ...value, work_type: "documentation" };
  }
  // A registered verification run produces a report even when the owner did not name a file. Keeping
  // `none` here makes artifact-bound checks disappear from the run and lets identical messages select
  // different gate sets depending on a model's incidental artifact choice.
  if (value.work_type === "verification" && value.reply_mode === "work" && value.artifact_type === "none" && catalog.artifact_types.includes("test_report")) {
    value = { ...value, artifact_type: "test_report" };
  }
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
  if (typeof value.resolved_objective !== "string" || !value.resolved_objective.trim() || value.resolved_objective.length > 12000) throw new Error("CLASSIFICATION_SCHEMA_INVALID: resolved_objective");
  if (value.human_response !== null && (typeof value.human_response !== "string" || value.human_response.length > 4000)) throw new Error("CLASSIFICATION_SCHEMA_INVALID: human_response");
  // A clarification lives until the next message and is then settled either way, so naming it wrongly
  // costs nothing while refusing the whole classification costs the run, the call and the person's
  // answer. An id that is not pending is dropped and recorded. A decision is different and stays exact:
  // it authorizes an action, and a mis-named one is left open rather than guessed at, which is why the
  // paired response below is only accepted for an interaction that was actually found.
  const pending = new Map(catalog.pending_interactions.map(item => [item.id, item]));
  const claimed = value.pending_interaction_id === null ? [] : [value.pending_interaction_id].flat();
  const named = claimed.filter(item => pending.has(item));
  const unknown = claimed.filter(item => !pending.has(item));
  value.pending_interaction_id = named[0] ?? null;
  // One message routinely answers every question the platform asked, so all of them are settled, not
  // just the first: the schema carries one id for compatibility and the full list beside it.
  value.pending_interaction_ids = named;
  value.unknown_pending_interaction_ids = unknown;
  // A person answering a request for consent can also be neither agreeing nor refusing: doubting,
  // asking back, thinking aloud. Read as agreement that is an action taken without consent, so the
  // three outcomes are named separately and anything short of an unambiguous yes is still undecided.
  const answered = catalog.pending_interactions.find(item => item.id === value.pending_interaction_id) ?? null;
  const decides = Boolean(answered) && !CLARIFICATION_INTERACTION_KINDS.has(answered.kind);
  if (!OWNER_RESPONSES.has(value.pending_interaction_response)) throw new Error(`CLASSIFICATION_SCHEMA_INVALID: pending_interaction_response=${value.pending_interaction_response}`);
  if (decides !== (value.pending_interaction_response !== null)) throw new Error("CLASSIFICATION_SCHEMA_INVALID: pending_interaction_response belongs to a decision, and every decision needs one");
  if (answered?.kind === RUN_PROFILE_CONFIRMATION_KIND) {
    if (value.pending_interaction_response === "approve" && (value.reply_mode !== "work" || !value.planning_required)) {
      throw new Error("CLASSIFICATION_SCHEMA_INVALID: approving a pending run profile must execute its work route");
    }
    if (value.pending_interaction_response !== "approve" && value.reply_mode !== "conversation") {
      throw new Error("CLASSIFICATION_SCHEMA_INVALID: a pending run profile remains conversational until approved");
    }
  }
  // A request for external evidence asks for a fact that exists outside anything the platform can read.
  // A message saying the fact is true is an assertion about the evidence, not the evidence, and reading
  // it as one closes the request while the claim it guards stays unproven. Refusal and cancellation are
  // the person's to make and are honoured; agreement leaves the request open and is recorded as claimed.
  value.external_evidence_claimed_without_packet = false;
  if (answered?.kind === EXTERNAL_EVIDENCE_KIND && value.pending_interaction_response === "approve") {
    value.pending_interaction_response = "undecided";
    value.external_evidence_claimed_without_packet = true;
  }
  if (value.work_type === "conversation" && (value.planning_required || value.artifact_type !== "none" || value.reply_mode !== "conversation")) throw new Error("CLASSIFICATION_SCHEMA_INVALID: conversation contract");
  if (value.work_type === "continuation" && (value.planning_required || value.document_required || value.artifact_type !== "none" || value.reply_mode !== "conversation")) throw new Error("CLASSIFICATION_SCHEMA_INVALID: continuation contract");
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

export function classifierPrompt({ message, catalog, projectSnapshot, acceptedDecisions = [], currentState = null, responseLanguage = "en" }) {
  // Everything above the run state is identical between runs of the same project, and providers only
  // reuse a cached prompt prefix once it passes their minimum length, so the whole invariant contract
  // is stated here and every field that carries run state is kept below it.
  const invariant = [
    "WORKFLOW CLASSIFICATION CONTRACT v8",
    "You classify the current user message. Do not plan work, edit files, invoke tools, or invent registry values.",
    "Return exactly one JSON object and no Markdown.",
    `OUTPUT_FIELDS:${JSON.stringify(REQUIRED_FIELDS)}`,
    "FIXED_OUTPUT_VALUES:{\"schema_version\":1}",
    "The contract revision in the heading is not the output schema version. schema_version must be the integer 1.",
    "FIELD_SEMANTICS:",
    "- work_type, artifact_type, domain, discipline, quality_mode, planning_level: one registry value each, taken from ALLOWED_VALUES and never invented.",
    "- risk: low when the message cannot damage anything, medium when it changes registered material, high when it is irreversible or touches production.",
    "- reply_mode: conversation for ordinary talk, research for bounded read-only investigation of registered project sources, clarification when required information is missing, work when a registered route must run.",
    "- work_type=conversation forces artifact_type=none, planning_required=false and reply_mode=conversation.",
    "- work_type=continuation is only a short conversational follow-up with artifact_type=none, document_required=false, planning_required=false and reply_mode=conversation. A detailed task remains the underlying registered work type even when the same subject appeared earlier; a request to create a document is documentation, not continuation.",
    "- A verification request that explicitly asks to run registered checks, validations, or acceptance checks produces artifact_type=test_report when that registry value exists, even if the owner did not name a report file.",
    "- reply_mode=work requires planning_required=true and a work_type that REGISTERED_ROUTES actually routes.",
    "- planning_required: the answer needs ordered steps rather than a single response.",
    "- human_required: a person must decide or approve before the result can stand.",
    "- document_required: the result belongs in a registered document, not only in the reply.",
    "- needs_questions must equal questions.length > 0, and must be true exactly when reply_mode is clarification.",
    "- questions: 0 to 5 plain-language questions, each one a real choice only the user can make. Never ask what the registry or the project files already answer.",
    "- The supplied project snapshot is proof that downstream roles can use the registered roots and sources. You only route the request; the platform collects matching file contents and Git history after a work route is selected. Never ask the user to paste source files, repository content, diffs or logs that are inside those registered roots.",
    "- A request to inspect registered project code and write the findings into a project document is documentation work: reply_mode=work, planning_required=true and document_required=true. The classifier's own lack of tools is not missing user information and never justifies clarification.",
    "- A request to inspect, understand, explain, or analyze the registered repository without changing it or producing a registered project artifact is bounded research: reply_mode=research. The researcher may inspect the registered project source inventory under a read-only contract and must name the files supporting its answer. A conceptual explanation that explicitly says not to read files, source or the repository is ordinary conversation: reply_mode=conversation. Do not classify that message as research or clarification merely because it mentions project architecture; lack of source access is not missing user information when the user asks for a general explanation. A request that explicitly asks to run registered checks, registered validations, or acceptance checks and report their results is verification (work_type=verification, reply_mode=work), not testing. Testing is development work about designing, adding, or running tests; never use testing for a registry check run. Verification means running registered checks against a claim or result; the word analysis alone never turns repository research into verification.",
    "- pending_interaction_id: the id from PENDING_INTERACTIONS that this message answers, or null. One message often answers every question that was asked, so when it answers several give the list of their ids instead of a single one. A short confirmation is resolved from pending interactions and CURRENT_SESSION_STATE, never from a keyword rule. A new detailed task does not answer an older interaction merely because it mentions the same subject.",
    "- An interaction of kind run_profile_confirmation is the pending next action for this chat. Its objective is the authoritative task and its profile is the exact proposed execution profile. If the current message unambiguously accepts it, name that interaction, set pending_interaction_response=approve, classify the stored objective on its registered work route, and copy the complete stored objective into resolved_objective. If the user refuses or cancels it, set decline and answer conversationally. If the user asks what the profile means, hesitates, adds a condition, or requests a change, set undecided and answer conversationally; the pending action remains open. An unrelated detailed request names no pending profile interaction and is classified as a new request.",
    "- An interaction of kind external_evidence asks for a fact from a live information base, a runtime, a device or a closed contour, described by the evidence contract carried beside it. It cannot be answered in words: only a delivered evidence packet closes it. Set pending_interaction_response to decline when the user refuses or cancels the request, and undecided otherwise, including when the user asserts the fact is true.",
    "- pending_interaction_response: null when pending_interaction_id is null or names an interaction of kind clarification or planner_clarification. When it names any other kind, the user is being asked to decide whether an action may happen, and this field says what they decided: approve only for an unambiguous yes to that exact action, decline for a refusal, undecided for anything else. Doubt, a question back, a condition, a partial agreement and thinking aloud are all undecided: the decision stays open and the user is answered. Treating hesitation as approval takes an action the user never authorized, so undecided is the answer whenever both readings are possible.",
    "- reason: why this classification, in RESPONSE_LANGUAGE.",
    "- resolved_objective: a standalone formulation of exactly what downstream roles must answer or do. Resolve pronouns, confirmations, item numbers and phrases such as 'all three' against CURRENT_SESSION_STATE and PENDING_INTERACTIONS. Preserve every requested item and its order. Do not include internal ids. For a self-contained message, restate it without adding scope. Older events are not present unless requested separately by exact id.",
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
    `CURRENT_SESSION_STATE:${JSON.stringify(currentState)}`,
    `CURRENT_USER_MESSAGE:${JSON.stringify(String(message))}`
  ].join("\n");
  return `${invariant}\n${runState}`;
}
