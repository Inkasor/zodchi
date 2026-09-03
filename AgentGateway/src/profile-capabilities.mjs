const CAPABILITY_NAMES = Object.freeze([
  "context_input",
  "project_read",
  "file_search",
  "language_server",
  "process_execution",
  "local_endpoint",
  "external_mutation",
  "long_lived_process",
  "project_write",
  "network",
  "browser_automation",
  "screen_capture",
  "mcp",
  "skills"
]);

const CAPABILITY_SET = new Set(CAPABILITY_NAMES);
const STATUS = new Set(["available", "unavailable", "unknown"]);
const ENFORCEMENT = new Set(["technical", "declarative", "unknown"]);
const ACCESS = new Set(["embedded", "direct", "none", "unknown"]);
const BROWSER_MCP_PROVIDERS = new Set(["codex", "claude", "opencode"]);

const capability = (status, enforcement, access, source, evidenceRef = null) => Object.freeze({ status, enforcement, access, source, evidence_ref: evidenceRef });
const unknown = source => capability("unknown", "unknown", "unknown", source);
const available = (access, source, enforcement = "technical") => capability("available", enforcement, access, source);
const unavailable = (source, enforcement = "technical") => capability("unavailable", enforcement, "none", source);

function toolState(profileConfig, names) {
  const allowed = new Set(profileConfig.allowedTools ?? []);
  const denied = new Set(profileConfig.disallowedTools ?? []);
  if (names.some(name => denied.has(name))) return "denied";
  if (allowed.size && names.some(name => allowed.has(name))) return "allowed";
  return "unknown";
}

function configuredBrowserMcp(provider, profileConfig) {
  const name = profileConfig.browserMcpServer;
  if (name === undefined) return null;
  if (typeof name !== "string" || !name.trim() || name !== name.trim()) throw new Error("PROFILE_BROWSER_MCP_INVALID");
  if (!BROWSER_MCP_PROVIDERS.has(provider)) throw new Error(`PROFILE_BROWSER_MCP_PROVIDER_UNSUPPORTED: ${provider}`);
  if (!(profileConfig.allowedMcpServers ?? []).includes(name)) throw new Error(`PROFILE_BROWSER_MCP_NOT_ALLOWED: ${name}`);
  return name;
}

