import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDb, schemaVersion, now } from "../src/db.mjs";
import { fileURLToPath } from "node:url";

const migrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

test("clean database applies numbered normalized migrations and SQLite safety pragmas", () => {
  const root = temporaryRoot("workflow-migrations-clean-");
  const db = openDb(path.join(root, "workflow.sqlite"));
  assert.equal(schemaVersion(db), 29);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const table of ["goals", "stages", "tasks", "workflow_runs", "workflow_steps", "attempts", "decisions", "approvals", "artifacts", "events", "budgets", "budget_entries", "leases", "resource_leases", "project_resources", "inbox_events", "dead_letters", "role_contracts", "role_profile_assignments", "workflow_package_releases", "workflow_import_proposals", "package_import_mappings", "experience_observations", "experience_proposals", "experience_evaluations", "check_baselines", "check_baseline_diagnostics", "diagnostic_rules", "diagnostic_rule_tags", "project_diagnostic_policies", "project_semantic_statuses", "project_evidence_types", "project_strategy_overrides", "run_root_baselines", "run_evidence", "run_control_requests", "progress_snapshots", "evidence_flow_adapters", "external_executors", "external_control_requests", "external_control_results", "owner_acceptance_records"]) assert.equal(tables.has(table), true, `missing ${table}`);
  assert.equal(new Set(db.prepare("PRAGMA table_info(gateway_calls)").all().map(row => row.name)).has("model_provider"), true);
  assert.equal(new Set(db.prepare("PRAGMA table_info(workflow_step_templates)").all().map(row => row.name)).has("resources_json"), true);
  assert.equal(db.prepare("SELECT name FROM domains WHERE id='one-c'").get().name, "1C");
  assert.equal(db.prepare("SELECT name FROM disciplines WHERE id='one-c-development'").get().name, "1C development");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM work_types WHERE id LIKE 'one-c.%'").get().count, 7);
  const prototypeContract = db.prepare("SELECT version,reviewer_policy FROM quality_contracts WHERE level='prototype'").get();
  assert.equal(prototypeContract.version, "1.0.0");
  assert.equal(prototypeContract.reviewer_policy, "none");
  assert.equal(db.prepare("SELECT limit_value FROM quality_contract_budgets WHERE level='prototype' AND metric='calls'").get().limit_value, 4);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the known pre-publication migration 7 newline checksum remains readable", () => {
  const root = temporaryRoot("workflow-migrations-legacy-seven-");
  const file = path.join(root, "workflow.sqlite");
  let db = openDb(file);
  db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=7").run("8080e01be11bc8882303b50e3d51dc00d1dffcd23c3f08691dee6d7452770c1c");
  db.close();
  db = openDb(file);
  assert.equal(schemaVersion(db), 29);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("database upgrades sequentially and verifies applied checksums", () => {
  const root = temporaryRoot("workflow-migrations-upgrade-");
  const migrations = path.join(root, "migrations");
  const file = path.join(root, "test.sqlite");
  fs.mkdirSync(migrations);
  fs.writeFileSync(path.join(migrations, "001_alpha.sql"), "CREATE TABLE alpha(id TEXT PRIMARY KEY);\n");
  let db = openDb(file, { migrationsDirectory: migrations });
  assert.equal(schemaVersion(db), 1);
  db.close();
  fs.writeFileSync(path.join(migrations, "002_beta.sql"), "CREATE TABLE beta(id TEXT PRIMARY KEY);\n");
  db = openDb(file, { migrationsDirectory: migrations });
  assert.equal(schemaVersion(db), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 2);
  db.close();
  fs.writeFileSync(path.join(migrations, "001_alpha.sql"), "CREATE TABLE changed(id TEXT PRIMARY KEY);\n");
  assert.throws(() => openDb(file, { migrationsDirectory: migrations }), /MIGRATION_CHECKSUM_MISMATCH/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("failed migration rolls back and legacy database fails closed", () => {
  const root = temporaryRoot("workflow-migrations-fail-");
  const migrations = path.join(root, "migrations");
  const file = path.join(root, "test.sqlite");
  fs.mkdirSync(migrations);
  fs.writeFileSync(path.join(migrations, "001_alpha.sql"), "CREATE TABLE alpha(id TEXT PRIMARY KEY);\n");
  let db = openDb(file, { migrationsDirectory: migrations });
  db.close();
  fs.writeFileSync(path.join(migrations, "002_broken.sql"), "CREATE TABLE beta(id TEXT PRIMARY KEY); THIS IS NOT SQL;\n");
  assert.throws(() => openDb(file, { migrationsDirectory: migrations }), /MIGRATION_FAILED/);
  db = new DatabaseSync(file);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='beta'").get().count, 0);
  db.close();
  const legacy = path.join(root, "legacy.sqlite");
  db = new DatabaseSync(legacy);
  db.exec("CREATE TABLE old_experiment(id TEXT)");
  db.close();
  assert.throws(() => openDb(legacy), /LEGACY_DATABASE_UNSUPPORTED/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a migration that rebuilds a referenced table survives a database that has been used", () => {
  const root = temporaryRoot("workflow-migration-rebuild-");
  const partial = path.join(root, "migrations");
  const all = fs.readdirSync(migrationsDirectory).filter(name => /^\d{3}_/.test(name)).sort();
  fs.mkdirSync(partial);
  // Everything up to the rebuild, so the database can be filled the way a real one is before the
  // rebuilding migration runs against it.
  const rebuildIndex = all.findIndex(name => name.startsWith("015_"));
  assert.notEqual(rebuildIndex, -1);
  for (const name of all.slice(0, rebuildIndex)) fs.copyFileSync(path.join(migrationsDirectory, name), path.join(partial, name));

  const file = path.join(root, "workflow.sqlite");
  const before = openDb(file, { migrationsDirectory: partial });
  before.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(root, now());
  before.prepare("INSERT OR IGNORE INTO roles(id,name) VALUES('documentator','Documentator')").run();
  before.prepare("INSERT INTO project_documents(id,project_id,path,document_type,authority,status,active) VALUES('doc','project','docs/plan.md','plan','owner','active',1)").run();
  before.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES('project','documentator','doc',1,1,'record',10)").run();
  before.close();

  // A fresh database has nothing referencing the table being rebuilt, so a migration that cannot drop
  // it passes every test and fails on the first database anyone has actually used.
  const after = openDb(file);
  assert.equal(schemaVersion(after), all.length);
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM project_documents").get().count, 1);
  assert.equal(after.prepare("SELECT root_key FROM project_documents WHERE id='doc'").get().root_key, "primary");
  assert.equal(after.prepare("SELECT COUNT(*) AS count FROM role_documents WHERE document_id='doc'").get().count, 1);
  const resource = after.prepare("SELECT alias,kind,declaration_json FROM project_resources WHERE project_id='project'").get();
  assert.deepEqual({ alias: resource.alias, kind: resource.kind, declaration: JSON.parse(resource.declaration_json) }, { alias: "project.worktree", kind: "project.worktree", declaration: { path: root } });
  assert.equal(after.prepare("PRAGMA foreign_key_check").all().length, 0);
  after.close();

  fs.rmSync(root, { recursive: true, force: true });
});
