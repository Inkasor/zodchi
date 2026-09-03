import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const slash = value => value.replaceAll("\\", "/");

function walk(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function gitValue(directory, args) {
  try { return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

function skillDirectory(entry) {
  const resolved = path.resolve(entry);
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
}

function pluginNameForSkill(directory) {
  let current = directory;
  while (true) {
    if (path.basename(current).toLowerCase() === "skills") {
      const manifest = path.join(current, "..", ".codex-plugin", "plugin.json");
      try {
        const name = JSON.parse(fs.readFileSync(manifest, "utf8")).name;
        if (typeof name === "string" && name.trim()) return name.trim();
      } catch { /* ordinary standalone skill or malformed plugin metadata */ }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function skillIdentity(entry) {
  const directory = skillDirectory(entry);
  const name = path.basename(directory);
  const pluginName = pluginNameForSkill(directory);
  return pluginName ? `${pluginName}:${name}` : name;
}

function skillRecord(entry) {
  const directory = skillDirectory(entry);
  const files = walk(directory).map(file => ({ path: slash(path.relative(directory, file)), sha256: sha256(fs.readFileSync(file)) }));
  const marker = path.join(directory, ".zodchi-skill.json");
  let installation = null;
  try { installation = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf8")) : null; } catch { /* malformed marker remains visible as null */ }
  return {
    name: skillIdentity(directory), source: installation?.application_root ? "zodchi-installation" : gitValue(directory, ["rev-parse", "--show-toplevel"]) ? "git" : "local",
    repository: gitValue(directory, ["config", "--get", "remote.origin.url"]),
    revision: gitValue(directory, ["describe", "--tags", "--exact-match"]) ?? gitValue(directory, ["rev-parse", "HEAD"]),
    content_hash: sha256(JSON.stringify(files)), files
  };
}

const INSTRUCTION_PATHS = Object.freeze(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "KIMI.md", ".github/copilot-instructions.md", ".cursorrules"]);

function instructionCandidates(projectRoot) {
  if (!projectRoot) return [];
  const roots = [];
  let current = path.resolve(projectRoot);
  while (true) {
    roots.push(current);
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const files = roots.flatMap(root => INSTRUCTION_PATHS.map(relative => path.join(root, relative)).filter(file => fs.existsSync(file) && fs.statSync(file).isFile()));
  const cursorRules = roots.flatMap(root => walk(path.join(root, ".cursor", "rules"))).filter(file => /\.(?:md|mdc)$/iu.test(file));
  return [...new Set([...files, ...cursorRules].map(file => path.resolve(file)))].sort();
}

export function buildInputManifest({ projectRoot = null, profileConfig = {}, requirements = {}, providerEnvironment = null }) {
  const allowedSkills = new Set(requirements.allowed_skills ?? []);
  const skills = (profileConfig.allowedSkills ?? []).map(skillRecord).filter(skill => allowedSkills.has(skill.name));
  const allowedInstructions = new Set(requirements.native_instruction_files ?? []);
  const instructionFiles = instructionCandidates(projectRoot).map(file => {
    const relative = slash(path.relative(path.resolve(projectRoot), file));
    return { path: relative, sha256: sha256(fs.readFileSync(file)), status: allowedInstructions.has(relative) ? "included" : profileConfig.nativeInstructionEnforcement === "technical" ? "suppressed" : "suppression_unverified" };
  });
  const externalTools = (requirements.external_tools ?? []).map(item => ({
    name: item.name, transport: item.transport ?? null, endpoint: item.endpoint ?? null,
    pinned_version: item.pinned_version ?? null, read_only_mode: item.read_only_mode ?? null,
    arbitrary_execution: item.arbitrary_execution === true, contains_model: item.contains_model === true,
    self_liftable_boundary: item.self_liftable_boundary === true, doubles_as_provider: item.doubles_as_provider === true
  }));
  const endpoints = profileConfig.allowNetwork === true ? [...new Set([
    ...externalTools.map(item => item.endpoint).filter(Boolean),
    ...(profileConfig.allowedLocalEndpoints ?? [])
  ])].sort() : [];
  const manifest = {
    schema_version: 1,
    skills,
    mcp_servers: externalTools,
    instruction_files: instructionFiles,
    available_endpoints: endpoints,
    provider_environment: providerEnvironment ?? null
  };
  return Object.freeze({ ...manifest, manifest_hash: sha256(JSON.stringify(manifest)) });
}

export function includedInstructionText(manifest, projectRoot) {
  if (!projectRoot) return "";
  return manifest.instruction_files.filter(item => item.status === "included").map(item => {
    const file = path.resolve(projectRoot, item.path);
    return `<native_instruction path=${JSON.stringify(item.path)} sha256=${JSON.stringify(item.sha256)}>\n${fs.readFileSync(file, "utf8")}\n</native_instruction>`;
  }).join("\n");
}