function providerCapabilities(provider, providerConfig, profileConfig, platform = process.platform) {
  const result = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, unknown(`provider:${provider}`)]));
  result.context_input = available("embedded", "gateway:prompt");
  const readOnly = profileConfig.readOnly === true;
  const browserMcp = configuredBrowserMcp(provider, profileConfig);

  if (providerConfig.type === "openai-compatible" || provider === "openai-compatible" || provider === "openrouter") {
    for (const name of ["project_read", "file_search", "language_server", "process_execution", "local_endpoint", "external_mutation", "long_lived_process", "project_write", "browser_automation", "screen_capture", "mcp", "skills"]) result[name] = unavailable("gateway:api-context-only");
    result.network = available("direct", "gateway:provider-api");
    return result;
  }

  if (provider === "codex") {
    result.project_write = readOnly ? unavailable("codex:sandbox-read-only") : available("direct", "codex:sandbox-workspace-write");
    result.process_execution = readOnly
      ? (platform === "win32" ? unavailable("codex:windows-read-only-process-policy") : unknown("codex:read-only-process-unverified"))
      : available("direct", "codex:sandbox-workspace-write");
    const networkAllowed = profileConfig.allowNetwork === true;
    result.local_endpoint = networkAllowed ? available("direct", "codex:sandbox-network-enabled") : unavailable("codex:sandbox-network-disabled");
    result.external_mutation = networkAllowed || (profileConfig.allowedMcpServers ?? []).length
      ? unknown("codex:external-mutation-tool-registry-required")
      : unavailable("codex:no-network-or-mcp");
    result.project_read = readOnly
      ? (platform === "win32" ? unavailable("codex:windows-read-only-no-reader") : unknown("codex:read-only-reader-unverified"))
      : available("direct", "codex:process-access");
    result.file_search = result.project_read;
    result.long_lived_process = result.process_execution.status === "available" ? available("direct", "codex:process-access") : result.process_execution;
    const browserPlugin = (profileConfig.allowedPlugins ?? []).some(name => /^(?:browser|chrome)@/u.test(name));
    const browserRuntime = (profileConfig.allowedMcpServers ?? []).includes("node_repl");
    result.browser_automation = browserMcp ? unknown(`codex:browser-mcp-configured-unverified:${browserMcp}`) : browserPlugin && browserRuntime ? unknown("codex:browser-plugin-configured-unverified") : unavailable("codex:browser-plugin-allowlist");
    result.screen_capture = browserMcp ? unknown(`codex:browser-mcp-configured-unverified:${browserMcp}`) : browserPlugin && browserRuntime ? unknown("codex:browser-plugin-configured-unverified") : unavailable("codex:browser-plugin-allowlist");
    result.network = unknown("codex:network-policy-unverified");
    result.mcp = (profileConfig.allowedMcpServers ?? []).length ? available("direct", "codex:mcp-allowlist") : unavailable("codex:mcp-allowlist");
    result.skills = (profileConfig.allowedSkills ?? []).length ? available("direct", "codex:skills-allowlist") : unavailable("codex:skills-allowlist");
    return result;
  }

  if (provider === "claude") {
    const read = toolState(profileConfig, ["Read", "Glob", "Grep"]);
    const shell = toolState(profileConfig, ["Bash"]);
    const write = toolState(profileConfig, ["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    result.project_read = read === "denied" ? unavailable("claude:tool-denylist") : read === "allowed" ? available("direct", "claude:tool-allowlist") : unknown("claude:read-tools-unbounded");
    result.file_search = result.project_read;
    result.process_execution = shell === "denied" ? unavailable("claude:tool-denylist") : shell === "allowed" ? available("direct", "claude:tool-allowlist") : unknown("claude:bash-unbounded");
    result.local_endpoint = result.process_execution.status === "unavailable" && !(profileConfig.allowedMcpServers ?? []).length
      ? unavailable("claude:no-shell-or-mcp") : unknown("claude:local-endpoint-unverified");
    result.external_mutation = result.local_endpoint.status === "unavailable"
      ? unavailable("claude:no-shell-or-mcp") : unknown("claude:external-mutation-tool-registry-required");
    result.long_lived_process = result.process_execution;
    result.browser_automation = browserMcp ? unknown(`claude:browser-mcp-configured-unverified:${browserMcp}`) : result.process_execution.status === "unavailable" ? result.process_execution : unknown("claude:browser-tooling-unverified");
    result.screen_capture = browserMcp ? unknown(`claude:browser-mcp-configured-unverified:${browserMcp}`) : result.process_execution.status === "unavailable" ? result.process_execution : unknown("claude:screen-capture-unverified");
    result.project_write = write === "denied" ? unavailable("claude:tool-denylist") : write === "allowed" ? available("direct", "claude:tool-allowlist") : unknown("claude:write-tools-unbounded");
    result.network = unknown("claude:network-unverified");
    result.mcp = Array.isArray(profileConfig.allowedMcpServers)
      ? profileConfig.allowedMcpServers.length ? available("direct", "claude:strict-mcp-allowlist") : unavailable("claude:strict-mcp-allowlist")
      : unknown("claude:mcp-unverified");
    // AgentGateway invokes Claude with --safe-mode. The 0.6.13 observation proves that project and
    // lazily discovered nested skills are withheld; selective skill allowlisting remains unknown.
    result.skills = unavailable("claude:safe-mode-customizations-disabled");
    return result;
  }

  if (provider === "opencode") {
    result.project_read = available("direct", "opencode:permission-read");
    result.file_search = available("direct", "opencode:permission-search");
    result.language_server = available("direct", "opencode:permission-lsp");
    result.process_execution = readOnly && profileConfig.allowShell !== true ? unavailable("opencode:permission-bash") : available("direct", "opencode:permission-bash");
    result.local_endpoint = result.process_execution.status === "unavailable" && !(profileConfig.allowedMcpServers ?? []).length
      ? unavailable("opencode:no-shell-or-mcp") : unknown("opencode:local-endpoint-unverified");
    result.external_mutation = result.local_endpoint.status === "unavailable" && profileConfig.allowWeb !== true
      ? unavailable("opencode:no-shell-web-or-mcp") : unknown("opencode:external-mutation-tool-registry-required");
    result.long_lived_process = result.process_execution;
    result.browser_automation = browserMcp ? unknown(`opencode:browser-mcp-configured-unverified:${browserMcp}`) : result.process_execution.status === "unavailable" ? result.process_execution : unknown("opencode:browser-tooling-unverified");
    result.screen_capture = browserMcp ? unknown(`opencode:browser-mcp-configured-unverified:${browserMcp}`) : result.process_execution.status === "unavailable" ? result.process_execution : unknown("opencode:screen-capture-unverified");
    result.project_write = readOnly ? unavailable("opencode:permission-edit") : available("direct", "opencode:permission-edit");
    result.network = profileConfig.allowWeb === true ? available("direct", "opencode:permission-web") : unavailable("opencode:permission-web");
    result.mcp = (profileConfig.allowedMcpServers ?? []).length ? available("direct", "opencode:mcp-allowlist") : unavailable("opencode:mcp-allowlist");
    result.skills = (profileConfig.allowedSkillNames ?? []).length ? available("direct", "opencode:skills-allowlist") : unavailable("opencode:skills-allowlist");
    return result;
  }

  if (provider === "kimi") {
    for (const name of ["project_read", "file_search", "process_execution", "local_endpoint", "external_mutation", "long_lived_process", "project_write", "network", "browser_automation", "screen_capture", "mcp"]) result[name] = available("direct", "kimi:inherited-config", "declarative");
    result.skills = unavailable("kimi:ephemeral-skills-withheld");
    return result;
  }

  // Cursor currently has no verified non-interactive capability contract. In particular, absence of
  // --force must not be described as a technical read-only boundary.
  if (provider === "cursor") return result;
  return result;
}

function normalizeOverride(name, value) {
  if (!CAPABILITY_SET.has(name)) throw new Error(`PROFILE_CAPABILITY_UNKNOWN: ${name}`);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`PROFILE_CAPABILITY_INVALID: ${name}`);
  const keys = Object.keys(value).sort();
  const validKeys = [["access", "enforcement", "status"].sort(), ["access", "enforcement", "evidenceRef", "status"].sort()].some(expected => JSON.stringify(keys) === JSON.stringify(expected));
  if (!validKeys || !STATUS.has(value.status) || !ENFORCEMENT.has(value.enforcement) || !ACCESS.has(value.access)) throw new Error(`PROFILE_CAPABILITY_INVALID: ${name}`);
  if (value.enforcement === "technical" && (typeof value.evidenceRef !== "string" || !value.evidenceRef.trim())) throw new Error(`PROFILE_CAPABILITY_EVIDENCE_REQUIRED: ${name}`);
  if (value.evidenceRef !== undefined && (typeof value.evidenceRef !== "string" || !value.evidenceRef.trim())) throw new Error(`PROFILE_CAPABILITY_INVALID: ${name}`);
  return capability(value.status, value.enforcement, value.access, "profile:explicit", value.evidenceRef?.trim() ?? null);
}

