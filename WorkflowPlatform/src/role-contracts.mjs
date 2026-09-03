import crypto from "node:crypto";
import path from "node:path";
import { escapeXml } from "./limited-xml.mjs";
import { renderQualityContract, validateQualityContract } from "./quality-contracts.mjs";
import { languageName, normalizeLanguage } from "./language.mjs";
import { validateEvidenceContract } from "./interactions.mjs";

const RESULT_SCHEMAS = new Set(["planner.v1", "worker.v1", "reviewer.v1", "judge.v1", "strategy_review.v1", "documentator.v1", "release_operation.v1", "access_change.v1", "conversation.v1"]);

// The validator accepts an exact field set, so the prompt has to state that set. Naming the schema and
// leaving the fields unsaid asks the model to guess a shape that is then rejected for guessing wrong.
// Both the validator and the prompt read these, so the contract shown cannot drift from the one checked.
export const RESULT_SCHEMA_SHAPES = Object.freeze({
  "planner.v1": Object.freeze({
    schema_version: 1,
    outcome: "ready | questions",
    scope: { included: ["string"], excluded: ["string"] },
    allowed_paths: ["path relative to the project root"],
    inputs: ["string"],
    checks: ["registered check id from task_package.registered_checks"],
    risks: ["string"],
    artifacts: [{ key: "string", type: "registered artifact type", path: "path relative to the project root; null is permitted only when type is decision", required: true }],
    completion_criteria: ["string"],
    questions: ["string, at most 5; empty when outcome is ready"],
    steps: [{ key: "string", role: "role id from task_package.registered_roles", objective: "string", allowed_paths: ["subset of the plan allowed_paths"], artifact_keys: ["keys of non-document artifacts this worker creates; final document artifacts belong to the documentator"], check_ids: ["registered check id"], resources: [{ alias: "alias from task_package.registered_resources", mode: "shared to read it, exclusive to change it" }], required: true, irreversible: false, max_attempts: 1 }]
  }),
  "worker.v1": Object.freeze({
    schema_version: 1,
    status: "completed | blocked | failed",
    summary: "string",
    changed_paths: ["path from task_package.allowed_paths"],
    artifacts: [{ key: "key from task_package.artifact_keys", type: "registered artifact type", path: "path from task_package.allowed_paths", content_hash: "64 hex characters or null", status: "created | updated | unchanged" }],
    evidence: ["string"],
    questions: ["string, at most 5"],
    external_evidence_request: "null, or the evidence contract when status is blocked on a fact that exists only outside the project"
  }),
  "reviewer.v1": Object.freeze({
    schema_version: 1,
    decision: "PASS | CHANGES_REQUESTED | REJECT",
    summary: "non-empty string",
    blockers: [{ code: "string", message: "string", path: "path relative to the project root, or null" }],
    required_actions: ["string"],
    evidence_refs: ["string"]
  }),
  "judge.v1": Object.freeze({
    schema_version: 1,
    decision: "PASS | PRIMARY_GAP | TARGETED_VERIFICATION | OWNER_DECISION",
    rationale: "non-empty string",
    evidence_refs: ["string"],
    primary_gap: { kind: "string", message: "string", path: "path relative to the project root, or null", evidence_refs: ["string"], search_intent: "string" },
    verification_request: { kind: "symbol_reference | exact_term | directed_relation | field_flow | path_change | gate_fact", subject: "string", from: "string or null", to: "string or null", path: "path relative to the project root, or null", evidence_refs: ["string"] },
    state_patch: { schema_version: 1, patch_id: "exact id from task_package.state_patch_contract", base_projection_hash: "exact task state projection hash", changes: [{ operation: "replace_active", path: "decisions.judge_resolution" }] }
  }),
  "strategy_review.v1": Object.freeze({
    schema_version: 1,
    decision: "SELECT_EXISTING_STEP | REPLAN | TARGETED_VERIFICATION | OWNER_DECISION | NO_VIABLE_STRATEGY",
    rationale: "non-empty string",
    selected_step_keys: ["existing planner step key"],
    verification_request: { kind: "symbol_reference | exact_term | directed_relation | field_flow | path_change | gate_fact", subject: "string", from: "string or null", to: "string or null", path: "path relative to the project root, or null", evidence_refs: ["string"] },
    replan_intent: "non-empty string or null",
    evidence_refs: ["string"],
    state_patch: { schema_version: 1, patch_id: "exact id from task_package.state_patch_contract", base_projection_hash: "exact task state projection hash", changes: [{ operation: "replace_active", path: "decisions.strategy_recovery" }] }
  }),
  "documentator.v1": Object.freeze({
    schema_version: 1,
    status: "proposed",
    document_id: "id of an allowed registered document",
    expected_version: "sha256:<64 hex> or null",
    operation: "create_document | update_section | append_decision | append_evidence | change_status | supersede_document | create_plan | create_package_record",
    authority: "non-empty string",
    content: "string or null", section_id: "string or null", decision_id: "string or null", evidence_id: "string or null",
    status_value: "string or null", target_tag: "string or null", target_id: "string or null", replacement_id: "string or null"
  }),
  "release_operation.v1": Object.freeze({
    schema_version: 1, status: "proposed", operation_id: "registered external release operation id",
    target_revision: "non-empty immutable revision", target_environment: "non-empty registered deployment target",
    artifact_refs: ["string"], evidence_refs: ["string"], summary: "non-empty string"
  }),
  "access_change.v1": Object.freeze({
    schema_version: 1, status: "proposed", operation_id: "registered external access operation id",
    subject: "non-empty identity", resource: "non-empty registered resource", grant: ["permission"], revoke: ["permission"],
    expires_at: "ISO timestamp or null", evidence_refs: ["string"], summary: "non-empty string"
  }),
  "conversation.v1": Object.freeze({
    schema_version: 1, status: "answered", answer: "non-empty human-facing answer"
  })
});

