import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { checkGatewayProfileRequirements } from "../src/gateway.mjs";
import { processMessage as scopedProcessMessage } from "../src/workflow-app.mjs";

const statelessProcessMessage = input => scopedProcessMessage({ semanticScope: { mode: "stateless" }, ...input });
import { projectRuntimeReadiness, workflowRuntimeReadiness } from "../src/runtime-readiness.mjs";

const compatibleProfileCheck = requirements => ({ status: "compatible", checks: requirements, conflicts: [] });

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
  readiness = projectRuntimeReadiness(db, "project", { profileCheck: compatibleProfileCheck });
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.registered_context.status, "no_read_access");
  assert.equal(readiness.warnings.length, 1);

  db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES('project','researcher','readme',1,0,'research',10)").run();
  readiness = projectRuntimeReadiness(db, "project", { profileCheck: compatibleProfileCheck });
  assert.equal(readiness.registered_context.status, "available");
  assert.equal(readiness.registered_context.researcher_documents, 1);
  assert.deepEqual(readiness.warnings, []);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("runtime readiness isolates an incompatible profile to the selected workflow", async () => {
  const { root, project, dbFile, db } = fixture();
  for (const role of ["classifier", "researcher", "documentator"]) db.prepare("INSERT INTO profiles(id,provider,name,role_id) VALUES(?, 'codex', ?, ?)").run(`${role}-profile`, `${role}-profile`, role);
  for (const role of ["classifier", "researcher", "documentator"]) db.prepare("INSERT INTO role_profile_assignments(project_id,role_id,profile_id,operational_level,enabled) VALUES('project',?,?, 'mvp',1)").run(role, `${role}-profile`);
  db.prepare(`INSERT INTO role_contracts(id,project_id,role_id,version,purpose,boundaries_json,allowed_work_types_json,allowed_artifact_types_json,allowed_tools_json,allowed_skills_json,required_checks_json,allowed_transitions_json,allowed_profiles_json,context_limit_bytes,max_calls,max_correction_cycles,timeout_seconds,result_schema_key,prompt_template_version,escalation_json,status)
    VALUES('documentator-contract','project','documentator','1','documentation','{}','[]','[]','[]','[]','[]','[]','[]',65536,1,0,60,'documentator.v1','1','{}','active')`).run();
  db.prepare(`INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json)
    VALUES('project','workflow','document',1,'documentator',1,0,'package.v1','documentator.v1','[]','[]','{}','{}')`).run();
  const gatewayPolicy = path.join(root, "policy.json");
  fs.writeFileSync(gatewayPolicy, JSON.stringify({ schemaVersion: 1, providers: { codex: { profiles: {
    "classifier-profile": { readOnly: true }, "researcher-profile": { readOnly: true }, "documentator-profile": { readOnly: false }
  } } } }), "utf8");
  const profileCheck = requirements => checkGatewayProfileRequirements({ requirements, gateway: path.resolve(import.meta.dirname, "..", "..", "AgentGateway", "src", "cli.mjs"), gatewayPolicy });
  const projectReadiness = projectRuntimeReadiness(db, "project", { profileCheck });
  assert.equal(projectReadiness.status, "ready");
  assert.deepEqual(projectReadiness.profile_write_requirements.checks.map(item => item.role).sort(), ["classifier", "researcher"]);
  const workflowReadiness = workflowRuntimeReadiness(db, "project", "workflow", "mvp", { profileCheck });
  assert.equal(workflowReadiness.status, "unavailable");
  assert.deepEqual(workflowReadiness.profile_write_requirements.conflicts, [{ code: "PROFILE_WRITE_REQUIREMENT_MISMATCH", role: "documentator", provider: "codex", profile: "documentator-profile", operational_level: "mvp", requires_write: false, profile_read_only: false }]);
  db.close();

  let calls = 0;
  const result = await statelessProcessMessage({
    message: "Implement the change", project, dbFile, execute: true, gatewayProfileCheck: profileCheck,
    classificationResult: {
      schema_version: 1, work_type: "implementation", artifact_type: "code", domain: "workflow", discipline: "software",
      risk: "low", planning_level: "L2", quality_mode: "mvp", planning_required: true, human_required: false,
      needs_questions: false, document_required: false, reply_mode: "work", pending_interaction_id: null,
      pending_interaction_response: null, reason: "Bounded implementation requested.", questions: [], human_response: null
    },
    gatewayCall: async () => { calls += 1; throw new Error("must not be called"); }
  });
  assert.equal(result.route, "failed");
  assert.equal(result.error, "WORKFLOW_RUNTIME_NOT_READY");
  assert.equal(calls, 0);
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 1);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs").get().state, "failed");
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("registry-backed intake fails before accepting a run or spending a classifier call when direct roles are missing", async () => {
  const { root, project, dbFile, db } = fixture();
  db.close();
  let calls = 0;
  await assert.rejects(() => statelessProcessMessage({
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
  await assert.rejects(() => statelessProcessMessage({
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
