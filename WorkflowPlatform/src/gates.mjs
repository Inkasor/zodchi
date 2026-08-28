import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolveWorkflowSettings } from "./paths.mjs";
import { qualityModesThrough } from "./quality-contracts.mjs";
import { resolveCommandConfiguration } from "./command-resolver.mjs";

const CHECKED_ARTIFACTS = new Set(["code", "prototype", "data_migration", "release_package", "deployment_evidence", "security_report", "access_change", "test_report"]);
const ARTIFACT_CASCADE = Object.freeze({
  none: [],
  document: ["document"],
  code: ["code"],
  prototype: ["prototype", "code"],
  test_report: ["test_report", "code", "prototype"],
  decision: ["decision", "document"],
  data_migration: ["data_migration", "code", "test_report", "document"],
  release_package: ["release_package", "code", "prototype", "test_report", "document"],
  deployment_evidence: ["deployment_evidence", "release_package", "code", "prototype", "test_report", "document"],
  access_change: ["access_change", "document"],
  security_report: ["security_report", "deployment_evidence", "release_package", "data_migration", "access_change", "code", "prototype", "test_report", "document"]
});

function parseJson(value, fallback = {}) { try { return JSON.parse(value); } catch { return fallback; } }

function artifactTypesThrough(artifactType) {
  if (!artifactType) return null;
  return new Set(ARTIFACT_CASCADE[artifactType] ?? [artifactType]);
}

export function resolveProjectChecks(db, projectId, level, artifactType = null) {
  const qualities = qualityModesThrough(level);
  const allowedArtifacts = artifactTypesThrough(artifactType);
  const placeholders = qualities.map(() => "?").join(",");
  const rows = db.prepare(`SELECT pc.check_id,pc.required,pc.artifact_type_id,pc.quality_mode_id,cd.name,cd.runner,cd.kind,cd.config_json,cd.timeout_seconds,
      COALESCE((SELECT m.semantic_key FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id=pc.project_id AND p.status='applied' AND m.entity_type='check' AND m.local_id=pc.check_id ORDER BY p.applied_at DESC LIMIT 1),pc.check_id) AS semantic_id
    FROM project_checks pc JOIN check_definitions cd ON cd.id=pc.check_id
    WHERE pc.project_id=? AND pc.quality_mode_id IN (${placeholders})
    ORDER BY CASE pc.quality_mode_id WHEN 'prototype' THEN 0 WHEN 'mvp' THEN 1 WHEN 'production' THEN 2 WHEN 'security' THEN 3 ELSE 9 END,cd.id`).all(projectId, ...qualities)
    .filter(row => row.artifact_type_id === null || allowedArtifacts === null || allowedArtifacts.has(row.artifact_type_id));
  const merged = new Map();
  for (const row of rows) {
    const existing = merged.get(row.check_id);
    if (!existing) {
      merged.set(row.check_id, { ...row, required: Boolean(row.required), quality_sources: [row.quality_mode_id], artifact_sources: row.artifact_type_id ? [row.artifact_type_id] : [] });
      continue;
    }
    existing.required ||= Boolean(row.required);
    if (!existing.quality_sources.includes(row.quality_mode_id)) existing.quality_sources.push(row.quality_mode_id);
    if (row.artifact_type_id && !existing.artifact_sources.includes(row.artifact_type_id)) existing.artifact_sources.push(row.artifact_type_id);
  }
  return [...merged.values()];
}

export function registeredProjectCheckKeys(db, projectId, level, artifactType = null) {
  return resolveProjectChecks(db, projectId, level, artifactType).map(row => row.semantic_id);
}

function configuredChecks(project, level, dbFile, artifactType = null) {
  const db = new DatabaseSync(dbFile);
  try {
    const projectId = db.prepare("SELECT id FROM projects WHERE lower(root_path)=lower(?)").get(project)?.id;
    if (!projectId) return [];
    return resolveProjectChecks(db, projectId, level, artifactType).map(row => {
      const config = parseJson(row.config_json);
      const executionRoot = row.kind === "project_command" && typeof config.project_id === "string"
        ? db.prepare("SELECT root_path FROM projects WHERE id=?").get(config.project_id)?.root_path ?? null
        : row.kind === "command" ? project : null;
      const executionProjectId = row.kind === "project_command" && typeof config.project_id === "string" ? config.project_id : projectId;
      return { ...row, config, execution_root: executionRoot, execution_project_id: executionProjectId };
    });
  } finally { db.close(); }
}

