import { id, now } from "./db.mjs";

export const TASK_STATES = Object.freeze([
  "received", "discovering", "classifying", "clarification_required", "classified", "classification_failed",
  "planning", "executing", "documenting", "verifying", "review_required", "changes_requested",
  "approval_required", "documented", "completed", "cancelled", "rejected", "failed", "paused", "blocked", "retry_scheduled"
]);
export const RUN_STATES = TASK_STATES;
export const STEP_STATES = Object.freeze(["pending", "ready", "leased", "running", "verifying", "review_required", "changes_requested", "approval_required", "documented", "completed", "failed", "cancelled", "blocked", "retry_scheduled"]);
export const ATTEMPT_STATES = Object.freeze(["pending", "running", "succeeded", "failed", "timed_out", "cancelled"]);

const taskTransitions = {
  received: ["discovering", "cancelled"],
  discovering: ["classifying", "clarification_required", "failed", "paused", "cancelled"],
  classifying: ["classified", "clarification_required", "classification_failed", "failed", "paused", "cancelled"],
  clarification_required: ["discovering", "classifying", "rejected", "cancelled"],
  // Execution can fail before it has planned anything — a role contract that does not permit the work
  // type, a role with no profile assigned at this level — and a classified run had nowhere to go: the
  // failure was reported to the person while the run stayed classified for ever, neither finished nor
  // waiting for anything, and nothing could act on it afterwards.
  classified: ["clarification_required", "planning", "executing", "documenting", "completed", "failed", "blocked", "paused", "cancelled"],
  classification_failed: ["retry_scheduled", "blocked", "failed", "cancelled"],
  planning: ["executing", "documenting", "clarification_required", "approval_required", "retry_scheduled", "failed", "blocked", "paused", "cancelled"],
  executing: ["verifying", "documenting", "approval_required", "retry_scheduled", "failed", "blocked", "paused", "cancelled"],
  documenting: ["verifying", "documented", "approval_required", "retry_scheduled", "failed", "blocked", "paused", "cancelled"],
  verifying: ["review_required", "changes_requested", "approval_required", "documenting", "documented", "completed", "retry_scheduled", "failed", "blocked", "paused", "cancelled"],
  review_required: ["changes_requested", "approval_required", "documenting", "documented", "completed", "rejected", "failed", "blocked", "paused", "cancelled"],
  changes_requested: ["executing", "documenting", "retry_scheduled", "blocked", "rejected", "cancelled"],
  approval_required: ["planning", "executing", "documenting", "documented", "completed", "blocked", "rejected", "cancelled"],
  documented: ["verifying", "review_required", "approval_required", "completed", "blocked", "cancelled"],
  retry_scheduled: ["discovering", "classifying", "planning", "executing", "documenting", "verifying", "blocked", "cancelled"],
  paused: ["discovering", "classifying", "planning", "executing", "documenting", "verifying", "review_required", "approval_required", "blocked", "cancelled"],
  blocked: ["retry_scheduled", "paused", "failed", "cancelled"],
  completed: [], cancelled: [], rejected: [], failed: []
};

const stepTransitions = {
  pending: ["ready", "cancelled", "blocked"],
  ready: ["leased", "running", "cancelled", "blocked"],
  leased: ["running", "ready", "cancelled", "blocked"],
  running: ["verifying", "approval_required", "retry_scheduled", "failed", "cancelled", "blocked"],
  verifying: ["review_required", "changes_requested", "approval_required", "documented", "completed", "retry_scheduled", "failed", "blocked", "cancelled"],
  review_required: ["changes_requested", "approval_required", "documented", "completed", "failed", "cancelled"],
  changes_requested: ["ready", "retry_scheduled", "failed", "cancelled"],
  approval_required: ["ready", "documented", "completed", "failed", "cancelled"],
  documented: ["completed", "cancelled"],
  retry_scheduled: ["ready", "blocked", "cancelled"],
  blocked: ["retry_scheduled", "ready", "failed", "cancelled"],
  completed: [], failed: [], cancelled: []
};

const attemptTransitions = {
  pending: ["running", "cancelled"],
  running: ["succeeded", "failed", "timed_out", "cancelled"],
  succeeded: [], failed: [], timed_out: [], cancelled: []
};

