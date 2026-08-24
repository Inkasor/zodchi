import crypto from "node:crypto";
import path from "node:path";
import { escapeXml } from "./limited-xml.mjs";
import { renderQualityContract, validateQualityContract } from "./quality-contracts.mjs";

const RESULT_SCHEMAS = new Set(["planner.v1", "worker.v1", "reviewer.v1", "documentator.v1"]);

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
  if (allowedProfiles.length && !allowedProfiles.includes(assignment.profile_id) && !allowedProfiles.includes("*")) throw new Error(`ROLE_PROFILE_NOT_ALLOWED: ${assignment.profile_id}`);
  return Object.freeze({
    id: row.id, project_id: row.project_id, role_id: row.role_id, version: row.version, purpose: row.purpose,
    boundaries: parseJson(row.boundaries_json, {}), allowed_work_types: parseJson(row.allowed_work_types_json, []),
    allowed_artifact_types: parseJson(row.allowed_artifact_types_json, []), allowed_tools: parseJson(row.allowed_tools_json, []),
    allowed_skills: parseJson(row.allowed_skills_json, []), required_checks: parseJson(row.required_checks_json, []),
    allowed_transitions: parseJson(row.allowed_transitions_json, []), allowed_profiles: allowedProfiles,
    context_limit_bytes: row.context_limit_bytes, max_calls: row.max_calls, max_correction_cycles: row.max_correction_cycles,
    timeout_seconds: row.timeout_seconds, result_schema_key: row.result_schema_key, prompt_template_version: row.prompt_template_version,
    escalation: parseJson(row.escalation_json, {}), provider: assignment.provider, profile_id: assignment.profile_id,
    profile: assignment.profile_name, operational_level: operationalLevel
  });
}

export function rolePrompt({ contract, qualityContract, packageContract, context, resultSchema }) {
  if (contract.result_schema_key !== resultSchema) throw new Error(`ROLE_RESULT_SCHEMA_MISMATCH: ${contract.result_schema_key} != ${resultSchema}`);
  validateQualityContract(qualityContract);
  return `<workflow_role_prompt schema_version="2" prompt_template_version="${escapeXml(contract.prompt_template_version)}">\n`+
    `  <role_contract id="${escapeXml(contract.role_id)}" version="${escapeXml(contract.version)}">\n`+
    `    <purpose>${escapeXml(contract.purpose)}</purpose>\n`+
    `    <boundaries format="application/json">${escapeXml(stableJson(contract.boundaries))}</boundaries>\n`+
    `    <allowed_tools format="application/json">${escapeXml(stableJson(contract.allowed_tools))}</allowed_tools>\n`+
    `    <allowed_skills format="application/json">${escapeXml(stableJson(contract.allowed_skills))}</allowed_skills>\n`+
    `  </role_contract>\n`+
    `${renderQualityContract(qualityContract, "  ")}\n`+
    `  <project_context format="application/json">${escapeXml(stableJson(context ?? {}))}</project_context>\n`+
    `  <result_contract schema="${escapeXml(resultSchema)}">Return exactly one JSON object matching this schema. Do not wrap it in Markdown and do not expose private reasoning.</result_contract>\n`+
    `  <task_package format="application/json">${escapeXml(stableJson(packageContract ?? {}))}</task_package>\n`+
    `</workflow_role_prompt>`;
}

