import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDb, schemaVersion } from "../src/db.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

test("clean database applies numbered normalized migrations and SQLite safety pragmas", () => {
  const root = temporaryRoot("workflow-migrations-clean-");
  const db = openDb(path.join(root, "workflow.sqlite"));
  assert.equal(schemaVersion(db), 11);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const table of ["goals", "stages", "tasks", "workflow_runs", "workflow_steps", "attempts", "decisions", "approvals", "artifacts", "events", "budgets", "budget_entries", "leases", "inbox_events", "dead_letters", "role_contracts", "role_profile_assignments", "workflow_package_releases", "workflow_import_proposals", "package_import_mappings", "experience_observations", "experience_proposals", "experience_evaluations", "check_baselines", "check_baseline_diagnostics", "diagnostic_rules", "diagnostic_rule_tags", "project_diagnostic_policies"]) assert.equal(tables.has(table), true, `missing ${table}`);
  assert.equal(new Set(db.prepare("PRAGMA table_info(gateway_calls)").all().map(row => row.name)).has("model_provider"), true);
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
  assert.equal(schemaVersion(db), 11);
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
