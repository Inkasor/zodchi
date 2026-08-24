import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { id, now, openDb } from "./db.mjs";

const SEVERITY_RANK = Object.freeze({ Hint: 0, Information: 1, Warning: 2, Error: 3 });
const DIAGNOSTIC_SEVERITY_RANK = Object.freeze({ INFO: 0, MINOR: 1, MAJOR: 2, CRITICAL: 3, BLOCKER: 4 });
const DEFAULT_MINIMUM_SEVERITY = "Warning";
const CHECK_SEMANTIC_KEY = "bsl_language_server";
const DEFAULT_CATALOG_FILE = fileURLToPath(new URL("../catalogs/bsl-language-server-1.0.7.json", import.meta.url));
const QUALITY_MODE_ID = Object.freeze({ prototype: "prototype", mvp: "mvp", production: "production", "security-audit": "security", security: "security" });

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const next = values[index + 1];
    result[value.slice(2)] = next === undefined || next.startsWith("--") ? true : next;
  }
  return result;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`ONE_C_BSL_ARGUMENT_REQUIRED: ${name}`);
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function resolveReportPath(value) {
  if (typeof value !== "string" || !value) throw new Error("ONE_C_BSL_REPORT_PATH_MISSING");
  if (!value.startsWith("file:")) return path.resolve(value);
  return fileURLToPath(value);
}

function relativeDiagnosticPath(filePath, sourceRoot) {
  const resolved = resolveReportPath(filePath);
  const relative = path.relative(path.resolve(sourceRoot), resolved).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error(`ONE_C_BSL_REPORT_OUTSIDE_SOURCE: ${filePath}`);
  return relative;
}

function severityAccepted(severity, minimumSeverity) {
  if (!(severity in SEVERITY_RANK)) throw new Error(`ONE_C_BSL_UNKNOWN_SEVERITY: ${severity}`);
  if (!(minimumSeverity in SEVERITY_RANK)) throw new Error(`ONE_C_BSL_UNKNOWN_MINIMUM_SEVERITY: ${minimumSeverity}`);
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimumSeverity];
}

