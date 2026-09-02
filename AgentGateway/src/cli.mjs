import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { resolveGatewayPaths } from "./paths.mjs";
import { cleanupConfirmedOrphans, withProviderEnvironment } from "./ephemeral.mjs";
import { openGatewayDb } from "./db.mjs";
import { runOpenAICompatible } from "./openai-compatible.mjs";
import { providerCommandInvocation, resolveProviderCommand } from "./command.mjs";
import { loadGatewayPolicy } from "./policy.mjs";
import { assertMetadataOnlyReceipt, DEFAULT_PRIVACY_MODE, privacyAttestation } from "./receipt-privacy.mjs";
import { inspectCapabilityRequirements, normalizeCapabilityRequirements, profileCapabilities } from "./profile-capabilities.mjs";

const paths = resolveGatewayPaths();
const root = paths.root;
const { policyPath, dataRoot, databasePath } = paths;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function argsObject(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    result[key] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
  }
  return result;
}

function compact(text, max = 12000) {
  const value = String(text ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return value.length <= max ? value : `${value.slice(-max)}\n[output truncated]`;
}

function extractUsage(text, provider = null) {
  const values = [];
  const openCodeSteps = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value?.usage) values.push(value.usage);
      if (value?.type === "turn.completed" && value?.usage) values.push(value.usage);
      if (value?.type === "step_finish" && value?.part?.tokens) openCodeSteps.push(value);
    } catch { /* non-JSON CLI output */ }
  }
  if (provider === "opencode" && openCodeSteps.length) {
    const sum = selector => openCodeSteps.reduce((total, item) => total + (Number(selector(item)) || 0), 0);
    return {
      input_tokens: sum(item => item.part.tokens.input),
      cached_input_tokens: sum(item => item.part.tokens.cache?.read),
      cache_read_input_tokens: sum(item => item.part.tokens.cache?.read),
      cache_write_input_tokens: sum(item => item.part.tokens.cache?.write),
      output_tokens: sum(item => item.part.tokens.output),
      reasoning_output_tokens: sum(item => item.part.tokens.reasoning),
      total_tokens: sum(item => item.part.tokens.total ?? (item.part.tokens.input + item.part.tokens.output)),
      cost_usd: sum(item => item.part.cost),
      session_id: openCodeSteps.at(-1).sessionID ?? openCodeSteps.at(-1).part.sessionID ?? null
    };
  }
  return values.at(-1) ?? null;
}

function inferredModelProvider(provider, profileConfig) {
  if (profileConfig.modelProvider) return profileConfig.modelProvider;
  if (provider === "codex") return "openai";
  if (provider === "claude") return "anthropic";
  if (provider === "kimi") return "moonshot";
  if (provider === "cursor") return "cursor-managed";
  if (provider === "opencode" && profileConfig.model?.includes("/")) return profileConfig.model.split("/", 1)[0];
  return null;
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const number = value => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    input_tokens: number(usage.input_tokens),
    cached_input_tokens: number(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? 0),
    cache_write_input_tokens: number(usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: number(usage.cache_read_input_tokens),
    cache_creation_input_tokens: number(usage.cache_creation_input_tokens),
    output_tokens: number(usage.output_tokens),
    reasoning_output_tokens: number(usage.reasoning_output_tokens),
    total_tokens: number(usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0))),
    cost_usd: number(usage.cost_usd ?? usage.total_cost_usd),
    duration_ms: number(usage.duration_ms),
    num_turns: number(usage.num_turns),
    session_id: typeof usage.session_id === "string" ? usage.session_id : null,
    service_tier: typeof usage.service_tier === "string" ? usage.service_tier : null,
    speed: typeof usage.speed === "string" ? usage.speed : null
  };
}

function extractSessionId(text) {
  for (const line of String(text ?? "").split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      const candidate = value?.session_id ?? value?.sessionID ?? value?.usage?.session_id;
      if (typeof candidate === "string") return candidate;
    } catch { /* non-JSON CLI output */ }
  }
  const match = String(text ?? "").match(/session[_-][0-9a-f-]{20,}/i);
  return match?.[0] ?? null;
}

