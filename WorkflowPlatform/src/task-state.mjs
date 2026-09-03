import { id, now } from "./db.mjs";
import { structuredHash } from "./role-contracts.mjs";
import { completionBlockers, appendEvent } from "./state-machine.mjs";
import { strategicRunContext } from "./strategic-state.mjs";

function parseJson(value, fallback) {
  try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; }
}

function tacticalPlan(row) {
  if (!row) return null;
  return {
    schema_version: row.schema_version ?? 1,
    objective: row.objective,
    authority: row.authority,
    outcome: row.outcome,
    status: row.status,
    scope: parseJson(row.scope_json, { included: [], excluded: [] }),
    allowed_paths: parseJson(row.allowed_paths_json, []),
    inputs: parseJson(row.inputs_json, []),
    checks: parseJson(row.checks_json, []),
    risks: parseJson(row.risks_json, []),
    artifacts: parseJson(row.artifacts_json, []),
    completion_criteria: parseJson(row.completion_criteria_json, []),
    questions: parseJson(row.questions_json, []),
    steps: parseJson(row.steps_json, [])
  };
}

function nextActions(run, steps, questions, blockers) {
  if (questions.length) return questions.map(item => ({ kind: "interaction", id: item.id, interaction_kind: item.kind }));
  const actionable = steps.filter(step => ["ready", "pending", "retry_scheduled", "approval_required", "blocked", "unavailable"].includes(step.state));
  if (actionable.length) return actionable.map(step => ({ kind: "workflow_step", id: step.id, key: step.key, state: step.state, role_id: step.role_id }));
  if (!blockers.length && !["completed", "cancelled", "rejected", "failed"].includes(run.state)) return [{ kind: "completion_evaluation", run_id: run.id }];
  return [];
}

// This is a projection over canonical tables, not another state store. Operational telemetry such as
// prompt measurements and gateway calls is deliberately absent: it may change during the invocation
// that consumes this snapshot and cannot be an input to a model-authored state transition.
export function taskStateProjection(db, runId) {
  const run = db.prepare(`SELECT wr.*,t.title AS task_title,t.state AS task_state,t.goal_id,t.stage_id
    FROM workflow_runs wr JOIN tasks t ON t.id=wr.task_id WHERE wr.id=?`).get(runId);
  if (!run) throw new Error(`TASK_STATE_RUN_NOT_FOUND: ${runId}`);
  const classification = db.prepare(`SELECT kind,domain_id,discipline_id,risk,planning_level_id,quality_mode_id,
      planning_required,human_required,document_required,artifact_type_id,reply_mode,needs_questions,reason
    FROM classifications WHERE run_id=?`).get(runId) ?? null;
  const plan = tacticalPlan(db.prepare("SELECT * FROM plans WHERE run_id=?").get(runId));
  const steps = db.prepare(`SELECT id,step_key AS key,ordinal,role_id,state,required,irreversible,result_schema_key
    FROM workflow_steps WHERE run_id=? ORDER BY ordinal,id`).all(runId).map(row => ({ ...row, required: Boolean(row.required), irreversible: Boolean(row.irreversible) }));
  const decisions = db.prepare(`SELECT id,kind,outcome,source,structured_json FROM decisions
    WHERE task_id=? AND active=1 ORDER BY created_at,id`).all(run.task_id)
    .map(row => ({ id: row.id, kind: row.kind, outcome: row.outcome, source: row.source, structured: parseJson(row.structured_json, null) }));
  const questions = db.prepare(`SELECT id,kind,question,status,detail_json,affected_steps_json,binding_hash FROM approvals
    WHERE task_id=? AND status='pending' ORDER BY created_at,id`).all(run.task_id)
    .map(row => ({ id: row.id, kind: row.kind, question: row.question, status: row.status, detail: parseJson(row.detail_json, null), affected_steps: parseJson(row.affected_steps_json, []), binding_hash: row.binding_hash }));
  const artifacts = db.prepare(`SELECT id,step_id,kind,uri,content_hash,status,provenance_json FROM artifacts
    WHERE task_id=? AND status NOT IN ('rejected','superseded') ORDER BY created_at,id LIMIT 200`).all(run.task_id)
    .map(row => ({ id: row.id, step_id: row.step_id, kind: row.kind, uri: row.uri, content_hash: row.content_hash, status: row.status, provenance: parseJson(row.provenance_json, null) }));
  const checks = db.prepare("SELECT id,step_id,kind,required,status,details_json FROM gates WHERE run_id=? ORDER BY rowid,id LIMIT 200").all(runId)
    .map(row => ({ id: row.id, step_id: row.step_id, kind: row.kind, required: Boolean(row.required), status: row.status, details_hash: structuredHash(parseJson(row.details_json, {})) }));
  const evidenceRows = db.prepare(`SELECT id,step_id,kind,evidence_hash FROM run_evidence
    WHERE run_id=? AND kind NOT IN ('role_prompt_metrics','role_prompt_overflow','reflection_checkpoint') ORDER BY created_at,id`).all(runId);
  const evidenceByKind = new Map();
  for (const row of evidenceRows) evidenceByKind.set(row.kind, row);
  const evidence = [...evidenceByKind.values()].sort((left, right) => left.kind.localeCompare(right.kind));
  const blockers = completionBlockers(db, run.task_id);
  const strategy = strategicRunContext(db, runId);
  const projection = {
    schema_version: 1,
    identity: { project_id: run.project_id, task_id: run.task_id, run_id: run.id, workflow_id: run.workflow_id },
    owner_objective: { verbatim: run.user_message },
    resolved_objective: run.resolved_objective ?? run.user_message,
    constraints: {
      operational_level: run.operational_level,
      classification: classification ? { ...classification, planning_required: Boolean(classification.planning_required), human_required: Boolean(classification.human_required), document_required: Boolean(classification.document_required), needs_questions: Boolean(classification.needs_questions) } : null,
      scope: plan?.scope ?? null,
      allowed_paths: plan?.allowed_paths ?? []
    },
    strategic_plan: strategy,
    tactical_plan: plan,
    current_state: { task: run.task_state, run: run.state, steps },
    decisions,
    open_questions: questions,
    blockers,
    artifacts,
    checks,
    evidence,
    next_actions: nextActions(run, steps, questions, blockers)
  };
  return Object.freeze({ ...projection, projection_hash: structuredHash(projection) });
}