const schemaFields = key => Object.keys(RESULT_SCHEMA_SHAPES[key]);

function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function exactObject(value, fields, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${name}: object required`);
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name}: fields mismatch missing=${expected.filter(key => !actual.includes(key)).join(",")} extra=${actual.filter(key => !expected.includes(key)).join(",")}`);
  return value;
}
function strings(value, name, max = 100) {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim())) throw new Error(`${name}: non-empty string array required`);
  return value;
}
function relativePath(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.replaceAll("\\", "/").split("/").includes("..")) throw new Error(`${name}: relative project path required`);
  return value.replaceAll("\\", "/");
}
function parsedJsonText(text) { try { return JSON.parse(String(text).trim()); } catch { return null; } }
function fromEnvelope(value) {
  if (!value || typeof value !== "object") return null;
  if (value.schema_version === 1) return value;
  for (const field of [value.result, value.text, value.content, value.item?.text, value.message?.content]) {
    const parsed = typeof field === "string" ? parsedJsonText(field) : null;
    if (parsed) return fromEnvelope(parsed) ?? parsed;
  }
  return null;
}
function receiptObject(receipt) {
  const output = String(receipt?.output ?? "");
  let candidate = fromEnvelope(parsedJsonText(output));
  if (!candidate) for (const line of output.split(/\r?\n/)) candidate = fromEnvelope(parsedJsonText(line)) ?? candidate;
  if (!candidate) throw new Error("ROLE_RESULT_INVALID_JSON");
  return candidate;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function structuredHash(value) { return crypto.createHash("sha256").update(stableJson(value)).digest("hex"); }

export function loadRoleContract(db, projectId, roleId, operationalLevel) {
  const row = db.prepare("SELECT * FROM role_contracts WHERE project_id=? AND role_id=? AND status='active'").get(projectId, roleId);
  if (!row) throw new Error(`ROLE_CONTRACT_NOT_REGISTERED: ${roleId}`);
  if (!RESULT_SCHEMAS.has(row.result_schema_key)) throw new Error(`ROLE_RESULT_SCHEMA_UNKNOWN: ${row.result_schema_key}`);
  const assignment = db.prepare(`SELECT rpa.*,p.provider,p.name AS profile_name FROM role_profile_assignments rpa
    JOIN profiles p ON p.id=rpa.profile_id WHERE rpa.project_id=? AND rpa.role_id=? AND rpa.operational_level=? AND rpa.enabled=1`).get(projectId, roleId, operationalLevel);
  if (!assignment) throw new Error(`ROLE_PROFILE_NOT_ASSIGNED: ${roleId}:${operationalLevel}`);
  const allowedProfiles = parseJson(row.allowed_profiles_json, []);
  // The contract names portable requirement keys, the assignment names a local profile, and the two are
  // separate namespaces because a package carries no local identity. What has to match is the
  // requirement the assignment declares it fulfils, never the local id.
  if (allowedProfiles.length && !allowedProfiles.includes("*")) {
    if (!assignment.satisfies_profile_key) throw new Error(`ROLE_PROFILE_REQUIREMENT_UNDECLARED: ${roleId}:${assignment.profile_id}`);
    if (!allowedProfiles.includes(assignment.satisfies_profile_key)) throw new Error(`ROLE_PROFILE_REQUIREMENT_NOT_ALLOWED: ${assignment.satisfies_profile_key}`);
  }
  return Object.freeze({
    id: row.id, project_id: row.project_id, role_id: row.role_id, version: row.version, purpose: row.purpose,
    boundaries: parseJson(row.boundaries_json, {}), allowed_work_types: parseJson(row.allowed_work_types_json, []),
    allowed_artifact_types: parseJson(row.allowed_artifact_types_json, []), allowed_tools: parseJson(row.allowed_tools_json, []),
    allowed_skills: parseJson(row.allowed_skills_json, []),
    allowed_mcp_servers: parseJson(row.allowed_mcp_servers_json, []),
    native_instruction_files: parseJson(row.native_instruction_files_json, []),
    required_checks: parseJson(row.required_checks_json, []),
    allowed_transitions: parseJson(row.allowed_transitions_json, []), allowed_profiles: allowedProfiles,
    context_limit_bytes: row.context_limit_bytes, max_calls: row.max_calls, max_correction_cycles: row.max_correction_cycles,
    timeout_seconds: row.timeout_seconds, result_schema_key: row.result_schema_key, prompt_template_version: row.prompt_template_version,
    escalation: parseJson(row.escalation_json, {}), provider: assignment.provider, profile_id: assignment.profile_id,
    satisfies_profile_key: assignment.satisfies_profile_key ?? null,
    profile: assignment.profile_name, operational_level: operationalLevel
  });
}

export function rolePrompt({ contract, qualityContract, packageContract, context, resultSchema }) {
  if (contract.result_schema_key !== resultSchema) throw new Error(`ROLE_RESULT_SCHEMA_MISMATCH: ${contract.result_schema_key} != ${resultSchema}`);
  validateQualityContract(qualityContract);
  const responseLanguage = normalizeLanguage(context?.response_language) ?? "en";
  const documentProposalInstruction = resultSchema === "documentator.v1"
    ? "The role proposes a structured document operation only. Do not edit or write the filesystem and do not use file-editing tools: the platform validates, atomically applies and lints the returned proposal after this invocation. For a missing target whose expected_version is null, use create_document and put the complete new semantic document in content."
    : null;
  const workerCompletionInstruction = resultSchema === "worker.v1"
    ? "Return external_evidence_request=null unless you are blocked on a fact that exists only in a live information base, a runtime, a device or another system outside the readable project; in that case return status=blocked with an evidence contract naming evidence_kind, resource.kind, resource.identity, expected_provenance.source, expected_completeness.rule and must_cover, the claims it would establish, and command when a project command would collect it. Missing authority or a missing product decision is a question, not evidence. Treat the task package allowed_paths as the complete authority boundary, not as a reason to request a broader system. A complete-file exact term scan with count zero is conclusive negative evidence inside that boundary. Claim a zero count only when that exact term and path are present in exact_term_scan with count zero; an omitted term is unknown, and a positive count must never be summarized as absent. Reconcile every positive and negative exact-scan claim before returning the result. If a scan proves that a requested identifier or producer is absent, complete the step with that negative finding and the nearest supported facts; do not return blocked or ask for out-of-scope sources merely because no positive producer exists. Return blocked only when the objective cannot be answered even negatively because authorized evidence is genuinely unavailable or unreadable."
    : null;
  const reviewerPhaseInstruction = resultSchema === "reviewer.v1"
    ? "This independent review runs after worker evidence and deterministic gates but before the documentator. Compare the result first with task_package.review_evidence.owner_objective.verbatim and task_package.review_evidence.canonical_completion; planner completion criteria are advisory and never override owner intent, the quality contract, registered gates or completionBlockers. For change evidence, judge the run-relative delta and primary facts, never a builder or worker narrative. For analytical evidence, judge whether the conclusion follows from the supplied primary source ranges and scans. Truncated evidence is not absent evidence, incomplete collection is not a false fact, and failure to find a path in a bounded graph is not proof that the path is missing. A required final document is intentionally not created yet and its absence from worker artifacts or changed_paths is not a blocker. Final receipt totals, calls, tokens, cache, total duration and this invocation's full prompt measurement are platform-generated after review; their absence from review_evidence is not a blocker and they are supplied to the documentator and final run statistics later. Use CHANGES_REQUESTED for an evidence gap that a targeted correction can still address when task_package.remaining_correction_cycles is positive. Reserve REJECT for a fundamental unsafe, unauthorized or contradictory result that another bounded evidence collection cycle cannot repair. The decision fields are conditional and must agree: PASS requires blockers=[] and required_actions=[]; CHANGES_REQUESTED or REJECT requires at least one blocker. Never return PASS while describing a blocker or required action. If task_package.schema_repair is present, correct exactly the reported contract contradiction while preserving the evidence-grounded judgment."
    : null;
  const judgeInstruction = resultSchema === "judge.v1"
    ? "Resolve only the evaluative conflict in the independently recorded opinions after considering task_package.blocker_admissibility. Unsupported, invalid or unknown factual blockers are not vetoes. Truncated evidence is not absence, incomplete collection is not falsehood, and no path in a bounded graph is not a missing edge. Use TARGETED_VERIFICATION for a fact that the deterministic verifier can resolve; use PRIMARY_GAP for an admissible correction gap; use OWNER_DECISION only for a genuine product or authority decision. Nullable payload rule is strict: PRIMARY_GAP requires primary_gap object and verification_request=null; TARGETED_VERIFICATION requires verification_request object and primary_gap=null; PASS and OWNER_DECISION require both fields=null. Never populate both nullable fields. Copy task_package.state_patch_contract.patch_id and base_projection_hash exactly into state_patch and propose only its listed canonical change; the platform rejects stale or broader patches before applying the resolution."
    : resultSchema === "strategy_review.v1"
    ? "Review only the correction strategy, never execute it. Select only keys listed in task_package.available_steps. SELECT_EXISTING_STEP requires one or more selected_step_keys and no replan or verification payload. REPLAN requires replan_intent and no selected steps or verification payload. TARGETED_VERIFICATION requires verification_request and no selected steps or replan. OWNER_DECISION and NO_VIABLE_STRATEGY require no selected steps, verification request or replan intent. NO_VIABLE_STRATEGY means no bounded evidence, existing-step, verification, replan or owner-decision path remains. Copy task_package.state_patch_contract.patch_id and base_projection_hash exactly into state_patch and propose only its listed canonical changes; the platform rejects stale or broader patches before applying the decision."
    : null;
  const conversationInstruction = resultSchema === "conversation.v1"
    ? "Answer the owner's current question directly and use the supplied conversation history to resolve short follow-ups. Do not classify the message, describe a route, repeat a private reason, invent a tool result or expose internal workflow state. Return only the human-facing answer in the answer field."
    : null;
  const toolAuthorityInstruction = contract.allowed_tools.length
    ? "Only the tools listed in allowed_tools are authorized. The supplied context remains the primary evidence package."
    : "No tool calls are authorized for this role. Do not invoke shell, search, file-read, file-write or network tools; analyze only the evidence already present in project_context and task_package.";
  return `<workflow_role_prompt schema_version="2" prompt_template_version="${escapeXml(contract.prompt_template_version)}">\n`+
    `  <role_contract id="${escapeXml(contract.role_id)}" version="${escapeXml(contract.version)}">\n`+
    `    <purpose>${escapeXml(contract.purpose)}</purpose>\n`+
    `    <boundaries format="application/json">${escapeXml(stableJson(contract.boundaries))}</boundaries>\n`+
    `    <allowed_tools format="application/json">${escapeXml(stableJson(contract.allowed_tools))}</allowed_tools>\n`+
    `    <tool_authority>${escapeXml(toolAuthorityInstruction)}</tool_authority>\n`+
    // The role works from the context the platform assembled for it and does not go looking for more:
    // deterministic collection is what makes a run repeatable and its cost bounded. Saying so is not
    // decoration — a role that was only told it had no tools concluded the sources were unreachable and
    // asked the owner to paste them in, when the real fault was that collection had not supplied them.
    `    <supplied_context>Everything this role may use was collected for it and appears in project_context and task_package: the platform reads the project, not the role. Do not ask the owner for sources, history or paths that collection is expected to provide. If something needed is genuinely absent, say which path or which root is missing and stop; that is a gap in collection and it is fixed there.</supplied_context>\n`+
    `    <allowed_skills format="application/json">${escapeXml(stableJson(contract.allowed_skills))}</allowed_skills>\n`+
    `    <allowed_mcp_servers format="application/json">${escapeXml(stableJson(contract.allowed_mcp_servers ?? []))}</allowed_mcp_servers>\n`+
    `    <native_instruction_files format="application/json">${escapeXml(stableJson(contract.native_instruction_files ?? []))}</native_instruction_files>\n`+
    `  </role_contract>\n`+
    `${renderQualityContract(qualityContract, "  ")}\n`+
    `  <communication language="${responseLanguage}">Write summaries, questions and other human-facing values in ${languageName(responseLanguage)}. Keep JSON keys, enum values, paths and machine identifiers in English.</communication>\n`+
    `  <project_context format="application/json">${escapeXml(stableJson(context ?? {}))}</project_context>\n`+
    `  <result_contract schema="${escapeXml(resultSchema)}">\n`+
    `    <instruction>Return exactly one JSON object carrying exactly the fields of the shape below: no field missing and no field added. A value written as "a | b" lists the only permitted values; any other value states the type expected there. Do not wrap the object in Markdown and do not expose private reasoning.</instruction>\n`+
    (workerCompletionInstruction ? `    <completion_semantics>${escapeXml(workerCompletionInstruction)}</completion_semantics>\n` : "")+
    (reviewerPhaseInstruction ? `    <review_phase>${escapeXml(reviewerPhaseInstruction)}</review_phase>\n` : "")+
    (judgeInstruction ? `    <judge_semantics>${escapeXml(judgeInstruction)}</judge_semantics>\n` : "")+
    (conversationInstruction ? `    <conversation_semantics>${escapeXml(conversationInstruction)}</conversation_semantics>\n` : "")+
    (documentProposalInstruction ? `    <document_proposal>${escapeXml(documentProposalInstruction)}</document_proposal>\n` : "")+
    `    <shape format="application/json">${escapeXml(stableJson(RESULT_SCHEMA_SHAPES[resultSchema] ?? {}))}</shape>\n`+
    `  </result_contract>\n`+
    `  <task_package format="application/json">${escapeXml(stableJson(packageContract ?? {}))}</task_package>\n`+
    `</workflow_role_prompt>`;
}

export function validatePlannerResult(value, { contract, registeredRoles = [], registeredChecks = [], registeredArtifactTypes = [], registeredResources = [], maxStepAttempts = null, allowEmptyReadyPlan = false }) {
  exactObject(value, schemaFields("planner.v1"), "planner.v1");
  if (value.schema_version !== 1 || !["ready", "questions"].includes(value.outcome)) throw new Error("planner.v1: invalid version or outcome");
  exactObject(value.scope, ["included", "excluded"], "planner.v1.scope");
  strings(value.scope.included, "planner.v1.scope.included"); strings(value.scope.excluded, "planner.v1.scope.excluded");
  value.allowed_paths = strings(value.allowed_paths, "planner.v1.allowed_paths").map(item => relativePath(item, "planner.v1.allowed_paths"));
  strings(value.inputs, "planner.v1.inputs"); strings(value.checks, "planner.v1.checks"); strings(value.risks, "planner.v1.risks");
  strings(value.completion_criteria, "planner.v1.completion_criteria"); strings(value.questions, "planner.v1.questions", 5);
  for (const check of value.checks) if (!registeredChecks.includes(check)) throw new Error(`planner.v1: unregistered check ${check}`);
  value.artifacts = value.artifacts.map(item => {
    exactObject(item, ["key", "type", "path", "required"], "planner.v1.artifact");
    if (typeof item.key !== "string" || !item.key || typeof item.required !== "boolean") throw new Error("planner.v1.artifact: invalid key or required");
    if (!registeredArtifactTypes.includes(item.type) || !contract.allowed_artifact_types.includes(item.type)) throw new Error(`planner.v1.artifact: type not allowed ${item.type}`);
    const artifactPath = relativePath(item.path, "planner.v1.artifact.path", { nullable: true });
    // A pathless planner artifact is carried by the structured role receipt. Today the only native
    // runtime entity with those semantics is a decision; every other artifact is file-backed and must
    // name the file that the worker will return and the platform will hash.
    if (artifactPath === null && item.type !== "decision") throw new Error("planner.v1.artifact: only decision may have a null path");
    return { ...item, path: artifactPath };
  });
  value.steps = value.steps.map(item => {
    exactObject(item, ["key", "role", "objective", "allowed_paths", "artifact_keys", "check_ids", "resources", "required", "irreversible", "max_attempts"], "planner.v1.step");
    if (!registeredRoles.includes(item.role)) throw new Error(`planner.v1.step: unregistered role ${item.role}`);
    if (typeof item.key !== "string" || !item.key || typeof item.objective !== "string" || !item.objective || typeof item.required !== "boolean" || typeof item.irreversible !== "boolean" || !Number.isInteger(item.max_attempts) || item.max_attempts < 1) throw new Error("planner.v1.step: invalid scalar field");
    if (maxStepAttempts !== null && item.max_attempts > maxStepAttempts) throw new Error(`planner.v1.step: max_attempts exceeds quality contract for ${item.key}`);
    const allowed = strings(item.allowed_paths, "planner.v1.step.allowed_paths").map(entry => relativePath(entry, "planner.v1.step.allowed_paths"));
    if (allowed.some(entry => !value.allowed_paths.includes(entry))) throw new Error("planner.v1.step: path outside plan allowlist");
    const artifactKeys = strings(item.artifact_keys, "planner.v1.step.artifact_keys");
    for (const key of artifactKeys) if (!value.artifacts.some(artifact => artifact.key === key)) throw new Error(`planner.v1.step: unknown artifact ${key}`);
    for (const check of strings(item.check_ids, "planner.v1.step.check_ids")) if (!registeredChecks.includes(check)) throw new Error(`planner.v1.step: unregistered check ${check}`);
    // A step says which registered resources it touches and how. It names them by alias and never by
    // path, host or information base: an authority a planner composes is a resource nobody registered,
    // and a second spelling of one resource is a second lock that does not see the first.
    if (!Array.isArray(item.resources) || item.resources.length > 16) throw new Error("planner.v1.step.resources: list required");
    for (const resource of item.resources) {
      exactObject(resource, ["alias", "mode"], "planner.v1.step.resource");
      if (!registeredResources.some(registered => registered.alias === resource.alias)) throw new Error(`planner.v1.step.resource: unregistered alias ${resource.alias}`);
      if (!["shared", "exclusive"].includes(resource.mode)) throw new Error(`planner.v1.step.resource: invalid mode ${resource.mode}`);
    }
    // The documentator owns final documents after workers and gates complete. A planner sometimes assigns
    // that final key to every analytical step; carrying it forward would require each read-only worker to
    // create the same file. Paths outside a step's own allowlist are equally impossible outputs, so both
    // forms are removed while the plan-level artifact remains available to the documentator.
    const producibleArtifactKeys = artifactKeys.filter(key => {
      const artifact = value.artifacts.find(candidate => candidate.key === key);
      return artifact.type !== "document" && (artifact.path === null || allowed.includes(artifact.path));
    });
    return { ...item, allowed_paths: allowed, artifact_keys: producibleArtifactKeys };
  });
  if (value.outcome === "questions" && !value.questions.length) throw new Error("planner.v1: questions outcome requires questions");
  // A documentation-only route has no pre-documentation worker: the platform itself runs the gate,
  // review and documentator phases after the planner. Keep the normal non-empty-plan rule everywhere
  // else, and require the executor to opt into this narrow route explicitly.
  if (value.outcome === "ready" && ((!value.steps.length && !allowEmptyReadyPlan) || value.questions.length)) throw new Error("planner.v1: ready outcome requires steps and no questions");
  return value;
}

export function validateWorkerResult(value, { contract, packageContract }) {
  exactObject(value, schemaFields("worker.v1"), "worker.v1");
  if (value.schema_version !== 1 || !["completed", "blocked", "failed"].includes(value.status) || typeof value.summary !== "string") throw new Error("worker.v1: invalid scalar field");
  value.changed_paths = strings(value.changed_paths, "worker.v1.changed_paths").map(item => relativePath(item, "worker.v1.changed_paths"));
  if (value.changed_paths.some(item => !packageContract.allowed_paths.includes(item))) throw new Error("worker.v1: changed path outside package allowlist");
  strings(value.evidence, "worker.v1.evidence"); strings(value.questions, "worker.v1.questions", 5);
  // Blocked used to be a dead end: the run stopped and nobody was asked for the thing that was missing.
  // A blocked worker now says which of the two waits it is in. Questions are for a decision only a person
  // can make; this contract is for a fact that no readable file contains, and it has to be specific
  // enough that a delivered packet can be checked against it rather than accepted on its say-so.
  if (value.external_evidence_request !== null) {
    if (value.status !== "blocked") throw new Error("worker.v1: external_evidence_request requires status blocked");
    value.external_evidence_request = validateEvidenceContract(value.external_evidence_request);
  }
  value.artifacts = value.artifacts.map(item => {
    exactObject(item, ["key", "type", "path", "content_hash", "status"], "worker.v1.artifact");
    if (!packageContract.artifact_keys.includes(item.key) || !contract.allowed_artifact_types.includes(item.type)) throw new Error("worker.v1.artifact: artifact not allowed");
    if (!packageContract.allowed_paths.includes(relativePath(item.path, "worker.v1.artifact.path"))) throw new Error("worker.v1.artifact: path outside package allowlist");
    if (item.content_hash !== null && (typeof item.content_hash !== "string" || !/^[0-9a-f]{64}$/.test(item.content_hash))) throw new Error("worker.v1.artifact: invalid hash");
    if (!["created", "updated", "unchanged"].includes(item.status)) throw new Error("worker.v1.artifact: invalid status");
    return item;
  });
  return value;
}

export function validateReviewerResult(value) {
  exactObject(value, schemaFields("reviewer.v1"), "reviewer.v1");
  if (value.schema_version !== 1 || !["PASS", "CHANGES_REQUESTED", "REJECT"].includes(value.decision) || typeof value.summary !== "string" || !value.summary.trim()) throw new Error("reviewer.v1: invalid scalar field");
  strings(value.required_actions, "reviewer.v1.required_actions"); strings(value.evidence_refs, "reviewer.v1.evidence_refs");
  value.blockers = value.blockers.map(item => {
    exactObject(item, ["code", "message", "path"], "reviewer.v1.blocker");
    if (typeof item.code !== "string" || !item.code || typeof item.message !== "string" || !item.message) throw new Error("reviewer.v1.blocker: invalid");
    return { ...item, path: relativePath(item.path, "reviewer.v1.blocker.path", { nullable: true }) };
  });
  if (value.decision === "PASS" && (value.blockers.length || value.required_actions.length)) throw new Error("reviewer.v1: PASS cannot contain blockers");
  if (value.decision !== "PASS" && !value.blockers.length) throw new Error("reviewer.v1: non-PASS requires blockers");
  return value;
}

export function validateJudgeResult(value, { statePatchContract = null } = {}) {
  exactObject(value, schemaFields("judge.v1"), "judge.v1");
  if (value.schema_version !== 1 || !["PASS", "PRIMARY_GAP", "TARGETED_VERIFICATION", "OWNER_DECISION"].includes(value.decision) || typeof value.rationale !== "string" || !value.rationale.trim()) throw new Error("judge.v1: invalid scalar field");
  strings(value.evidence_refs, "judge.v1.evidence_refs");
  if (value.primary_gap !== null) {
    exactObject(value.primary_gap, ["kind", "message", "path", "evidence_refs", "search_intent"], "judge.v1.primary_gap");
    if (![value.primary_gap.kind, value.primary_gap.message, value.primary_gap.search_intent].every(item => typeof item === "string" && item.trim())) throw new Error("judge.v1.primary_gap: invalid scalar field");
    value.primary_gap.path = relativePath(value.primary_gap.path, "judge.v1.primary_gap.path", { nullable: true });
    strings(value.primary_gap.evidence_refs, "judge.v1.primary_gap.evidence_refs");
  }
  if (value.verification_request !== null) {
    exactObject(value.verification_request, ["kind", "subject", "from", "to", "path", "evidence_refs"], "judge.v1.verification_request");
    if (!["symbol_reference", "exact_term", "directed_relation", "field_flow", "path_change", "gate_fact"].includes(value.verification_request.kind) || typeof value.verification_request.subject !== "string" || !value.verification_request.subject.trim()) throw new Error("judge.v1.verification_request: invalid scalar field");
    for (const key of ["from", "to"]) if (value.verification_request[key] !== null && (typeof value.verification_request[key] !== "string" || !value.verification_request[key].trim())) throw new Error(`judge.v1.verification_request.${key}: string or null required`);
    value.verification_request.path = relativePath(value.verification_request.path, "judge.v1.verification_request.path", { nullable: true });
    strings(value.verification_request.evidence_refs, "judge.v1.verification_request.evidence_refs");
  }
  const requiresGap = value.decision === "PRIMARY_GAP";
  const requiresVerification = value.decision === "TARGETED_VERIFICATION";
  if (requiresGap !== Boolean(value.primary_gap) || requiresVerification !== Boolean(value.verification_request)) throw new Error("judge.v1: decision payload mismatch");
  if (!["PRIMARY_GAP"].includes(value.decision) && value.primary_gap !== null) throw new Error("judge.v1: primary_gap only allowed for PRIMARY_GAP");
  if (!["TARGETED_VERIFICATION"].includes(value.decision) && value.verification_request !== null) throw new Error("judge.v1: verification_request only allowed for TARGETED_VERIFICATION");
  exactObject(value.state_patch, ["schema_version", "patch_id", "base_projection_hash", "changes"], "judge.v1.state_patch");
  if (value.state_patch.schema_version !== 1 || !/^[0-9a-f]{64}$/.test(value.state_patch.base_projection_hash) || typeof value.state_patch.patch_id !== "string" || !value.state_patch.patch_id) throw new Error("judge.v1: invalid state patch identity");
  if (!Array.isArray(value.state_patch.changes) || value.state_patch.changes.length !== 1) throw new Error("judge.v1: invalid state patch changes");
  exactObject(value.state_patch.changes[0], ["operation", "path"], "judge.v1.state_patch.change");
  if (value.state_patch.changes[0].operation !== "replace_active" || value.state_patch.changes[0].path !== "decisions.judge_resolution") throw new Error("judge.v1: state patch field not allowed");
  if (statePatchContract && (value.state_patch.patch_id !== statePatchContract.patch_id || value.state_patch.base_projection_hash !== statePatchContract.base_projection_hash)) throw new Error("judge.v1: state patch contract mismatch");
  return value;
}

export function validateStrategyReviewResult(value, { availableStepKeys = [], statePatchContract = null } = {}) {
  exactObject(value, schemaFields("strategy_review.v1"), "strategy_review.v1");
  if (value.schema_version !== 1 || !["SELECT_EXISTING_STEP", "REPLAN", "TARGETED_VERIFICATION", "OWNER_DECISION", "NO_VIABLE_STRATEGY"].includes(value.decision) || typeof value.rationale !== "string" || !value.rationale.trim()) throw new Error("strategy_review.v1: invalid scalar field");
  strings(value.selected_step_keys, "strategy_review.v1.selected_step_keys");
  if (value.selected_step_keys.some(key => !availableStepKeys.includes(key))) throw new Error("strategy_review.v1: unknown selected step");
  strings(value.evidence_refs, "strategy_review.v1.evidence_refs");
  if (value.replan_intent !== null && (typeof value.replan_intent !== "string" || !value.replan_intent.trim())) throw new Error("strategy_review.v1: invalid replan_intent");
  if (value.verification_request !== null) {
    exactObject(value.verification_request, ["kind", "subject", "from", "to", "path", "evidence_refs"], "strategy_review.v1.verification_request");
    if (!["symbol_reference", "exact_term", "directed_relation", "field_flow", "path_change", "gate_fact"].includes(value.verification_request.kind) || typeof value.verification_request.subject !== "string" || !value.verification_request.subject.trim()) throw new Error("strategy_review.v1.verification_request: invalid");
    for (const key of ["from", "to"]) if (value.verification_request[key] !== null && (typeof value.verification_request[key] !== "string" || !value.verification_request[key].trim())) throw new Error(`strategy_review.v1.verification_request.${key}: string or null required`);
    value.verification_request.path = relativePath(value.verification_request.path, "strategy_review.v1.verification_request.path", { nullable: true });
    strings(value.verification_request.evidence_refs, "strategy_review.v1.verification_request.evidence_refs");
  }
  const selected = value.selected_step_keys.length > 0, verification = Boolean(value.verification_request), replan = Boolean(value.replan_intent);
  if ((value.decision === "SELECT_EXISTING_STEP") !== selected || (value.decision === "TARGETED_VERIFICATION") !== verification || (value.decision === "REPLAN") !== replan) throw new Error("strategy_review.v1: decision payload mismatch");
  exactObject(value.state_patch, ["schema_version", "patch_id", "base_projection_hash", "changes"], "strategy_review.v1.state_patch");
  if (value.state_patch.schema_version !== 1 || !/^[0-9a-f]{64}$/.test(value.state_patch.base_projection_hash) || typeof value.state_patch.patch_id !== "string" || !value.state_patch.patch_id) throw new Error("strategy_review.v1: invalid state patch identity");
  if (!Array.isArray(value.state_patch.changes) || value.state_patch.changes.length !== 1) throw new Error("strategy_review.v1: invalid state patch changes");
  exactObject(value.state_patch.changes[0], ["operation", "path"], "strategy_review.v1.state_patch.change");
  if (value.state_patch.changes[0].operation !== "replace_active" || value.state_patch.changes[0].path !== "decisions.strategy_recovery") throw new Error("strategy_review.v1: state patch field not allowed");
  if (statePatchContract && (value.state_patch.patch_id !== statePatchContract.patch_id || value.state_patch.base_projection_hash !== statePatchContract.base_projection_hash)) throw new Error("strategy_review.v1: state patch contract mismatch");
  return value;
}

export function validateDocumentatorResult(value, { allowedDocumentIds }) {
  exactObject(value, schemaFields("documentator.v1"), "documentator.v1");
  if (value.schema_version !== 1 || value.status !== "proposed" || !allowedDocumentIds.includes(value.document_id)) throw new Error("documentator.v1: document not allowed");
  if (value.expected_version !== null && (typeof value.expected_version !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.expected_version))) throw new Error("documentator.v1: invalid expected_version");
  const operations = ["create_document", "update_section", "append_decision", "append_evidence", "change_status", "supersede_document", "create_plan", "create_package_record"];
  if (!operations.includes(value.operation) || typeof value.authority !== "string" || !value.authority) throw new Error("documentator.v1: invalid operation or authority");
  for (const field of ["content", "section_id", "decision_id", "evidence_id", "status_value", "target_tag", "target_id", "replacement_id"]) if (value[field] !== null && typeof value[field] !== "string") throw new Error(`documentator.v1: ${field} must be string or null`);
  return value;
}

