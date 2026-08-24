import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const defaultMigrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

function migrations(directory) {
  const result = fs.readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name)).sort().map(name => {
    const sql = fs.readFileSync(path.join(directory, name), "utf8");
    return { version: Number(name.slice(0, 3)), name, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
  });
  for (const [index, item] of result.entries()) if (item.version !== index + 1) throw new Error(`GATEWAY_MIGRATION_SEQUENCE_INVALID: expected ${index + 1}, found ${item.version}`);
  if (!result.length) throw new Error(`GATEWAY_MIGRATIONS_MISSING: ${directory}`);
  return result;
}

export function applyGatewayMigrations(db, directory = defaultMigrationsDirectory) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  if (tables.length && !tables.includes("schema_migrations")) throw new Error(`GATEWAY_LEGACY_DATABASE_UNSUPPORTED: create a clean database; found ${tables.join(", ")}`);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)");
  const available = migrations(directory);
  const applied = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
  for (const row of applied) {
    const expected = available.find(item => item.version === row.version);
    if (!expected) throw new Error(`GATEWAY_MIGRATION_UNKNOWN_APPLIED_VERSION: ${row.version}`);
    if (expected.name !== row.name || expected.checksum !== row.checksum) throw new Error(`GATEWAY_MIGRATION_CHECKSUM_MISMATCH: ${row.version}`);
  }
  const insert = db.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)");
  for (const migration of available.filter(item => !applied.some(row => row.version === item.version))) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      db.exec(`PRAGMA user_version=${migration.version}`);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw new Error(`GATEWAY_MIGRATION_FAILED ${migration.name}: ${error.message}`, { cause: error }); }
  }
  return { currentVersion: available.at(-1).version, applied: available.length };
}

export function openGatewayDb(file, options = {}) {
  if (!file) throw new Error("GATEWAY_DATABASE_PATH_REQUIRED");
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    applyGatewayMigrations(db, options.migrationsDirectory ?? defaultMigrationsDirectory);
    return db;
  } catch (error) { db.close(); throw error; }
}

export function gatewaySchemaVersion(db) { return db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get().version; }
