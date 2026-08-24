import { openDb, now } from "./db.mjs";
import { stableJson, structuredHash } from "./role-contracts.mjs";
import { buildWorkflowPackageValue } from "./workflow-package.mjs";

const CHANGE_TYPES = new Set(["role_contract", "prompt_template", "check", "route"]);
const OBSERVATION_FIELDS = ["schema_version", "project_id", "package_key", "package_version", "scenario_key", "role_key", "structured_result", "error_category", "gate_outcomes", "human_feedback", "metrics"];
const METRIC_FIELDS = ["calls", "input_tokens", "output_tokens", "cached_tokens", "duration_ms", "cost_usd"];
const EVALUATION_FIELDS = ["passed", "quality_score", "cost_usd", "duration_ms"];
const RAW_FIELDS = new Set(["prompt", "raw_prompt", "output", "raw_output", "stdout", "stderr", "transcript", "conversation"]);

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: object required`);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label}: exact fields required`);
  return value;
}
function finite(value, label, nullable = false) { if (nullable && value === null) return value; if (!Number.isFinite(value) || value < 0) throw new Error(`${label}: non-negative number required`); return value; }
function nextPatch(version) { const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/); if (!match) throw new Error("EXPERIENCE_BASE_VERSION_INVALID"); return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`; }
function id(prefix, value) { return `${prefix}_${structuredHash([value, Date.now(), Math.random()]).slice(0, 20)}`; }
function rejectRawFields(value, location = "structured_result") { if (Array.isArray(value)) return value.forEach((item, index) => rejectRawFields(item, `${location}[${index}]`)); if (!value || typeof value !== "object") return; for (const [name, item] of Object.entries(value)) { if (RAW_FIELDS.has(name.toLowerCase())) throw new Error(`${location}.${name}: raw provider content forbidden`); rejectRawFields(item, `${location}.${name}`); } }

export function recordExperienceObservation(dbFile, input) {
  exact(input, OBSERVATION_FIELDS, "experience_observation");
  if (input.schema_version !== 1) throw new Error("experience_observation: unsupported schema");
  if (!input.structured_result && !input.error_category && !(input.gate_outcomes?.length) && !input.human_feedback) throw new Error("experience_observation: structured evidence required");
  if (input.structured_result && (typeof input.structured_result !== "object" || Array.isArray(input.structured_result))) throw new Error("experience_observation.structured_result: object required");
  rejectRawFields(input.structured_result);
  if (!Array.isArray(input.gate_outcomes)) throw new Error("experience_observation.gate_outcomes: array required");
  for (const gate of input.gate_outcomes) { exact(gate, ["key", "status"], "experience_observation.gate"); if (!String(gate.key ?? "").trim() || !["passed", "failed", "timed_out", "unavailable", "skipped"].includes(gate.status)) throw new Error("experience_observation.gate: invalid outcome"); }
  if (input.human_feedback) { exact(input.human_feedback, ["outcome", "confirmed_by", "note"], "human_feedback"); if (!String(input.human_feedback.confirmed_by ?? "").trim()) throw new Error("human_feedback: confirmation required"); }
  exact(input.metrics, METRIC_FIELDS, "experience_observation.metrics");
  for (const name of METRIC_FIELDS) finite(input.metrics[name], `metrics.${name}`, name === "cost_usd");
  const db = openDb(dbFile), observationId = id("obs", input.project_id);
  try {
    if (!db.prepare("SELECT 1 FROM workflow_package_releases WHERE project_id=? AND package_key=? AND version=?").get(input.project_id, input.package_key, input.package_version)) throw new Error("EXPERIENCE_PACKAGE_VERSION_NOT_FOUND");
    db.prepare(`INSERT INTO experience_observations(id,project_id,package_key,package_version,scenario_key,role_key,structured_result_json,error_category,gate_outcomes_json,human_feedback_json,calls,input_tokens,output_tokens,cached_tokens,duration_ms,cost_usd,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(observationId, input.project_id, input.package_key, input.package_version, input.scenario_key, input.role_key, input.structured_result ? stableJson(input.structured_result) : null, input.error_category, stableJson(input.gate_outcomes), input.human_feedback ? stableJson(input.human_feedback) : null, input.metrics.calls, input.metrics.input_tokens, input.metrics.output_tokens, input.metrics.cached_tokens, input.metrics.duration_ms, input.metrics.cost_usd, now());
    return { status: "recorded", observation_id: observationId };
  } finally { db.close(); }
}