// Role envelopes receive a view assembled from the one canonical projection. Large structured decision
// payloads and the full tactical plan are already supplied by the phase-specific package; repeating them
// here would evict source evidence without adding current truth.
export function taskStateRoleContext(projection) {
  return {
    schema_version: projection.schema_version,
    projection_hash: projection.projection_hash,
    identity: projection.identity,
    owner_objective: projection.owner_objective,
    resolved_objective: projection.resolved_objective,
    constraints: projection.constraints,
    strategic_plan: projection.strategic_plan,
    tactical_plan: projection.tactical_plan ? {
      objective: projection.tactical_plan.objective,
      authority: projection.tactical_plan.authority,
      outcome: projection.tactical_plan.outcome,
      status: projection.tactical_plan.status,
      completion_criteria: projection.tactical_plan.completion_criteria
    } : null,
    current_state: projection.current_state,
    decisions: projection.decisions.map(({ structured: _structured, ...decision }) => decision),
    open_questions: projection.open_questions.map(({ detail: _detail, ...question }) => question),
    blockers: projection.blockers,
    artifacts: projection.artifacts.map(({ provenance: _provenance, ...artifact }) => artifact),
    checks: projection.checks,
    evidence: projection.evidence,
    next_actions: projection.next_actions
  };
}

export function statePatchContract(db, runId, roleId, projection = null) {
  if (roleId !== "strategy_reviewer") return null;
  const current = projection ?? taskStateProjection(db, runId);
  return Object.freeze({ schema_version: 1, patch_id: id("state_patch"), base_projection_hash: current.projection_hash, allowed_changes: [{ operation: "replace_active", path: "decisions.strategy_recovery" }] });
}

function validatePatch(patch, contract) {
  if (!contract || Array.isArray(contract) || typeof contract !== "object") throw new Error("STATE_PATCH_CONTRACT_REQUIRED");
  if (!patch || Array.isArray(patch) || typeof patch !== "object") throw new Error("STATE_PATCH_INVALID: object required");
  const expectedFields = ["base_projection_hash", "changes", "patch_id", "schema_version"];
  const actualFields = Object.keys(patch).sort();
  if (JSON.stringify(actualFields) !== JSON.stringify(expectedFields)) throw new Error("STATE_PATCH_INVALID: fields mismatch");
  if (patch.schema_version !== 1 || patch.patch_id !== contract.patch_id || patch.base_projection_hash !== contract.base_projection_hash) throw new Error("STATE_PATCH_CONTRACT_MISMATCH");
  if (!Array.isArray(patch.changes) || patch.changes.length !== contract.allowed_changes.length) throw new Error("STATE_PATCH_CHANGE_INVALID");
  for (const [index, change] of patch.changes.entries()) {
    if (!change || Array.isArray(change) || typeof change !== "object" || Object.keys(change).sort().join(",") !== "operation,path") throw new Error("STATE_PATCH_CHANGE_INVALID");
    const allowed = contract.allowed_changes[index];
    if (change.operation !== allowed.operation || change.path !== allowed.path) throw new Error(`STATE_PATCH_FIELD_NOT_ALLOWED: ${change.path}`);
  }
  return patch;
}