function normalizeDeclarativeBoundaryExceptions(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("PROFILE_DECLARATIVE_BOUNDARY_EXCEPTIONS_INVALID");
  return Object.freeze(value.map((item, index) => {
    if (!item || Array.isArray(item) || typeof item !== "object") throw new Error(`PROFILE_DECLARATIVE_BOUNDARY_EXCEPTION_INVALID: ${index}`);
    if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(["capability", "reason", "roles"])) throw new Error(`PROFILE_DECLARATIVE_BOUNDARY_EXCEPTION_INVALID: ${index}`);
    if (!CAPABILITY_SET.has(item.capability)) throw new Error(`PROFILE_DECLARATIVE_BOUNDARY_EXCEPTION_CAPABILITY_INVALID: ${index}`);
    if (!Array.isArray(item.roles) || !item.roles.length || item.roles.some(role => typeof role !== "string" || !role.trim() || role !== role.trim())) throw new Error(`PROFILE_DECLARATIVE_BOUNDARY_EXCEPTION_ROLES_INVALID: ${index}`);
    if (typeof item.reason !== "string" || !item.reason.trim() || item.reason !== item.reason.trim()) throw new Error(`PROFILE_DECLARATIVE_BOUNDARY_EXCEPTION_REASON_REQUIRED: ${index}`);
    return Object.freeze({ capability: item.capability, roles: Object.freeze([...new Set(item.roles)].sort()), reason: item.reason });
  }));
}

