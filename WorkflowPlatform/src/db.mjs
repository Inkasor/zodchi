import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const defaultMigrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
const migrationChecksumAliases = new Map([
  ["7:902b94730a8d048ab08ccd611a9b82f29226a3ef3c5df7d5b02b81b7dd82a380", new Set(["8080e01be11bc8882303b50e3d51dc00d1dffcd23c3f08691dee6d7452770c1c"])]
]);

function migrationFiles(directory) {
  const files = fs.readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name)).sort();
  const migrations = files.map(name => {
    const version = Number(name.slice(0, 3));
    const sql = fs.readFileSync(path.join(directory, name), "utf8");
    return { version, name, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
  });
  for (const [index, migration] of migrations.entries()) if (migration.version !== index + 1) throw new Error(`MIGRATION_SEQUENCE_INVALID: expected ${index + 1}, found ${migration.version}`);
  if (!migrations.length) throw new Error(`MIGRATIONS_MISSING: ${directory}`);
  return migrations;
}

function existingTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}

export function applyMigrations(db, directory = defaultMigrationsDirectory) {
  const tables = existingTables(db);
  if (tables.length && !tables.includes("schema_migrations")) throw new Error(`LEGACY_DATABASE_UNSUPPORTED: create a clean database; found ${tables.join(", ")}`);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const migrations = migrationFiles(directory);
  const applied = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
  for (const row of applied) {
    const expected = migrations.find(item => item.version === row.version);
    if (!expected) throw new Error(`MIGRATION_UNKNOWN_APPLIED_VERSION: ${row.version}`);
    const compatible = migrationChecksumAliases.get(`${expected.version}:${expected.checksum}`)?.has(row.checksum) === true;
    if (expected.name !== row.name || (expected.checksum !== row.checksum && !compatible)) throw new Error(`MIGRATION_CHECKSUM_MISMATCH: ${row.version}`);
  }
  const insert = db.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)");
  // A table whose constraints have to change is rebuilt, and SQLite refuses to drop a table other
  // tables reference while foreign keys are enforced. The documented rebuild turns enforcement off
  // around the change, which cannot be done inside a transaction, and checks afterwards that the
  // change left no reference dangling — so nothing is taken on trust, the check is simply moved to
  // where it can run. A fresh database has no referencing rows, which is why a migration like this
  // passes every test and fails on the first database that has been used.
  for (const migration of migrations.filter(item => !applied.some(row => row.version === item.version))) {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      db.exec(`PRAGMA user_version=${migration.version}`);
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`FOREIGN_KEY_VIOLATIONS: ${violations.slice(0, 5).map(row => `${row.table}:${row.rowid}`).join(", ")}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`MIGRATION_FAILED ${migration.name}: ${error.message}`, { cause: error });
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  return { currentVersion: migrations.at(-1).version, applied: migrations.length };
}

export function openDb(file, options = {}) {
  if (!file) throw new Error("DATABASE_PATH_REQUIRED");
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    applyMigrations(db, options.migrationsDirectory ?? defaultMigrationsDirectory);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function schemaVersion(db) {
  return db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get().version;
}

export const now = () => new Date().toISOString();
export const id = prefix => `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
