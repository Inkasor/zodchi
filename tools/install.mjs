import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { hookInstallationStatus, hookSnapshotHashes, removeOwnedHookInstallation, restoreHookInstallation, snapshotHookInstallation } from "../WorkflowPlatform/src/hook-installation.mjs";
import { defaultInstallationPaths } from "./installation-paths.mjs";
import { defaultSkillRoots, installClientSkills, removeClientSkills, restoreClientSkills, snapshotClientSkills } from "./skill-installation.mjs";

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

function restoreHookTransaction(transaction) {
  if (!transaction) return;
  for (let index = transaction.snapshots.length - 1; index >= 0; index -= 1) restoreHookInstallation(transaction.snapshots[index], transaction.current[index]);
}

function readState(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }

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
  const workflowDatabase = options.workflowDatabase ?? process.env.WORKFLOW_DB ?? path.join(dataRoot, "workflow.sqlite");
  const targets = registeredHookTargets(workflowDatabase, options.hooks ?? []);
  const skillRoots = options.skillRoots ?? defaultSkillRoots();
  let oldMoved = false, hookTransaction = null, skillTransaction = null;
  try {
    fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
    healthCheck(stage);
    if (previous) { fs.renameSync(destination, previous); oldMoved = true; }
    fs.renameSync(stage, destination);
    hookTransaction = removeLegacyHooks(targets);
    skillTransaction = updateClientSkills(destination, skillRoots);
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
      hooks: [],
      legacy_hooks_removed: targets,
      skills: skillTransaction.applied,
      updated_at: new Date().toISOString()
    };
    atomicJson(stateFile, state);
    return Object.freeze({ ...state, state_file: stateFile, hook_results: hookTransaction.applied, skill_results: skillTransaction.applied });
  } catch (error) {
    try { restoreSkillTransaction(skillTransaction); } catch (rollbackError) { error.skillRollbackError = rollbackError; }
    try { restoreHookTransaction(hookTransaction); } catch (rollbackError) { error.hookRollbackError = rollbackError; }
    if (fs.existsSync(destination) && oldMoved) fs.rmSync(destination, { recursive: true, force: true });
    else if (fs.existsSync(destination) && !oldMoved) fs.rmSync(destination, { recursive: true, force: true });
    if (oldMoved && previous && fs.existsSync(previous) && !fs.existsSync(destination)) fs.renameSync(previous, destination);
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
  const failed = safeSibling(`${destination}.previous-${crypto.randomUUID()}`, destination, "previous");
  const targets = registeredHookTargets(state.workflow_database, [...(state.hooks ?? []), ...(state.legacy_hooks_removed ?? [])]);
  let hookTransaction = null, skillTransaction = null, movedCurrent = false, movedPrevious = false;
  try {
    healthCheck(previous);
    fs.renameSync(destination, failed); movedCurrent = true;
    fs.renameSync(previous, destination); movedPrevious = true;
    hookTransaction = removeLegacyHooks(targets);
    skillTransaction = updateClientSkills(destination, skillRoots);
    healthCheck(destination);
    const next = { ...state, version: releaseVersion(destination), previous_release: failed, previous_version: releaseVersion(failed), rolled_back_at: new Date().toISOString() };
    atomicJson(stateFile, next);
    return Object.freeze({ status: "rolled_back", application: destination, version: next.version, previous_release: failed, hook_results: hookTransaction.applied, skill_results: skillTransaction.applied });
  } catch (error) {
    try { restoreSkillTransaction(skillTransaction); } catch (rollbackError) { error.skillRollbackError = rollbackError; }
    try { restoreHookTransaction(hookTransaction); } catch (rollbackError) { error.hookRollbackError = rollbackError; }
    if (movedPrevious && fs.existsSync(destination)) fs.renameSync(destination, previous);
    if (movedCurrent && fs.existsSync(failed)) fs.renameSync(failed, destination);
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
  let recoverable = null;
  if (fs.existsSync(destination)) { recoverable = safeSibling(`${destination}.uninstalled-${crypto.randomUUID()}`, destination, "uninstalled"); fs.renameSync(destination, recoverable); }
  const next = { ...(state ?? {}), status: "uninstalled", application: destination, data_root: dataRoot, recoverable_release: recoverable, uninstalled_at: new Date().toISOString() };
  atomicJson(stateFile, next);
  return Object.freeze({ ...next, state_file: stateFile, hooks: hookResults, skills: skillResults, user_data_preserved: true });
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

function main() {
  const cli = argsObject(process.argv.slice(2));
  const command = cli._[0];
  const defaults = defaultInstallationPaths();
  const common = { destination: path.resolve(String(cli.destination ?? defaults.application)), dataRoot: path.resolve(String(cli["data-root"] ?? defaults.data)), workflowDatabase: cli["workflow-db"] ? path.resolve(String(cli["workflow-db"])) : undefined, hooks: manifestHooks(cli["hook-manifest"]), skillRoots: manifestSkillRoots(cli["skill-roots"]) };
  let result;
  if (command === "install" || command === "update") result = installRelease({ ...common, source: path.resolve(String(cli.source ?? "")) });
  else if (command === "rollback") result = rollbackRelease(common);
  else if (command === "uninstall") result = uninstallRelease(common);
  else throw new Error("Usage: node tools/install.mjs install|update --source <extracted-release> [--destination <dir>] [--data-root <dir>] [--workflow-db <file>] [--hook-manifest <legacy-removal-json>] [--skill-roots <json>] | rollback | uninstall");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; }
}