export function buildDiagnosticSnapshot(report, { minimumSeverity = DEFAULT_MINIMUM_SEVERITY } = {}) {
  if (!report || !Array.isArray(report.fileinfos) || typeof report.sourceDir !== "string") throw new Error("ONE_C_BSL_INVALID_JSON_REPORT");
  const counts = new Map();
  const summary = { Error: 0, Warning: 0, Information: 0, Hint: 0, considered: 0, files: report.fileinfos.length };
  for (const file of report.fileinfos) {
    const relativePath = relativeDiagnosticPath(file.path, report.sourceDir);
    for (const diagnostic of file.diagnostics ?? []) {
      const severity = String(diagnostic.severity ?? "");
      if (!(severity in summary)) throw new Error(`ONE_C_BSL_UNKNOWN_SEVERITY: ${severity}`);
      summary[severity] += 1;
      if (!severityAccepted(severity, minimumSeverity)) continue;
      summary.considered += 1;
      const entry = {
        path: relativePath,
        severity,
        code: String(diagnostic.code ?? "unknown"),
        message_hash: sha256(String(diagnostic.message ?? "").trim()).slice(0, 16)
      };
      const key = JSON.stringify(entry);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const diagnostics = [...counts.entries()].map(([key, count]) => ({ ...JSON.parse(key), count }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.severity.localeCompare(right.severity) || left.code.localeCompare(right.code) || left.message_hash.localeCompare(right.message_hash));
  return { minimum_severity: minimumSeverity, summary, diagnostics };
}

export function compareDiagnosticSnapshots(current, baseline) {
  if (current.minimum_severity !== baseline.minimum_severity) throw new Error(`ONE_C_BSL_BASELINE_POLICY_MISMATCH: ${baseline.minimum_severity} != ${current.minimum_severity}`);
  const keyOf = item => JSON.stringify({ path: item.path, severity: item.severity, code: item.code, message_hash: item.message_hash });
  const baselineCounts = new Map((baseline.diagnostics ?? []).map(item => [keyOf(item), Number(item.count)]));
  const currentCounts = new Map((current.diagnostics ?? []).map(item => [keyOf(item), Number(item.count)]));
  const added = [], removed = [];
  for (const item of current.diagnostics ?? []) {
    const delta = Number(item.count) - (baselineCounts.get(keyOf(item)) ?? 0);
    if (delta > 0) added.push({ ...item, count: delta });
  }
  for (const item of baseline.diagnostics ?? []) {
    const delta = Number(item.count) - (currentCounts.get(keyOf(item)) ?? 0);
    if (delta > 0) removed.push({ ...item, count: delta });
  }
  return {
    status: added.length ? "failed" : "passed",
    added,
    removed,
    added_count: added.reduce((sum, item) => sum + item.count, 0),
    removed_count: removed.reduce((sum, item) => sum + item.count, 0)
  };
}

function validateCatalog(value, toolVersion) {
  if (value?.schema_version !== 1 || value?.tool?.name !== "BSL Language Server" || value.tool.version !== toolVersion || !Array.isArray(value.diagnostics)) throw new Error("ONE_C_BSL_CATALOG_INVALID");
  const codes = new Set();
  for (const rule of value.diagnostics) {
    if (!rule?.code || codes.has(rule.code) || !["ERROR", "CODE_SMELL", "VULNERABILITY", "SECURITY_HOTSPOT"].includes(rule.type) || !(rule.severity in DIAGNOSTIC_SEVERITY_RANK) || !(rule.lsp_severity in SEVERITY_RANK) || !Array.isArray(rule.tags)) throw new Error(`ONE_C_BSL_CATALOG_RULE_INVALID: ${rule?.code ?? "unknown"}`);
    codes.add(rule.code);
  }
  return value;
}

function readCatalog(catalogFile, toolVersion) {
  const resolved = path.resolve(catalogFile ?? DEFAULT_CATALOG_FILE);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`ONE_C_BSL_CATALOG_NOT_FOUND: ${resolved}`);
  return validateCatalog(JSON.parse(fs.readFileSync(resolved, "utf8")), toolVersion);
}

function importCatalog(db, catalog) {
  const rule = db.prepare(`INSERT INTO diagnostic_rules(tool_name,tool_version,diagnostic_code,name_ru,name_en,diagnostic_type,diagnostic_severity,lsp_severity,activated_by_default,minutes_to_fix,source_revision,source_url,source_license)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tool_name,tool_version,diagnostic_code) DO UPDATE SET name_ru=excluded.name_ru,name_en=excluded.name_en,diagnostic_type=excluded.diagnostic_type,diagnostic_severity=excluded.diagnostic_severity,lsp_severity=excluded.lsp_severity,activated_by_default=excluded.activated_by_default,minutes_to_fix=excluded.minutes_to_fix,source_revision=excluded.source_revision,source_url=excluded.source_url,source_license=excluded.source_license`);
  const clearTags = db.prepare("DELETE FROM diagnostic_rule_tags WHERE tool_name=? AND tool_version=? AND diagnostic_code=?");
  const tag = db.prepare("INSERT INTO diagnostic_rule_tags(tool_name,tool_version,diagnostic_code,tag) VALUES(?,?,?,?)");
  for (const item of catalog.diagnostics) {
    rule.run(catalog.tool.name, catalog.tool.version, item.code, item.name_ru, item.name_en, item.type, item.severity, item.lsp_severity, item.activated_by_default ? 1 : 0, item.minutes_to_fix, catalog.tool.source_revision, catalog.tool.source_url, catalog.tool.license);
    clearTags.run(catalog.tool.name, catalog.tool.version, item.code);
    for (const value of item.tags) tag.run(catalog.tool.name, catalog.tool.version, item.code, value);
  }
}

function replaceProjectPolicies(db, projectId, checkId) {
  db.prepare("DELETE FROM project_diagnostic_policies WHERE project_id=? AND check_id=?").run(projectId, checkId);
  const insert = db.prepare("INSERT INTO project_diagnostic_policies(project_id,check_id,quality_mode_id,diagnostic_type,minimum_severity,disposition) VALUES(?,?,?,?,?,'block')");
  for (const quality of ["prototype", "mvp", "production", "security"]) insert.run(projectId, checkId, quality, "ERROR", "CRITICAL");
  for (const type of ["VULNERABILITY", "SECURITY_HOTSPOT"]) insert.run(projectId, checkId, "security", type, "INFO");
}

function loadDiagnosticPolicy(db, projectId, checkId, qualityLevel, tool) {
  const qualityMode = QUALITY_MODE_ID[qualityLevel];
  if (!qualityMode) throw new Error(`ONE_C_BSL_QUALITY_LEVEL_INVALID: ${qualityLevel}`);
  const rules = new Map(db.prepare("SELECT diagnostic_code AS code,name_ru,name_en,diagnostic_type AS type,diagnostic_severity AS severity,lsp_severity,activated_by_default,minutes_to_fix FROM diagnostic_rules WHERE tool_name=? AND tool_version=?").all(tool.name, tool.version).map(item => [item.code, item]));
  if (!rules.size) throw new Error(`ONE_C_BSL_CATALOG_NOT_IMPORTED: ${tool.version}`);
  const policies = db.prepare("SELECT diagnostic_type AS type,minimum_severity,disposition FROM project_diagnostic_policies WHERE project_id=? AND check_id=? AND quality_mode_id=?").all(projectId, checkId, qualityMode);
  return { quality_mode: qualityMode, rules, policies };
}

export function classifyDiagnosticChanges(items, policy) {
  const policies = new Map(policy.policies.map(item => [item.type, item]));
  const blocking = [], advisory = [], unknown = [];
  for (const item of items) {
    const rule = policy.rules.get(item.code);
    if (!rule) {
      const value = { ...item, name_ru: item.code, type: "UNKNOWN", diagnostic_severity: "UNKNOWN", disposition: item.severity === "Error" ? "block" : "report", catalog_missing: true };
      unknown.push(value);
      (value.disposition === "block" ? blocking : advisory).push(value);
      continue;
    }
    const selector = policies.get(rule.type);
    const disposition = selector?.disposition === "block" && DIAGNOSTIC_SEVERITY_RANK[rule.severity] >= DIAGNOSTIC_SEVERITY_RANK[selector.minimum_severity] ? "block" : "report";
    const value = { ...item, name_ru: rule.name_ru, type: rule.type, diagnostic_severity: rule.severity, disposition };
    (disposition === "block" ? blocking : advisory).push(value);
  }
  const count = values => values.reduce((sum, item) => sum + Number(item.count), 0);
  return { blocking, advisory, unknown, blocking_count: count(blocking), advisory_count: count(advisory), unknown_count: count(unknown) };
}

function validateExecutable(executable) {
  const resolved = path.resolve(executable);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`ONE_C_BSL_EXECUTABLE_NOT_FOUND: ${resolved}`);
  return resolved;
}

function validatePlatformBin(platformBin) {
  const resolved = path.resolve(platformBin);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`ONE_C_PLATFORM_BIN_NOT_FOUND: ${resolved}`);
  if (!fs.readdirSync(resolved).some(name => /^shcntx_.*\.hbk$/i.test(name))) throw new Error(`ONE_C_PLATFORM_CONTEXT_NOT_FOUND: ${resolved}`);
  return resolved;
}

