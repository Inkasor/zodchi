import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { Runtime } from "../src/runtime.mjs";
import { activateChatSession } from "../src/chat-session.mjs";
import { addressedEvent, addressedInteraction, applyRoleStatePatch, statePatchContract, taskStateProjection } from "../src/task-state.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-task-state-"));
  const dbFile = path.join(root, "workflow.sqlite"), projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot);
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(projectRoot, now());
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status) VALUES('workflow','Workflow','project','mvp','L2','active')").run();
  activateChatSession(db, { client: "codex", sessionId: "task-state-chat", origin: projectRoot, turnKey: "turn-1" });
  db.close();
  const runtime = new Runtime(dbFile);
  const runId = runtime.accept("Exact owner objective", { project_id: "project", workflow_id: "workflow", chat_session: { client: "codex", session_id: "task-state-chat" } }).runId;
  return { root, runtime, runId };
}

test("task state is a computed current projection and history is read only by exact id", () => {
  const { root, runtime, runId } = fixture();
  const task = runtime.getTask(runId), timestamp = now();
  runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at,detail_json,affected_steps_json) VALUES('interaction',?,?,'clarification','Which boundary?','pending',?,'{}','[]')")
    .run(task.id, runId, timestamp);
  const state = taskStateProjection(runtime.db, runId);
  assert.equal(state.owner_objective.verbatim, "Exact owner objective");
  assert.equal(state.open_questions[0].id, "interaction");
  assert.match(state.projection_hash, /^[0-9a-f]{64}$/);
  assert.equal(addressedInteraction(runtime.db, runId, "interaction").question, "Which boundary?");
  const eventId = runtime.db.prepare("SELECT event_id FROM events WHERE run_id=? ORDER BY sequence LIMIT 1").get(runId).event_id;
  assert.equal(addressedEvent(runtime.db, runId, eventId).event_id, eventId);
  const nextRun = runtime.accept("Address the earlier item", { project_id: "project", workflow_id: "workflow", chat_session: { client: "codex", session_id: "task-state-chat" } }).runId;
  assert.equal(addressedInteraction(runtime.db, nextRun, "interaction").id, "interaction");
  assert.equal(addressedEvent(runtime.db, nextRun, eventId).event_id, eventId);
  assert.throws(() => addressedInteraction(runtime.db, runId, "missing"), /INTERACTION_NOT_FOUND/);
  assert.equal(runtime.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_state'").get(), undefined);
  runtime.db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("strategy reviewer patch is hash-bound and cannot write a derived field", () => {
  const { root, runtime, runId } = fixture();
  const contract = statePatchContract(runtime.db, runId, "strategy_reviewer");
  const result = {
    schema_version: 1, decision: "NO_VIABLE_STRATEGY", rationale: "No bounded route remains.", selected_step_keys: [], verification_request: null, replan_intent: null, evidence_refs: [],
    state_patch: { schema_version: 1, patch_id: contract.patch_id, base_projection_hash: contract.base_projection_hash, changes: [{ operation: "replace_active", path: "decisions.strategy_recovery" }] }
  };
  assert.throws(() => applyRoleStatePatch(runtime.db, runId, "strategy_reviewer", result, null), /STATE_PATCH_CONTRACT_REQUIRED/);
  runtime.db.exec("BEGIN IMMEDIATE");
  const applied = applyRoleStatePatch(runtime.db, runId, "strategy_reviewer", result, contract);
  assert.equal(runtime.db.isTransaction, true);
  runtime.db.exec("COMMIT");
  assert.equal(applied.status, "applied");
  assert.equal(runtime.db.prepare("SELECT kind FROM decisions WHERE id=?").get(contract.patch_id).kind, "strategy_recovery");
  const forbidden = statePatchContract(runtime.db, runId, "strategy_reviewer");
  const forbiddenResult = structuredClone(result);
  forbiddenResult.state_patch = { schema_version: 1, patch_id: forbidden.patch_id, base_projection_hash: forbidden.base_projection_hash, changes: [{ operation: "replace", path: "blockers" }] };
  assert.throws(() => applyRoleStatePatch(runtime.db, runId, "strategy_reviewer", forbiddenResult, forbidden), /FIELD_NOT_ALLOWED/);
  const stale = statePatchContract(runtime.db, runId, "strategy_reviewer");
  runtime.db.prepare("UPDATE workflow_runs SET state='classifying' WHERE id=?").run(runId);
  const staleResult = structuredClone(result);
  staleResult.state_patch = { schema_version: 1, patch_id: stale.patch_id, base_projection_hash: stale.base_projection_hash, changes: [{ operation: "replace_active", path: "decisions.strategy_recovery" }] };
  assert.throws(() => applyRoleStatePatch(runtime.db, runId, "strategy_reviewer", staleResult, stale), /STATE_PATCH_STALE/);
  runtime.db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("judge is the next role migrated to a hash-bound canonical decision patch", () => {
  const { root, runtime, runId } = fixture();
  const contract = statePatchContract(runtime.db, runId, "judge");
  const result = {
    schema_version: 1, decision: "PASS", rationale: "The admissible opinions support completion.", evidence_refs: [], primary_gap: null, verification_request: null,
    state_patch: { schema_version: 1, patch_id: contract.patch_id, base_projection_hash: contract.base_projection_hash, changes: [{ operation: "replace_active", path: "decisions.judge_resolution" }] }
  };
  const applied = applyRoleStatePatch(runtime.db, runId, "judge", result, contract);
  assert.equal(applied.status, "applied");
  assert.deepEqual({ ...runtime.db.prepare("SELECT kind,outcome,source FROM decisions WHERE id=?").get(contract.patch_id) }, { kind: "judge_resolution", outcome: "PASS", source: "judge" });
  const broader = statePatchContract(runtime.db, runId, "judge");
  assert.throws(() => applyRoleStatePatch(runtime.db, runId, "judge", { ...result, state_patch: { schema_version: 1, patch_id: broader.patch_id, base_projection_hash: broader.base_projection_hash, changes: [{ operation: "replace_active", path: "decisions.strategy_recovery" }] } }, broader), /FIELD_NOT_ALLOWED/);
  runtime.db.close(); fs.rmSync(root, { recursive: true, force: true });
});