export const ALLOWED_TRANSITIONS = Object.freeze({ task: taskTransitions, workflow_run: taskTransitions, workflow_step: stepTransitions, attempt: attemptTransitions });
const TABLES = Object.freeze({ task: "tasks", workflow_run: "workflow_runs", workflow_step: "workflow_steps", attempt: "attempts" });

export function canTransition(entityType, from, to) {
  return Boolean(ALLOWED_TRANSITIONS[entityType]?.[from]?.includes(to));
}

function eventReferences(db, entityType, entityId) {
  if (entityType === "task") return { taskId: entityId, runId: null, stepId: null, attemptId: null };
  if (entityType === "workflow_run") { const row = db.prepare("SELECT task_id FROM workflow_runs WHERE id=?").get(entityId); return { taskId: row?.task_id ?? null, runId: entityId, stepId: null, attemptId: null }; }
  if (entityType === "workflow_step") { const row = db.prepare("SELECT wr.task_id,ws.run_id FROM workflow_steps ws JOIN workflow_runs wr ON wr.id=ws.run_id WHERE ws.id=?").get(entityId); return { taskId: row?.task_id ?? null, runId: row?.run_id ?? null, stepId: entityId, attemptId: null }; }
  const row = db.prepare("SELECT wr.task_id,ws.run_id,a.step_id FROM attempts a JOIN workflow_steps ws ON ws.id=a.step_id JOIN workflow_runs wr ON wr.id=ws.run_id WHERE a.id=?").get(entityId);
  return { taskId: row?.task_id ?? null, runId: row?.run_id ?? null, stepId: row?.step_id ?? null, attemptId: entityId };
}

