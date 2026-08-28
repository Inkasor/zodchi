import { id, now } from "./db.mjs";
import { structuredHash } from "./role-contracts.mjs";

function parseJson(value, fallback) {
  try { return value === null || value === undefined ? fallback : JSON.parse(value); } catch { return fallback; }
}

function planSnapshot(db, runId) {
  const plan = db.prepare("SELECT * FROM plans WHERE run_id=?").get(runId);
  if (!plan) throw new Error(`APPROVAL_BINDING_PLAN_MISSING: ${runId}`);
  return {
    schema_version: plan.schema_version ?? 1,
    objective: plan.objective,
    authority: plan.authority,
    outcome: plan.outcome,
    scope: parseJson(plan.scope_json, { included: [], excluded: [] }),
    allowed_paths: parseJson(plan.allowed_paths_json, []),
    inputs: parseJson(plan.inputs_json, []),
    checks: parseJson(plan.checks_json, []),
    risks: parseJson(plan.risks_json, []),
    artifacts: parseJson(plan.artifacts_json, []),
    completion_criteria: parseJson(plan.completion_criteria_json, []),
    questions: parseJson(plan.questions_json, []),
    steps: parseJson(plan.steps_json, [])
  };
}

function checkpointSnapshot(db, runId) {
  const steps = db.prepare("SELECT step_key,ordinal,role_id,state,required,irreversible,contract_json,result_json,result_schema_key FROM workflow_steps WHERE run_id=? ORDER BY ordinal,id").all(runId)
    .map(step => ({
      key: step.step_key,
      ordinal: step.ordinal,
      role: step.role_id,
      state: step.state,
      required: Boolean(step.required),
      irreversible: Boolean(step.irreversible),
      result_schema_key: step.result_schema_key,
      contract_hash: structuredHash(parseJson(step.contract_json, {})),
      result_hash: step.result_json ? structuredHash(parseJson(step.result_json, null)) : null
    }));
  const gates = db.prepare("SELECT kind,status,required,details_json FROM gates WHERE run_id=? ORDER BY rowid").all(runId)
    .map(gate => ({ kind: gate.kind, status: gate.status, required: Boolean(gate.required), details_hash: structuredHash(parseJson(gate.details_json, {})) }));
  const decisions = db.prepare("SELECT kind,outcome,source,structured_json FROM decisions WHERE run_id=? AND active=1 ORDER BY created_at,id").all(runId)
    .filter(decision => decision.kind !== "classification")
    .map(decision => ({ kind: decision.kind, outcome: decision.outcome, source: decision.source, result_hash: structuredHash(parseJson(decision.structured_json, {})) }));
  return { steps, gates, decisions };
}

export function currentApprovalBinding(db, runId, actionStepKey) {
  const run = db.prepare("SELECT id,project_id,workflow_id,user_message FROM workflow_runs WHERE id=?").get(runId);
  if (!run) throw new Error(`APPROVAL_BINDING_RUN_MISSING: ${runId}`);
  if (typeof actionStepKey !== "string" || !actionStepKey.trim()) throw new Error("APPROVAL_BINDING_ACTION_REQUIRED");
  const value = {
    schema_version: 1,
    objective: { owner_message: run.user_message },
    plan: planSnapshot(db, runId),
    checkpoint: checkpointSnapshot(db, runId),
    action: { project_id: run.project_id, workflow_id: run.workflow_id, step_key: actionStepKey.trim() }
  };
  return Object.freeze({ value, hash: structuredHash(value) });
}

export function approvalBindingFromRow(row) {
  const value = parseJson(row?.binding_json, null);
  if (!value || row?.binding_hash !== structuredHash(value)) throw new Error("APPROVAL_BINDING_RECORD_INVALID");
  return { value, hash: row.binding_hash };
}

// Approval and binding verification are one write transaction. If the protected state changed, the old
// decision is superseded and a fresh pending decision is opened for the new exact state. A stale "yes"
// never authorizes either the old state (which no longer exists) or the new one (which was never shown).
export function approveBoundInteraction(db, interactionId, { answeredRunId = null, actor = "owner" } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const approval = db.prepare("SELECT * FROM approvals WHERE id=?").get(interactionId);
    if (!approval) throw new Error(`INTERACTION_NOT_FOUND: ${interactionId}`);
    if (approval.status !== "pending") {
      db.exec("COMMIT");
      return { approved: false, duplicate: true, status: approval.status, replacement_id: approval.superseded_by ?? null };
    }
    const recorded = approvalBindingFromRow(approval);
    const current = currentApprovalBinding(db, approval.run_id, recorded.value.action.step_key);
    if (current.hash !== recorded.hash) {
      const replacementId = id("approval"), timestamp = now();
      db.prepare("INSERT INTO approvals(id,task_id,run_id,step_id,kind,question,status,created_at,detail_json,affected_steps_json,expires_at,binding_hash,binding_json) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?)")
        .run(replacementId, approval.task_id, approval.run_id, approval.step_id, approval.kind, approval.question, timestamp, approval.detail_json, approval.affected_steps_json, approval.expires_at, current.hash, JSON.stringify(current.value));
      db.prepare("UPDATE approvals SET status='superseded',resolved_at=?,superseded_by=?,answered_run_id=?,answer_json=? WHERE id=? AND status='pending'")
        .run(timestamp, replacementId, answeredRunId, JSON.stringify({ reason: "approval_binding_changed", actor, recorded_hash: recorded.hash, current_hash: current.hash }), interactionId);
      db.exec("COMMIT");
      return { approved: false, stale: true, status: "superseded", replacement_id: replacementId, recorded_hash: recorded.hash, current_hash: current.hash };
    }
    const changed = db.prepare("UPDATE approvals SET status='approved',resolved_at=?,answered_run_id=?,answer_json=? WHERE id=? AND status='pending'")
      .run(now(), answeredRunId, JSON.stringify({ actor, binding_hash: current.hash }), interactionId);
    if (changed.changes !== 1) throw new Error("APPROVAL_BINDING_CONCURRENT_UPDATE");
    db.exec("COMMIT");
    return { approved: true, status: "approved", binding_hash: current.hash, binding: current.value };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function assertApprovalStillCurrent(db, interactionId) {
  const approval = db.prepare("SELECT * FROM approvals WHERE id=?").get(interactionId);
  if (!approval || approval.status !== "approved") throw new Error("APPROVAL_BINDING_NOT_APPROVED");
  const recorded = approvalBindingFromRow(approval);
  const current = currentApprovalBinding(db, approval.run_id, recorded.value.action.step_key);
  if (current.hash !== recorded.hash) throw new Error(`APPROVAL_BINDING_STALE: ${recorded.hash} != ${current.hash}`);
  return current;
}