export function createExperienceProposal(dbFile, input) {
  exact(input, ["project_id", "package_key", "base_version", "change_type", "target_key", "change", "reason"], "experience_proposal");
  if (!CHANGE_TYPES.has(input.change_type) || !String(input.reason ?? "").trim() || !input.change || typeof input.change !== "object" || Array.isArray(input.change)) throw new Error("experience_proposal: invalid change");
  const db = openDb(dbFile), proposalId = id("exp", input.project_id);
  try {
    const active = db.prepare("SELECT version FROM workflow_package_releases WHERE project_id=? AND package_key=? AND status='active'").get(input.project_id, input.package_key);
    if (!active || active.version !== input.base_version) throw new Error("EXPERIENCE_BASE_VERSION_NOT_ACTIVE");
    db.prepare("INSERT INTO experience_proposals(id,project_id,package_key,base_version,change_type,target_key,change_json,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(proposalId, input.project_id, input.package_key, input.base_version, input.change_type, input.target_key, stableJson(input.change), input.reason, "pending", now());
    return { status: "pending", proposal_id: proposalId, base_version: input.base_version, proposed_version: nextPatch(input.base_version) };
  } finally { db.close(); }
}

function validateEvaluation(value, label) { exact(value, EVALUATION_FIELDS, label); if (typeof value.passed !== "boolean") throw new Error(`${label}.passed: boolean required`); finite(value.quality_score, `${label}.quality_score`); if (value.quality_score > 1) throw new Error(`${label}.quality_score: value above 1`); finite(value.cost_usd, `${label}.cost_usd`, true); finite(value.duration_ms, `${label}.duration_ms`); return value; }

export async function evaluateExperienceProposal(dbFile, proposalId, evaluator) {
  if (typeof evaluator !== "function") throw new Error("EXPERIENCE_EVALUATOR_REQUIRED");
  let proposal, scenarios;
  let db = openDb(dbFile);
  try {
    proposal = db.prepare("SELECT * FROM experience_proposals WHERE id=? AND status='pending'").get(proposalId);
    if (!proposal) throw new Error("EXPERIENCE_PROPOSAL_NOT_PENDING");
    scenarios = db.prepare("SELECT scenario_key,input_json,expected_json,anonymized FROM package_test_scenarios WHERE project_id=? AND package_key=? AND package_version=? ORDER BY scenario_key").all(proposal.project_id, proposal.package_key, proposal.base_version);
    if (!scenarios.length || scenarios.some(item => item.anonymized !== 1)) throw new Error("EXPERIENCE_ANONYMIZED_SCENARIOS_REQUIRED");
  } finally { db.close(); }
  const evaluations = [];
  for (const scenario of scenarios) {
    const contract = { scenario_key: scenario.scenario_key, input: JSON.parse(scenario.input_json), expected: JSON.parse(scenario.expected_json) };
    const before = validateEvaluation(await evaluator({ ...contract, variant: "current", change: null }), `evaluation.${scenario.scenario_key}.before`);
    const after = validateEvaluation(await evaluator({ ...contract, variant: "proposed", change: JSON.parse(proposal.change_json) }), `evaluation.${scenario.scenario_key}.after`);
    evaluations.push({ scenario_key: scenario.scenario_key, before, after });
  }
  db = openDb(dbFile);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of evaluations) db.prepare("INSERT INTO experience_evaluations(id,proposal_id,scenario_key,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)").run(id("eval", item.scenario_key), proposalId, item.scenario_key, stableJson(item.before), stableJson(item.after), now());
      db.prepare("UPDATE experience_proposals SET status='evaluated' WHERE id=? AND status='pending'").run(proposalId); db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
  const sum = (side, field) => evaluations.reduce((total, item) => total + item[side][field], 0), nullableSum = (side, field) => evaluations.some(item => item[side][field] === null) ? null : sum(side, field);
  return { status: "evaluated", proposal_id: proposalId, scenarios: evaluations.length, comparison: { quality_score: { before: sum("before", "quality_score"), after: sum("after", "quality_score") }, cost_usd: { before: nullableSum("before", "cost_usd"), after: nullableSum("after", "cost_usd") }, duration_ms: { before: sum("before", "duration_ms"), after: sum("after", "duration_ms") }, passed: { before: evaluations.filter(item => item.before.passed).length, after: evaluations.filter(item => item.after.passed).length } } };
}

