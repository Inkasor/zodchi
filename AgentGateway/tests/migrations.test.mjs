import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { gatewaySchemaVersion, openGatewayDb } from "../src/db.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.AGENT_GATEWAY_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

test("clean database applies Gateway-only migrations and SQLite safety pragmas", () => {
  const root = temporaryRoot("gateway-migrations-clean-");
  const db = openGatewayDb(path.join(root, "gateway.sqlite"));
  assert.equal(gatewaySchemaVersion(db), 3);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name));
  assert.deepEqual([...tables].sort(), ["provider_snapshots", "providers", "receipts", "schema_migrations"]);
  const receiptColumns = new Set(db.prepare("PRAGMA table_info(receipts)").all().map(row => row.name));
  assert.equal(receiptColumns.has("model_provider"), true);
  for (const forbidden of ["output", "error", "raw_output", "gate_status", "gate_cycles", "escalation_reason"]) assert.equal(receiptColumns.has(forbidden), false, `forbidden receipt column ${forbidden}`);
  const snapshotColumns = new Set(db.prepare("PRAGMA table_info(provider_snapshots)").all().map(row => row.name));
  for (const forbidden of ["account", "raw_output", "error"]) assert.equal(snapshotColumns.has(forbidden), false, `forbidden snapshot column ${forbidden}`);
  assert.deepEqual(db.prepare("SELECT provider_key FROM providers ORDER BY provider_key").all().map(row => row.provider_key), ["claude", "codex", "cursor", "kimi", "openai-compatible", "opencode"]);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("Gateway database upgrades sequentially and verifies checksums", () => {
  const root = temporaryRoot("gateway-migrations-upgrade-");
  const migrations = path.join(root, "migrations");
  const file = path.join(root, "test.sqlite");
  fs.mkdirSync(migrations);
  fs.writeFileSync(path.join(migrations, "001_alpha.sql"), "CREATE TABLE alpha(id TEXT PRIMARY KEY);\n");
  let db = openGatewayDb(file, { migrationsDirectory: migrations });
  assert.equal(gatewaySchemaVersion(db), 1);
  db.close();
  fs.writeFileSync(path.join(migrations, "002_beta.sql"), "CREATE TABLE beta(id TEXT PRIMARY KEY);\n");
  db = openGatewayDb(file, { migrationsDirectory: migrations });
  assert.equal(gatewaySchemaVersion(db), 2);
  db.close();
  fs.writeFileSync(path.join(migrations, "001_alpha.sql"), "CREATE TABLE changed(id TEXT PRIMARY KEY);\n");
  assert.throws(() => openGatewayDb(file, { migrationsDirectory: migrations }), /GATEWAY_MIGRATION_CHECKSUM_MISMATCH/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("failed Gateway migration rolls back and legacy databases fail closed", () => {
  const root = temporaryRoot("gateway-migrations-fail-");
  const migrations = path.join(root, "migrations");
  const file = path.join(root, "test.sqlite");
  fs.mkdirSync(migrations);
  fs.writeFileSync(path.join(migrations, "001_alpha.sql"), "CREATE TABLE alpha(id TEXT PRIMARY KEY);\n");
  let db = openGatewayDb(file, { migrationsDirectory: migrations });
  db.close();
  fs.writeFileSync(path.join(migrations, "002_broken.sql"), "CREATE TABLE beta(id TEXT PRIMARY KEY); THIS IS NOT SQL;\n");
  assert.throws(() => openGatewayDb(file, { migrationsDirectory: migrations }), /GATEWAY_MIGRATION_FAILED/);
  db = new DatabaseSync(file);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='beta'").get().count, 0);
  db.close();
  const legacy = path.join(root, "legacy.sqlite");
  db = new DatabaseSync(legacy);
  db.exec("CREATE TABLE workflow_runs(id TEXT PRIMARY KEY)");
  db.close();
  assert.throws(() => openGatewayDb(legacy), /GATEWAY_LEGACY_DATABASE_UNSUPPORTED/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("technical receipts are immutable", () => {
  const root = temporaryRoot("gateway-receipts-immutable-");
  const db = openGatewayDb(path.join(root, "gateway.sqlite"));
  db.prepare(`INSERT INTO receipts
    (receipt_id,task_id,attempt_no,provider,profile,level,role,started_at,finished_at,calls,correction_cycles,retries,timed_out,exit_code,status,duration_ms,context_bytes,contract_hash,result_hash)
    VALUES ('receipt','task',1,'codex','test','mvp','worker','2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z',1,0,0,0,0,'completed',1000,10,'contract','result')`).run();
  assert.throws(() => db.prepare("UPDATE receipts SET status='failed' WHERE receipt_id='receipt'").run(), /receipts are immutable/);
  assert.throws(() => db.prepare("DELETE FROM receipts WHERE receipt_id='receipt'").run(), /receipts are immutable/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