function runCommand(command, args, cwd, timeoutSeconds) {
  return new Promise(resolve => {
    const windowsScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const executable = windowsScript ? (process.env.ComSpec ?? "cmd.exe") : command;
    const quote = value => {
      const text = String(value);
      if (/[\0\r\n]/.test(text)) throw new Error("COMMAND_ARGUMENT_INVALID");
      return `"${text.replaceAll("%", "%%").replaceAll('"', '""')}"`;
    };
    const commandLine = windowsScript ? `"${[command, ...args].map(quote).join(" ")}"` : null;
    const commandArgs = windowsScript ? ["/d", "/s", "/c", commandLine] : args;
    try {
      execFile(executable, commandArgs, { cwd, windowsHide: true, shell: false, windowsVerbatimArguments: windowsScript, timeout: timeoutSeconds * 1000 }, (error, stdout, stderr) => {
        const timedOut = error?.code === "ETIMEDOUT" || error?.killed === true;
        resolve({ status: timedOut ? "timed_out" : error ? "failed" : "passed", exit_code: timedOut ? 124 : typeof error?.code === "number" ? error.code : error ? 1 : 0, error_code: typeof error?.code === "string" ? error.code : null, output: `${stdout ?? ""}\n${stderr ?? ""}` });
      });
    } catch (error) { resolve({ status: "failed", exit_code: 1, error_code: typeof error?.code === "string" ? error.code : null, output: String(error.message) }); }
  });
}

function topLevelCommandUnavailable(result, command) {
  if (result.error_code === "ENOENT") return true;
  if (result.status !== "failed") return false;
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\r?\\n)[^\\r\\n]*${escaped}[^\\r\\n]*not recognized as an internal or external command`, "i").test(result.output);
}

function compactFailure(text, max = 2200) {
  const lines = String(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).filter(Boolean);
  const useful = lines.filter(line => /error|fail|warning|assert|exception|timeout/i.test(line));
  return (useful.length ? useful : lines.slice(-8)).slice(-20).join("\n").slice(-max);
}

function secretScan(project, allowedPaths) {
  const findings = [];
  const patterns = [/(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})/m, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m];
  let candidates = allowedPaths;
  if (!candidates.length) {
    try {
      candidates = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: project, encoding: "utf8", windowsHide: true })
        .split("\0").filter(Boolean).map(item => item.replaceAll("\\", "/"));
    } catch {
      return { status: "unavailable", exit_code: 1, failure: "cannot enumerate tracked and unignored project files" };
    }
  }
  for (const relative of candidates) {
    const file = path.resolve(project, relative);
    if (!file.startsWith(`${path.resolve(project)}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    if (fs.statSync(file).size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(file, "utf8");
    if (patterns.some(pattern => pattern.test(text))) findings.push(relative);
  }
  return { status: findings.length ? "failed" : "passed", exit_code: findings.length ? 1 : 0, failure: findings.length ? `credential-shaped material: ${findings.join(", ")}` : null };
}

function commandArguments(args, context) {
  const replacements = new Map([
    ["{{quality_level}}", context.level],
    ["{{artifact_type}}", context.artifactType ?? ""]
  ]);
  return args.map(value => replacements.has(value) ? replacements.get(value) : value);
}

