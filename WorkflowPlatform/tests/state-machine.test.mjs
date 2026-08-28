import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, id, now } from "../src/db.mjs";
import { Runtime } from "../src/runtime.mjs";
import { ALLOWED_TRANSITIONS, ATTEMPT_STATES, RUN_STATES, STEP_STATES, TASK_STATES, canTransition, completionBlockers, transitionEntity, transitionRunAndTask } from "../src/state-machine.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function runtimeFixture() {
  const root = temporaryRoot("workflow-state-machine-");
  const dbFile = path.join(root, "workflow.sqlite");
  const runtime = new Runtime(dbFile);
  const timestamp = now();
  runtime.db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(path.join(root, "project"), timestamp);
  runtime.db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status) VALUES('workflow','Workflow','project','mvp','L2','active')").run();
  return { root, runtime };
}

test("closed vocabularies classify every allowed and forbidden transition", () => {
  const vocabularies = { task: TASK_STATES, workflow_run: RUN_STATES, workflow_step: STEP_STATES, attempt: ATTEMPT_STATES };
  for (const [entityType, states] of Object.entries(vocabularies)) {
    assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS[entityType]).sort(), [...states].sort());
    for (const from of states) for (const to of states) assert.equal(canTransition(entityType, from, to), ALLOWED_TRANSITIONS[entityType][from].includes(to), `${entityType} ${from} -> ${to}`);
    for (const terminal of states.filter(state => ["completed", "cancelled", "rejected", "failed", "succeeded", "timed_out"].includes(state))) assert.deepEqual(ALLOWED_TRANSITIONS[entityType][terminal], []);
  }
});

test("generated state walks never escape a terminal state or invent an unregistered transition", () => {
  const vocabularies = { task: TASK_STATES, workflow_run: RUN_STATES, workflow_step: STEP_STATES, attempt: ATTEMPT_STATES };
  const random = seed => {
    let value = seed >>> 0;
    return () => ((value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0) / 0x1_0000_0000);
  };

  for (const [entityType, states] of Object.entries(vocabularies)) {
    for (let seed = 1; seed <= 64; seed += 1) {
      const next = random(seed * 97 + entityType.length), initial = states[Math.floor(next() * states.length)];
      let current = initial, terminalReached = ALLOWED_TRANSITIONS[entityType][current].length === 0;
      for (let turn = 0; turn < 256; turn += 1) {
        const proposed = states[Math.floor(next() * states.length)];
        const registered = ALLOWED_TRANSITIONS[entityType][current].includes(proposed);
        assert.equal(canTransition(entityType, current, proposed), registered, `${entityType}:${seed}:${turn} ${current} -> ${proposed}`);
        if (terminalReached) assert.equal(registered, false, `${entityType}:${current} escaped a terminal state`);
        if (registered) current = proposed;
        terminalReached ||= ALLOWED_TRANSITIONS[entityType][current].length === 0;
      }
    }
  }
});

test("paired task/run transition is atomic and forbidden transition records contract errors", () => {
  const { root, runtime } = runtimeFixture();
  const runId = runtime.create("state contract", { project_id: "project", workflow_id: "workflow" });
  transitionRunAndTask(runtime.db, runId, "classifying", { reason: "test" });
  assert.equal(runtime.get(runId).state, "classifying");
  assert.equal(runtime.getTask(runId).state, "classifying");
  assert.throws(() => transitionRunAndTask(runtime.db, runId, "completed"), /STATE_TRANSITION_FORBIDDEN/);
  assert.equal(runtime.get(runId).state, "classifying");
  assert.equal(runtime.getTask(runId).state, "classifying");
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='contract_error' AND entity_id IN (?,?)").get(runId, runtime.get(runId).task_id).count, 2);
  assert.throws(() => runtime.db.prepare("UPDATE events SET kind='changed' WHERE run_id=?").run(runId), /events are immutable/);
  assert.throws(() => runtime.db.prepare("DELETE FROM events WHERE run_id=?").run(runId), /events are immutable/);
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("task, step and attempt states remain independent", () => {
  const { root, runtime } = runtimeFixture();
  const runId = runtime.create("independent states", { project_id: "project", workflow_id: "workflow" });
  const stepId = id("step"), attemptId = id("attempt"), timestamp = now();
  runtime.db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,state,required,irreversible,created_at,updated_at) VALUES(?,?,?,1,'pending',1,0,?,?)").run(stepId, runId, "worker", timestamp, timestamp);
  runtime.db.prepare("INSERT INTO attempts(id,step_id,ordinal,state) VALUES(?,?,1,'pending')").run(attemptId, stepId);
  transitionEntity(runtime.db, "workflow_step", stepId, "ready");
  transitionEntity(runtime.db, "attempt", attemptId, "running");
  assert.equal(runtime.get(runId).state, "discovering");
  assert.equal(runtime.db.prepare("SELECT state FROM workflow_steps WHERE id=?").get(stepId).state, "ready");
  assert.equal(runtime.db.prepare("SELECT state FROM attempts WHERE id=?").get(attemptId).state, "running");
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("completion is blocked until required steps, gates, approvals and reviewer decisions are clear", () => {
  const { root, runtime } = runtimeFixture();
  const runId = runtime.create("completion guard", { project_id: "project", workflow_id: "workflow" });
  runtime.classify(runId, { kind: "task", domain: "workflow", discipline: "general", risk: "low", level: "L2", quality: "mvp", planning_required: true, human_required: false, document_required: false });
  runtime.setState(runId, "executing");
  runtime.setState(runId, "verifying");
  const taskId = runtime.get(runId).task_id;
  const stepId = id("step"), timestamp = now();
  runtime.db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,state,required,irreversible,created_at,updated_at) VALUES(?,?,?,1,'pending',1,0,?,?)").run(stepId, runId, "worker", timestamp, timestamp);
  runtime.db.prepare("INSERT INTO gates(id,run_id,kind,required,status,details_json) VALUES(?,?, 'project',1,'failed','{}')").run(id("gate"), runId);
  runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'owner','Approve?','pending',?)").run(id("approval"), taskId, runId, timestamp);
  runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,'review','REJECT','reviewer','{}',1,?)").run(id("decision"), taskId, runId, timestamp);
  assert.deepEqual(completionBlockers(runtime.db, taskId).map(item => item.kind), ["required_steps", "required_gates", "pending_approvals", "rejecting_decisions"]);
  assert.throws(() => runtime.setState(runId, "completed"), /COMPLETION_BLOCKED/);
  assert.equal(runtime.get(runId).state, "verifying");
  transitionEntity(runtime.db, "workflow_step", stepId, "ready");
  transitionEntity(runtime.db, "workflow_step", stepId, "running");
  transitionEntity(runtime.db, "workflow_step", stepId, "verifying");
  transitionEntity(runtime.db, "workflow_step", stepId, "completed");
  runtime.db.prepare("UPDATE gates SET status='passed' WHERE run_id=?").run(runId);
  runtime.db.prepare("UPDATE approvals SET status='approved',resolved_at=? WHERE task_id=?").run(now(), taskId);
  runtime.db.prepare("UPDATE decisions SET active=0 WHERE task_id=? AND outcome='REJECT'").run(taskId);
  assert.deepEqual(completionBlockers(runtime.db, taskId), []);
  runtime.setState(runId, "completed");
  assert.equal(runtime.get(runId).state, "completed");
  assert.equal(runtime.getTask(runId).state, "completed");
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
