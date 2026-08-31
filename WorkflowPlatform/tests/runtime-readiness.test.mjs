import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { processMessage as scopedProcessMessage } from "../src/workflow-app.mjs";

const processMessage = input => scopedProcessMessage({ semanticScope: { mode: "stateless" }, ...input });
import { projectRuntimeReadiness } from "../src/runtime-readiness.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(), "workflow-runtime-readiness-"));
  const project = path.join(root, "project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "README.md"), "# Project\n", "utf8");
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, now());
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES('workflow','Workflow','project','mvp','L2','active','{}',4096)").run();
  db.prepare("INSERT INTO workflow_routes(project_id,work_type_id,workflow_id,enabled,priority) VALUES('project','implementation','workflow',1,0)").run();
  return { root, project, dbFile, db };
}

test("runtime readiness requires direct classifier and researcher assignments and reports researcher document access", () => {
  const { root, db } = fixture();
  let readiness = projectRuntimeReadiness(db, "project");
  assert.equal(readiness.status, "unavailable");
  assert.deepEqual(readiness.missing_role_assignments, ["classifier", "researcher"]);
  assert.equal(readiness.registered_context.status, "no_controlled_documents");

  db.prepare("INSERT INTO profiles(id,provider,name,role_id) VALUES('classifier-profile','codex','classifier-profile','classifier')").run();
  db.prepare("INSERT INTO profiles(id,provider,name,role_id) VALUES('researcher-profile','codex','researcher-profile','researcher')").run();
  db.prepare("INSERT INTO role_profile_assignments(project_id,role_id,profile_id,operational_level,enabled) VALUES('project','classifier','classifier-profile','prototype',1)").run();
  db.prepare("INSERT INTO role_profile_assignments(project_id,role_id,profile_id,operational_level,enabled) VALUES('project','researcher','researcher-profile','mvp',1)").run();
  db.prepare("INSERT INTO project_documents(id,project_id,path,root_key,document_type,authority,status,active) VALUES('readme','project','README.md','primary','reference','owner','active',1)").run();
  readiness = projectRuntimeReadiness(db, "project");
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.registered_context.status, "no_read_access");
  assert.equal(readiness.warnings.length, 1);

  db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES('project','researcher','readme',1,0,'research',10)").run();
  readiness = projectRuntimeReadiness(db, "project");
  assert.equal(readiness.registered_context.status, "available");
  assert.equal(readiness.registered_context.researcher_documents, 1);
  assert.deepEqual(readiness.warnings, []);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("registry-backed intake fails before accepting a run or spending a classifier call when direct roles are missing", async () => {
  const { root, project, dbFile, db } = fixture();
  db.close();
  let calls = 0;
  await assert.rejects(() => processMessage({
    message: "Implement the change",
    project,
    dbFile,
    execute: true,
    gatewayCall: async () => { calls += 1; throw new Error("must not be called"); }
  }), /PROJECT_RUNTIME_NOT_READY: project: missing classifier,researcher/);
  assert.equal(calls, 0);
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 0);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a file-backed workflow also declares both direct roles before a classifier call", async () => {
  const { root, project, dbFile, db } = fixture();
  db.close();
  let calls = 0;
  await assert.rejects(() => processMessage({
    message: "Research the registered context",
    project,
    dbFile,
    workflowDefinition: {
      id: "workflow",
      roles: { classifier: { provider: "codex", profile: "classifier-profile", role: "classifier" } }
    },
    execute: true,
    gatewayCall: async () => { calls += 1; throw new Error("must not be called"); }
  }), /WORKFLOW_RUNTIME_NOT_READY: workflow: missing researcher/);
  assert.equal(calls, 0);
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 0);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});
