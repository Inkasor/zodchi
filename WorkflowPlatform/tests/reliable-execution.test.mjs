import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "../src/runtime.mjs";
import { ExecutionQueue } from "../src/execution-queue.mjs";
import { BudgetManager, invokeWithinBudget } from "../src/budget.mjs";
import { now } from "../src/db.mjs";

const CLASSIFICATION = { kind: "task", domain: "workflow", discipline: "general", risk: "low", level: "L2", quality: "mvp", planning_required: true, human_required: false, document_required: false };

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function fixture(prefix = "workflow-reliable-") {
  const root = temporaryRoot(prefix);
  const dbFile = path.join(root, "workflow.sqlite");
  const runtime = new Runtime(dbFile);
  const timestamp = now();
  runtime.db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(path.join(root, "project"), timestamp);
  runtime.db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status) VALUES('workflow','Workflow','project','mvp','L2','active')").run();
  return { root, dbFile, runtime, queue: new ExecutionQueue(runtime.db), budgets: new BudgetManager(runtime.db) };
}

function plannedRun(runtime, title, steps, eventKey = null) {
  const runId = runtime.create(title, { project_id: "project", workflow_id: "workflow", event_source: "test", event_key: eventKey });
  runtime.classify(runId, CLASSIFICATION);
  runtime.plan(runId, { objective: title, steps });
  runtime.setState(runId, "executing");
  return runId;
}

function cleanup(root, runtime) {
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

test("inbox idempotency returns the original run and rejects key reuse with another payload", () => {
  const { root, runtime } = fixture("workflow-inbox-");
  const first = runtime.create("same message", { project_id: "project", workflow_id: "workflow", event_source: "codex-hook", event_key: "event-1" });
  const duplicate = runtime.create("same message", { project_id: "project", workflow_id: "workflow", event_source: "codex-hook", event_key: "event-1" });
  assert.equal(duplicate, first);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 1);
  assert.throws(() => runtime.create("different message", { project_id: "project", workflow_id: "workflow", event_source: "codex-hook", event_key: "event-1" }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='contract_error'").get().count, 2);
  cleanup(root, runtime);
});

test("distinct hook event keys always create distinct runs for the same project and payload", () => {
  const { root, runtime } = fixture("workflow-inbox-distinct-events-");
  const first = runtime.create("same owner message", { project_id: "project", workflow_id: "workflow", event_source: "codex-hook", event_key: "turn-1" });
  const second = runtime.create("same owner message", { project_id: "project", workflow_id: "workflow", event_source: "codex-hook", event_key: "turn-2" });
  assert.notEqual(second, first);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 2);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 2);
  assert.deepEqual(runtime.db.prepare("SELECT event_key FROM inbox_events ORDER BY event_key").all().map(row => row.event_key), ["turn-1", "turn-2"]);
  cleanup(root, runtime);
});

test("checkout is atomic, one task stays sequential and independent tasks can run in parallel", () => {
  const { root, dbFile, runtime, queue } = fixture("workflow-lease-");
  const runA = plannedRun(runtime, "A", [{ key: "worker-a" }, { key: "review-a" }]);
  const runB = plannedRun(runtime, "B", [{ key: "worker-b" }]);
  queue.enqueueRun(runA);
  queue.enqueueRun(runB);
  const first = queue.checkout({ ownerId: "worker-1", leaseMs: 60_000 });
  const secondRuntime = new Runtime(dbFile);
  const secondQueue = new ExecutionQueue(secondRuntime.db);
  const second = secondQueue.checkout({ ownerId: "worker-2", leaseMs: 60_000 });
  assert.ok(first && second);
  assert.notEqual(first.runId, second.runId);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE released_at IS NULL").get().count, 2);
  assert.equal(queue.start(first.token).idempotent, false);
  assert.equal(queue.start(first.token).idempotent, true);
  const completion = queue.complete(first.token, { receiptId: "receipt-1" });
  assert.ok(completion.nextStepId);
  const third = queue.checkout({ ownerId: "worker-3", leaseMs: 60_000 });
  assert.equal(third.runId, first.runId);
  assert.notEqual(third.stepId, first.stepId);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE step_id=?").get(first.stepId).count, 1);
  secondRuntime.db.close();
  cleanup(root, runtime);
});

