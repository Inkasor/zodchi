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

// A project can register skills in more than one place, and a skill the ephemeral home does not disable is
// a capability the worker silently keeps. `.agents/skills` is the harness-neutral location; `.codex/skills`
// is where Codex itself looks. Scanning only the first left the second enabled for every role.
const SKILL_DIRECTORIES = Object.freeze([[".agents", "skills"], [".codex", "skills"]]);

function skillsIn(root, scope) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const file = path.join(root, item.name, "SKILL.md");
    if (fs.existsSync(file)) found.push({ scope, name: item.name, path: path.resolve(file) });
  }
  return found;
}

function projectSkills(projectRoot) {
  if (!projectRoot) return [];
  const ancestors = [];
  let current = path.resolve(projectRoot);
  while (true) {
    ancestors.push(current);
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const found = new Map();
  for (const directory of ancestors) {
    for (const segments of SKILL_DIRECTORIES) {
      for (const skill of skillsIn(path.join(directory, ...segments), "project")) if (!found.has(skill.path)) found.set(skill.path, skill);
    }
  }
  return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
}

// The ephemeral home replaces the real one wholesale, so every skill the owner installed for themselves
// disappears from the run. That is the intended isolation, but it changes what the worker can do, and a
// capability change nobody recorded is indistinguishable from a worker that simply chose not to act.
function homeSkills(sourceHome) {
  return sourceHome ? skillsIn(path.join(sourceHome, "skills"), "home") : [];
}

// Enumerating `[mcp_servers.<name>]` tables is all that is needed here, and a section is copied by slicing
// its own lines, so no TOML parser has to be shipped to move one verbatim.
const MCP_PREFIX = "mcp_servers";
const LINE = "\n";

function tomlTables(text, prefix) {
  const lines = text.split(/\r?\n/);
  const tables = new Map();
  let current = null;
  for (const line of lines) {
    const header = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*$/.exec(line);
    if (header) {
      const parts = header[1].split(".").map(part => part.trim().replace(/^"(.*)"$/, "$1"));
      current = parts[0] === prefix && parts.length > 1 ? parts[1] : null;
      if (current && !tables.has(current)) tables.set(current, []);
    }
    if (current) tables.get(current).push(line);
  }
  return tables;
}

function readIfPresent(file) {
  return file && fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : "";
}

// An unreadable source configuration must not take the call down: the worker still runs, it simply runs
// without the servers that file would have named, and the empty report says exactly that.
function jsonIfPresent(file) {
  const text = readIfPresent(file);
  if (!text.trim()) return {};
  try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

// The policy is an allowlist by name, and it is explicit in both directions: a server the profile did not
// name is withheld and said so, never quietly absent.
function selectTomlTables(sources, allowed, prefix = MCP_PREFIX) {
  const allowedNames = new Set(allowed ?? []);
  const carried = [], withheld = [], shadowed = [], sections = [];
  const selected = new Map();
  for (const { scope, text } of sources) {
    for (const [name, lines] of tomlTables(text, prefix)) {
      if (selected.has(name)) shadowed.push({ scope: selected.get(name).scope, name, by_scope: scope });
      selected.set(name, { scope, name, lines });
    }
  }
  for (const item of selected.values()) {
    if (allowedNames.has(item.name)) { carried.push({ scope: item.scope, name: item.name }); sections.push(item.lines.join(LINE)); }
    else withheld.push({ scope: item.scope, name: item.name });
  }
  return { carried, withheld, shadowed, sections };
}

function copyAllowedPluginCaches(sourceHome, targetHome, allowedPlugins) {
  const copied = [];
  for (const id of allowedPlugins ?? []) {
    const separator = id.lastIndexOf("@");
    if (separator <= 0 || separator === id.length - 1) throw new Error(`ALLOWED_PLUGIN_INVALID: ${id}`);
    const name = id.slice(0, separator), marketplace = id.slice(separator + 1);
    const source = path.join(sourceHome, "plugins", "cache", marketplace, name);
    if (!fs.existsSync(source)) throw new Error(`ALLOWED_PLUGIN_NOT_FOUND: ${id}`);
    const target = path.join(targetHome, "plugins", "cache", marketplace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    copied.push({ id, path: target });
  }
  return copied;
}

function rewriteHomeReferences(sections, sourceHome, targetHome) {
  if (!sourceHome) return sections;
  const variants = [sourceHome, sourceHome.replaceAll("\\", "/"), sourceHome.replaceAll("\\", "\\\\")];
  return sections.map(section => variants.reduce((text, value) => text.replaceAll(value, targetHome.replaceAll("\\", value.includes("\\\\") ? "\\\\" : value.includes("/") ? "/" : "\\")), section));
}

function capabilityReport(provider, { skills, mcp, plugins = { policy: "disabled", carried: [], withheld: [] } }) {
  return Object.freeze({
    provider,
    home: "ephemeral",
    skills: Object.freeze({ policy: "allowlist", allowed: Object.freeze(skills.allowed), withheld: Object.freeze(skills.withheld) }),
    mcp_servers: Object.freeze({ policy: mcp.policy, carried: Object.freeze(mcp.carried ?? []), withheld: Object.freeze(mcp.withheld ?? []), shadowed: Object.freeze(mcp.shadowed ?? []) }),
    plugins: Object.freeze({ policy: plugins.policy, carried: Object.freeze(plugins.carried ?? []), withheld: Object.freeze(plugins.withheld ?? []) })
  });
}

export function createProviderEnvironment(provider, { tempRoot, sourceHome, sourceConfig = null, profileConfig = {}, projectRoot = null }) {
  if (!["codex", "kimi", "opencode"].includes(provider)) return { env: {}, directory: null, capabilities: null, cleanup() {} };
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
      const withheldSkills = [...projectSkills(projectRoot), ...homeSkills(sourceHome)].filter(skill => !allowedSkillFiles.has(skill.path));
      const skillOverrides = withheldSkills.filter(skill => skill.scope === "project").flatMap(skill => ["", "[[skills.config]]", `path = ${JSON.stringify(skill.path)}`, "enabled = false"]);
      // Whatever the owner registered for Codex stays registered: an ephemeral home that quietly drops
      // every MCP server changes what the worker can reach without anyone deciding it should, and a role
      // that cannot reach its server reports the work as impossible instead of as unequipped.
      const configSources = [
        { scope: "home", text: readIfPresent(sourceHome ? path.join(sourceHome, "config.toml") : null) },
        { scope: "project", text: readIfPresent(projectRoot ? path.join(projectRoot, ".codex", "config.toml") : null) }
      ];
      const mcp = selectTomlTables(configSources, profileConfig.allowedMcpServers);
      const plugins = selectTomlTables(configSources, profileConfig.allowedPlugins, "plugins");
      const marketplaces = selectTomlTables(configSources, [...new Set((profileConfig.allowedPlugins ?? []).map(id => id.slice(id.lastIndexOf("@") + 1)))], "marketplaces");
      const copiedPlugins = copyAllowedPluginCaches(sourceHome, directory, profileConfig.allowedPlugins);
      const mcpSections = rewriteHomeReferences(mcp.sections, sourceHome, directory);
      fs.writeFileSync(path.join(directory, "config.toml"), [
        ...(profileConfig.model ? [`model = ${JSON.stringify(profileConfig.model)}`] : []),
        `model_reasoning_effort = ${JSON.stringify(profileConfig.reasoningEffort ?? "low")}`,
        `sandbox_mode = ${JSON.stringify(profileConfig.readOnly ? "read-only" : "workspace-write")}`,
        'approval_policy = "never"',
        "[features]",
        "memories = false",
        "multi_agent = false",
        `plugins = ${(profileConfig.allowedPlugins ?? []).length > 0}`,
        "remote_plugin = false",
        "[plugins]",
        ...plugins.sections,
        ...marketplaces.sections,
        ...skillOverrides,
        ...mcpSections
      ].join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
      return {
        directory,
        env: { CODEX_HOME: directory, RUST_LOG: "error" },
        capabilities: capabilityReport(provider, { skills: { allowed: [...allowedSkillFiles], withheld: withheldSkills }, mcp: { policy: "allowlist", carried: mcp.carried, withheld: mcp.withheld, shadowed: mcp.shadowed }, plugins: { policy: "allowlist", carried: copiedPlugins.map(item => ({ id: item.id })), withheld: plugins.withheld } }),
        cleanup: () => removeDirectory(directory)
      };
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
      // OpenCode's configuration lives outside the data directory the ephemeral home replaces, so the
      // servers the owner registered are readable here and can be carried by name. Whatever the profile
      // did not name stays out and is recorded as withheld rather than simply vanishing.
      const declared = jsonIfPresent(sourceConfig).mcp ?? {};
      const allowedServers = new Set(profileConfig.allowedMcpServers ?? []);
      const mcp = { carried: [], withheld: [], config: {} };
      for (const name of Object.keys(declared).sort()) {
        if (allowedServers.has(name)) { mcp.carried.push({ scope: "home", name }); mcp.config[name] = declared[name]; }
        else mcp.withheld.push({ scope: "home", name });
      }
      const inlineConfig = {
        $schema: "https://opencode.ai/config.json",
        plugin: [],
        mcp: mcp.config,
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
        capabilities: capabilityReport(provider, {
          skills: { allowed: [...(profileConfig.allowedSkillNames ?? [])], withheld: projectSkills(projectRoot) },
          mcp: { policy: "allowlist", carried: mcp.carried, withheld: mcp.withheld }
        }),
        cleanup: () => removeDirectory(directory)
      };
    }
    for (const allowed of ["config.toml", "credentials", "device_id", "region"]) copyIfPresent(sourceHome, directory, allowed);
    const configPath = path.join(directory, "config.toml");
    const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    fs.writeFileSync(configPath, `${config.trimEnd()}\n\n[loop_control]\nmax_steps_per_turn = ${profileConfig.maxStepsPerTurn ?? 40}\nreserved_context_size = ${profileConfig.reservedContextSize ?? 50000}\n`, { encoding: "utf8", mode: 0o600 });
    // Kimi's whole configuration file is copied, so the servers it registers come along. That is inherited
    // rather than selected, and the report says so instead of implying an allowlist decided it.
    return {
      directory,
      env: { KIMI_CODE_HOME: directory, KIMI_LOOP_MAX_STEPS_PER_TURN: String(profileConfig.maxStepsPerTurn ?? 40) },
      capabilities: capabilityReport(provider, {
        skills: { allowed: [], withheld: homeSkills(sourceHome) },
        mcp: { policy: "inherited", carried: [...tomlTables(config, MCP_PREFIX).keys()].sort().map(name => ({ scope: "home", name })), withheld: [] }
      }),
      cleanup: () => removeDirectory(directory)
    };
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
  try { return await operation({ ...process.env, ...environment.env }, environment.directory, environment.capabilities ?? null); }
  finally { cleanup(); }
}