function verifyAcceptedSource(source, acceptedRevision) {
  const resolvedSource = path.resolve(source);
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: resolvedSource, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  if (revision.error || revision.status !== 0) throw new Error(`ONE_C_BSL_BASELINE_GIT_FAILED: ${revision.error?.message ?? revision.stderr ?? revision.stdout}`);
  const actualRevision = String(revision.stdout).trim();
  if (actualRevision.toLowerCase() !== acceptedRevision.toLowerCase()) throw new Error(`ONE_C_BSL_BASELINE_REVISION_MISMATCH: ${acceptedRevision} != ${actualRevision}`);
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: resolvedSource, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (status.error || status.status !== 0) throw new Error(`ONE_C_BSL_BASELINE_GIT_STATUS_FAILED: ${status.error?.message ?? status.stderr ?? status.stdout}`);
  if (String(status.stdout).trim()) throw new Error("ONE_C_BSL_BASELINE_SOURCE_DIRTY");
  return actualRevision;
}

function toolVersion(executable) {
  const result = spawnSync(executable, ["version"], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`ONE_C_BSL_VERSION_FAILED: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  const match = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/version:\s*([^\s]+)/i);
  if (!match) throw new Error("ONE_C_BSL_VERSION_UNKNOWN");
  return match[1];
}

function safeTemporaryRoot(root) {
  const resolved = path.resolve(root ?? path.join(os.tmpdir(), "one-man-company-bsl"));
  fs.mkdirSync(resolved, { recursive: true });
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`ONE_C_BSL_TEMP_ROOT_INVALID: ${resolved}`);
  return resolved;
}

function runAnalyzer({ executable, source, workspace, platformBin, tempRoot, timeoutSeconds = 1500 }) {
  const resolvedExecutable = validateExecutable(executable);
  const resolvedSource = path.resolve(source);
  const resolvedWorkspace = path.resolve(workspace ?? source);
  const resolvedPlatformBin = validatePlatformBin(platformBin);
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) throw new Error(`ONE_C_BSL_SOURCE_NOT_FOUND: ${resolvedSource}`);
  if (!fs.existsSync(resolvedWorkspace) || !fs.statSync(resolvedWorkspace).isDirectory()) throw new Error(`ONE_C_BSL_WORKSPACE_NOT_FOUND: ${resolvedWorkspace}`);
  const root = safeTemporaryRoot(tempRoot);
  const temporary = fs.mkdtempSync(path.join(root, "run-"));
  const prefix = `${root}${path.sep}`;
  if (!temporary.startsWith(prefix)) throw new Error(`ONE_C_BSL_UNSAFE_TEMP_PATH: ${temporary}`);
  const output = path.join(temporary, "report"), configuration = path.join(temporary, ".bsl-language-server.json");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(configuration, `${JSON.stringify({ language: "ru", v8platform: { binPath: resolvedPlatformBin } }, null, 2)}\n`, "utf8");
  try {
    const args = ["analyze", "--srcDir", resolvedSource, "--workspaceDir", resolvedWorkspace, "--outputDir", output, "--reporter", "json", "--silent", "--configuration", configuration];
    const result = spawnSync(resolvedExecutable, args, { cwd: resolvedWorkspace, encoding: "utf8", windowsHide: true, timeout: Number(timeoutSeconds) * 1000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error?.code === "ETIMEDOUT") throw new Error(`ONE_C_BSL_ANALYSIS_TIMED_OUT: ${timeoutSeconds}s`);
    if (result.error || result.status !== 0) throw new Error(`ONE_C_BSL_ANALYSIS_FAILED: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    const reportFile = path.join(output, "bsl-json.json");
    if (!fs.existsSync(reportFile)) throw new Error("ONE_C_BSL_JSON_REPORT_NOT_CREATED");
    return { report: JSON.parse(fs.readFileSync(reportFile, "utf8")), version: toolVersion(resolvedExecutable) };
  } finally {
    if (!temporary.startsWith(prefix)) throw new Error(`ONE_C_BSL_UNSAFE_TEMP_CLEANUP: ${temporary}`);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function loadBaseline(db, projectId, checkId) {
  const row = db.prepare("SELECT * FROM check_baselines WHERE project_id=? AND check_id=? AND status='active'").get(projectId, checkId);
  if (!row) throw new Error(`ONE_C_BSL_BASELINE_NOT_FOUND: ${projectId}:${checkId}`);
  const diagnostics = db.prepare("SELECT path,severity,diagnostic_code AS code,message_hash,occurrence_count AS count FROM check_baseline_diagnostics WHERE baseline_id=? ORDER BY path,severity,diagnostic_code,message_hash").all(row.id);
  return {
    id: row.id,
    tool: { name: row.tool_name, version: row.tool_version },
    accepted_revision: row.accepted_revision,
    confirmed_by: row.confirmed_by,
    snapshot: {
      minimum_severity: row.minimum_severity,
      summary: { Error: row.error_count, Warning: row.warning_count, Information: row.information_count, Hint: row.hint_count, considered: row.considered_count, files: row.file_count },
      diagnostics
    }
  };
}

function storeBaseline(db, projectId, checkId, value) {
  db.prepare("UPDATE check_baselines SET status='superseded' WHERE project_id=? AND check_id=? AND status='active'").run(projectId, checkId);
  const baselineId = id("check_baseline"), summary = value.snapshot.summary;
  db.prepare(`INSERT INTO check_baselines(id,project_id,check_id,kind,tool_name,tool_version,accepted_revision,confirmed_by,minimum_severity,error_count,warning_count,information_count,hint_count,considered_count,file_count,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(baselineId, projectId, checkId, "one-c-bsl-diagnostics", value.tool.name, value.tool.version, value.accepted_revision, value.confirmed_by, value.snapshot.minimum_severity, summary.Error, summary.Warning, summary.Information, summary.Hint, summary.considered, summary.files, "active", now());
  const insert = db.prepare("INSERT INTO check_baseline_diagnostics(baseline_id,path,severity,diagnostic_code,message_hash,occurrence_count) VALUES(?,?,?,?,?,?)");
  for (const item of value.snapshot.diagnostics) insert.run(baselineId, item.path, item.severity, item.code, item.message_hash, item.count);
  return baselineId;
}

export function createOneCBslBaseline(options) {
  const dbFile = path.resolve(requiredString(options.dbFile, "db"));
  const projectId = requiredString(options.projectId, "project");
  const acceptedRevision = requiredString(options.acceptedRevision, "accepted-revision");
  const confirmedBy = requiredString(options.confirmedBy, "confirmed-by");
  const minimumSeverity = options.minimumSeverity ?? DEFAULT_MINIMUM_SEVERITY;
  if (!["Warning", "Error"].includes(minimumSeverity)) throw new Error(`ONE_C_BSL_BASELINE_SEVERITY_UNSUPPORTED: ${minimumSeverity}`);
  verifyAcceptedSource(requiredString(options.source, "source"), acceptedRevision);
  const analysis = runAnalyzer(options);
  const baseline = {
    confirmed_by: confirmedBy,
    accepted_revision: acceptedRevision,
    tool: { name: "BSL Language Server", version: analysis.version },
    snapshot: buildDiagnosticSnapshot(analysis.report, { minimumSeverity })
  };
  const db = openDb(dbFile);
  db.exec("BEGIN");
  try {
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error(`ONE_C_PROJECT_NOT_FOUND: ${projectId}`);
    const checkId = mappedCheckId(db, projectId);
    if (!checkId) throw new Error(`ONE_C_BSL_CHECK_NOT_REGISTERED: ${projectId}`);
    importCatalog(db, readCatalog(options.catalogFile, analysis.version));
    replaceProjectPolicies(db, projectId, checkId);
    const baselineId = storeBaseline(db, projectId, checkId, baseline);
    db.exec("COMMIT");
    return { status: "created", baseline_id: baselineId, project_id: projectId, check_id: checkId, accepted_revision: acceptedRevision, tool_version: analysis.version, summary: baseline.snapshot.summary, diagnostic_signatures: baseline.snapshot.diagnostics.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function runOneCBslCheck(options) {
  const dbFile = path.resolve(requiredString(options.dbFile, "db"));
  const projectId = requiredString(options.projectId, "project");
  const db = openDb(dbFile);
  let baseline, policy;
  try {
    const checkId = mappedCheckId(db, projectId);
    if (!checkId) throw new Error(`ONE_C_BSL_CHECK_NOT_REGISTERED: ${projectId}`);
    baseline = loadBaseline(db, projectId, checkId);
    policy = loadDiagnosticPolicy(db, projectId, checkId, options.qualityLevel ?? "mvp", baseline.tool);
  } finally {
    db.close();
  }
  const analysis = runAnalyzer(options);
  if (analysis.version !== baseline.tool.version) throw new Error(`ONE_C_BSL_TOOL_VERSION_MISMATCH: ${baseline.tool.version} != ${analysis.version}`);
  const current = buildDiagnosticSnapshot(analysis.report, { minimumSeverity: baseline.snapshot.minimum_severity });
  const comparison = compareDiagnosticSnapshots(current, baseline.snapshot);
  const evaluation = classifyDiagnosticChanges(comparison.added, policy);
  return {
    status: evaluation.blocking_count ? "failed" : "passed",
    quality_mode: policy.quality_mode,
    tool_version: analysis.version,
    accepted_revision: baseline.accepted_revision,
    current: current.summary,
    baseline: baseline.snapshot.summary,
    added_count: comparison.added_count,
    removed_count: comparison.removed_count,
    blocking_added_count: evaluation.blocking_count,
    advisory_added_count: evaluation.advisory_count,
    unknown_added_count: evaluation.unknown_count,
    blocking_added: evaluation.blocking.slice(0, 20),
    advisory_added: evaluation.advisory.slice(0, 20),
    removed: comparison.removed.slice(0, 20)
  };
}

function mappedCheckId(db, projectId) {
  return db.prepare(`SELECT m.local_id FROM package_import_mappings m
    JOIN workflow_import_proposals p ON p.id=m.proposal_id
    WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type='check' AND m.semantic_key=?
    ORDER BY p.applied_at DESC LIMIT 1`).get(projectId, CHECK_SEMANTIC_KEY)?.local_id
    ?? db.prepare("SELECT id FROM check_definitions WHERE id=?").get(CHECK_SEMANTIC_KEY)?.id
    ?? null;
}

export function configureOneCBslCheck(dbFile, options) {
  const projectId = requiredString(options.projectId, "project");
  const executable = validateExecutable(requiredString(options.executable, "executable"));
  const platformBin = validatePlatformBin(requiredString(options.platformBin, "platform-bin"));
  const runner = path.resolve(requiredString(options.runner, "runner"));
  const tempRoot = safeTemporaryRoot(requiredString(options.tempRoot, "temp-root"));
  if (!fs.existsSync(runner) || !fs.statSync(runner).isFile()) throw new Error(`ONE_C_BSL_RUNNER_NOT_FOUND: ${runner}`);
  const db = openDb(dbFile);
  db.exec("BEGIN");
  try {
    const project = db.prepare("SELECT root_path FROM projects WHERE id=?").get(projectId);
    if (!project) throw new Error(`ONE_C_PROJECT_NOT_FOUND: ${projectId}`);
    const checkId = mappedCheckId(db, projectId);
    if (!checkId) throw new Error(`ONE_C_BSL_CHECK_NOT_REGISTERED: ${projectId}`);
    const baseline = loadBaseline(db, projectId, checkId);
    importCatalog(db, readCatalog(options.catalogFile, baseline.tool.version));
    replaceProjectPolicies(db, projectId, checkId);
    const config = {
      command: process.execPath,
      args: [runner, "check", "--db", path.resolve(dbFile), "--project", projectId, "--quality-level", "{{quality_level}}", "--executable", executable, "--source", ".", "--workspace", ".", "--platform-bin", platformBin, "--temp-root", tempRoot, "--timeout-seconds", "1500"]
    };
    db.prepare("UPDATE check_definitions SET name=?,runner=?,kind='command',config_json=?,timeout_seconds=? WHERE id=?")
      .run("BSL: new critical findings; all other diagnostics are report-only", "one_c_bsl_policy", JSON.stringify(config), 1800, checkId);
    db.exec("COMMIT");
    return { status: "configured", project_id: projectId, project_root: project.root_path, check_id: checkId, runner, executable, platform_bin: platformBin, baseline_id: baseline.id, accepted_revision: baseline.accepted_revision };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

async function main() {
  const command = process.argv[2], args = parseArgs(process.argv.slice(3));
  if (command === "baseline") {
    const result = createOneCBslBaseline({
      executable: args.executable, source: args.source, workspace: args.workspace, platformBin: args["platform-bin"], tempRoot: args["temp-root"],
      timeoutSeconds: args["timeout-seconds"], dbFile: args.db, projectId: args.project, acceptedRevision: args["accepted-revision"], confirmedBy: args["confirmed-by"], minimumSeverity: args["minimum-severity"], catalogFile: args.catalog
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "check") {
    const result = runOneCBslCheck({ executable: args.executable, source: args.source, workspace: args.workspace, platformBin: args["platform-bin"], tempRoot: args["temp-root"], timeoutSeconds: args["timeout-seconds"], dbFile: args.db, projectId: args.project, qualityLevel: args["quality-level"] ?? "mvp" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "passed" ? 0 : 1;
    return;
  }
  throw new Error("Usage: node src/one-c-bsl-check.mjs baseline|check [options]");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ status: "failed", error: error.message })}\n`);
  process.exitCode = 1;
});
