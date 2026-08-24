import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MARKER = ".agent-gateway-ephemeral.json";
const PREFIXES = ["codex-home-", "kimi-home-", "opencode-home-"];

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function restrictDirectory(directory) {
  if (process.platform === "win32") {
    const principal = os.userInfo().username;
    const result = spawnSync("icacls", [directory, "/inheritance:r", "/grant:r", `${principal}:(OI)(CI)F`], { windowsHide: true, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`EPHEMERAL_ACL_FAILED: ${String(result.stderr || result.stdout).trim()}`);
  } else {
    fs.chmodSync(directory, 0o700);
  }
}

function removeDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export function cleanupConfirmedOrphans(tempRoot, { now = Date.now(), graceMs = 0 } = {}) {
  if (!fs.existsSync(tempRoot)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PREFIXES.some(prefix => entry.name.startsWith(prefix))) continue;
    const directory = path.join(tempRoot, entry.name);
    const markerPath = path.join(directory, MARKER);
    if (!fs.existsSync(markerPath)) continue;
    let marker;
    try { marker = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch { continue; }
    if (marker.owner !== "agent-gateway" || !PREFIXES.includes(`${marker.provider}-home-`)) continue;
    const age = now - Date.parse(marker.createdAt);
    if (!Number.isFinite(age) || age < graceMs || isRunning(marker.pid)) continue;
    removeDirectory(directory);
    removed.push(directory);
  }
  return removed;
}

function copyIfPresent(sourceHome, targetHome, relativePath) {
  const source = path.join(sourceHome, relativePath);
  if (!fs.existsSync(source)) return;
  const target = path.join(targetHome, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
}

function skillFile(entry) {
  const resolved = path.resolve(entry);
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? path.join(resolved, "SKILL.md") : resolved;
}

function repositorySkillFiles(projectRoot) {
  if (!projectRoot) return [];
  const start = path.resolve(projectRoot);
  const ancestors = [];
  let current = start;
  while (true) {
    ancestors.push(current);
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const result = [];
  for (const directory of ancestors) {
    const root = path.join(directory, ".agents", "skills");
    if (!fs.existsSync(root)) continue;
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const file = path.join(root, item.name, "SKILL.md");
      if (fs.existsSync(file)) result.push(path.resolve(file));
    }
  }
  return [...new Set(result)].sort();
}

export function createProviderEnvironment(provider, { tempRoot, sourceHome, profileConfig = {}, projectRoot = null }) {
  if (!["codex", "kimi", "opencode"].includes(provider)) return { env: {}, directory: null, cleanup() {} };
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  cleanupConfirmedOrphans(tempRoot);
  const directory = fs.mkdtempSync(path.join(tempRoot, `${provider}-home-`));
  try {
    restrictDirectory(directory);
    fs.writeFileSync(path.join(directory, MARKER), JSON.stringify({ owner: "agent-gateway", provider, pid: process.pid, createdAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 });
    if (provider === "codex") {
      fs.mkdirSync(path.join(directory, "skills"), { recursive: true });
      copyIfPresent(sourceHome, directory, "auth.json");
      const allowedSkillFiles = new Set((profileConfig.allowedSkills ?? []).map(skillFile));
      for (const skill of profileConfig.allowedSkills ?? []) {
        const source = path.resolve(skill);
        if (!fs.existsSync(source)) throw new Error(`ALLOWED_SKILL_NOT_FOUND: ${source}`);
        const sourceDirectory = fs.statSync(source).isDirectory() ? source : path.dirname(source);
        fs.cpSync(sourceDirectory, path.join(directory, "skills", path.basename(sourceDirectory)), { recursive: true, force: false, errorOnExist: true });
      }
      const disabledRepositorySkills = repositorySkillFiles(projectRoot).filter(file => !allowedSkillFiles.has(file));
      const skillOverrides = disabledRepositorySkills.flatMap(file => ["", "[[skills.config]]", `path = ${JSON.stringify(file)}`, "enabled = false"]);
      fs.writeFileSync(path.join(directory, "config.toml"), [
        ...(profileConfig.model ? [`model = ${JSON.stringify(profileConfig.model)}`] : []),
        `model_reasoning_effort = ${JSON.stringify(profileConfig.reasoningEffort ?? "low")}`,
        `sandbox_mode = ${JSON.stringify(profileConfig.readOnly ? "read-only" : "workspace-write")}`,
        'approval_policy = "never"',
        "[features]",
        "memories = false",
        "multi_agent = false",
        "plugins = false",
        "remote_plugin = false",
        "[plugins]",
        ...skillOverrides
      ].join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
      return { directory, env: { CODEX_HOME: directory, RUST_LOG: "error" }, cleanup: () => removeDirectory(directory) };
    }
    if (provider === "opencode") {
      copyIfPresent(sourceHome, path.join(directory, ".local", "share", "opencode"), "auth.json");
      const permissions = {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        lsp: "allow",
        edit: profileConfig.readOnly ? "deny" : "allow",
        bash: profileConfig.readOnly && profileConfig.allowShell !== true ? "deny" : "allow",
        webfetch: profileConfig.allowWeb === true ? "allow" : "deny",
        websearch: profileConfig.allowWeb === true ? "allow" : "deny",
        task: "deny",
        external_directory: "deny",
        skill: {
          "*": "deny",
          ...Object.fromEntries((profileConfig.allowedSkillNames ?? []).map(name => [name, "allow"]))
        }
      };
      const inlineConfig = {
        $schema: "https://opencode.ai/config.json",
        plugin: [],
        permission: permissions,
        agent: {
          gateway: {
            description: "Bounded AgentGateway role",
            mode: "primary",
            permission: permissions
          }
        }
      };
      return {
        directory,
        env: {
          HOME: directory,
          USERPROFILE: directory,
          XDG_CONFIG_HOME: path.join(directory, ".config"),
          XDG_DATA_HOME: path.join(directory, ".local", "share"),
          OPENCODE_CONFIG_DIR: path.join(directory, ".config", "opencode"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig)
        },
        cleanup: () => removeDirectory(directory)
      };
    }
    for (const allowed of ["config.toml", "credentials", "device_id", "region"]) copyIfPresent(sourceHome, directory, allowed);
    const configPath = path.join(directory, "config.toml");
    const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    fs.writeFileSync(configPath, `${config.trimEnd()}\n\n[loop_control]\nmax_steps_per_turn = ${profileConfig.maxStepsPerTurn ?? 40}\nreserved_context_size = ${profileConfig.reservedContextSize ?? 50000}\n`, { encoding: "utf8", mode: 0o600 });
    return { directory, env: { KIMI_CODE_HOME: directory, KIMI_LOOP_MAX_STEPS_PER_TURN: String(profileConfig.maxStepsPerTurn ?? 40) }, cleanup: () => removeDirectory(directory) };
  } catch (error) {
    removeDirectory(directory);
    throw error;
  }
}

export function registerProcessCleanup(cleanup) {
  let completed = false;
  const once = () => { if (!completed) { completed = true; try { cleanup(); } catch {} } };
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      once();
      for (const [registeredSignal, registeredHandler] of signalHandlers) process.removeListener(registeredSignal, registeredHandler);
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  process.once("exit", once);
  return () => {
    once();
    process.removeListener("exit", once);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  };
}

export async function withProviderEnvironment(provider, options, operation) {
  const environment = createProviderEnvironment(provider, options);
  const cleanup = registerProcessCleanup(environment.cleanup);
  try { return await operation({ ...process.env, ...environment.env }, environment.directory); }
  finally { cleanup(); }
}