export function appendEvent(db, { entityType, entityId, kind, fromState = null, toState = null, payload = {} }) {
  const refs = eventReferences(db, entityType, entityId);
  db.prepare("INSERT INTO events(event_id,entity_type,entity_id,task_id,run_id,step_id,attempt_id,kind,from_state,to_state,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id("evt"), entityType, entityId, refs.taskId, refs.runId, refs.stepId, refs.attemptId, kind, fromState, toState, JSON.stringify(payload), now());
}

export function completionBlockers(db, taskId, { excludeReviewDecisions = false } = {}) {
  const blockers = [];
  const unfinishedSteps = db.prepare("SELECT COUNT(*) AS count FROM workflow_steps ws JOIN workflow_runs wr ON wr.id=ws.run_id WHERE wr.task_id=? AND ws.required=1 AND ws.state NOT IN ('completed','documented')").get(taskId).count;
  if (unfinishedSteps) blockers.push({ kind: "required_steps", count: unfinishedSteps });
  const failedGates = db.prepare("SELECT COUNT(*) AS count FROM gates g JOIN workflow_runs wr ON wr.id=g.run_id WHERE wr.task_id=? AND g.required=1 AND g.status!='passed'").get(taskId).count;
  if (failedGates) blockers.push({ kind: "required_gates", count: failedGates });
  const pendingApprovals = db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE task_id=? AND status='pending'").get(taskId).count;
  if (pendingApprovals) blockers.push({ kind: "pending_approvals", count: pendingApprovals });
  // While a corrected package is being reviewed, the previous review decision is the reason for the
  // new review, not independent proof that the correction failed. Keep it active for crash recovery and
  // ordinary completion checks, but let the new immutable review package evaluate the corrected facts
  // without treating the decision it is about to supersede as a canonical blocker.
  const rejectingQuery = excludeReviewDecisions
    ? "SELECT COUNT(*) AS count FROM decisions WHERE task_id=? AND active=1 AND kind!='review' AND outcome IN ('REJECT','CHANGES_REQUESTED')"
    : "SELECT COUNT(*) AS count FROM decisions WHERE task_id=? AND active=1 AND outcome IN ('REJECT','CHANGES_REQUESTED')";
  const rejectingDecisions = db.prepare(rejectingQuery).get(taskId).count;
  if (rejectingDecisions) blockers.push({ kind: "rejecting_decisions", count: rejectingDecisions });
  return blockers;
}

export function transitionEntity(db, entityType, entityId, toState, options = {}) {
  const table = TABLES[entityType];
  if (!table) throw new Error(`STATE_ENTITY_INVALID: ${entityType}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`SELECT state FROM ${table} WHERE id=?`).get(entityId);
    if (!row) throw new Error(`STATE_ENTITY_NOT_FOUND: ${entityType}:${entityId}`);
    if (!canTransition(entityType, row.state, toState)) {
      appendEvent(db, { entityType, entityId, kind: "contract_error", fromState: row.state, toState, payload: { reason: options.reason ?? "forbidden transition" } });
      db.exec("COMMIT");
      throw new Error(`STATE_TRANSITION_FORBIDDEN: ${entityType} ${row.state} -> ${toState}`);
    }
    const refs = eventReferences(db, entityType, entityId);
    if (["task", "workflow_run"].includes(entityType) && toState === "completed") {
      const blockers = completionBlockers(db, refs.taskId);
      if (blockers.length) {
        appendEvent(db, { entityType, entityId, kind: "completion_blocked", fromState: row.state, toState, payload: { blockers } });
        db.exec("COMMIT");
        throw new Error(`COMPLETION_BLOCKED: ${JSON.stringify(blockers)}`);
      }
    }
    const timestamp = now();
    if (["task", "workflow_run", "workflow_step"].includes(entityType)) db.prepare(`UPDATE ${table} SET state=?,updated_at=? WHERE id=?`).run(toState, timestamp, entityId);
    else db.prepare("UPDATE attempts SET state=?, started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END, finished_at=CASE WHEN ? IN ('succeeded','failed','timed_out','cancelled') THEN ? ELSE finished_at END WHERE id=?").run(toState, toState, timestamp, toState, timestamp, entityId);
    appendEvent(db, { entityType, entityId, kind: "state_transition", fromState: row.state, toState, payload: { actor: options.actor ?? "workflow-platform", reason: options.reason ?? null } });
    db.exec("COMMIT");
    return toState;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function transitionRunAndTask(db, runId, toState, options = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = db.prepare("SELECT task_id,state FROM workflow_runs WHERE id=?").get(runId);
    if (!run) throw new Error(`STATE_ENTITY_NOT_FOUND: workflow_run:${runId}`);
    const task = db.prepare("SELECT state FROM tasks WHERE id=?").get(run.task_id);
    if (!task || task.state !== run.state) throw new Error(`STATE_DIVERGENCE: task ${task?.state ?? "missing"}, run ${run.state}`);
    if (!canTransition("workflow_run", run.state, toState) || !canTransition("task", task.state, toState)) {
      appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: "contract_error", fromState: run.state, toState, payload: { reason: options.reason ?? "forbidden paired transition" } });
      appendEvent(db, { entityType: "task", entityId: run.task_id, kind: "contract_error", fromState: task.state, toState, payload: { reason: options.reason ?? "forbidden paired transition" } });
      db.exec("COMMIT");
      throw new Error(`STATE_TRANSITION_FORBIDDEN: task/run ${run.state} -> ${toState}`);
    }
    if (toState === "completed") {
      const blockers = completionBlockers(db, run.task_id);
      if (blockers.length) {
        appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: "completion_blocked", fromState: run.state, toState, payload: { blockers } });
        appendEvent(db, { entityType: "task", entityId: run.task_id, kind: "completion_blocked", fromState: task.state, toState, payload: { blockers } });
        db.exec("COMMIT");
        throw new Error(`COMPLETION_BLOCKED: ${JSON.stringify(blockers)}`);
      }
    }
    const timestamp = now();
    db.prepare("UPDATE workflow_runs SET state=?,updated_at=?,completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END WHERE id=?").run(toState, timestamp, toState, timestamp, runId);
    db.prepare("UPDATE tasks SET state=?,updated_at=? WHERE id=?").run(toState, timestamp, run.task_id);
    appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: "state_transition", fromState: run.state, toState, payload: { actor: options.actor ?? "workflow-platform", reason: options.reason ?? null } });
    appendEvent(db, { entityType: "task", entityId: run.task_id, kind: "state_transition", fromState: task.state, toState, payload: { actor: options.actor ?? "workflow-platform", reason: options.reason ?? null } });
    db.exec("COMMIT");
    return toState;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
