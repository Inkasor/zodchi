import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { runProjectGate } from "../src/gates.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

test("project gates run only registered checks and preserve green, red, timeout and unavailable outcomes", async () => {
  const root = temporaryRoot("workflow-gates-");
  const noChecksProject = path.join(root, "no-checks-project");
  const disabledProject = path.join(root, "disabled-project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(noChecksProject);
  fs.mkdirSync(disabledProject);
  fs.writeFileSync(path.join(noChecksProject, "package.json"), JSON.stringify({ scripts: { test: "must-not-run", build: "must-not-run" } }));
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('no-checks','No checks',?,?)").run(noChecksProject, now());
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('disabled','Disabled check',?,?)").run(disabledProject, now());
  const configured = [["prototype", "passed"], ["mvp", "failed"], ["production", "timed_out"], ["security", "unavailable"]];
  for (const [quality, status] of configured) {
    const project = path.join(root, `project-${status}`), projectId = `project-${status}`;
    fs.mkdirSync(project);
    db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(projectId, projectId, project, now());
    const checkId = `check-${status}`;
    db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES(?,?, 'fixture','fixture',?,30)").run(checkId, checkId, JSON.stringify({ status, failure: `fixture ${status}` }));
    db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required) VALUES(?,?,?,1)").run(projectId, checkId, quality);
  }
  db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES('bsl-language-server','BSL Language Server','bsl-language-server','disabled',?,30)").run(JSON.stringify({ reason: "not_configured" }));
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('disabled','bsl-language-server','mvp',1,'code')").run();
  db.close();
  for (const [quality, status] of configured) {
    const level = quality === "security" ? "security-audit" : quality;
    const result = await runProjectGate(path.join(root, `project-${status}`), level, dbFile, `gate-${status}`, { allowedPaths: [] });
    assert.equal(result.status, status);
    assert.deepEqual(result.checks.map(item => item.id), [`check-${status}`]);
  }
  const none = await runProjectGate(noChecksProject, "mvp", dbFile, "gate-no-checks", { allowedPaths: [] });
  assert.equal(none.status, "passed");
  assert.deepEqual(none.checks, []);
  const uncoveredCode = await runProjectGate(noChecksProject, "prototype", dbFile, "gate-no-code-checks", { allowedPaths: [], artifactType: "code" });
  assert.equal(uncoveredCode.status, "unavailable");
  assert.equal(uncoveredCode.checks[0].id, "quality_contract_checks");
  const disabled = await runProjectGate(disabledProject, "mvp", dbFile, "gate-disabled", { allowedPaths: [], artifactType: "code" });
  assert.equal(disabled.status, "unavailable");
  assert.equal(disabled.checks[0].failure, "not_configured");
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM gate_runs").get().count, 7);
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("quality gates cascade lower-level checks and de-duplicate repeated bindings", async () => {
  const root = temporaryRoot("workflow-gates-cascade-"), project = path.join(root, "project"), dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project);
  const db = openDb(dbFile), timestamp = now();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('cascade','Cascade',?,?)").run(project, timestamp);
  for (const id of ["static", "tests", "release", "security"]) {
    db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES(?,?,?,'fixture','{\"status\":\"passed\"}',30)").run(id, id, id);
  }
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required) VALUES('cascade','static','prototype',1)").run();
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('cascade','tests','mvp',1,'code')").run();
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('cascade','tests','production',1,'release_package')").run();
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('cascade','release','production',1,'release_package')").run();
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('cascade','security','security',1,'security_report')").run();
  db.close();

  const prototype = await runProjectGate(project, "prototype", dbFile, "cascade-prototype", { allowedPaths: [], artifactType: "code" });
  assert.deepEqual(prototype.checks.map(item => item.id), ["static"]);
  const mvp = await runProjectGate(project, "mvp", dbFile, "cascade-mvp", { allowedPaths: [], artifactType: "code" });
  assert.deepEqual(mvp.checks.map(item => item.id), ["static", "tests"]);
  const production = await runProjectGate(project, "production", dbFile, "cascade-production", { allowedPaths: [], artifactType: "release_package" });
  assert.deepEqual(production.checks.map(item => item.id), ["static", "tests", "release"]);
  assert.deepEqual(production.checks.find(item => item.id === "tests").inherited_from, ["mvp", "production"]);
  const security = await runProjectGate(project, "security-audit", dbFile, "cascade-security", { allowedPaths: [], artifactType: "security_report" });
  assert.deepEqual(security.checks.map(item => item.id), ["static", "tests", "release", "security"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Windows command checks execute cmd wrappers without shell fallback", { skip: process.platform !== "win32" }, async () => {
  const root = temporaryRoot("workflow-gates-windows-cmd-"), project = path.join(root, "project"), dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project); const db = openDb(dbFile), timestamp = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('cmd-project','Cmd Project',?,?)").run(project, timestamp);
  db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES('npm-version','npm version','npm-version','command','{\"command\":\"npm.cmd\",\"args\":[\"--version\"]}',30)").run();
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('cmd-project','npm-version','mvp',1,'code')").run(); db.close();
  const result = await runProjectGate(project, "mvp", dbFile, "cmd-gate", { artifactType: "code", allowedPaths: [] });
  assert.equal(result.status, "passed"); assert.equal(result.checks[0].exit_code, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an inner ENOENT test failure is not mistaken for a missing check runner", async () => {
  const root = temporaryRoot("workflow-gates-inner-enoent-"), project = path.join(root, "project"), dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project); const db = openDb(dbFile), timestamp = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('inner-enoent-project','Inner ENOENT Project',?,?)").run(project, timestamp);
  db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES('inner-enoent','Inner ENOENT','inner-enoent','command',?,30)")
    .run(JSON.stringify({ command: process.execPath, args: ["-e", "process.stderr.write('spawn ps ENOENT'); process.exit(1)"] }));
  db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES('missing-runner','Missing runner','missing-runner','command',?,30)")
    .run(JSON.stringify({ command: `workflow-missing-command-${Date.now()}`, args: [] }));
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('inner-enoent-project','inner-enoent','mvp',1,'code')").run();
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('inner-enoent-project','missing-runner','mvp',1,'code')").run();
  db.close();
  const result = await runProjectGate(project, "mvp", dbFile, "inner-enoent-gate", { artifactType: "code", allowedPaths: [] });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.checks.map(item => item.status), ["failed", "unavailable"]);
  assert.match(result.checks[0].failure, /ENOENT/);
  assert.match(result.checks[1].failure, /required tool is not installed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("project command resolves its execution root from the project registry", async () => {
  const root = temporaryRoot("workflow-gates-linked-project-"), project = path.join(root, "project"), consumer = path.join(root, "consumer"), dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project); fs.mkdirSync(consumer);
  const db = openDb(dbFile), timestamp = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('source','Source',?,?)").run(project, timestamp);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('consumer','Consumer',?,?)").run(consumer, timestamp);
  db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES('linked','Linked','linked','project_command',?,30)")
    .run(JSON.stringify({ project_id: "consumer", command: process.execPath, args: ["-e", "process.exit(process.cwd() === process.argv[1] ? 0 : 1)", consumer] }));
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('source','linked','mvp',1,'code')").run();
  db.close();
  const result = await runProjectGate(project, "mvp", dbFile, "linked-gate", { artifactType: "code", allowedPaths: [] });
  assert.equal(result.status, "passed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("command checks receive the current quality level through an explicit placeholder", async () => {
  const root = temporaryRoot("workflow-gates-quality-placeholder-"), project = path.join(root, "project"), dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project); const db = openDb(dbFile), timestamp = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('quality-project','Quality Project',?,?)").run(project, timestamp);
  db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES('quality-check','Quality check','quality-check','command',?,30)")
    .run(JSON.stringify({ command: process.execPath, args: ["-e", "process.exit(process.argv[1] === 'production' ? 0 : 1)", "{{quality_level}}"] }));
  db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('quality-project','quality-check','prototype',1,'code')").run();
  db.close();
  const result = await runProjectGate(project, "production", dbFile, "quality-placeholder-gate", { artifactType: "code", allowedPaths: [] });
  assert.equal(result.status, "passed");
  fs.rmSync(root, { recursive: true, force: true });
});