function validateOperationId(value, allowedOperationIds, schema) {
  if (typeof value !== "string" || !value || !allowedOperationIds.includes(value)) throw new Error(`${schema}: operation not registered`);
}

export function validateReleaseOperationResult(value, { allowedOperationIds = [] } = {}) {
  exactObject(value, schemaFields("release_operation.v1"), "release_operation.v1");
  if (value.schema_version !== 1 || value.status !== "proposed") throw new Error("release_operation.v1: invalid version or status");
  validateOperationId(value.operation_id, allowedOperationIds, "release_operation.v1");
  for (const field of ["target_revision", "target_environment", "summary"]) if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`release_operation.v1: ${field} required`);
  strings(value.artifact_refs, "release_operation.v1.artifact_refs");
  strings(value.evidence_refs, "release_operation.v1.evidence_refs");
  return value;
}

export function validateAccessChangeResult(value, { allowedOperationIds = [] } = {}) {
  exactObject(value, schemaFields("access_change.v1"), "access_change.v1");
  if (value.schema_version !== 1 || value.status !== "proposed") throw new Error("access_change.v1: invalid version or status");
  validateOperationId(value.operation_id, allowedOperationIds, "access_change.v1");
  for (const field of ["subject", "resource", "summary"]) if (typeof value[field] !== "string" || !value[field].trim()) throw new Error(`access_change.v1: ${field} required`);
  strings(value.grant, "access_change.v1.grant"); strings(value.revoke, "access_change.v1.revoke"); strings(value.evidence_refs, "access_change.v1.evidence_refs");
  if (!value.grant.length && !value.revoke.length) throw new Error("access_change.v1: empty permission delta");
  if (value.expires_at !== null && !Number.isFinite(Date.parse(value.expires_at))) throw new Error("access_change.v1: invalid expires_at");
  return value;
}

