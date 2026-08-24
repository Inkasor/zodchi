import crypto from "node:crypto";
import { id, now } from "./db.mjs";
import { appendEvent, canTransition } from "./state-machine.mjs";

const TERMINAL_STEP_STATES = new Set(["completed", "documented", "failed", "cancelled"]);

function iso(value = Date.now()) { return value instanceof Date ? value.toISOString() : typeof value === "number" ? new Date(value).toISOString() : new Date(value).toISOString(); }
function tokenHash(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }

function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function entityState(db, entityType, entityId, toState, at, payload = {}) {
  const table = entityType === "workflow_step" ? "workflow_steps" : entityType === "attempt" ? "attempts" : null;
  if (!table) throw new Error(`QUEUE_ENTITY_INVALID: ${entityType}`);
  const row = db.prepare(`SELECT state FROM ${table} WHERE id=?`).get(entityId);
  if (!row) throw new Error(`QUEUE_ENTITY_NOT_FOUND: ${entityType}:${entityId}`);
  if (row.state === toState) return row.state;
  if (!canTransition(entityType, row.state, toState)) throw new Error(`STATE_TRANSITION_FORBIDDEN: ${entityType} ${row.state} -> ${toState}`);
  if (entityType === "workflow_step") db.prepare("UPDATE workflow_steps SET state=?,updated_at=? WHERE id=?").run(toState, at, entityId);
  else db.prepare("UPDATE attempts SET state=?,started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,finished_at=CASE WHEN ? IN ('succeeded','failed','timed_out','cancelled') THEN ? ELSE finished_at END WHERE id=?")
    .run(toState, toState, at, toState, at, entityId);
  appendEvent(db, { entityType, entityId, kind: "state_transition", fromState: row.state, toState, payload });
  return toState;
}

function pairedState(db, runId, toState, at, payload = {}, { remember = false, clearResume = false } = {}) {
  const run = db.prepare("SELECT id,task_id,state,resume_state FROM workflow_runs WHERE id=?").get(runId);
  if (!run) throw new Error(`STATE_ENTITY_NOT_FOUND: workflow_run:${runId}`);
  const task = db.prepare("SELECT id,state,resume_state FROM tasks WHERE id=?").get(run.task_id);
  if (!task || task.state !== run.state) throw new Error(`STATE_DIVERGENCE: task ${task?.state ?? "missing"}, run ${run.state}`);
  if (run.state === toState) return toState;
  if (!canTransition("workflow_run", run.state, toState) || !canTransition("task", task.state, toState)) throw new Error(`STATE_TRANSITION_FORBIDDEN: task/run ${run.state} -> ${toState}`);
  const resumeState = remember ? run.state : clearResume ? null : run.resume_state;
  const taskResumeState = remember ? task.state : clearResume ? null : task.resume_state;
  db.prepare("UPDATE workflow_runs SET state=?,resume_state=?,updated_at=? WHERE id=?").run(toState, resumeState, at, runId);
  db.prepare("UPDATE tasks SET state=?,resume_state=?,updated_at=? WHERE id=?").run(toState, taskResumeState, at, task.id);
  appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: "state_transition", fromState: run.state, toState, payload });
  appendEvent(db, { entityType: "task", entityId: task.id, kind: "state_transition", fromState: task.state, toState, payload });
  return toState;
}

function activateNext(db, runId, at) {
  const step = db.prepare(`SELECT ws.* FROM workflow_steps ws
    WHERE ws.run_id=? AND ws.state='pending'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_steps previous
        WHERE previous.run_id=ws.run_id AND previous.ordinal<ws.ordinal
          AND previous.required=1 AND previous.state NOT IN ('completed','documented','cancelled')
      )
    ORDER BY ws.ordinal LIMIT 1`).get(runId);
  if (!step) return null;
  entityState(db, "workflow_step", step.id, "ready", at, { reason: "previous required steps confirmed" });
  return db.prepare("SELECT * FROM workflow_steps WHERE id=?").get(step.id);
}

function activeLeaseByToken(db, token, { allowReleased = false } = {}) {
  const lease = db.prepare("SELECT * FROM leases WHERE token_hash=?").get(tokenHash(token));
  if (!lease) throw new Error("LEASE_TOKEN_INVALID");
  if (!allowReleased && lease.released_at) throw new Error(`LEASE_RELEASED: ${lease.release_reason ?? "released"}`);
  return lease;
}

