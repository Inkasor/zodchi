import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { recordOwnerAcceptance } from "../src/owner-acceptance.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(), "owner-acceptance-"));
  const dbFile = path.join(root, "workflow.sqlite"), db = openDb(dbFile), timestamp = now();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(root, timestamp);
  db.prepare("INSERT INTO workflows(id,name,project_id,package_key,package_version,default_quality,default_level,status) VALUES('workflow','Workflow','project','marketing.content-operations','0.1.0','mvp','L1','active')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','Task','completed',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at,completed_at) VALUES('run','task','project','workflow','completed','mvp','Task',?,?,?)").run(timestamp, timestamp, timestamp);
  db.prepare("INSERT INTO workflow_package_releases(id,project_id,package_key,version,purpose,prompt_builder_version,manifest_hash,status,created_at) VALUES('release','project','marketing.content-operations','0.1.0','test','1','hash','active',?)").run(timestamp);
  db.close();
  return { root, dbFile };
}

const valid = { schema_version: 1, project_id: "project", preset_key: "marketing-manager-activity", run_id: "run", package_key: "marketing.content-operations", package_version: "0.1.0", artifact_sha256: "a".repeat(64), owner_identity: "Owner", review_status: "read", domain_status: "open", note: "Read; domain decision remains open." };

test("OWNER_READ is an explicit hash-bound append-only record separate from domain acceptance", () => {
  const fx = fixture();
  const first = recordOwnerAcceptance(fx.dbFile, valid), duplicate = recordOwnerAcceptance(fx.dbFile, valid);
  assert.equal(first.duplicate, false); assert.equal(duplicate.duplicate, true);
  assert.equal(first.source, "owner_explicit"); assert.equal(first.review_status, "read"); assert.equal(first.domain_status, "open");
  const db = openDb(fx.dbFile), row = db.prepare("SELECT * FROM owner_acceptance_records").get(); db.close();
  assert.equal(row.content_hash, first.content_hash); assert.equal(row.artifact_sha256, valid.artifact_sha256); assert.equal(row.source, "owner_explicit");
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test("owner acceptance refuses the wrong project, package version and nonterminal run", () => {
  const fx = fixture();
  assert.throws(() => recordOwnerAcceptance(fx.dbFile, { ...valid, model_summary: "accepted" }), /SCHEMA_INVALID/);
  assert.throws(() => recordOwnerAcceptance(fx.dbFile, { ...valid, project_id: "other" }), /RUN_PROJECT_MISMATCH/);
  assert.throws(() => recordOwnerAcceptance(fx.dbFile, { ...valid, package_version: "9.9.9" }), /PACKAGE_VERSION_MISMATCH/);
  let db = openDb(fx.dbFile); db.prepare("UPDATE workflow_runs SET state='executing',completed_at=NULL WHERE id='run'").run(); db.close();
  assert.throws(() => recordOwnerAcceptance(fx.dbFile, valid), /RUN_NOT_TERMINAL/);
  fs.rmSync(fx.root, { recursive: true, force: true });
});
