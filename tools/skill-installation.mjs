import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OWNER = "zodchi";
const PLACEHOLDER = "__ZODCHI_ROOT__";
const NAMES = Object.freeze(["zodchi", "zod"]);

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const markerFile = directory => path.join(directory, ".zodchi-skill.json");

export function defaultSkillRoots(home = os.homedir()) {
  const resolved = path.resolve(home);
  return Object.freeze({
    "claude-code": path.join(resolved, ".claude", "skills"),
    codex: path.join(resolved, ".agents", "skills")
  });
}
function targets(roots) {
  return Object.entries(roots).flatMap(([client, root]) => NAMES.map(name => ({ client, name, root: path.resolve(root), directory: path.join(path.resolve(root), name) })));
}

function readJson(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function managedHashes(directory) {
  return Object.fromEntries(walk(directory).filter(file => path.resolve(file) !== path.resolve(markerFile(directory))).map(file => [path.relative(directory, file).replaceAll("\\", "/"), sha256(fs.readFileSync(file))]));
}

function validateOwned(target) {
  if (!fs.existsSync(target.directory)) return;
  const marker = readJson(markerFile(target.directory));
  if (marker?.owner !== OWNER || marker.client !== target.client || marker.name !== target.name) throw new Error(`SKILL_TARGET_NOT_OWNED: ${target.directory}`);
  if (JSON.stringify(managedHashes(target.directory)) !== JSON.stringify(marker.managed_hashes ?? {})) throw new Error(`SKILL_OWNED_CONTENT_CHANGED: ${target.directory}`);
}

function safeTarget(target) {
  if (!NAMES.includes(path.basename(target.directory)) || path.resolve(path.dirname(target.directory)) !== path.resolve(target.root)) throw new Error(`SKILL_TARGET_UNSAFE: ${target.directory}`);
}

function snapshotDirectory(directory) {
  if (!fs.existsSync(directory)) return Object.freeze({ exists: false, files: [] });
  return Object.freeze({ exists: true, files: walk(directory).map(file => ({ relative: path.relative(directory, file), content: fs.readFileSync(file) })) });
}

export function snapshotClientSkills({ roots = defaultSkillRoots() } = {}) {
  return Object.freeze(targets(roots).map(target => Object.freeze({ ...target, snapshot: snapshotDirectory(target.directory) })));
}

export function restoreClientSkills(snapshots) {
  for (const target of snapshots) {
    safeTarget(target);
    fs.rmSync(target.directory, { recursive: true, force: true });
    if (!target.snapshot.exists) continue;
    for (const file of target.snapshot.files) {
      const destination = path.join(target.directory, file.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.content);
    }
  }
}

function renderSource(source, destination, applicationRoot) {
  fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
  const skill = path.join(destination, "SKILL.md");
  const renderedRoot = path.resolve(applicationRoot).replaceAll("\\", "/");
  fs.writeFileSync(skill, fs.readFileSync(skill, "utf8").replaceAll(PLACEHOLDER, renderedRoot), "utf8");
}

export function installClientSkills({ applicationRoot, roots = defaultSkillRoots() }) {
  const application = path.resolve(applicationRoot), all = targets(roots);
  for (const target of all) validateOwned(target);
  const applied = [];
  for (const target of all) {
    safeTarget(target);
    const source = path.join(application, "integrations", target.client, "skills", target.name);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) throw new Error(`SKILL_SOURCE_MISSING: ${source}`);
    fs.mkdirSync(target.root, { recursive: true });
    const stage = path.join(target.root, `.${target.name}.stage-${crypto.randomUUID()}`);
    const previous = fs.existsSync(target.directory) ? path.join(target.root, `.${target.name}.previous-${crypto.randomUUID()}`) : null;
    try {
      renderSource(source, stage, application);
      const record = {
        owner: OWNER,
        schema_version: 1,
        client: target.client,
        name: target.name,
        application_root: application,
        managed_hashes: managedHashes(stage),
        installed_at: new Date().toISOString()
      };
      fs.writeFileSync(markerFile(stage), `${JSON.stringify(record, null, 2)}\n`, "utf8");
      if (previous) fs.renameSync(target.directory, previous);
      fs.renameSync(stage, target.directory);
      if (previous) fs.rmSync(previous, { recursive: true, force: true });
      applied.push({ status: previous ? "updated" : "installed", client: target.client, name: target.name, directory: target.directory });
    } catch (error) {
      fs.rmSync(stage, { recursive: true, force: true });
      if (previous && fs.existsSync(previous) && !fs.existsSync(target.directory)) fs.renameSync(previous, target.directory);
      throw error;
    }
  }
  return Object.freeze(applied);
}

export function removeClientSkills({ roots = defaultSkillRoots() } = {}) {
  return Object.freeze(targets(roots).map(target => {
    safeTarget(target);
    if (!fs.existsSync(target.directory)) return { status: "absent", client: target.client, name: target.name, directory: target.directory };
    const marker = readJson(markerFile(target.directory));
    if (marker?.owner !== OWNER) return { status: "not_owned", client: target.client, name: target.name, directory: target.directory };
    if (JSON.stringify(managedHashes(target.directory)) !== JSON.stringify(marker.managed_hashes ?? {})) return { status: "changed", client: target.client, name: target.name, directory: target.directory };
    fs.rmSync(target.directory, { recursive: true, force: true });
    return { status: "removed", client: target.client, name: target.name, directory: target.directory };
  }));
}