function workflowIdForKey(db, projectId, semanticKey) {
  return db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type='workflow' AND m.semantic_key=? ORDER BY p.applied_at DESC LIMIT 1`).get(projectId, semanticKey)?.local_id ?? semanticKey;
}
function checkIdForKey(db, projectId, semanticKey) {
  return db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type='check' AND m.semantic_key=? ORDER BY p.applied_at DESC LIMIT 1`).get(projectId, semanticKey)?.local_id ?? semanticKey;
}

function applyChange(db, proposal, nextVersion) {
  const change = JSON.parse(proposal.change_json);
  if (proposal.change_type === "route") {
    exact(change, ["workflow_key", "enabled", "priority"], "experience.route");
    const workflowId = workflowIdForKey(db, proposal.project_id, change.workflow_key);
    if (!db.prepare("SELECT 1 FROM workflows WHERE id=? AND project_id=?").get(workflowId, proposal.project_id)) throw new Error("EXPERIENCE_ROUTE_WORKFLOW_NOT_FOUND");
    db.prepare("INSERT INTO workflow_routes(project_id,work_type_id,workflow_id,enabled,priority) VALUES(?,?,?,?,?) ON CONFLICT(project_id,work_type_id,workflow_id) DO UPDATE SET enabled=excluded.enabled,priority=excluded.priority").run(proposal.project_id, proposal.target_key, workflowId, Number(Boolean(change.enabled)), change.priority);
  } else if (proposal.change_type === "check") {
    exact(change, ["kind", "runner", "config", "timeout_seconds"], "experience.check"); const checkId = checkIdForKey(db, proposal.project_id, proposal.target_key);
    const result = db.prepare("UPDATE check_definitions SET kind=?,runner=?,config_json=?,timeout_seconds=? WHERE id=?").run(change.kind, change.runner, stableJson(change.config), change.timeout_seconds, checkId); if (!result.changes) throw new Error("EXPERIENCE_CHECK_NOT_FOUND");
  } else if (proposal.change_type === "prompt_template") {
    exact(change, ["template", "result_schema_key"], "experience.prompt_template"); const current = db.prepare("SELECT * FROM prompt_templates WHERE project_id=? AND package_key=? AND template_key=? AND status='active'").get(proposal.project_id, proposal.package_key, proposal.target_key); if (!current) throw new Error("EXPERIENCE_PROMPT_NOT_FOUND"); db.prepare("UPDATE prompt_templates SET status='superseded' WHERE id=?").run(current.id); db.prepare("INSERT INTO prompt_templates(id,project_id,package_key,template_key,version,role_id,result_schema_key,template_text,content_hash,status) VALUES(?,?,?,?,?,?,?,?,?,'active')").run(id("prompt", proposal.id), proposal.project_id, proposal.package_key, proposal.target_key, nextVersion, current.role_id, change.result_schema_key, change.template, `sha256:${structuredHash(change.template)}`);
  } else {
    const allowed = new Set(["context_limit_bytes", "max_calls", "max_correction_cycles", "timeout_seconds", "prompt_template_version", "escalation"]); if (Object.keys(change).some(name => !allowed.has(name)) || !Object.keys(change).length) throw new Error("EXPERIENCE_ROLE_PATCH_INVALID");
    const current = db.prepare("SELECT * FROM role_contracts WHERE project_id=? AND role_id=? AND status='active'").get(proposal.project_id, proposal.target_key); if (!current) throw new Error("EXPERIENCE_ROLE_NOT_FOUND"); db.prepare("UPDATE role_contracts SET status='superseded' WHERE id=?").run(current.id);
    const values = { ...current, ...change, version: nextVersion, escalation_json: change.escalation ? stableJson(change.escalation) : current.escalation_json };
    db.prepare(`INSERT INTO role_contracts(id,project_id,role_id,version,purpose,boundaries_json,allowed_work_types_json,allowed_artifact_types_json,allowed_tools_json,allowed_skills_json,required_checks_json,allowed_transitions_json,allowed_profiles_json,context_limit_bytes,max_calls,max_correction_cycles,timeout_seconds,result_schema_key,prompt_template_version,escalation_json,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id("role", proposal.id), values.project_id, values.role_id, values.version, values.purpose, values.boundaries_json, values.allowed_work_types_json, values.allowed_artifact_types_json, values.allowed_tools_json, values.allowed_skills_json, values.required_checks_json, values.allowed_transitions_json, values.allowed_profiles_json, values.context_limit_bytes, values.max_calls, values.max_correction_cycles, values.timeout_seconds, values.result_schema_key, values.prompt_template_version, values.escalation_json, "active");
  }
}

export function applyExperienceProposal(dbFile, proposalId, options = {}) {
  const confirmedBy = String(options.confirmedBy ?? "").trim(); if (!confirmedBy) throw new Error("EXPERIENCE_CONFIRMATION_REQUIRED");
  const db = openDb(dbFile);
  try {
    const proposal = db.prepare("SELECT * FROM experience_proposals WHERE id=? AND status='evaluated'").get(proposalId); if (!proposal) throw new Error("EXPERIENCE_PROPOSAL_NOT_EVALUATED");
    const active = db.prepare("SELECT * FROM workflow_package_releases WHERE project_id=? AND package_key=? AND status='active'").get(proposal.project_id, proposal.package_key); if (!active || active.version !== proposal.base_version) { db.prepare("UPDATE experience_proposals SET status='stale' WHERE id=?").run(proposalId); throw new Error("EXPERIENCE_BASE_VERSION_CHANGED"); }
    const version = nextPatch(proposal.base_version); db.exec("BEGIN IMMEDIATE");
    try {
      applyChange(db, proposal, version);
      const scenarios = db.prepare("SELECT * FROM package_test_scenarios WHERE project_id=? AND package_key=? AND package_version=? ORDER BY scenario_key").all(proposal.project_id, proposal.package_key, proposal.base_version);
      for (const scenario of scenarios) db.prepare("INSERT INTO package_test_scenarios(id,project_id,package_key,package_version,scenario_key,input_json,expected_json,anonymized) VALUES(?,?,?,?,?,?,?,?)").run(id("scenario", `${proposalId}:${scenario.scenario_key}`), proposal.project_id, proposal.package_key, version, scenario.scenario_key, scenario.input_json, scenario.expected_json, scenario.anonymized);
      db.prepare("UPDATE workflow_package_releases SET status='superseded' WHERE id=?").run(active.id); const releaseId = id("release", proposalId); db.prepare("INSERT INTO workflow_package_releases(id,project_id,package_key,version,purpose,prompt_builder_version,manifest_hash,parent_version,change_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?)").run(releaseId, proposal.project_id, proposal.package_key, version, active.purpose, active.prompt_builder_version, "sha256:pending", active.version, proposal.change_json, now());
      db.prepare("UPDATE workflows SET package_version=? WHERE project_id=? AND package_key=?").run(version, proposal.project_id, proposal.package_key);
      const manifestHash = `sha256:${structuredHash(buildWorkflowPackageValue(db, proposal.project_id, proposal.package_key))}`; db.prepare("UPDATE workflow_package_releases SET manifest_hash=? WHERE id=?").run(manifestHash, releaseId);
      db.prepare("UPDATE experience_proposals SET status='applied',confirmed_by=?,applied_version=? WHERE id=?").run(confirmedBy, version, proposalId); db.exec("COMMIT"); return { status: "applied", proposal_id: proposalId, version, confirmed_by: confirmedBy };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}