test("role-aware checkout cannot lease a sibling role and an abandoned phase releases its lease", () => {
  const { root, runtime, queue } = fixture("workflow-role-aware-lease-");
  runtime.db.prepare("INSERT OR IGNORE INTO roles(id,name) VALUES('adversarial_reviewer','Test adversarial reviewer role')").run();
  const runId = plannedRun(runtime, "parallel review", [
    { key: "review-a", role: "reviewer" },
    { key: "review-b", role: "adversarial_reviewer" }
  ]);
  runtime.db.prepare("UPDATE workflow_steps SET ordinal=1,role_id=CASE step_key WHEN 'review-a' THEN 'reviewer' ELSE 'adversarial_reviewer' END WHERE run_id=?").run(runId);
  queue.enqueueRun(runId);
  const lease = queue.checkout({ ownerId: "workflow:adversarial_reviewer", runId, roleId: "adversarial_reviewer" });
  const leasedStep = runtime.db.prepare("SELECT role_id FROM workflow_steps WHERE id=?").get(lease.stepId);
  assert.equal(leasedStep.role_id, "adversarial_reviewer");
  const ids = runtime.db.prepare("SELECT id FROM workflow_steps WHERE run_id=?").all(runId).map(row => row.id);
  assert.equal(queue.abandonSteps(runId, ids, { reason: "test phase abort" }).length, 2);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) count FROM leases WHERE released_at IS NULL").get().count, 0);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) count FROM workflow_steps WHERE run_id=? AND state!='cancelled'").get(runId).count, 0);
  cleanup(root, runtime);
});

test("pause/resume preserves the confirmed lifecycle state and cancel revokes active work", () => {
  const { root, runtime, queue } = fixture("workflow-pause-cancel-");
  const runId = plannedRun(runtime, "pause and cancel", [{ key: "worker" }, { key: "reviewer" }]);
  queue.enqueueRun(runId);
  queue.pauseRun(runId);
  assert.equal(runtime.get(runId).state, "paused");
  assert.equal(runtime.get(runId).resume_state, "executing");
  queue.resumeRun(runId);
  assert.equal(runtime.get(runId).state, "executing");
  const lease = queue.checkout({ ownerId: "worker", leaseMs: 60_000 });
  queue.start(lease.token);
  queue.cancelRun(runId);
  assert.equal(runtime.get(runId).state, "cancelled");
  assert.equal(runtime.db.prepare("SELECT state FROM attempts WHERE id=?").get(lease.attemptId).state, "cancelled");
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE released_at IS NULL").get().count, 0);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND state!='cancelled'").get(runId).count, 0);
  cleanup(root, runtime);
});

for (const stage of ["planning", "worker", "gate", "reviewer", "documentator"]) {
  test(`expired ${stage} execution resumes from the last confirmed step`, () => {
    const { root, runtime, queue } = fixture(`workflow-recover-${stage}-`);
    const runId = plannedRun(runtime, `recover ${stage}`, [{ key: stage, max_attempts: 2 }]);
    queue.enqueueRun(runId, "2026-01-01T00:00:00.000Z");
    const first = queue.checkout({ ownerId: "crashing-worker", leaseMs: 1000, at: "2026-01-01T00:00:00.000Z" });
    queue.start(first.token, "2026-01-01T00:00:00.100Z");
    const recovered = queue.recoverExpiredLeases("2026-01-01T00:00:02.000Z");
    assert.deepEqual(recovered.map(item => item.action), ["retry_scheduled"]);
    assert.equal(runtime.db.prepare("SELECT state FROM attempts WHERE id=?").get(first.attemptId).state, "timed_out");
    const second = queue.checkout({ ownerId: "recovery-worker", leaseMs: 1000, at: "2026-01-01T00:00:02.100Z" });
    assert.equal(second.stepId, first.stepId);
    assert.equal(second.attemptNo, 2);
    queue.start(second.token, "2026-01-01T00:00:02.200Z");
    queue.complete(second.token, { at: "2026-01-01T00:00:02.300Z" });
    assert.equal(runtime.db.prepare("SELECT state FROM workflow_steps WHERE id=?").get(first.stepId).state, "completed");
    cleanup(root, runtime);
  });
}

test("bounded retries enter dead-letter and an explicit retry restores reversible work", () => {
  const { root, runtime, queue } = fixture("workflow-dead-letter-");
  const runId = plannedRun(runtime, "bounded retry", [{ key: "worker", max_attempts: 2 }]);
  queue.enqueueRun(runId);
  const first = queue.checkout({ ownerId: "worker", leaseMs: 60_000 });
  queue.start(first.token);
  assert.equal(queue.fail(first.token, { category: "red_gate" }).action, "retry_scheduled");
  const second = queue.checkout({ ownerId: "worker", leaseMs: 60_000 });
  queue.start(second.token);
  const failed = queue.fail(second.token, { category: "red_gate" });
  assert.equal(failed.action, "dead_lettered");
  assert.equal(runtime.get(runId).state, "blocked");
  assert.equal(runtime.db.prepare("SELECT state FROM workflow_steps WHERE id=?").get(first.stepId).state, "blocked");
  queue.retryDeadLetter(failed.deadLetterId);
  assert.equal(runtime.get(runId).state, "retry_scheduled");
  const third = queue.checkout({ ownerId: "manual-retry", leaseMs: 60_000 });
  assert.equal(runtime.get(runId).state, "executing");
  queue.start(third.token);
  queue.complete(third.token);
  assert.equal(runtime.db.prepare("SELECT resolution FROM dead_letters WHERE id=?").get(failed.deadLetterId).resolution, "retry_scheduled");
  cleanup(root, runtime);
});