function diffStats(cwd) {
  if (!cwd) return { files: null, added: null, deleted: null };
  try {
    const lines = execFileSync("git", ["diff", "--numstat"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/).filter(Boolean);
    let added = 0, deleted = 0;
    for (const line of lines) { const [a, d] = line.split(/\s+/); added += Number(a) || 0; deleted += Number(d) || 0; }
    return { files: lines.length, added, deleted };
  } catch { return { files: null, added: null, deleted: null }; }
}

// A receipt that counted only the primary directory would under-report a call given more than one
// writable root: whatever it did in the second one would leave no trace in the record that exists to say
// what the call changed. Every writable directory is measured; one that is not a repository contributes
// nothing rather than silently zeroing the total.
function combinedDiffStats(directories) {
  const measured = directories.map(diffStats).filter(item => item.files !== null);
  if (!measured.length) return { files: null, added: null, deleted: null };
  return {
    files: measured.reduce((total, item) => total + item.files, 0),
    added: measured.reduce((total, item) => total + item.added, 0),
    deleted: measured.reduce((total, item) => total + item.deleted, 0)
  };
}

// argsObject keeps the last value of a repeated flag, which is right for --profile and wrong for a root:
// a project can have several, and quietly keeping one would run the call against less than the owner
// registered.
function repeatedArgs(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === flag && argv[index + 1] && !argv[index + 1].startsWith("--")) values.push(argv[index + 1]);
  return values;
}

function readTask(file) {
  if (!file) fail("--task-file is required");
  if (!fs.existsSync(file)) fail(`Task file not found: ${file}`);
  return fs.readFileSync(file, "utf8");
}

function runProcess(command, commandArgs, input, timeoutSec, cwd, env = process.env) {
  return new Promise((resolve) => {
    const { executable, args, windowsVerbatimArguments } = providerCommandInvocation(command, commandArgs, { env });
    const child = spawn(executable, args, { windowsHide: true, windowsVerbatimArguments, detached: process.platform !== "win32", cwd: cwd || undefined, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const signalHandlers = new Map();
    const terminateTree = () => {
      if (child.exitCode !== null) return;
      if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    };
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitWatchdog) clearInterval(exitWatchdog);
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => { timedOut = true; terminateTree(); }, timeoutSec * 1000);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        terminateTree();
        // Installing a signal handler suppresses Node's default exit. Exit the
        // gateway after forwarding cancellation so the outer supervisor cannot hang.
        setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 25).unref();
      };
      signalHandlers.set(signal, handler); process.once(signal, handler);
    }
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += error.message; finish(127); });
    // On Windows descendants may keep stdio handles open after the root CLI
    // exits. `exit` is the process-status boundary; waiting for `close` can
    // leave the gateway supervisor alive forever without a receipt.
    child.on("exit", (exitCode) => finish(exitCode));
    let exitWatchdog = setInterval(() => {
      if (child.exitCode !== null) {
        clearInterval(exitWatchdog);
        finish(child.exitCode);
      }
    }, 100);
    child.stdin.end(input ?? "");
  });
}

const cli = argsObject(process.argv.slice(2));
const command = process.argv[2];
if (!["run", "profiles-check"].includes(command)) fail("Usage: node src/cli.mjs run --provider <adapter> --level prototype|mvp|production|security-audit --task-file <file> [--project <path>] [--role <name>] --profile <name> --capability-requirements <json> | node src/cli.mjs profiles-check");

const policy = loadGatewayPolicy(paths);
function inspectProfileRequirement({ provider, profile, role = "worker", project_id: projectId = null, operational_level: operationalLevel = null, capability_requirements: capabilityRequirements }) {
  const scope = { ...(projectId ? { project_id: projectId } : {}), ...(operationalLevel ? { operational_level: operationalLevel } : {}) };
  const providerConfig = policy.providers?.[provider];
  if (!providerConfig) return { code: "PROFILE_PROVIDER_UNKNOWN", role, provider, profile, ...scope };
  if (!profile || !providerConfig.profiles?.[profile]) return { code: "PROFILE_UNKNOWN", role, provider, profile: profile ?? null, ...scope };
  const profileConfig = { ...(providerConfig.profileDefaults ?? {}), ...(providerConfig.profiles[profile] ?? {}) };
  let requirements;
  try { requirements = normalizeCapabilityRequirements(capabilityRequirements); }
  catch (error) { return { code: error.message.split(":", 1)[0], role, provider, profile, ...scope, value: capabilityRequirements ?? null }; }
  let capabilities;
  try { capabilities = profileCapabilities(provider, providerConfig, profileConfig); }
  catch (error) { return { code: error.message.split(":", 1)[0], role, provider, profile, ...scope, message: error.message }; }
  const inspection = inspectCapabilityRequirements(capabilities, requirements, { role, acceptedDeclarativeBoundaries: profileConfig.acceptedDeclarativeBoundaries });
  if (inspection.mismatches.length) return { code: "PROFILE_CAPABILITY_MISMATCH", role, provider, profile, ...scope, capability_requirements: requirements, mismatches: inspection.mismatches, profile_capabilities: capabilities };
  const accepted = inspection.accepted_declarative;
  const profileCapabilitiesReport = accepted.length
    ? Object.freeze(Object.fromEntries(Object.entries(capabilities).map(([name, value]) => [name, accepted.some(item => item.capability === name) ? Object.freeze({ ...value, boundary_acceptance: Object.freeze(accepted.find(item => item.capability === name)) }) : value])))
    : capabilities;
  return { status: accepted.length ? "accepted_declarative" : "compatible", role, provider, profile, ...scope, capability_requirements: requirements, accepted_declarative: accepted, profile_capabilities: profileCapabilitiesReport };
}

