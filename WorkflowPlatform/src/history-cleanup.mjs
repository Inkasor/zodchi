import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

// This is deliberately an allowlist. A new execution table must be classified here before the
// cleanup command can run; "delete everything that is not registry" is not a safe history policy.
export const WORKFLOW_HISTORY_TABLES = Object.freeze([
  "external_control_results",
  "external_operation_executions",
  "external_control_requests",
  "document_operations",
  "document_proposals",
  "gates",
  "gate_runs",
  "lint_results",
  "resource_leases",
  "run_control_requests",
  "run_evidence",
  "run_profiles",
  "run_reflection_checkpoints",
  "run_root_baselines",
  "progress_snapshots",
  "events",
  "artifacts",
  "conversation_messages",
  "inbox_events",
  "dead_letters",
  "gateway_calls",
  "leases",
  "attempts",
  "approvals",
  "plans",
  "classifications",
  "decisions",
  "owner_acceptance_records",
  "budget_entries",
  "budgets",
  "zodchi_chat_session_runs",
  "zodchi_chat_sessions",
  "workflow_steps",
  "workflow_runs",
  "tasks",
  "workflow_questions"
]);

export const GATEWAY_HISTORY_TABLES = Object.freeze(["receipts", "provider_snapshots"]);

// These are the tables the command promises not to touch. Keeping this list explicit also makes a
// schema addition fail closed instead of silently becoming an unreviewed deletion target.
export const PRESERVED_WORKFLOW_TABLES = Object.freeze([
  "projects",
  "project_roots",
  "project_resources",
  "domains",
  "disciplines",
  "planning_levels",
  "quality_modes",
  "semantic_statuses",
  "evidence_types",
  "artifact_types",
  "work_types",
  "check_definitions",
  "project_checks",
  "check_baselines",
  "check_baseline_diagnostics",
  "diagnostic_rules",
  "diagnostic_rule_tags",
  "evidence_flow_adapters",
  "external_tool_registry",
  "external_executors",
  "external_operation_definitions",
  "goals",
  "stages",
  "operational_level_budget_limits",
  "operational_level_escalation_rules",
  "operational_level_policies",
  "project_diagnostic_policies",
  "project_evidence_types",
  "project_run_profile_defaults",
  "project_semantic_statuses",
  "project_strategy_overrides",
  "portable_profile_requirements",
  "profiles",
  "prompt_templates",
  "quality_contracts",
  "quality_contract_budgets",
  "quality_contract_escalations",
  "quality_contract_rules",
  "role_contracts",
  "role_documents",
  "role_profile_assignments",
  "roles",
  "package_import_mappings",
  "package_test_scenarios",
  "project_documents",
  "workflow_import_proposals",
  "workflow_package_releases",
  "workflow_routes",
  "workflow_step_templates",
  "workflow_transition_templates",
  "workflows",
  "experience_evaluations",
  "experience_observations",
  "experience_proposals",
  "schema_migrations"
]);

const WORKFLOW_TABLES = Object.freeze([...WORKFLOW_HISTORY_TABLES, ...PRESERVED_WORKFLOW_TABLES]);