test("a scheduled retry keeps its run selectable until the second attempt is consumed", () => {
  const { root, runtime, queue } = fixture("workflow-live-retry-");
  const runId = plannedRun(runtime, "live retry", [{ key: "worker", max_attempts: 2 }]);
  queue.enqueueRun(runId, "2026-01-01T00:00:00.000Z");
  const first = queue.checkout({ ownerId: "worker", leaseMs: 60_000, at: "2026-01-01T00:00:00.100Z" });
  queue.start(first.token, "2026-01-01T00:00:00.200Z");
  const scheduled = queue.fail(first.token, { category: "ROLE_RESULT_SCHEMA_INVALID", retryDelayMs: 1_000, at: "2026-01-01T00:00:00.300Z" });
  assert.equal(scheduled.action, "retry_scheduled");
  assert.equal(scheduled.runState, "retry_scheduled");
  assert.equal(runtime.get(runId).state, "retry_scheduled");
  assert.equal(runtime.db.prepare("SELECT state FROM workflow_steps WHERE id=?").get(first.stepId).state, "retry_scheduled");
  assert.equal(queue.checkout({ ownerId: "too-early", leaseMs: 60_000, at: "2026-01-01T00:00:00.900Z" }), null);
  const second = queue.checkout({ ownerId: "worker-retry", leaseMs: 60_000, at: "2026-01-01T00:00:01.400Z" });
  assert.equal(second.attemptNo, 2);
  assert.equal(runtime.get(runId).state, "executing");
  queue.start(second.token, "2026-01-01T00:00:01.500Z");
  queue.complete(second.token, { at: "2026-01-01T00:00:01.600Z" });
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND state='retry_scheduled'").get(runId).count, 0);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE id=? AND state='failed'").get(runId).count, 0);
  cleanup(root, runtime);
});

test("irreversible work never retries without an explicit recorded approval", () => {
  const { root, runtime, queue } = fixture("workflow-irreversible-");
  const runId = plannedRun(runtime, "irreversible", [{ key: "publish-like-step", irreversible: true, max_attempts: 3 }]);
  queue.enqueueRun(runId);
  const lease = queue.checkout({ ownerId: "worker", leaseMs: 60_000 });
  queue.start(lease.token);
  const failed = queue.fail(lease.token, { category: "connection_lost" });
  assert.equal(failed.action, "dead_lettered");
  assert.throws(() => queue.retryDeadLetter(failed.deadLetterId), /IRREVERSIBLE_REPLAY_APPROVAL_REQUIRED/);
  queue.retryDeadLetter(failed.deadLetterId, { approved: true, actor: "test-owner" });
  assert.equal(runtime.db.prepare("SELECT status FROM approvals WHERE step_id=? AND kind='irreversible_replay'").get(lease.stepId).status, "approved");
  assert.equal(runtime.db.prepare("SELECT outcome FROM decisions WHERE step_id=? AND kind='irreversible_replay'").get(lease.stepId).outcome, "APPROVE");
  cleanup(root, runtime);
});

test("project, task, workflow, role and attempt budgets stop atomically before another call", async () => {
  const { root, runtime, budgets } = fixture("workflow-budget-");
  const runId = plannedRun(runtime, "budget", [{ key: "worker" }]);
  const taskId = runtime.get(runId).task_id;
  const scopes = [
    { type: "project", id: "project" },
    { type: "task", id: taskId },
    { type: "workflow", id: runId },
    { type: "role", id: "worker" },
    { type: "attempt", id: "attempt-1" }
  ];
  for (const scope of scopes) budgets.define({ scopeType: scope.type, scopeId: scope.id, metric: "calls", limit: 1 });
  assert.equal(budgets.consume({ scopes, metric: "calls", amount: 1, idempotencyKey: "call-1", taskId, runId }).applied, true);
  assert.equal(budgets.consume({ scopes, metric: "calls", amount: 1, idempotencyKey: "call-1", taskId, runId }).idempotent, true);
  let invoked = false;
  await assert.rejects(() => invokeWithinBudget(budgets, { scopes, metric: "calls", amount: 1, idempotencyKey: "call-2", taskId, runId }, async () => { invoked = true; }), /BUDGET_EXHAUSTED/);
  assert.equal(invoked, false);
  assert.equal(runtime.get(runId).state, "blocked");
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM budget_entries").get().count, 5);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM budgets WHERE used_value=1 AND status='exhausted'").get().count, 5);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='budget_hard_stop'").get().count, 2);
  cleanup(root, runtime);
});