export function applyRoleStatePatch(db, runId, roleId, result, contract) {
  if (roleId !== "strategy_reviewer") throw new Error(`STATE_PATCH_ROLE_NOT_ALLOWED: ${roleId}`);
  validatePatch(result?.state_patch, contract);
  const nested = db.isTransaction, savepoint = "apply_role_state_patch";
  db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const current = taskStateProjection(db, runId);
    if (current.projection_hash !== contract.base_projection_hash) throw new Error(`STATE_PATCH_STALE: ${contract.base_projection_hash} != ${current.projection_hash}`);
    const run = db.prepare("SELECT task_id FROM workflow_runs WHERE id=?").get(runId);
    const timestamp = now(), stored = { ...result };
    db.prepare("UPDATE decisions SET active=0 WHERE run_id=? AND kind='strategy_recovery' AND active=1").run(runId);
    db.prepare("INSERT INTO decisions(id,task_id,run_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,?,?,?,?,1,?)")
      .run(contract.patch_id, run.task_id, runId, "strategy_recovery", result.decision, roleId, JSON.stringify(stored), timestamp);
    appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: "state_patch_applied", payload: { patch_id: contract.patch_id, role_id: roleId, base_projection_hash: contract.base_projection_hash, changes: contract.allowed_changes } });
    const appliedProjectionHash = taskStateProjection(db, runId).projection_hash;
    db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
    return { status: "applied", patch_id: contract.patch_id, base_projection_hash: contract.base_projection_hash, projection_hash: appliedProjectionHash };
  } catch (error) {
    if (db.isTransaction) db.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
    if (nested && db.isTransaction) db.exec(`RELEASE ${savepoint}`);
    throw error;
  }
}

function runScope(db, runId) {
  const row = db.prepare("SELECT task_id FROM workflow_runs WHERE id=?").get(runId);
  if (!row) throw new Error(`TASK_STATE_RUN_NOT_FOUND: ${runId}`);
  return row;
}

export function addressedInteraction(db, runId, interactionId) {
  const scope = runScope(db, runId);
  const row = db.prepare(`SELECT a.* FROM approvals a WHERE a.id=? AND (
    a.task_id=? OR EXISTS (SELECT 1 FROM zodchi_chat_session_runs current
      JOIN zodchi_chat_session_runs target ON target.client=current.client AND target.session_id=current.session_id
      WHERE current.run_id=? AND target.run_id=a.run_id))`).get(interactionId, scope.task_id, runId);
  if (!row) throw new Error(`TASK_STATE_INTERACTION_NOT_FOUND: ${interactionId}`);
  return {
    id: row.id, kind: row.kind, question: row.question, status: row.status, decision_id: row.decision_id,
    detail: parseJson(row.detail_json, null), affected_steps: parseJson(row.affected_steps_json, []),
    answer: parseJson(row.answer_json, null), binding_hash: row.binding_hash, binding: parseJson(row.binding_json, null),
    superseded_by: row.superseded_by, answered_run_id: row.answered_run_id
  };
}

export function addressedEvent(db, runId, eventId) {
  const scope = runScope(db, runId);
  const binding = db.prepare("SELECT goal_id,stage_id FROM tasks WHERE id=?").get(scope.task_id);
  const row = db.prepare(`SELECT * FROM events WHERE event_id=? AND (
    task_id=? OR run_id=? OR (entity_type='goal' AND entity_id=?) OR (entity_type='stage' AND entity_id=?) OR
    EXISTS (SELECT 1 FROM zodchi_chat_session_runs current
      JOIN zodchi_chat_session_runs target ON target.client=current.client AND target.session_id=current.session_id
      WHERE current.run_id=? AND target.run_id=events.run_id))`).get(eventId, scope.task_id, runId, binding.goal_id, binding.stage_id, runId);
  if (!row) throw new Error(`TASK_STATE_EVENT_NOT_FOUND: ${eventId}`);
  return { sequence: row.sequence, event_id: row.event_id, entity_type: row.entity_type, entity_id: row.entity_id, kind: row.kind, from_state: row.from_state, to_state: row.to_state, payload: parseJson(row.payload_json, {}) };
}
