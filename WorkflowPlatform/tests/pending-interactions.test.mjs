import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { classificationCatalog, validateClassificationDecision } from "../src/classifier.mjs";
import { Runtime } from "../src/runtime.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function fixture(prefix) {
  const root = temporaryRoot(prefix);
  const project = path.join(root, "project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project);
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, now());
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES('workflow','Workflow','project','mvp','L2','active','{\"git\":false}',4096)").run();
  for (const [table, values] of [["work_types", ["implementation", "conversation", "clarification", "research"]], ["artifact_types", ["code", "none"]], ["domains", ["workflow"]], ["disciplines", ["software"]]]) {
    for (const value of values) db.prepare(`INSERT OR IGNORE INTO ${table}(id,name${table === "artifact_types" || table === "work_types" ? ",category" : ""}) VALUES(?,?${table === "artifact_types" || table === "work_types" ? ",'general'" : ""})`).run(value, value);
  }
  for (const [value, ordinal] of [["mvp", 1]]) db.prepare("INSERT OR IGNORE INTO quality_modes(id,name,ordinal) VALUES(?,?,?)").run(value, value, ordinal);
  for (const [value, ordinal] of [["L2", 2]]) db.prepare("INSERT OR IGNORE INTO planning_levels(id,name,ordinal) VALUES(?,?,?)").run(value, value, ordinal);
  db.prepare("INSERT INTO workflow_routes(project_id,work_type_id,workflow_id,enabled,priority) VALUES('project','implementation','workflow',1,10)").run();
  return { root, project, dbFile, db };
}

function decision(overrides = {}) {
  return {
    schema_version: 1, work_type: "implementation", artifact_type: "code", domain: "workflow", discipline: "software",
    risk: "low", planning_level: "L2", quality_mode: "mvp", planning_required: true, human_required: false,
    needs_questions: false, document_required: false, reply_mode: "work", pending_interaction_id: null, pending_interaction_response: null,
    reason: "Ответ на заданные вопросы.", questions: [], human_response: null, ...overrides
  };
}

function askQuestions(db, taskId, runId, count) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const approvalId = `approval_${index}`;
    db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'clarification',?,'pending',?)").run(approvalId, taskId, runId, `Вопрос ${index}`, now());
    ids.push(approvalId);
  }
  return ids;
}

function askPlannerQuestion(db, taskId, runId, approvalId = "planner_question") {
  db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'planner_clarification','Что нужно уточнить?','pending',?)").run(approvalId, taskId, runId, now());
  return approvalId;
}

test("one answer settles every question it answered, and an id that is not pending does not end the run", () => {
  const { root, dbFile, db } = fixture("workflow-pending-");
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','asked','clarification_required',?,?)").run(now(), now());
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at) VALUES('asking','task','project','workflow','clarification_required','mvp','asked',?,?)").run(now(), now());
  const asked = askQuestions(db, "task", "asking", 2);
  const catalog = classificationCatalog(db, "project");

  // The platform asked two questions and the person answered both in one message. Naming one and
  // cancelling the other recorded an answer that was given as an answer that never came.
  const answered = validateClassificationDecision(decision({ pending_interaction_id: [...asked, "approval_invented"] }), catalog);
  assert.deepEqual(answered.pending_interaction_ids, asked);
  assert.deepEqual(answered.unknown_pending_interaction_ids, ["approval_invented"]);

  // A clarification is settled by the next message either way, so an id that is not pending is dropped
  // and recorded rather than refused: refusing it ends the run and throws away the answer with it.
  db.close();

  const runtime = new Runtime(dbFile);
  const runId = runtime.create("отвечаю на оба", { project_id: "project", workflow_id: "workflow" });
  runtime.classify(runId, answered);
  const settled = runtime.db.prepare("SELECT id,status FROM approvals ORDER BY id").all().map(row => `${row.id}:${row.status}`);
  assert.deepEqual(settled, asked.map(id => `${id}:approved`));

  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a decision on an action is still named exactly", () => {
  const { root, db } = fixture("workflow-pending-decision-");
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','asked','approval_required',?,?)").run(now(), now());
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at) VALUES('asking','task','project','workflow','approval_required','mvp','asked',?,?)").run(now(), now());
  db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES('approval_deploy','task','asking','workflow_approval','Разрешить выкладку?','pending',?)").run(now());
  const catalog = classificationCatalog(db, "project");

  // Leniency belongs where being wrong costs nothing. An approval authorizes an action, so a response
  // paired with an id that is not pending is refused rather than read as consent to something else.
  assert.throws(() => validateClassificationDecision(decision({ pending_interaction_id: "approval_invented", pending_interaction_response: "approve" }), catalog), /pending_interaction_response belongs to a decision/);
  const granted = validateClassificationDecision(decision({ pending_interaction_id: "approval_deploy", pending_interaction_response: "approve" }), catalog);
  assert.equal(granted.pending_interaction_id, "approval_deploy");

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a planner clarification is a question, not an approval decision, and is settled by the answer", () => {
  const { root, dbFile, db } = fixture("workflow-planner-clarification-");
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','asked','clarification_required',?,?)").run(now(), now());
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at) VALUES('asking','task','project','workflow','clarification_required','mvp','asked',?,?)").run(now(), now());
  const pendingId = askPlannerQuestion(db, "task", "asking");
  const classified = validateClassificationDecision(decision({ pending_interaction_id: pendingId }), classificationCatalog(db, "project"));
  assert.equal(classified.pending_interaction_response, null);
  db.close();

  const runtime = new Runtime(dbFile);
  const runId = runtime.create("это новая подробная постановка", { project_id: "project", workflow_id: "workflow" });
  runtime.classify(runId, classified);
  assert.equal(runtime.db.prepare("SELECT status FROM approvals WHERE id=?").get(pendingId).status, "approved");
  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a run that fails on its way into execution ends instead of staying classified", () => {
  const { root, db } = fixture("workflow-classified-dead-end-");
  const classified = validateClassificationDecision(decision(), classificationCatalog(db, "project"));
  db.close();
  const runtime = new Runtime(path.join(root, "workflow.sqlite"));
  const runId = runtime.create("сделай пакет", { project_id: "project", workflow_id: "workflow" });
  runtime.classify(runId, classified);
  assert.equal(runtime.get(runId).state, "classified");

  // Execution can fail before it plans anything — a role contract that does not permit the work type, a
  // role with no profile at this level. The state machine refused the transition, so the person was told
  // the run was rejected while the run itself stayed classified and nothing could ever act on it.
  runtime.setState(runId, "failed", { reason: "ROLE_WORK_TYPE_NOT_ALLOWED" });
  assert.equal(runtime.get(runId).state, "failed");

  runtime.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
