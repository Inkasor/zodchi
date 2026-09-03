import { id, now } from "./db.mjs";
import { appendEvent } from "./state-machine.mjs";

const GOAL_TRANSITIONS = Object.freeze({ active: ["blocked", "completed", "cancelled"], blocked: ["active", "cancelled"] });
const STAGE_TRANSITIONS = Object.freeze({ planned: ["active", "cancelled"], active: ["blocked", "completed", "cancelled"], blocked: ["active", "cancelled"] });

function owner(value) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error("STRATEGY_OWNER_CONFIRMATION_REQUIRED");
  return result;
}
function title(value, code) {
  const result = String(value ?? "").trim();
  if (!result || Buffer.byteLength(result) > 4096) throw new Error(code);
  return result;
}
function project(db, projectId) {
  const row = db.prepare("SELECT id FROM projects WHERE id=?").get(projectId);
  if (!row) throw new Error(`STRATEGY_PROJECT_NOT_FOUND: ${projectId}`);
  return row;
}

let savepointSequence = 0;
function atomic(db, action) {
  const nested = db.isTransaction;
  const savepoint = `strategy_${++savepointSequence}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
    if (nested && db.isTransaction) db.exec(`RELEASE ${savepoint}`);
    throw error;
  }
}

export function listStrategicState(db, projectId) {
  project(db, projectId);
  const goals = db.prepare("SELECT id,title,status,created_at,updated_at FROM goals WHERE project_id=? ORDER BY created_at,id").all(projectId);
  const stages = db.prepare("SELECT id,goal_id,stage_key,title,status,ordinal,created_at,updated_at FROM stages WHERE project_id=? ORDER BY ordinal,created_at,id").all(projectId);
  return { project_id: projectId, goals, stages };
}

export function createGoal(db, { projectId, title: value, confirmedBy }) {
  project(db, projectId); const timestamp = now(), goalId = id("goal"), confirmed = owner(confirmedBy);
  const objective = title(value, "STRATEGY_GOAL_TITLE_INVALID");
  atomic(db, () => {
    db.prepare("INSERT INTO goals(id,project_id,title,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)").run(goalId, projectId, objective, timestamp, timestamp);
    appendEvent(db, { entityType: "goal", entityId: goalId, kind: "created", payload: { confirmed_by: confirmed, authority: "owner" } });
  });
  return db.prepare("SELECT id,project_id,title,status,created_at,updated_at FROM goals WHERE id=?").get(goalId);
}

export function setGoalStatus(db, { goalId, status, confirmedBy }) {
  const row = db.prepare("SELECT * FROM goals WHERE id=?").get(goalId);
  if (!row) throw new Error(`STRATEGY_GOAL_NOT_FOUND: ${goalId}`);
  const target = String(status ?? "");
  if (!(GOAL_TRANSITIONS[row.status] ?? []).includes(target)) throw new Error(`STRATEGY_GOAL_TRANSITION_FORBIDDEN: ${row.status}->${target}`);
  const confirmed = owner(confirmedBy), timestamp = now();
  if (target === "completed") {
    const open = db.prepare("SELECT COUNT(*) AS count FROM stages WHERE goal_id=? AND status NOT IN ('completed','cancelled')").get(goalId).count;
    if (open) throw new Error(`STRATEGY_GOAL_HAS_OPEN_STAGES: ${open}`);
  }
  atomic(db, () => {
    if (target === "blocked") db.prepare("UPDATE stages SET status='blocked',updated_at=? WHERE goal_id=? AND status='active'").run(timestamp, goalId);
    if (target === "cancelled") db.prepare("UPDATE stages SET status='cancelled',updated_at=? WHERE goal_id=? AND status NOT IN ('completed','cancelled')").run(timestamp, goalId);
    db.prepare("UPDATE goals SET status=?,updated_at=? WHERE id=?").run(target, timestamp, goalId);
    appendEvent(db, { entityType: "goal", entityId: goalId, kind: "state_transition", fromState: row.status, toState: target, payload: { confirmed_by: confirmed, authority: "owner" } });
  });
  return db.prepare("SELECT id,project_id,title,status,created_at,updated_at FROM goals WHERE id=?").get(goalId);
}

export function createStage(db, { projectId, goalId, stageKey, title: value, ordinal = 0, confirmedBy }) {
  project(db, projectId); const goal = db.prepare("SELECT id,status FROM goals WHERE id=? AND project_id=?").get(goalId, projectId);
  if (!goal) throw new Error(`STRATEGY_GOAL_NOT_FOUND: ${goalId}`);
  if (!["active", "blocked"].includes(goal.status)) throw new Error(`STRATEGY_GOAL_NOT_OPEN: ${goalId}`);
  const key = String(stageKey ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(key)) throw new Error("STRATEGY_STAGE_KEY_INVALID");
  const position = Number(ordinal);
  if (!Number.isInteger(position) || position < 0) throw new Error("STRATEGY_STAGE_ORDINAL_INVALID");
  const confirmed = owner(confirmedBy), timestamp = now(), stageId = id("stage");
  const stageTitle = title(value, "STRATEGY_STAGE_TITLE_INVALID");
  atomic(db, () => {
    db.prepare("INSERT INTO stages(id,goal_id,project_id,stage_key,title,status,ordinal,created_at,updated_at) VALUES(?,?,?,?,?,'planned',?,?,?)")
      .run(stageId, goalId, projectId, key, stageTitle, position, timestamp, timestamp);
    appendEvent(db, { entityType: "stage", entityId: stageId, kind: "created", payload: { confirmed_by: confirmed, authority: "owner", goal_id: goalId } });
  });
  return db.prepare("SELECT id,goal_id,project_id,stage_key,title,status,ordinal,created_at,updated_at FROM stages WHERE id=?").get(stageId);
}

export function setStageStatus(db, { stageId, status, confirmedBy }) {
  const row = db.prepare("SELECT s.*,g.status AS goal_status FROM stages s LEFT JOIN goals g ON g.id=s.goal_id WHERE s.id=?").get(stageId);
  if (!row) throw new Error(`STRATEGY_STAGE_NOT_FOUND: ${stageId}`);
  const target = String(status ?? "");
  if (!(STAGE_TRANSITIONS[row.status] ?? []).includes(target)) throw new Error(`STRATEGY_STAGE_TRANSITION_FORBIDDEN: ${row.status}->${target}`);
  if (target === "active" && row.goal_status !== "active") throw new Error(`STRATEGY_STAGE_GOAL_NOT_ACTIVE: ${row.goal_id}`);
  if (target === "active") {
    const other = db.prepare("SELECT id FROM stages WHERE goal_id=? AND status='active' AND id<>?").get(row.goal_id, stageId);
    if (other) throw new Error(`STRATEGY_ACTIVE_STAGE_CONFLICT: ${other.id}`);
  }
  const confirmed = owner(confirmedBy), timestamp = now();
  atomic(db, () => {
    db.prepare("UPDATE stages SET status=?,updated_at=? WHERE id=?").run(target, timestamp, stageId);
    appendEvent(db, { entityType: "stage", entityId: stageId, kind: "state_transition", fromState: row.status, toState: target, payload: { confirmed_by: confirmed, authority: "owner", goal_id: row.goal_id } });
  });
  return db.prepare("SELECT id,goal_id,project_id,stage_key,title,status,ordinal,created_at,updated_at FROM stages WHERE id=?").get(stageId);
}

export function bindTaskToCurrentStrategy(db, taskId) {
  const task = db.prepare("SELECT id,project_id,goal_id,stage_id FROM tasks WHERE id=?").get(taskId);
  if (!task) throw new Error(`STRATEGY_TASK_NOT_FOUND: ${taskId}`);
  if (task.goal_id || task.stage_id) return { status: "already_bound", goal_id: task.goal_id, stage_id: task.stage_id };
  const activeStages = db.prepare(`SELECT s.id AS stage_id,s.goal_id FROM stages s JOIN goals g ON g.id=s.goal_id
    WHERE s.project_id=? AND s.status='active' AND g.status='active' ORDER BY s.ordinal,s.id`).all(task.project_id);
  let goalId = null, stageId = null, status = "unbound", candidateCount = 0;
  if (activeStages.length === 1) { goalId = activeStages[0].goal_id; stageId = activeStages[0].stage_id; status = "bound"; }
  else if (activeStages.length > 1) { status = "ambiguous"; candidateCount = activeStages.length; }
  else {
    const activeGoals = db.prepare("SELECT id FROM goals WHERE project_id=? AND status='active' ORDER BY created_at,id").all(task.project_id);
    if (activeGoals.length === 1) { goalId = activeGoals[0].id; status = "bound"; }
    else if (activeGoals.length > 1) { status = "ambiguous"; candidateCount = activeGoals.length; }
  }
  if (status === "bound") {
    atomic(db, () => {
      db.prepare("UPDATE tasks SET goal_id=?,stage_id=?,updated_at=? WHERE id=?").run(goalId, stageId, now(), taskId);
      appendEvent(db, { entityType: "task", entityId: taskId, kind: "strategy_bound", payload: { goal_id: goalId, stage_id: stageId, authority: "deterministic_active_strategy" } });
    });
  }
  return { status, goal_id: goalId, stage_id: stageId, candidates: status === "ambiguous" ? candidateCount : undefined };
}

export function strategicRunContext(db, runId) {
  const row = db.prepare(`SELECT t.id AS task_id,t.project_id,t.goal_id,t.stage_id,g.title AS goal_title,g.status AS goal_status,
      s.stage_key,s.title AS stage_title,s.status AS stage_status,s.ordinal AS stage_ordinal
    FROM workflow_runs wr JOIN tasks t ON t.id=wr.task_id
    LEFT JOIN goals g ON g.id=t.goal_id LEFT JOIN stages s ON s.id=t.stage_id WHERE wr.id=?`).get(runId);
  if (!row) throw new Error(`STRATEGY_RUN_NOT_FOUND: ${runId}`);
  const active = listStrategicState(db, row.project_id);
  const stripTimes = ({ created_at: _created, updated_at: _updated, ...value }) => value;
  return {
    authority: "owner_control_plane",
    task_binding: row.goal_id ? {
      goal: { id: row.goal_id, title: row.goal_title, status: row.goal_status },
      stage: row.stage_id ? { id: row.stage_id, key: row.stage_key, title: row.stage_title, status: row.stage_status, ordinal: row.stage_ordinal } : null
    } : null,
    active_goals: active.goals.filter(goal => goal.status === "active").map(stripTimes),
    active_stages: active.stages.filter(stage => stage.status === "active").map(stripTimes)
  };
}