export function profileCapabilities(provider, providerConfig, profileConfig, options = {}) {
  const result = providerCapabilities(provider, providerConfig, profileConfig, options.platform);
  normalizeDeclarativeBoundaryExceptions(profileConfig.acceptedDeclarativeBoundaries);
  const overrides = profileConfig.capabilities ?? {};
  if (!overrides || Array.isArray(overrides) || typeof overrides !== "object") throw new Error("PROFILE_CAPABILITIES_INVALID");
  for (const [name, value] of Object.entries(overrides)) {
    const normalized = normalizeOverride(name, value);
    if (["browser_automation", "screen_capture"].includes(name) && normalized.status === "available" && normalized.enforcement === "technical") {
      const browserPlugin = (profileConfig.allowedPlugins ?? []).some(id => /^(?:browser|chrome)@/u.test(id));
      const browserRuntime = (profileConfig.allowedMcpServers ?? []).includes("node_repl");
      const browserMcp = configuredBrowserMcp(provider, profileConfig);
      if ((!browserPlugin || !browserRuntime) && !browserMcp) throw new Error(`PROFILE_CAPABILITY_PREREQUISITE_MISSING: ${name}`);
    }
    result[name] = normalized;
  }
  return Object.freeze(Object.fromEntries(CAPABILITY_NAMES.map(name => [name, result[name]])));
}

export function normalizeCapabilityRequirements(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("PROFILE_CAPABILITY_REQUIREMENTS_INVALID");
  const keys = Object.keys(value).sort();
  const supported = new Set(["allowed_mcp_servers", "allowed_skills", "external_tools", "forbidden", "native_instruction_files", "required"]);
  if (!keys.includes("required") || !keys.includes("forbidden") || keys.some(key => !supported.has(key))) throw new Error("PROFILE_CAPABILITY_REQUIREMENTS_INVALID");
  const normalize = (items, field) => {
    if (!Array.isArray(items) || items.some(item => typeof item !== "string" || !CAPABILITY_SET.has(item))) throw new Error(`PROFILE_CAPABILITY_REQUIREMENTS_INVALID: ${field}`);
    return [...new Set(items)].sort();
  };
  const required = normalize(value.required, "required"), forbidden = normalize(value.forbidden, "forbidden");
  const overlap = required.find(name => forbidden.includes(name));
  if (overlap) throw new Error(`PROFILE_CAPABILITY_REQUIREMENTS_CONTRADICTORY: ${overlap}`);
  const names = field => {
    const items = value[field] ?? [];
    if (!Array.isArray(items) || items.some(item => typeof item !== "string" || !item.trim())) throw new Error(`PROFILE_CAPABILITY_REQUIREMENTS_INVALID: ${field}`);
    return Object.freeze([...new Set(items.map(item => item.trim()))].sort());
  };
  const externalTools = value.external_tools ?? [];
  if (!Array.isArray(externalTools) || externalTools.some(item => !item || typeof item !== "object" || Array.isArray(item) || typeof item.name !== "string")) throw new Error("PROFILE_CAPABILITY_REQUIREMENTS_INVALID: external_tools");
  return Object.freeze({ required: Object.freeze(required), forbidden: Object.freeze(forbidden), allowed_skills: names("allowed_skills"), allowed_mcp_servers: names("allowed_mcp_servers"), native_instruction_files: names("native_instruction_files"), external_tools: Object.freeze(externalTools.map(item => Object.freeze({ ...item }))) });
}

export function inspectCapabilityRequirements(capabilities, requirements, { role = "worker", acceptedDeclarativeBoundaries = undefined } = {}) {
  const normalized = normalizeCapabilityRequirements(requirements);
  const exceptions = normalizeDeclarativeBoundaryExceptions(acceptedDeclarativeBoundaries);
  const mismatches = [];
  const acceptedDeclarative = [];
  for (const name of normalized.required) {
    const actual = capabilities[name];
    if (actual.status !== "available" || actual.enforcement !== "technical") mismatches.push({ capability: name, expectation: "required", actual });
  }
  for (const name of normalized.forbidden) {
    const actual = capabilities[name];
    if (actual.status === "unavailable" && actual.enforcement === "technical") continue;
    const exception = exceptions.find(item => item.capability === name && item.roles.includes(role));
    if (exception && actual.enforcement === "declarative") {
      acceptedDeclarative.push({ status: "accepted_declarative", capability: name, role, reason: exception.reason, actual });
      continue;
    }
    mismatches.push({ capability: name, expectation: "forbidden", actual });
  }
  return { requirements: normalized, mismatches, accepted_declarative: acceptedDeclarative };
}

export { CAPABILITY_NAMES };
