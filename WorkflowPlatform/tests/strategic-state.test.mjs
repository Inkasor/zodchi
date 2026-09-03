import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { Runtime } from "../src/runtime.mjs";
import { createGoal, createStage, listStrategicState, setGoalStatus, setStageStatus, strategicRunContext } from "../src/strategic-state.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-strategic-state-"));
  const dbFile = path.join(root, "workflow.sqlite"), project = path.join(root, "project");
  fs.mkdirSync(project); const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, now());
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status) VALUES('workflow','Workflow','project','mvp','L2','active')").run();
  return { root, dbFile, db };
}
function classification() {
  return { kind: "implementation", domain: "workflow", discipline: "software", risk: "low", level: "L2", quality: "mvp", planning_required: true, human_required: false, document_required: false, artifact_type: "code", reply_mode: "work", needs_questions: false, pending_interaction_id: null, resolved_objective: "Implement the bounded change.", reason: "Bounded work.", questions: [], human_response: null };
}

test("owner control plane preserves goal wording and enforces strategic transitions", () => {
  const { root, db } = fixture();
  assert.throws(() => createGoal(db, { projectId: "project", title: "Ship exact objective" }), /OWNER_CONFIRMATION_REQUIRED/);
  const goal = createGoal(db, { projectId: "project", title: "Ship exact objective", confirmedBy: "owner" });
  const stage = createStage(db, { projectId: "project", goalId: goal.id, stageKey: "implementation", title: "Implement first slice", ordinal: 1, confirmedBy: "owner" });
  assert.equal(setStageStatus(db, { stageId: stage.id, status: "active", confirmedBy: "owner" }).status, "active");
  assert.throws(() => setGoalStatus(db, { goalId: goal.id, status: "completed", confirmedBy: "owner" }), /GOAL_HAS_OPEN_STAGES/);
  assert.throws(() => setGoalStatus(db, { goalId: goal.id, status: "active", confirmedBy: "owner" }), /TRANSITION_FORBIDDEN/);
  assert.equal(listStrategicState(db, "project").goals[0].title, "Ship exact objective");
  assert.deepEqual(db.prepare("SELECT entity_type,kind FROM events WHERE entity_type IN ('goal','stage') ORDER BY sequence").all().map(row => ({ ...row })), [
    { entity_type: "goal", kind: "created" },
    { entity_type: "stage", kind: "created" },
    { entity_type: "stage", kind: "state_transition" }
  ]);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("classified work binds only to one unambiguous active strategic path", () => {
  const { root, dbFile, db } = fixture();
  const goal = createGoal(db, { projectId: "project", title: "Owner goal", confirmedBy: "owner" });
  const stage = createStage(db, { projectId: "project", goalId: goal.id, stageKey: "current", title: "Current stage", confirmedBy: "owner" });
  setStageStatus(db, { stageId: stage.id, status: "active", confirmedBy: "owner" }); db.close();
  const runtime = new Runtime(dbFile); const runId = runtime.accept("Do work", { project_id: "project", workflow_id: "workflow" }).runId;
  runtime.classify(runId, classification());
  const task = runtime.db.prepare("SELECT goal_id,stage_id FROM tasks WHERE id=?").get(runtime.get(runId).task_id);
  assert.deepEqual({ ...task }, { goal_id: goal.id, stage_id: stage.id });
  assert.equal(strategicRunContext(runtime.db, runId).task_binding.stage.key, "current");
  runtime.db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("multiple active goals stay explicit instead of being guessed", () => {
  const { root, dbFile, db } = fixture();
  createGoal(db, { projectId: "project", title: "Goal one", confirmedBy: "owner" });
  createGoal(db, { projectId: "project", title: "Goal two", confirmedBy: "owner" }); db.close();
  const runtime = new Runtime(dbFile); const runId = runtime.accept("Do work", { project_id: "project", workflow_id: "workflow" }).runId;
  runtime.classify(runId, classification());
  assert.equal(strategicRunContext(runtime.db, runId).task_binding, null);
  runtime.db.close(); fs.rmSync(root, { recursive: true, force: true });
});