export function validateConversationResult(value) {
  exactObject(value, schemaFields("conversation.v1"), "conversation.v1");
  if (value.schema_version !== 1 || value.status !== "answered") throw new Error("conversation.v1: invalid version or status");
  if (typeof value.answer !== "string" || !value.answer.trim() || value.answer.length > 20000) throw new Error("conversation.v1: non-empty answer required");
  return { ...value, answer: value.answer.trim() };
}

export function parseRoleReceipt(receipt, schemaKey, options) {
  const value = receiptObject(receipt);
  if (schemaKey === "planner.v1") return validatePlannerResult(value, options);
  if (schemaKey === "worker.v1") return validateWorkerResult(value, options);
  if (schemaKey === "reviewer.v1") return validateReviewerResult(value, options);
  if (schemaKey === "judge.v1") return validateJudgeResult(value, options);
  if (schemaKey === "strategy_review.v1") return validateStrategyReviewResult(value, options);
  if (schemaKey === "documentator.v1") return validateDocumentatorResult(value, options);
  if (schemaKey === "release_operation.v1") return validateReleaseOperationResult(value, options);
  if (schemaKey === "access_change.v1") return validateAccessChangeResult(value, options);
  if (schemaKey === "conversation.v1") return validateConversationResult(value, options);
  throw new Error(`ROLE_RESULT_SCHEMA_UNKNOWN: ${schemaKey}`);
}