if (command === "profiles-check") {
  let requirements;
  try { requirements = JSON.parse(fs.readFileSync(0, "utf8")); }
  catch (error) { fail(`PROFILE_REQUIREMENTS_INVALID: ${error.message}`, 77); }
  if (!Array.isArray(requirements)) fail("PROFILE_REQUIREMENTS_INVALID: expected a JSON array", 77);
  const checks = requirements.map(inspectProfileRequirement);
  const admitted = new Set(["compatible", "accepted_declarative"]);
  const conflicts = checks.filter(check => !admitted.has(check.status));
  const status = conflicts.length ? "incompatible" : checks.some(check => check.status === "accepted_declarative") ? "accepted_declarative" : "compatible";
  process.stdout.write(`${JSON.stringify({ status, checks: checks.filter(check => admitted.has(check.status)), conflicts })}\n`);
  process.exit(conflicts.length ? 77 : 0);
}

fs.mkdirSync(dataRoot, { recursive: true });
cleanupConfirmedOrphans(paths.tempRoot);
const level = cli.level ?? "mvp";
const provider = cli.provider;
const limits = policy.levels[level];
const providerConfig = policy.providers[provider];
if (!limits) fail(`Unknown level: ${level}`);
if (!providerConfig) fail(`Unknown provider: ${provider}`);
const profile = cli.profile ?? null;
if (!profile) fail("PROFILE_REQUIRED: all provider calls must use a named subscription profile");
const profileConfig = { ...(providerConfig.profileDefaults ?? {}), ...(providerConfig.profiles?.[profile] ?? {}) };
if (!providerConfig.profiles?.[profile]) fail(`Unknown profile '${profile}' for provider '${provider}'`);
let capabilityRequirements;
try { capabilityRequirements = JSON.parse(String(cli["capability-requirements"] ?? "")); }
catch { fail(`PROFILE_CAPABILITY_REQUIREMENTS_INVALID: role=${cli.role ?? "worker"}; profile=${profile}; value=${cli["capability-requirements"] ?? "missing"}`, 77); }
const requirement = inspectProfileRequirement({ provider, profile, role: cli.role ?? "worker", capability_requirements: capabilityRequirements });
if (!["compatible", "accepted_declarative"].includes(requirement.status)) fail(`${requirement.code}: role=${requirement.role}; profile=${requirement.profile}; mismatches=${JSON.stringify(requirement.mismatches ?? [])}`, 77);
const profileCapabilityReport = requirement.profile_capabilities;
const privacyMode = String(cli["privacy-mode"] ?? DEFAULT_PRIVACY_MODE);
if (privacyMode !== DEFAULT_PRIVACY_MODE) fail(`RECEIPT_PRIVACY_MODE_UNSUPPORTED: ${privacyMode}`);