function quote(value) { return `"${String(value).replaceAll('"', '""')}"`; }
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function tableNames(db) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name); }
function assertSource(file, label) {
  const resolved = path.resolve(file ?? "");
  if (!file || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`HISTORY_CLEANUP_${label}_DATABASE_MISSING: ${resolved}`);
  return resolved;
}
function assertClassification(db, label, expectedTables) {
  const actual = new Set(tableNames(db));
  const missing = expectedTables.filter(table => !actual.has(table));
  if (missing.length) throw new Error(`HISTORY_CLEANUP_${label}_TABLE_MISSING: ${missing.join(",")}`);
  const classified = new Set(expectedTables);
  const unknown = [...actual].filter(table => !classified.has(table));
  if (unknown.length) throw new Error(`HISTORY_CLEANUP_${label}_TABLE_UNCLASSIFIED: ${unknown.join(",")}`);
}
function tableRows(db, tables) {
  const result = {};
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM ${quote(table)}`).all().map(row => Object.fromEntries(Object.entries(row)));
    rows.sort((left, right) => canonical(left).localeCompare(canonical(right), "en"));
    result[table] = rows;
  }
  return result;
}
function snapshot(db, tables) {
  const rows = tableRows(db, tables);
  const counts = Object.fromEntries(tables.map(table => [table, rows[table].length]));
  return { counts, hash: digest(canonical(rows)) };
}
function integrity(db, label) {
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all().map(row => Object.fromEntries(Object.entries(row)));
  const check = db.prepare("PRAGMA integrity_check").get()?.integrity_check ?? null;
  if (foreignKeys.length || check !== "ok") throw new Error(`HISTORY_CLEANUP_${label}_INTEGRITY_FAILED: foreign_keys=${JSON.stringify(foreignKeys.slice(0, 5))}; integrity=${check}`);
  return { foreign_key_check: foreignKeys, integrity_check: check };
}
function configure(db) {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
}
function deleteTables(db, tables) {
  const deleted = {};
  for (const table of tables) {
    // Append-only logs are protected by triggers. The cleanup command is the one explicit, audited
    // retention boundary allowed to remove them, so temporarily replace only the delete trigger inside
    // the same transaction and restore it before the transaction can commit.
    if (IMMUTABLE_DELETE_TRIGGERS[table]) {
      db.exec(`DROP TRIGGER IF EXISTS ${table === "events" ? "events_no_delete" : "receipts_no_delete"}`);
      try { deleted[table] = Number(db.prepare(`DELETE FROM ${quote(table)}`).run().changes ?? 0); }
      finally {
        db.exec(IMMUTABLE_DELETE_TRIGGERS[table]);
      }
    } else deleted[table] = Number(db.prepare(`DELETE FROM ${quote(table)}`).run().changes ?? 0);
  }
  return deleted;
}
function sumCounts(counts) { return Object.values(counts).reduce((total, value) => total + Number(value), 0); }
function timestampToken(value = new Date()) { return value.toISOString().replaceAll(/[-:.TZ]/gu, ""); }

const IMMUTABLE_DELETE_TRIGGERS = Object.freeze({
  events: "CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END",
  receipts: "CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END"
});

async function backupDatabase(file, label, token) {
  const output = `${file}.history-backup-${token}-${crypto.randomUUID().slice(0, 8)}.sqlite`;
  const source = new DatabaseSync(file, { readOnly: true });
  try { await backup(source, output); }
  finally { source.close(); }
  const verified = new DatabaseSync(output, { readOnly: true });
  try { integrity(verified, `BACKUP_${label}`); }
  finally { verified.close(); }
  return { label, file: output, sha256: digest(fs.readFileSync(output)), size: fs.statSync(output).size };
}

function openWritable(file, label, expectedTables) {
  const db = new DatabaseSync(file);
  try { configure(db); assertClassification(db, label, expectedTables); return db; }
  catch (error) { db.close(); throw error; }
}

function applyDatabase(file, label, historyTables, preservedTables) {
  const db = openWritable(file, label, [...historyTables, ...preservedTables]);
  try {
    const before = snapshot(db, preservedTables);
    db.exec("BEGIN IMMEDIATE");
    try {
      const deleted = deleteTables(db, historyTables);
      const after = snapshot(db, preservedTables);
      if (before.hash !== after.hash) throw new Error(`HISTORY_CLEANUP_${label}_REGISTRY_CHANGED`);
      const checks = integrity(db, label);
      db.exec("COMMIT");
      return { deleted, deleted_total: sumCounts(deleted), registry_before: before, registry_after: after, checks };
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
}

function readDatabase(file, label, historyTables, preservedTables) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    configure(db);
    assertClassification(db, label, [...historyTables, ...preservedTables]);
    return {
      history: snapshot(db, historyTables),
      registry: snapshot(db, preservedTables),
      checks: integrity(db, label)
    };
  } finally { db.close(); }
}

/**
 * Print the exact rows that would be removed by default. Apply requires the caller to pass
 * `apply: true`; backups are made before the first write and both registry and SQLite checks are
 * verified inside and after the transaction.
 */
export async function cleanupHistory({ workflowDatabase, gatewayDatabase, apply = false, at = new Date() } = {}) {
  const workflowFile = assertSource(workflowDatabase, "WORKFLOW");
  const gatewayFile = assertSource(gatewayDatabase, "GATEWAY");
  const workflowBefore = readDatabase(workflowFile, "WORKFLOW", WORKFLOW_HISTORY_TABLES, PRESERVED_WORKFLOW_TABLES);
  const gatewayBefore = readDatabase(gatewayFile, "GATEWAY", GATEWAY_HISTORY_TABLES, ["providers", "schema_migrations"]);
  const preview = {
    workflow: { database: workflowFile, tables: workflowBefore.history.counts, rows: sumCounts(workflowBefore.history.counts) },
    gateway: { database: gatewayFile, tables: gatewayBefore.history.counts, rows: sumCounts(gatewayBefore.history.counts) },
    registry: { workflow_hash: workflowBefore.registry.hash, gateway_hash: gatewayBefore.registry.hash },
    checks_before: { workflow: workflowBefore.checks, gateway: gatewayBefore.checks }
  };
  if (apply !== true) return { schema_version: 1, status: "dry_run", apply: false, ...preview, backups: [] };

  const token = timestampToken(at);
  const backups = [await backupDatabase(workflowFile, "WORKFLOW", token), await backupDatabase(gatewayFile, "GATEWAY", token)];
  const workflowResult = applyDatabase(workflowFile, "WORKFLOW", WORKFLOW_HISTORY_TABLES, PRESERVED_WORKFLOW_TABLES);
  const gatewayResult = applyDatabase(gatewayFile, "GATEWAY", GATEWAY_HISTORY_TABLES, ["providers", "schema_migrations"]);
  const workflowAfter = readDatabase(workflowFile, "WORKFLOW", WORKFLOW_HISTORY_TABLES, PRESERVED_WORKFLOW_TABLES);
  const gatewayAfter = readDatabase(gatewayFile, "GATEWAY", GATEWAY_HISTORY_TABLES, ["providers", "schema_migrations"]);
  if (workflowAfter.registry.hash !== workflowBefore.registry.hash || gatewayAfter.registry.hash !== gatewayBefore.registry.hash) throw new Error("HISTORY_CLEANUP_REGISTRY_CHANGED_AFTER_COMMIT");
  return {
    schema_version: 1,
    status: "applied",
    apply: true,
    ...preview,
    backups,
    deleted: { workflow: workflowResult.deleted, gateway: gatewayResult.deleted },
    deleted_total: { workflow: workflowResult.deleted_total, gateway: gatewayResult.deleted_total },
    remaining: { workflow: workflowAfter.history.counts, gateway: gatewayAfter.history.counts },
    registry: {
      workflow_before: workflowBefore.registry.hash, workflow_after: workflowAfter.registry.hash,
      gateway_before: gatewayBefore.registry.hash, gateway_after: gatewayAfter.registry.hash,
      unchanged: true
    },
    checks_after: { workflow: workflowAfter.checks, gateway: gatewayAfter.checks }
  };
}