function blockForDeadLetter(db, step, attemptId, category, details, at) {
  const run = db.prepare("SELECT task_id,state FROM workflow_runs WHERE id=?").get(step.run_id);
  const deadLetterId = id("dead");
  const requiresApproval = step.irreversible ? 1 : 0;
  db.prepare("INSERT INTO dead_letters(id,task_id,run_id,step_id,attempt_id,category,details_json,replay_requires_approval,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(deadLetterId, run.task_id, step.run_id, step.id, attemptId, category, JSON.stringify(details ?? {}), requiresApproval, at);
  db.prepare("UPDATE workflow_steps SET dead_lettered_at=?,last_error_category=?,next_attempt_at=NULL WHERE id=?").run(at, category, step.id);
  if (requiresApproval) db.prepare("INSERT INTO approvals(id,task_id,run_id,step_id,kind,question,status,created_at) VALUES(?,?,?,?,?,?, 'pending',?)")
    .run(id("approval"), run.task_id, step.run_id, step.id, "irreversible_replay", `Повторить необратимый этап '${step.step_key}' после сбоя?`, at);
  if (run.state !== "blocked" && canTransition("workflow_run", run.state, "blocked")) pairedState(db, step.run_id, "blocked", at, { reason: "dead-letter escalation", dead_letter_id: deadLetterId }, { remember: true });
  appendEvent(db, { entityType: "workflow_step", entityId: step.id, kind: "dead_lettered", payload: { dead_letter_id: deadLetterId, category, replay_requires_approval: Boolean(requiresApproval) } });
  return deadLetterId;
}

function recoverExpiredInternal(db, at) {
  const leases = db.prepare("SELECT * FROM leases WHERE released_at IS NULL AND expires_at<=? ORDER BY expires_at,id").all(at);
  const recovered = [];
  for (const lease of leases) {
    const step = db.prepare("SELECT * FROM workflow_steps WHERE id=?").get(lease.step_id);
    const attempt = db.prepare("SELECT * FROM attempts WHERE lease_id=? ORDER BY ordinal DESC LIMIT 1").get(lease.id);
    db.prepare("UPDATE leases SET released_at=?,release_reason='expired' WHERE id=? AND released_at IS NULL").run(at, lease.id);
    if (!step || TERMINAL_STEP_STATES.has(step.state)) continue;
    let action = "released";
    if (attempt?.state === "pending") entityState(db, "attempt", attempt.id, "cancelled", at, { reason: "lease expired before attempt start" });
    if (attempt?.state === "running") entityState(db, "attempt", attempt.id, "timed_out", at, { reason: "lease expired while attempt was running" });
    if (step.state === "leased") {
      entityState(db, "workflow_step", step.id, "ready", at, { reason: "lease expired before execution" });
      action = "ready";
    } else if (step.state === "running") {
      const attemptCount = db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE step_id=?").get(step.id).count;
      if (!step.irreversible && attemptCount < step.max_attempts) {
        entityState(db, "workflow_step", step.id, "retry_scheduled", at, { reason: "recover after expired execution lease" });
        db.prepare("UPDATE workflow_steps SET next_attempt_at=?,last_error_category='lease_expired' WHERE id=?").run(at, step.id);
        action = "retry_scheduled";
      } else {
        entityState(db, "workflow_step", step.id, "blocked", at, { reason: "lease recovery requires escalation" });
        blockForDeadLetter(db, step, attempt?.id ?? null, "lease_expired", { attempts: attemptCount }, at);
        action = "dead_lettered";
      }
    }
    appendEvent(db, { entityType: "workflow_step", entityId: step.id, kind: "lease_expired", payload: { lease_id: lease.id, action } });
    recovered.push({ leaseId: lease.id, stepId: step.id, action });
  }
  return recovered;
}

export class ExecutionQueue {
  constructor(db) { this.db = db; }

  enqueueRun(runId, at = now()) {
    return transaction(this.db, () => activateNext(this.db, runId, iso(at)));
  }

  checkout({ ownerId, runId = null, leaseMs = 60_000, at = now() }) {
    if (!ownerId) throw new Error("LEASE_OWNER_REQUIRED");
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new Error("LEASE_DURATION_INVALID");
    return transaction(this.db, () => {
      const timestamp = iso(at);
      recoverExpiredInternal(this.db, timestamp);
      const step = this.db.prepare(`SELECT ws.*,wr.task_id,wr.state AS run_state,wr.resume_state AS run_resume_state
        FROM workflow_steps ws JOIN workflow_runs wr ON wr.id=ws.run_id
        WHERE ws.state IN ('ready','retry_scheduled')
          AND (ws.next_attempt_at IS NULL OR ws.next_attempt_at<=?)
          AND (? IS NULL OR ws.run_id=?)
          AND wr.state IN ('planning','executing','documenting','verifying','review_required','changes_requested','approval_required','documented','retry_scheduled')
          AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.step_id=ws.id AND l.released_at IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM workflow_steps previous
            WHERE previous.run_id=ws.run_id AND previous.ordinal<ws.ordinal
              AND previous.required=1 AND previous.state NOT IN ('completed','documented','cancelled')
          )
        ORDER BY ws.created_at,ws.run_id,ws.ordinal LIMIT 1`).get(timestamp, runId, runId);
      if (!step) return null;
      if (step.run_state === "retry_scheduled") pairedState(this.db, step.run_id, step.run_resume_state ?? "executing", timestamp, { reason: "dead-letter retry checked out" }, { clearResume: true });
      if (step.state === "retry_scheduled") entityState(this.db, "workflow_step", step.id, "ready", timestamp, { reason: "retry delay elapsed" });
      const token = crypto.randomBytes(32).toString("base64url");
      const leaseId = id("lease");
      const expiresAt = iso(Date.parse(timestamp) + leaseMs);
      this.db.prepare("INSERT INTO leases(id,step_id,owner_id,token_hash,acquired_at,expires_at,heartbeat_at) VALUES(?,?,?,?,?,?,?)")
        .run(leaseId, step.id, ownerId, tokenHash(token), timestamp, expiresAt, timestamp);
      entityState(this.db, "workflow_step", step.id, "leased", timestamp, { owner_id: ownerId, lease_id: leaseId });
      const ordinal = this.db.prepare("SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM attempts WHERE step_id=?").get(step.id).ordinal;
      const attemptId = id("attempt");
      const attemptKey = `${step.id}:${ordinal}`;
      this.db.prepare("INSERT INTO attempts(id,step_id,ordinal,state,idempotency_key,lease_id,details_json) VALUES(?,?,?,'pending',?,?, '{}')")
        .run(attemptId, step.id, ordinal, attemptKey, leaseId);
      appendEvent(this.db, { entityType: "attempt", entityId: attemptId, kind: "created", payload: { idempotency_key: attemptKey, lease_id: leaseId } });
      return { token, leaseId, attemptId, attemptNo: ordinal, stepId: step.id, stepKey: step.step_key, runId: step.run_id, taskId: step.task_id, ownerId, expiresAt };
    });
  }

  start(token, at = now()) {
    return transaction(this.db, () => {
      const timestamp = iso(at);
      const lease = activeLeaseByToken(this.db, token);
      if (lease.expires_at <= timestamp) throw new Error("LEASE_EXPIRED");
      const step = this.db.prepare("SELECT * FROM workflow_steps WHERE id=?").get(lease.step_id);
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE lease_id=? ORDER BY ordinal DESC LIMIT 1").get(lease.id);
      if (step.state === "running" && attempt?.state === "running") return { stepId: step.id, attemptId: attempt.id, idempotent: true };
      entityState(this.db, "workflow_step", step.id, "running", timestamp, { lease_id: lease.id });
      entityState(this.db, "attempt", attempt.id, "running", timestamp, { lease_id: lease.id });
      this.db.prepare("UPDATE leases SET heartbeat_at=? WHERE id=?").run(timestamp, lease.id);
      return { stepId: step.id, attemptId: attempt.id, idempotent: false };
    });
  }

  heartbeat(token, { leaseMs = 60_000, at = now() } = {}) {
    return transaction(this.db, () => {
      const timestamp = iso(at);
      const lease = activeLeaseByToken(this.db, token);
      if (lease.expires_at <= timestamp) throw new Error("LEASE_EXPIRED");
      const expiresAt = iso(Date.parse(timestamp) + leaseMs);
      this.db.prepare("UPDATE leases SET heartbeat_at=?,expires_at=? WHERE id=?").run(timestamp, expiresAt, lease.id);
      return { leaseId: lease.id, expiresAt };
    });
  }

  complete(token, { receiptId = null, details = {}, at = now() } = {}) {
    return transaction(this.db, () => {
      const timestamp = iso(at);
      const lease = activeLeaseByToken(this.db, token, { allowReleased: true });
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE lease_id=? ORDER BY ordinal DESC LIMIT 1").get(lease.id);
      if (lease.released_at) {
        if (lease.release_reason !== "completed") throw new Error(`LEASE_RELEASED: ${lease.release_reason}`);
        return { stepId: lease.step_id, attemptId: attempt?.id ?? null, idempotent: true };
      }
      const step = this.db.prepare("SELECT * FROM workflow_steps WHERE id=?").get(lease.step_id);
      if (step.state !== "running" || attempt?.state !== "running") throw new Error("ATTEMPT_NOT_RUNNING");
      entityState(this.db, "attempt", attempt.id, "succeeded", timestamp, { receipt_id: receiptId });
      this.db.prepare("UPDATE attempts SET receipt_id=?,details_json=? WHERE id=?").run(receiptId, JSON.stringify(details), attempt.id);
      entityState(this.db, "workflow_step", step.id, "verifying", timestamp, { reason: "attempt succeeded" });
      entityState(this.db, "workflow_step", step.id, "completed", timestamp, { reason: "attempt result confirmed" });
      this.db.prepare("UPDATE leases SET released_at=?,release_reason='completed' WHERE id=?").run(timestamp, lease.id);
      const next = activateNext(this.db, step.run_id, timestamp);
      if (!next) appendEvent(this.db, { entityType: "workflow_run", entityId: step.run_id, kind: "queue_drained", payload: { last_step_id: step.id } });
      return { stepId: step.id, attemptId: attempt.id, nextStepId: next?.id ?? null, idempotent: false };
    });
  }

  fail(token, { category = "execution_error", details = {}, retryable = true, retryDelayMs = 0, at = now() } = {}) {
    return transaction(this.db, () => {
      const timestamp = iso(at);
      const lease = activeLeaseByToken(this.db, token, { allowReleased: true });
      if (lease.released_at) return { stepId: lease.step_id, action: lease.release_reason, idempotent: true };
      const step = this.db.prepare("SELECT * FROM workflow_steps WHERE id=?").get(lease.step_id);
      const attempt = this.db.prepare("SELECT * FROM attempts WHERE lease_id=? ORDER BY ordinal DESC LIMIT 1").get(lease.id);
      if (step.state !== "running" || attempt?.state !== "running") throw new Error("ATTEMPT_NOT_RUNNING");
      entityState(this.db, "attempt", attempt.id, "failed", timestamp, { category });
      this.db.prepare("UPDATE attempts SET error_category=?,details_json=? WHERE id=?").run(category, JSON.stringify(details), attempt.id);
      this.db.prepare("UPDATE leases SET released_at=?,release_reason='failed' WHERE id=?").run(timestamp, lease.id);
      const attemptCount = this.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE step_id=?").get(step.id).count;
      if (retryable && !step.irreversible && attemptCount < step.max_attempts) {
        entityState(this.db, "workflow_step", step.id, "retry_scheduled", timestamp, { category, attempt: attemptCount, max_attempts: step.max_attempts });
        const nextAttemptAt = iso(Date.parse(timestamp) + Math.max(0, retryDelayMs));
        this.db.prepare("UPDATE workflow_steps SET next_attempt_at=?,last_error_category=? WHERE id=?").run(nextAttemptAt, category, step.id);
        return { stepId: step.id, attemptId: attempt.id, action: "retry_scheduled", nextAttemptAt, idempotent: false };
      }
      entityState(this.db, "workflow_step", step.id, "blocked", timestamp, { category, reason: step.irreversible ? "irreversible replay requires approval" : "retry budget exhausted" });
      const deadLetterId = blockForDeadLetter(this.db, step, attempt.id, category, { ...details, attempts: attemptCount, max_attempts: step.max_attempts }, timestamp);
      return { stepId: step.id, attemptId: attempt.id, action: "dead_lettered", deadLetterId, idempotent: false };
    });
  }

  recoverExpiredLeases(at = now()) { return transaction(this.db, () => recoverExpiredInternal(this.db, iso(at))); }

  pauseRun(runId, { reason = "paused by operator", at = now() } = {}) {
    return transaction(this.db, () => {
      const active = this.db.prepare("SELECT COUNT(*) AS count FROM leases l JOIN workflow_steps ws ON ws.id=l.step_id WHERE ws.run_id=? AND l.released_at IS NULL").get(runId).count;
      if (active) throw new Error("PAUSE_ACTIVE_LEASE");
      return pairedState(this.db, runId, "paused", iso(at), { reason }, { remember: true });
    });
  }

  resumeRun(runId, { at = now() } = {}) {
    return transaction(this.db, () => {
      const run = this.db.prepare("SELECT state,resume_state FROM workflow_runs WHERE id=?").get(runId);
      if (!run || run.state !== "paused" || !run.resume_state) throw new Error("RUN_NOT_RESUMABLE");
      return pairedState(this.db, runId, run.resume_state, iso(at), { reason: "resume from last confirmed lifecycle state" }, { clearResume: true });
    });
  }

  cancelRun(runId, { reason = "cancelled by operator", at = now() } = {}) {
    return transaction(this.db, () => {
      const timestamp = iso(at);
      const run = this.db.prepare("SELECT task_id,state FROM workflow_runs WHERE id=?").get(runId);
      if (!run) throw new Error(`STATE_ENTITY_NOT_FOUND: workflow_run:${runId}`);
      if (run.state === "cancelled") return "cancelled";
      for (const lease of this.db.prepare("SELECT l.* FROM leases l JOIN workflow_steps ws ON ws.id=l.step_id WHERE ws.run_id=? AND l.released_at IS NULL").all(runId)) {
        const attempt = this.db.prepare("SELECT * FROM attempts WHERE lease_id=? ORDER BY ordinal DESC LIMIT 1").get(lease.id);
        if (attempt && ["pending", "running"].includes(attempt.state)) entityState(this.db, "attempt", attempt.id, "cancelled", timestamp, { reason });
        this.db.prepare("UPDATE leases SET released_at=?,release_reason='cancelled' WHERE id=?").run(timestamp, lease.id);
      }
      for (const step of this.db.prepare("SELECT * FROM workflow_steps WHERE run_id=? ORDER BY ordinal").all(runId)) {
        if (!TERMINAL_STEP_STATES.has(step.state) && canTransition("workflow_step", step.state, "cancelled")) entityState(this.db, "workflow_step", step.id, "cancelled", timestamp, { reason });
      }
      return pairedState(this.db, runId, "cancelled", timestamp, { reason }, { clearResume: true });
    });
  }

  retryDeadLetter(deadLetterId, { approved = false, actor = "operator", at = now() } = {}) {
    return transaction(this.db, () => {
      const timestamp = iso(at);
      const dead = this.db.prepare("SELECT dl.*,ws.state AS step_state FROM dead_letters dl JOIN workflow_steps ws ON ws.id=dl.step_id WHERE dl.id=?").get(deadLetterId);
      if (!dead || dead.resolved_at) throw new Error("DEAD_LETTER_NOT_OPEN");
      if (dead.replay_requires_approval && !approved) throw new Error("IRREVERSIBLE_REPLAY_APPROVAL_REQUIRED");
      if (dead.replay_requires_approval) {
        const decisionId = id("decision");
        this.db.prepare("INSERT INTO decisions(id,task_id,run_id,step_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,?,?,'APPROVE',?,?,1,?)")
          .run(decisionId, dead.task_id, dead.run_id, dead.step_id, "irreversible_replay", actor, JSON.stringify({ dead_letter_id: dead.id }), timestamp);
        this.db.prepare("UPDATE approvals SET status='approved',decision_id=?,resolved_at=? WHERE step_id=? AND kind='irreversible_replay' AND status='pending'").run(decisionId, timestamp, dead.step_id);
      }
      entityState(this.db, "workflow_step", dead.step_id, "retry_scheduled", timestamp, { dead_letter_id: dead.id, approved, actor });
      this.db.prepare("UPDATE workflow_steps SET dead_lettered_at=NULL,next_attempt_at=?,last_error_category=NULL WHERE id=?").run(timestamp, dead.step_id);
      this.db.prepare("UPDATE dead_letters SET resolved_at=?,resolution='retry_scheduled' WHERE id=?").run(timestamp, dead.id);
      const run = this.db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(dead.run_id);
      if (run.state === "blocked") pairedState(this.db, dead.run_id, "retry_scheduled", timestamp, { reason: "dead-letter retry authorized", dead_letter_id: dead.id });
      return { deadLetterId: dead.id, stepId: dead.step_id, status: "retry_scheduled" };
    });
  }
}