const task = readTask(cli["task-file"]);
const database = openGatewayDb(databasePath);
const receiptId = `${new Date().toISOString().replaceAll(":", "-")}-${provider}-${crypto.randomUUID()}`;
const taskId = cli.task ?? path.basename(cli["task-file"]);
const previous = database.prepare("SELECT finished_at AS finishedAt FROM receipts WHERE task_id = ? ORDER BY finished_at").all(taskId);
if (previous.length >= limits.maxCalls) fail(`MODEL_BUDGET_EXHAUSTED: task ${taskId} already used ${previous.length}/${limits.maxCalls} calls`, 3);
const correctionCycles = Number(cli["correction-cycle"] ?? 0);
if (!Number.isInteger(correctionCycles) || correctionCycles < 0 || correctionCycles > limits.maxCorrectionCycles) fail(`CORRECTION_BUDGET_EXCEEDED: ${correctionCycles}/${limits.maxCorrectionCycles}`, 3);
const startedAt = new Date().toISOString();
const idleSince = previous.map((receipt) => receipt.finishedAt).filter(Boolean).sort().at(-1) ?? null;
const idleMs = idleSince ? Math.max(0, Date.parse(startedAt) - Date.parse(idleSince)) : null;
const prompt = [
  `ROLE: ${cli.role ?? "worker"}`,
  `LEVEL: ${level}`,
  `CORRECTION_CYCLE: ${correctionCycles}`,
  `PROJECT: ${cli.project ?? "unspecified"}`,
  `LIMIT: one bounded invocation; do not launch other agents.`,
  "TASK:",
  task
].join("\n");
const systemPrompt = [
  `You are a bounded ${cli.role ?? "worker"} for the ${level} delivery level.`,
  `Work only inside the supplied project directories and follow their native instructions (${profileConfig.instructionMode ?? "native project instructions"}).`,
  "Do not launch another AI agent, commit, push, deploy, or access production.",
  profileConfig.browserMcpServer ? `Use only the registered ${profileConfig.browserMcpServer} MCP server for optional browser automation; its observations do not replace deterministic project checks or owner acceptance.` : "",
  profileConfig.readOnly ? "This profile is read-only: do not edit or write files." : ""
].filter(Boolean).join(" ");
const maxTurns = String(profileConfig.maxTurns ?? 10);
const replaceArg = (arg) => {
  if (arg === "{prompt}") return prompt;
  if (arg === "{profile}") return profile;
  if (arg === "{model}") return profileConfig.model ?? "";
  if (arg === "{maxTurns}") return maxTurns;
  if (arg === "{systemPrompt}") return systemPrompt;
  if (arg === "{agent}") return profileConfig.agent ?? "gateway";
  if (arg === "{project}") return cli.project ?? "";
  return arg;
};
const commandArgs = (providerConfig.args ?? []).map(replaceArg);
const providerCommand = providerConfig.type === "openai-compatible" ? null : resolveProviderCommand(providerConfig);
const outputSchema = cli["output-schema"] ? path.resolve(String(cli["output-schema"])) : null;
let outputSchemaValue = null;
if (outputSchema) {
  if (!fs.existsSync(outputSchema) || !fs.statSync(outputSchema).isFile()) fail(`OUTPUT_SCHEMA_NOT_FOUND: ${outputSchema}`);
  if (fs.statSync(outputSchema).size > 1024 * 1024) fail(`OUTPUT_SCHEMA_TOO_LARGE: ${outputSchema}`);
  try { outputSchemaValue = JSON.parse(fs.readFileSync(outputSchema, "utf8")); }
  catch (error) { fail(`OUTPUT_SCHEMA_INVALID_JSON: ${error.message}`); }
  if (!outputSchemaValue || typeof outputSchemaValue !== "object" || Array.isArray(outputSchemaValue)) fail(`OUTPUT_SCHEMA_INVALID: ${outputSchema}`);
  if (providerConfig.outputSchemaArg) commandArgs.push(providerConfig.outputSchemaArg, outputSchema);
}
if (provider === "claude") {
  for (const tool of profileConfig.allowedTools ?? []) commandArgs.push("--allowedTools", tool);
  for (const tool of profileConfig.disallowedTools ?? []) commandArgs.push("--disallowedTools", tool);
}
if (provider === "opencode" && profileConfig.readOnly !== true) commandArgs.push("--auto");
if (provider === "cursor" && profileConfig.readOnly !== true) commandArgs.push("--force");
const projectPath = cli.project ? path.resolve(cli.project) : undefined;
if (projectPath && !fs.existsSync(projectPath)) fail(`PROJECT_NOT_FOUND: ${projectPath}`);
// A project may hold more than one writable root. The provider is told about each one through its own
// additional-directory flag, and a provider that has no such flag is not silently run against a project
// it cannot reach: the call fails and says so.
const writeDirs = repeatedArgs(process.argv.slice(2), "--write-dir").map(value => path.resolve(value)).filter(value => value !== projectPath);
for (const directory of writeDirs) if (!fs.existsSync(directory)) fail(`WRITE_ROOT_NOT_FOUND: ${directory}`);
if (writeDirs.length) {
  const flag = providerConfig.additionalDirectoryArg;
  if (!flag) fail(`PROVIDER_HAS_NO_ADDITIONAL_DIRECTORY_FLAG: ${provider}`, 78);
  for (const directory of writeDirs) commandArgs.push(flag, directory);
}
if (cli["dry-run"] === true) {
  process.stdout.write(`${JSON.stringify({ provider, modelProvider: inferredModelProvider(provider, profileConfig), level, profile, type: providerConfig.type ?? "cli", command: providerCommand, args: commandArgs.map((arg) => arg === prompt ? "<prompt>" : arg), limits })}\n`);
  process.exit(0);
}
const sourceHome = provider === "codex" ? paths.codexSourceHome : provider === "kimi" ? paths.kimiSourceHome : provider === "opencode" ? paths.opencodeSourceHome : null;
const sourceConfig = provider === "claude" ? paths.claudeSourceMcpConfig : provider === "opencode" ? paths.opencodeSourceConfig : null;
let result;
// What the ephemeral home gave the provider, and what it withheld, is part of the call: a role that ran
// without the server or the skill it needed produced a different result from the same prompt, and the
// receipt is the only place that difference is ever recorded.
let environment = { profile_capabilities: profileCapabilityReport, provider_environment: null };
try {
  result = providerConfig.type === "openai-compatible"
    ? await runOpenAICompatible({ profileConfig, prompt, systemPrompt, outputSchema: outputSchemaValue, outputSchemaName: `${cli.role ?? "worker"}_result`, timeoutSec: limits.timeoutSec, env: process.env })
    : await withProviderEnvironment(provider, { tempRoot: paths.tempRoot, sourceHome, sourceConfig, profileConfig, projectRoot: projectPath }, (providerEnvironment, _directory, capabilities) => {
      environment = { profile_capabilities: profileCapabilityReport, provider_environment: capabilities };
      if (profileConfig.browserMcpServer && !capabilities?.mcp_servers?.carried?.some(item => item.name === profileConfig.browserMcpServer)) {
        throw new Error(`BROWSER_MCP_SERVER_NOT_CARRIED: ${profileConfig.browserMcpServer}`);
      }
      const runtimeArgs = provider === "claude" && providerEnvironment.AGENT_GATEWAY_CLAUDE_MCP_CONFIG
        ? [...commandArgs, "--mcp-config", providerEnvironment.AGENT_GATEWAY_CLAUDE_MCP_CONFIG, "--strict-mcp-config"]
        : commandArgs;
      return runProcess(providerCommand, runtimeArgs, prompt, limits.timeoutSec, projectPath, providerEnvironment);
    });
} catch (error) {
  const profileMismatch = String(error.message).startsWith("BROWSER_MCP_SERVER_NOT_CARRIED:");
  result = {
    exitCode: profileMismatch ? 77 : 78,
    stdout: "",
    stderr: profileMismatch ? `PROFILE_CAPABILITY_MISMATCH: ${error.message}` : `ADAPTER_CONFIGURATION_ERROR: ${error.message}`,
    timedOut: false
  };
}
const stats = combinedDiffStats([projectPath, ...writeDirs].filter(Boolean));
const usage = normalizeUsage(extractUsage(result.stdout, provider));
const sessionId = usage?.session_id ?? extractSessionId(`${result.stdout}\n${result.stderr}`);
const finishedAt = new Date().toISOString();
const status = result.timedOut ? "timed_out" : result.exitCode === 0 ? "completed" : "failed";
const failureCategory = cli["failure-category"] ?? (result.timedOut ? "timeout" : result.exitCode === 0 ? null : "provider_exit");
const receipt = {
  receiptId, taskId, provider, profile, level, role: cli.role ?? "worker",
  harness: provider,
  supportsCancel: true,
  cancelMode: "process_tree",
  modelProvider: cli["model-provider"] ?? inferredModelProvider(provider, profileConfig),
  workflowRunId: cli["workflow-run"] ?? null,
  attemptNo: Number(cli.attempt ?? correctionCycles + 1),
  project: cli.project ?? null, startedAt, finishedAt, idleMs,
  calls: 1, correctionCycles, retries: 0, timedOut: result.timedOut,
  exitCode: result.exitCode, status,
  usage, output: compact(result.stdout), error: compact(result.stderr, 6000),
  failureCategory,
  contextBytes: Buffer.byteLength(prompt), diffFiles: stats.files, diffAddedLines: stats.added,
  diffDeletedLines: stats.deleted, cacheHitRatio: usage?.input_tokens ? (usage.cached_input_tokens ?? 0) / usage.input_tokens : null,
  model: cli.model ?? profileConfig.model ?? null,
  reasoningEffort: cli["reasoning-effort"] ?? profileConfig.reasoningEffort ?? null,
  sessionId,
  contractHash: crypto.createHash("sha256").update(prompt).digest("hex"),
  resultHash: crypto.createHash("sha256").update(`${result.stdout}\n${result.stderr}`).digest("hex"),
  artifactRef: cli["artifact-ref"] ?? null,
  decisionRef: cli["decision-ref"] ?? null,
  privacyMode,
  persistenceAttestation: privacyAttestation(privacyMode),
  environment
};
if (!Number.isInteger(receipt.attemptNo) || receipt.attemptNo < 1) fail(`ATTEMPT_NUMBER_INVALID: ${receipt.attemptNo}`);
const storedReceipt = {
  receipt_id: receipt.receiptId,
  task_id: receipt.taskId,
  workflow_run_id: receipt.workflowRunId,
  attempt_no: receipt.attemptNo,
  project: receipt.project,
  provider: receipt.provider,
  model_provider: receipt.modelProvider,
  profile: receipt.profile,
  level: receipt.level,
  role: receipt.role,
  started_at: receipt.startedAt,
  finished_at: receipt.finishedAt,
  idle_ms: receipt.idleMs,
  calls: receipt.calls,
  correction_cycles: receipt.correctionCycles,
  retries: receipt.retries,
  timed_out: receipt.timedOut ? 1 : 0,
  exit_code: receipt.exitCode,
  status: receipt.status,
  failure_category: receipt.failureCategory,
  error_summary: receipt.status === "completed" ? null : `${receipt.failureCategory ?? "provider_failure"}; exit_code=${receipt.exitCode}; timed_out=${receipt.timedOut}`,
  usage_json: receipt.usage ? JSON.stringify(receipt.usage) : null,
  input_tokens: receipt.usage?.input_tokens ?? null,
  cached_input_tokens: receipt.usage?.cached_input_tokens ?? null,
  cache_write_input_tokens: receipt.usage?.cache_write_input_tokens ?? null,
  cache_read_input_tokens: receipt.usage?.cache_read_input_tokens ?? null,
  cache_creation_input_tokens: receipt.usage?.cache_creation_input_tokens ?? null,
  cost_usd: receipt.usage?.cost_usd ?? null,
  output_tokens: receipt.usage?.output_tokens ?? null,
  reasoning_output_tokens: receipt.usage?.reasoning_output_tokens ?? null,
  total_tokens: receipt.usage?.total_tokens ?? null,
  duration_ms: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt),
  num_turns: receipt.usage?.num_turns ?? null,
  session_id: receipt.sessionId,
  service_tier: receipt.usage?.service_tier ?? null,
  speed: receipt.usage?.speed ?? null,
  context_bytes: receipt.contextBytes,
  diff_files: receipt.diffFiles,
  diff_added_lines: receipt.diffAddedLines,
  diff_deleted_lines: receipt.diffDeletedLines,
  cache_hit_ratio: receipt.cacheHitRatio,
  model: receipt.model,
  reasoning_effort: receipt.reasoningEffort,
  contract_hash: receipt.contractHash,
  result_hash: receipt.resultHash,
  artifact_ref: receipt.artifactRef,
  decision_ref: receipt.decisionRef,
  environment_json: receipt.environment ? JSON.stringify(receipt.environment) : null,
  privacy_mode: receipt.privacyMode,
  persistence_attestation_json: JSON.stringify(receipt.persistenceAttestation)
};
assertMetadataOnlyReceipt(storedReceipt, { prompt, stdout: result.stdout, stderr: result.stderr });
const storedColumns = Object.keys(storedReceipt);
database.prepare(`INSERT INTO receipts (${storedColumns.join(",")}) VALUES (${storedColumns.map(() => "?").join(",")})`)
  .run(...Object.values(storedReceipt));
process.stdout.write(`${JSON.stringify(receipt)}\n`);
database.close();
// On Windows a provider descendant can keep inherited stdio handles open
// after the receipt has been persisted. The Gateway contract ends here;
// do not make Workflow Platform wait for those detached handles.
process.exit(result.exitCode);
