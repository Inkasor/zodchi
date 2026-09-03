import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDb, now } from "../src/db.mjs";
import { openGatewayDb } from "../../AgentGateway/src/db.mjs";
import { cleanupHistory, GATEWAY_HISTORY_TABLES, WORKFLOW_HISTORY_TABLES } from "../src/history-cleanup.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function count(db, table) { return db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count; }

test("history cleanup is dry-run by default, backs up before apply and preserves the registry", async () => {
  const root = temporaryRoot("workflow-history-cleanup-");
  const workflow = path.join(root, "workflow.sqlite"), gateway = path.join(root, "gateway.sqlite");
  const timestamp = now();
  const db = openDb(workflow);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(path.join(root, "project"), timestamp);
  db.prepare("INSERT INTO workflows(id,name,project_id,package_key,package_version,default_quality,default_level,status,discovery_json) VALUES('workflow','Workflow','project','package','1.0.0','mvp','L2','active','{}')").run();
  db.prepare("INSERT INTO roles(id,name) VALUES('history_worker','History cleanup worker')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','history task','completed',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at) VALUES('run','task','project','workflow','completed','mvp','history task',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,role_id,state,created_at,updated_at) VALUES('step','run','work',1,'history_worker','completed',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO attempts(id,step_id,ordinal,state,started_at,finished_at,details_json) VALUES('attempt','step',1,'succeeded',?,?, '{}')").run(timestamp, timestamp);
  db.prepare("INSERT INTO decisions(id,task_id,run_id,step_id,kind,outcome,source,structured_json,created_at) VALUES('decision','task','run','step','classification','implementation','classifier','{}',?)").run(timestamp);
  db.prepare("INSERT INTO classifications(run_id,decision_id,kind,domain_id,discipline_id,risk,planning_level_id,quality_mode_id,planning_required,human_required,document_required,artifact_type_id,reply_mode,needs_questions,reason,questions_json) VALUES('run','decision','implementation','workflow','software','low','L2','mvp',1,0,0,'code','work',0,'history','[]')").run();
  db.prepare("INSERT INTO plans(id,run_id,objective,status,created_at) VALUES('plan','run','history','authorized',?)").run(timestamp);
  db.prepare("INSERT INTO conversation_messages(id,project_id,run_id,role,content,created_at) VALUES('message','project','run','user','history',?)").run(timestamp);
  db.prepare("INSERT INTO run_evidence(id,run_id,step_id,kind,evidence_hash,evidence_json,created_at) VALUES('evidence','run','step','test','hash','{}',?)").run(timestamp);
  db.prepare("INSERT INTO gateway_calls(id,run_id,step_id,attempt_id,provider,receipt_id,gateway_task_id,status) VALUES('call','run','step','attempt','codex','receipt','task','completed')").run();
  db.prepare("INSERT INTO budgets(id,scope_type,scope_id,metric,limit_value,used_value,status,created_at,updated_at) VALUES('budget','workflow','run','calls',4,1,'active',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO budget_entries(id,budget_id,task_id,run_id,amount,idempotency_key,created_at) VALUES('entry','budget','task','run',1,'history',?)").run(timestamp);
  db.prepare("INSERT INTO workflow_questions(project_id,workflow_id,question_key,phase,prompt) VALUES('project','workflow','history','planning','history')").run();
  db.close();

  const gatewayDb = openGatewayDb(gateway);
  gatewayDb.prepare(`INSERT INTO receipts
    (receipt_id,task_id,provider,profile,level,role,started_at,finished_at,calls,timed_out,exit_code,status,duration_ms,context_bytes,contract_hash,result_hash)
    VALUES('receipt','task','codex','profile','mvp','worker',?,?,1,0,0,'completed',0,1,'contract','result')`).run(timestamp, timestamp);
  gatewayDb.close();

  const dryRun = await cleanupHistory({ workflowDatabase: workflow, gatewayDatabase: gateway });
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.workflow.tables.workflow_runs, 1);
  assert.equal(dryRun.gateway.tables.receipts, 1);
  let verified = new DatabaseSync(workflow, { readOnly: true });
  assert.equal(count(verified, "workflow_runs"), 1);
  assert.equal(count(verified, "projects"), 1);
  verified.close();

  const applied = await cleanupHistory({ workflowDatabase: workflow, gatewayDatabase: gateway, apply: true });
  assert.equal(applied.status, "applied");
  assert.equal(applied.registry.unchanged, true);
  assert.equal(applied.checks_after.workflow.integrity_check, "ok");
  assert.equal(applied.checks_after.gateway.integrity_check, "ok");
  assert.deepEqual(applied.checks_after.workflow.foreign_key_check, []);
  assert.deepEqual(applied.checks_after.gateway.foreign_key_check, []);
  assert.equal(applied.remaining.workflow.workflow_runs, 0);
  assert.equal(applied.remaining.gateway.receipts, 0);
  assert.equal(applied.deleted.workflow.workflow_runs, 1);
  assert.equal(applied.deleted.gateway.receipts, 1);
  assert.equal(applied.backups.length, 2);
  for (const backup of applied.backups) {
    assert.equal(fs.existsSync(backup.file), true);
    assert.match(backup.file, /\.history-backup-\d{14,17}-[0-9a-f]{8}\.sqlite$/u);
  }
  verified = new DatabaseSync(workflow, { readOnly: true });
  for (const table of WORKFLOW_HISTORY_TABLES) assert.equal(count(verified, table), 0, table);
  assert.equal(count(verified, "projects"), 1);
  assert.equal(count(verified, "workflows"), 1);
  assert.equal(count(verified, "roles") > 0, true);
  verified.close();
  verified = new DatabaseSync(gateway, { readOnly: true });
  for (const table of GATEWAY_HISTORY_TABLES) assert.equal(count(verified, table), 0, table);
  assert.equal(count(verified, "providers"), 7);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