async function executeCheck(check, project, allowedPaths, context) {
  if (check.kind === "disabled") return { status: "unavailable", exit_code: 1, failure: check.config.reason ?? "not_configured" };
  if (check.kind === "fixture") {
    const status = check.config.status ?? "unavailable";
    return { status, exit_code: status === "passed" ? 0 : status === "timed_out" ? 124 : 1, failure: status === "passed" ? null : check.config.failure ?? `fixture ${status}` };
  }
  if (check.kind === "secret_scan") return secretScan(project, allowedPaths);
  if (check.kind !== "command" && check.kind !== "project_command") return { status: "unavailable", exit_code: 1, failure: `unsupported check kind: ${check.kind}` };
  if (!check.execution_root || !fs.existsSync(check.execution_root)) return { status: "unavailable", exit_code: 1, failure: check.kind === "project_command" ? `registered project is unavailable: ${check.config.project_id ?? "unknown"}` : "project root is unavailable" };
  if (!Array.isArray(check.config.args) || check.config.args.some(arg => typeof arg !== "string")) return { status: "unavailable", exit_code: 1, failure: "invalid command check configuration" };
  let resolved;
  try { resolved = resolveCommandConfiguration(check.config); }
  catch (error) { return { status: "unavailable", exit_code: 1, failure: String(error.message), capability: check.config.capability ?? null, resolved_command: null }; }
  const result = await runCommand(resolved.command, commandArguments(check.config.args, context), check.execution_root, check.timeout_seconds);
  if (topLevelCommandUnavailable(result, resolved.command)) return { status: "unavailable", exit_code: 1, failure: `required tool is not installed: ${resolved.capability ?? resolved.command}`, capability: resolved.capability, resolved_command: resolved.command };
  return { status: result.status, exit_code: result.exit_code, failure: result.status === "passed" ? null : compactFailure(result.output), capability: resolved.capability, resolved_command: resolved.command };
}

export async function runProjectGate(project, level = "mvp", dbFile = resolveWorkflowSettings().databasePath, taskId = `gate-${Date.now()}`, options = {}) {
  const resolvedProject = path.resolve(project);
  const allowedPaths = [...new Set((options.allowedPaths ?? []).map(item => item.replaceAll("\\", "/")))].sort();
  const configured = configuredChecks(resolvedProject, level, dbFile, options.artifactType ?? null);
  const checks = [];
  const startedAt = new Date().toISOString();
  // A check that cannot run is evidence of nothing, so coverage counts only required executable checks.
  const executableRequired = configured.filter(check => check.required && check.kind !== "disabled");
  if (!executableRequired.length && (level === "security-audit" || CHECKED_ARTIFACTS.has(options.artifactType))) {
    checks.push({ id: "quality_contract_checks", name: "Required check coverage", required: true, status: "unavailable", exit_code: 1, duration_ms: 0, failure: `No executable required checks are configured for ${level}/${options.artifactType ?? "unknown"}.`, execution_project_id: null, execution_root: resolvedProject });
  }
  for (const check of configured) {
    const started = Date.now();
    const result = await executeCheck(check, resolvedProject, allowedPaths, { level, artifactType: options.artifactType ?? null });
    checks.push({ id: check.check_id, name: check.name, required: check.required, inherited_from: check.quality_sources, execution_project_id: check.execution_project_id, execution_root: check.execution_root, status: result.status, exit_code: result.exit_code, duration_ms: Date.now() - started, ...(result.capability ? { command_capability: result.capability } : {}), ...(result.resolved_command ? { resolved_command: result.resolved_command } : {}), ...(result.failure ? { failure: result.failure } : {}) });
  }
  const blocking = checks.filter(check => check.required && check.status !== "passed");
  const status = blocking.some(check => check.status === "failed") ? "failed"
    : blocking.some(check => check.status === "timed_out") ? "timed_out"
      : blocking.some(check => check.status === "unavailable") ? "unavailable"
        : blocking.length ? "unavailable" : "passed";
  const result = { task_id: taskId, run_id: options.runId ?? null, project: resolvedProject, level, files: allowedPaths, status, checks, summary: `${checks.filter(check => check.status === "passed").length} passed, ${blocking.length} blocking` };
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    db.prepare("INSERT INTO gate_runs(gate_id,task_id,run_id,project,level,started_at,finished_at,status,checks_json,files_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(taskId, taskId, options.runId ?? null, resolvedProject, level, startedAt, new Date().toISOString(), status, JSON.stringify(checks), JSON.stringify(allowedPaths));
  } finally { db.close(); }
  return result;
}