export function validatePlannerResult(value, { contract, registeredRoles = [], registeredChecks = [], registeredArtifactTypes = [], maxStepAttempts = null }) {
  exactObject(value, ["schema_version", "outcome", "scope", "allowed_paths", "inputs", "checks", "risks", "artifacts", "completion_criteria", "questions", "steps"], "planner.v1");
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
    return { ...item, path: relativePath(item.path, "planner.v1.artifact.path", { nullable: true }) };
  });
  value.steps = value.steps.map(item => {
    exactObject(item, ["key", "role", "objective", "allowed_paths", "artifact_keys", "check_ids", "required", "irreversible", "max_attempts"], "planner.v1.step");
    if (!registeredRoles.includes(item.role)) throw new Error(`planner.v1.step: unregistered role ${item.role}`);
    if (typeof item.key !== "string" || !item.key || typeof item.objective !== "string" || !item.objective || typeof item.required !== "boolean" || typeof item.irreversible !== "boolean" || !Number.isInteger(item.max_attempts) || item.max_attempts < 1) throw new Error("planner.v1.step: invalid scalar field");
    if (maxStepAttempts !== null && item.max_attempts > maxStepAttempts) throw new Error(`planner.v1.step: max_attempts exceeds quality contract for ${item.key}`);
    const allowed = strings(item.allowed_paths, "planner.v1.step.allowed_paths").map(entry => relativePath(entry, "planner.v1.step.allowed_paths"));
    if (allowed.some(entry => !value.allowed_paths.includes(entry))) throw new Error("planner.v1.step: path outside plan allowlist");
    for (const key of strings(item.artifact_keys, "planner.v1.step.artifact_keys")) if (!value.artifacts.some(artifact => artifact.key === key)) throw new Error(`planner.v1.step: unknown artifact ${key}`);
    for (const check of strings(item.check_ids, "planner.v1.step.check_ids")) if (!registeredChecks.includes(check)) throw new Error(`planner.v1.step: unregistered check ${check}`);
    return { ...item, allowed_paths: allowed };
  });
  if (value.outcome === "questions" && !value.questions.length) throw new Error("planner.v1: questions outcome requires questions");
  if (value.outcome === "ready" && (!value.steps.length || value.questions.length)) throw new Error("planner.v1: ready outcome requires steps and no questions");
  return value;
}

export function validateWorkerResult(value, { contract, packageContract }) {
  exactObject(value, ["schema_version", "status", "summary", "changed_paths", "artifacts", "evidence", "questions"], "worker.v1");
  if (value.schema_version !== 1 || !["completed", "blocked", "failed"].includes(value.status) || typeof value.summary !== "string") throw new Error("worker.v1: invalid scalar field");
  value.changed_paths = strings(value.changed_paths, "worker.v1.changed_paths").map(item => relativePath(item, "worker.v1.changed_paths"));
  if (value.changed_paths.some(item => !packageContract.allowed_paths.includes(item))) throw new Error("worker.v1: changed path outside package allowlist");
  strings(value.evidence, "worker.v1.evidence"); strings(value.questions, "worker.v1.questions", 5);
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
  exactObject(value, ["schema_version", "decision", "summary", "blockers", "required_actions", "evidence_refs"], "reviewer.v1");
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

export function validateDocumentatorResult(value, { allowedDocumentIds }) {
  exactObject(value, ["schema_version", "status", "document_id", "expected_version", "operation", "authority", "content", "section_id", "decision_id", "evidence_id", "status_value", "target_tag", "target_id", "replacement_id"], "documentator.v1");
  if (value.schema_version !== 1 || value.status !== "proposed" || !allowedDocumentIds.includes(value.document_id)) throw new Error("documentator.v1: document not allowed");
  if (value.expected_version !== null && (typeof value.expected_version !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.expected_version))) throw new Error("documentator.v1: invalid expected_version");
  if (typeof value.operation !== "string" || typeof value.authority !== "string" || !value.authority) throw new Error("documentator.v1: invalid operation or authority");
  for (const field of ["content", "section_id", "decision_id", "evidence_id", "status_value", "target_tag", "target_id", "replacement_id"]) if (value[field] !== null && typeof value[field] !== "string") throw new Error(`documentator.v1: ${field} must be string or null`);
  return value;
}

export function parseRoleReceipt(receipt, schemaKey, options) {
  const value = receiptObject(receipt);
  if (schemaKey === "planner.v1") return validatePlannerResult(value, options);
  if (schemaKey === "worker.v1") return validateWorkerResult(value, options);
  if (schemaKey === "reviewer.v1") return validateReviewerResult(value, options);
  if (schemaKey === "documentator.v1") return validateDocumentatorResult(value, options);
  throw new Error(`ROLE_RESULT_SCHEMA_UNKNOWN: ${schemaKey}`);
}
