import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { hookInstallationStatus, hookSnapshotHashes, removeOwnedHookInstallation, restoreHookInstallation, snapshotHookInstallation } from "../WorkflowPlatform/src/hook-installation.mjs";
import { defaultInstallationPaths } from "./installation-paths.mjs";
import { defaultSkillRoots, installClientSkills, removeClientSkills, restoreClientSkills, snapshotClientSkills } from "./skill-installation.mjs";
import { defaultSessionHookFiles, installSessionHooks, removeSessionHooks, restoreSessionHooks, snapshotSessionHooks } from "./session-hook-installation.mjs";

const renameDelay = new Int32Array(new SharedArrayBuffer(4));

function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code) || attempt >= 9) throw error;
      Atomics.wait(renameDelay, 0, 0, 20 * (attempt + 1));
    }
  }
}

function argsObject(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { result._.push(token); continue; }
    const key = token.slice(2);
    result[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); fs.renameSync(temporary, file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

export function ensureDirectory(directory, label = "DIRECTORY") {
  const resolved = path.resolve(directory);
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label}_NOT_DIRECTORY: ${resolved}`);
    return resolved;
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function specificDirectory(value, label) {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(`${label}_MUST_BE_SPECIFIC_DIRECTORY: ${resolved}`);
  return resolved;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeSibling(candidate, destination, marker) {
  const parent = path.dirname(destination);
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(`${path.basename(destination)}.${marker}-`)) throw new Error(`INSTALL_WORK_PATH_UNSAFE: ${resolved}`);
  return resolved;
}

function releaseVersion(root) {
  const file = path.join(root, "product.json");
  if (!fs.existsSync(file)) throw new Error(`INSTALL_PRODUCT_MISSING: ${file}`);
  const product = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(product.version ?? "")) throw new Error(`INSTALL_PRODUCT_VERSION_INVALID: ${product.version}`);
  return product.version;
}

function defaultHealthCheck(root) {
  const lint = path.join(root, "tools", "release-lint.mjs");
  if (!fs.existsSync(lint)) throw new Error(`INSTALL_RELEASE_LINTER_MISSING: ${lint}`);
  execFileSync(process.execPath, [lint, root], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
}

function registeredHookTargets(databaseFile, explicit = []) {
  const unique = new Map();
  for (const item of explicit) {
    const projectRoot = path.resolve(item.projectRoot);
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new Error(`INSTALL_HOOK_PROJECT_MISSING: ${projectRoot}`);
    unique.set(`${projectRoot}\u0000${item.harness}`, { projectRoot, harness: item.harness });
  }
  if (databaseFile && fs.existsSync(databaseFile)) {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const hasProjects = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get();
      if (!hasProjects) return [...unique.values()];
      for (const row of db.prepare("SELECT root_path FROM projects ORDER BY id").all()) {
        for (const harness of ["codex", "claude-code"]) {
          const item = { projectRoot: path.resolve(String(row.root_path)), harness };
          if (fs.existsSync(item.projectRoot) && hookInstallationStatus(item).owned) unique.set(`${item.projectRoot}\u0000${harness}`, item);
        }
      }
    } finally { db.close(); }
  }
  return [...unique.values()];
}

function removeLegacyHooks(targets) {
  const snapshots = targets.map(snapshotHookInstallation);
  const applied = [];
  try {
    for (const item of targets) applied.push(removeOwnedHookInstallation(item));
    return { snapshots, applied, current: snapshots.map(hookSnapshotHashes) };
  } catch (error) {
    for (let index = snapshots.length - 1; index >= 0; index -= 1) restoreHookInstallation(snapshots[index]);
    throw error;
  }
}

function updateClientSkills(applicationRoot, roots) {
  const snapshots = snapshotClientSkills({ roots });
  try {
    const applied = fs.existsSync(path.join(applicationRoot, "integrations"))
      ? installClientSkills({ applicationRoot, roots })
      : removeClientSkills({ applicationRoot, roots });
    return { snapshots, applied };
  } catch (error) {
    restoreClientSkills(snapshots);
    throw error;
  }
}

function restoreSkillTransaction(transaction) {
  if (transaction) restoreClientSkills(transaction.snapshots);
}

function updateSessionHooks(applicationRoot, files, skillRoots) {
  const snapshots = snapshotSessionHooks({ files });
  try { return { snapshots, applied: installSessionHooks({ applicationRoot, files, skillRoots }) }; }
  catch (error) { restoreSessionHooks(snapshots); throw error; }
}

function restoreSessionHookTransaction(transaction) { if (transaction) restoreSessionHooks(transaction.snapshots); }

function stateSessionHookFiles(state) {
  const files = {};
  for (const item of state?.session_hooks ?? []) {
    if (!new Set(["codex", "claude-code", "cursor"]).has(item?.client) || typeof item?.file !== "string" || !item.file.trim()) continue;
    files[item.client] = path.resolve(item.file);
  }
  return Object.keys(files).length ? files : null;
}

function resolvedSessionHookFiles(options, skillRoots, state = null) {
  if (options.sessionHookFiles) return options.sessionHookFiles;
  const persisted = stateSessionHookFiles(state);
  if (persisted) return persisted;
  if (options.skillRoots) return Object.fromEntries(Object.entries(skillRoots).map(([client, root]) => [client, path.join(path.dirname(path.resolve(root)), `${client}-session-hooks.json`)]));
  return defaultSessionHookFiles();
}

function restoreHookTransaction(transaction) {
  if (!transaction) return;
  for (let index = transaction.snapshots.length - 1; index >= 0; index -= 1) restoreHookInstallation(transaction.snapshots[index], transaction.current[index]);
}

function readState(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }

function tableExists(db, name) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }

export function profileWriteRequirementDiagnostics({ workflowDatabase, gatewayPolicy, gateway }) {
  if (!workflowDatabase || !fs.existsSync(workflowDatabase)) return { status: "unavailable", reason: "workflow_database_missing", conflicts: [] };
  if (!gatewayPolicy || !fs.existsSync(gatewayPolicy)) return { status: "unavailable", reason: "gateway_policy_missing", conflicts: [] };
  if (!gateway || !fs.existsSync(gateway)) return { status: "unavailable", reason: "gateway_preflight_missing", conflicts: [] };
  const db = new DatabaseSync(workflowDatabase, { readOnly: true });
  try {
    const requiredTables = ["profiles", "role_profile_assignments", "role_contracts"];
    if (!requiredTables.every(name => tableExists(db, name))) return { status: "unavailable", reason: "workflow_schema_not_ready", conflicts: [] };
    const assignments = db.prepare(`SELECT a.project_id,a.role_id,a.operational_level,p.provider,p.name AS profile,rc.boundaries_json
      FROM role_profile_assignments a
      JOIN profiles p ON p.id=a.profile_id
      JOIN role_contracts rc ON rc.project_id=a.project_id AND rc.role_id=a.role_id AND rc.status='active'
      WHERE a.enabled=1
      ORDER BY a.project_id,a.role_id,a.operational_level,p.provider,p.name`).all();
    const requirements = assignments.map(assignment => {
      let boundaries = {};
      try { boundaries = JSON.parse(assignment.boundaries_json ?? "{}"); } catch { /* runtime treats an absent declaration as non-writing */ }
      return {
        project_id: assignment.project_id,
        role: assignment.role_id,
        operational_level: assignment.operational_level,
        provider: assignment.provider,
        profile: assignment.profile,
        requires_write: boundaries.writes === true
      };
    });
    const child = spawnSync(process.execPath, [gateway, "profiles-check"], {
      input: JSON.stringify(requirements), encoding: "utf8", windowsHide: true,
      env: { ...process.env, AGENT_GATEWAY_POLICY: gatewayPolicy }
    });
    let result = null;
    try { result = JSON.parse(String(child.stdout ?? "").trim()); } catch { /* reported below */ }
    if (!result || !["compatible", "incompatible"].includes(result.status)) {
      return { status: "unavailable", reason: "gateway_preflight_failed", conflicts: [], message: String(child.stderr || child.stdout || child.error?.message || "unknown failure").trim() };
    }
    const normalize = item => {
      const { role, ...rest } = item;
      return { ...rest, role_id: role };
    };
    return { status: "checked", reason: null, conflicts: result.conflicts.map(normalize), checks: result.checks.map(normalize) };
  } finally { db.close(); }
}

export function installRelease(options) {
  const source = specificDirectory(options.source, "SOURCE");
  const destination = specificDirectory(options.destination, "DESTINATION");
  const dataRoot = specificDirectory(options.dataRoot, "DATA_ROOT");
  const stateFile = path.join(dataRoot, "installation-state.json");
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`INSTALL_SOURCE_MISSING: ${source}`);
  if (fs.existsSync(path.join(source, ".git"))) throw new Error("INSTALL_SOURCE_IS_WORKTREE: use an extracted release");
  if (inside(source, destination) || inside(destination, source)) throw new Error("INSTALL_SOURCE_DESTINATION_OVERLAP");
  const version = releaseVersion(source);
  const healthCheck = options.healthCheck ?? defaultHealthCheck;
  healthCheck(source);
  ensureDirectory(path.dirname(destination), "DESTINATION_PARENT");
  ensureDirectory(dataRoot, "DATA_ROOT");
  const stage = safeSibling(`${destination}.stage-${crypto.randomUUID()}`, destination, "stage");
  const previous = fs.existsSync(destination) ? safeSibling(`${destination}.previous-${crypto.randomUUID()}`, destination, "previous") : null;
  const installedState = readState(stateFile);
  const workflowDatabase = options.workflowDatabase ?? installedState?.workflow_database ?? process.env.WORKFLOW_DB ?? path.join(dataRoot, "workflow.sqlite");
  const gatewayPolicy = options.gatewayPolicy ?? installedState?.gateway_policy ?? path.join(dataRoot, "gateway", "policy.local.json");
  const profileWriteRequirements = profileWriteRequirementDiagnostics({ workflowDatabase, gatewayPolicy, gateway: path.join(source, "AgentGateway", "src", "cli.mjs") });
  const targets = registeredHookTargets(workflowDatabase, options.hooks ?? []);
  const skillRoots = options.skillRoots ?? defaultSkillRoots();
  const sessionHookFiles = resolvedSessionHookFiles(options, skillRoots, installedState);
  let oldMoved = false, hookTransaction = null, skillTransaction = null, sessionHookTransaction = null;
  try {
    fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
    healthCheck(stage);
    if (previous) { renameWithRetry(destination, previous); oldMoved = true; }
    renameWithRetry(stage, destination);
    hookTransaction = removeLegacyHooks(targets);
    skillTransaction = updateClientSkills(destination, skillRoots);
    sessionHookTransaction = updateSessionHooks(destination, sessionHookFiles, skillRoots);
    healthCheck(destination);
    const state = {
      schema_version: 1,
      status: "installed",
      application: destination,
      data_root: dataRoot,
      version,
      previous_release: previous,
      previous_version: previous ? releaseVersion(previous) : null,
      workflow_database: workflowDatabase,
      gateway_policy: gatewayPolicy,
      profile_write_requirement_diagnostics: profileWriteRequirements,
      hooks: [],
      legacy_hooks_removed: targets,
      skills: skillTransaction.applied,
      session_hooks: sessionHookTransaction.applied,
      updated_at: new Date().toISOString()
    };
    atomicJson(stateFile, state);
    return Object.freeze({ ...state, state_file: stateFile, hook_results: hookTransaction.applied, skill_results: skillTransaction.applied, session_hook_results: sessionHookTransaction.applied });
  } catch (error) {
    try { restoreSessionHookTransaction(sessionHookTransaction); } catch (rollbackError) { error.sessionHookRollbackError = rollbackError; }
    try { restoreSkillTransaction(skillTransaction); } catch (rollbackError) { error.skillRollbackError = rollbackError; }
    try { restoreHookTransaction(hookTransaction); } catch (rollbackError) { error.hookRollbackError = rollbackError; }
    if (fs.existsSync(destination) && oldMoved) fs.rmSync(destination, { recursive: true, force: true });
    else if (fs.existsSync(destination) && !oldMoved) fs.rmSync(destination, { recursive: true, force: true });
    if (oldMoved && previous && fs.existsSync(previous) && !fs.existsSync(destination)) renameWithRetry(previous, destination);
    throw error;
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
}

export function rollbackRelease(options) {
  const dataRoot = specificDirectory(options.dataRoot, "DATA_ROOT");
  const stateFile = path.join(dataRoot, "installation-state.json");
  const state = readState(stateFile);
  if (!state?.previous_release) throw new Error("INSTALL_ROLLBACK_UNAVAILABLE");
  const destination = specificDirectory(options.destination ?? state.application, "DESTINATION");
  const previous = safeSibling(state.previous_release, destination, "previous");
  if (!fs.existsSync(destination) || !fs.existsSync(previous)) throw new Error("INSTALL_ROLLBACK_RELEASE_MISSING");
  const healthCheck = options.healthCheck ?? defaultHealthCheck;
  const skillRoots = options.skillRoots ?? defaultSkillRoots();
  const sessionHookFiles = resolvedSessionHookFiles(options, skillRoots, state);
  const failed = safeSibling(`${destination}.previous-${crypto.randomUUID()}`, destination, "previous");
  const targets = registeredHookTargets(state.workflow_database, [...(state.hooks ?? []), ...(state.legacy_hooks_removed ?? [])]);
  let hookTransaction = null, skillTransaction = null, sessionHookTransaction = null, movedCurrent = false, movedPrevious = false;
  try {
    healthCheck(previous);
    renameWithRetry(destination, failed); movedCurrent = true;
    renameWithRetry(previous, destination); movedPrevious = true;
    hookTransaction = removeLegacyHooks(targets);
    skillTransaction = updateClientSkills(destination, skillRoots);
    sessionHookTransaction = updateSessionHooks(destination, sessionHookFiles, skillRoots);
    healthCheck(destination);
    const next = { ...state, version: releaseVersion(destination), previous_release: failed, previous_version: releaseVersion(failed), rolled_back_at: new Date().toISOString() };
    atomicJson(stateFile, next);
    return Object.freeze({ status: "rolled_back", application: destination, version: next.version, previous_release: failed, hook_results: hookTransaction.applied, skill_results: skillTransaction.applied, session_hook_results: sessionHookTransaction.applied });
  } catch (error) {
    try { restoreSessionHookTransaction(sessionHookTransaction); } catch (rollbackError) { error.sessionHookRollbackError = rollbackError; }
    try { restoreSkillTransaction(skillTransaction); } catch (rollbackError) { error.skillRollbackError = rollbackError; }
    try { restoreHookTransaction(hookTransaction); } catch (rollbackError) { error.hookRollbackError = rollbackError; }
    if (movedPrevious && fs.existsSync(destination)) renameWithRetry(destination, previous);
    if (movedCurrent && fs.existsSync(failed)) renameWithRetry(failed, destination);
    throw error;
  }
}

export function uninstallRelease(options) {
  const dataRoot = specificDirectory(options.dataRoot, "DATA_ROOT");
  const stateFile = path.join(dataRoot, "installation-state.json");
  const state = readState(stateFile);
  const destination = specificDirectory(options.destination ?? state?.application, "DESTINATION");
  const targets = registeredHookTargets(state?.workflow_database, [...(state?.hooks ?? []), ...(state?.legacy_hooks_removed ?? []), ...(options.hooks ?? [])]);
  const hookResults = targets.map(removeOwnedHookInstallation);
  const skillResults = removeClientSkills({ applicationRoot: destination, roots: options.skillRoots ?? defaultSkillRoots() });
  const sessionHookResults = removeSessionHooks({ applicationRoot: destination, files: resolvedSessionHookFiles(options, options.skillRoots ?? defaultSkillRoots(), state) });
  let recoverable = null;
  if (fs.existsSync(destination)) { recoverable = safeSibling(`${destination}.uninstalled-${crypto.randomUUID()}`, destination, "uninstalled"); renameWithRetry(destination, recoverable); }
  const next = { ...(state ?? {}), status: "uninstalled", application: destination, data_root: dataRoot, recoverable_release: recoverable, uninstalled_at: new Date().toISOString() };
  atomicJson(stateFile, next);
  return Object.freeze({ ...next, state_file: stateFile, hooks: hookResults, skills: skillResults, session_hooks: sessionHookResults, user_data_preserved: true });
}

function manifestHooks(file) {
  if (!file) return [];
  const value = JSON.parse(fs.readFileSync(path.resolve(String(file)), "utf8"));
  if (!Array.isArray(value)) throw new Error("INSTALL_HOOK_MANIFEST_INVALID");
  return value;
}

// A release smoke or acceptance run installs into a throwaway directory. Without this the run would
// repoint the operator's real explicit commands at that directory and leave them dangling once it is
// deleted, so an isolated installation must be able to name its own skill roots.
function manifestSkillRoots(file) {
  if (!file) return undefined;
  const value = JSON.parse(fs.readFileSync(path.resolve(String(file)), "utf8"));
  const roots = {};
  for (const client of Object.keys(defaultSkillRoots())) {
    if (typeof value?.[client] !== "string" || !value[client].trim()) throw new Error(`INSTALL_SKILL_ROOTS_INVALID: ${client}`);
    roots[client] = path.resolve(value[client]);
  }
  return roots;
}

function manifestSessionHookFiles(file) {
  if (!file) return undefined;
  const value = JSON.parse(fs.readFileSync(path.resolve(String(file)), "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("INSTALL_SESSION_HOOK_FILES_INVALID: expected object");
  const files = {};
  for (const [client, target] of Object.entries(value)) {
    if (!new Set(["codex", "claude-code", "cursor"]).has(client) || typeof target !== "string" || !target.trim()) throw new Error(`INSTALL_SESSION_HOOK_FILES_INVALID: ${client}`);
    files[client] = path.resolve(target);
  }
  if (!Object.keys(files).length) throw new Error("INSTALL_SESSION_HOOK_FILES_INVALID: at least one selected host is required");
  return files;
}

function main() {
  const cli = argsObject(process.argv.slice(2));
  const command = cli._[0];
  const defaults = defaultInstallationPaths();
  const common = { destination: path.resolve(String(cli.destination ?? defaults.application)), dataRoot: path.resolve(String(cli["data-root"] ?? defaults.data)), workflowDatabase: cli["workflow-db"] ? path.resolve(String(cli["workflow-db"])) : undefined, gatewayPolicy: cli["gateway-policy"] ? path.resolve(String(cli["gateway-policy"])) : undefined, hooks: manifestHooks(cli["hook-manifest"]), skillRoots: manifestSkillRoots(cli["skill-roots"]), sessionHookFiles: manifestSessionHookFiles(cli["session-hook-files"]) };
  let result;
  if (command === "install" || command === "update") result = installRelease({ ...common, source: path.resolve(String(cli.source ?? "")) });
  else if (command === "rollback") result = rollbackRelease(common);
  else if (command === "uninstall") result = uninstallRelease(common);
  else throw new Error("Usage: node tools/install.mjs install|update --source <extracted-release> [--destination <dir>] [--data-root <dir>] [--workflow-db <file>] [--gateway-policy <file>] [--hook-manifest <legacy-removal-json>] [--skill-roots <json>] [--session-hook-files <json>] | rollback | uninstall");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; }
}
