import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function argsObject(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    result[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

function fail(message, code = 1) { process.stderr.write(`${message}\n`); process.exit(code); }
function parsedJson(text) { try { return JSON.parse(String(text).trim()); } catch { return null; } }
function parsedReceipt(text) {
  for (const line of String(text ?? "").trim().split(/\r?\n/u).filter(Boolean).reverse()) {
    const value = parsedJson(line);
    if (value?.receiptId) return value;
  }
  return null;
}
function extractModelText(text) {
  const direct = parsedJson(text);
  if (typeof direct?.result === "string") return direct.result;
  if (typeof direct?.text === "string") return direct.text;
  if (typeof direct?.item?.text === "string") return direct.item.text;
  for (const line of String(text ?? "").split(/\r?\n/u).reverse()) {
    const value = parsedJson(line);
    if (typeof value?.result === "string") return value.result;
    if (typeof value?.text === "string") return value.text;
    if (typeof value?.item?.text === "string") return value.item.text;
  }
  return String(text ?? "").trim();
}

const cli = argsObject(process.argv.slice(2));
const project = path.resolve(String(cli.project ?? ""));
const sourcePolicy = path.resolve(String(cli.policy ?? ""));
const sourceProfile = String(cli.profile ?? "");
const plugin = String(cli.plugin ?? "browser@openai-bundled");
const capture = String(cli.capture ?? "true") !== "false";
const gateway = path.resolve(String(cli.gateway ?? path.join(import.meta.dirname, "..", "AgentGateway", "src", "cli.mjs")));
if (!cli.project || !fs.statSync(project, { throwIfNoEntry: false })?.isDirectory()) fail("BROWSER_SMOKE_PROJECT_REQUIRED", 2);
if (!cli.policy || !fs.statSync(sourcePolicy, { throwIfNoEntry: false })?.isFile()) fail("BROWSER_SMOKE_POLICY_REQUIRED", 2);
if (!sourceProfile) fail("BROWSER_SMOKE_PROFILE_REQUIRED", 2);
if (!fs.statSync(gateway, { throwIfNoEntry: false })?.isFile()) fail(`BROWSER_SMOKE_GATEWAY_MISSING: ${gateway}`, 2);

const localPolicy = JSON.parse(fs.readFileSync(sourcePolicy, "utf8"));
const profile = localPolicy.providers?.codex?.profiles?.[sourceProfile];
if (!profile) fail(`BROWSER_SMOKE_PROFILE_UNKNOWN: ${sourceProfile}`, 2);
if (profile.readOnly === true) fail(`BROWSER_SMOKE_PROFILE_READ_ONLY: ${sourceProfile}`, 2);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-codex-browser-smoke-"));
const policyFile = path.join(root, "policy.local.json"), taskFile = path.join(root, "task.md"), schemaFile = path.join(root, "result.schema.json"), database = path.join(root, "gateway.sqlite");
const probeProfile = `browser-smoke-${crypto.randomUUID()}`;
const sentinel = `zodchi-browser-${crypto.randomUUID()}`;
const title = `Zodchi ${sentinel}`;
const body = `Body ${sentinel}`;
const dataUrl = `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title><main>${body}</main>`)}`;
const browserLabel = plugin.startsWith("chrome@") ? "Chrome" : "the in-app Browser";
const overlay = {
  schemaVersion: localPolicy.schemaVersion ?? 1,
  kind: "profile-overlay",
  providers: { codex: { profiles: { [probeProfile]: { ...profile, readOnly: false, allowedPlugins: [plugin], allowedMcpServers: ["node_repl"] } } } }
};
const task = [
  `Use ${browserLabel} through the allowed ${plugin} plugin to open this exact URL: ${dataUrl}`,
  "Follow the installed control-in-app-browser skill exactly: use only the node_repl js tool, select the requested browser with agent.browsers, read its complete documentation, and then use the documented tab.playwright API.",
  "Do not import or require Playwright, browser-client, or any npm package directly.",
  capture ? "Read the rendered document title and main text through Playwright, take one screenshot through that same browser surface, and close the tab." : "Read the rendered document title and main text through Playwright and close the tab. Do not take a screenshot in this probe.",
  "Do not use a shell, subprocess, HTTP client, or another agent. Do not create or modify project files.",
  `Return only the required structured result. Set screenshot=${capture ? "true only after the screenshot call succeeds" : "false"}.`
].join("\n");
const schema = {
  type: "object", additionalProperties: false, required: ["status", "title", "body", "screenshot", "evidence"],
  properties: {
    status: { type: "string", enum: ["observed", "unavailable", "blocked", "failed"] },
    title: { type: ["string", "null"] }, body: { type: ["string", "null"] }, screenshot: { type: "boolean" }, evidence: { type: "string" }
  }
};
fs.writeFileSync(policyFile, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
fs.writeFileSync(taskFile, task, "utf8");
fs.writeFileSync(schemaFile, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

try {
  const requirements = JSON.stringify({ required: ["context_input", "project_write", "browser_automation", ...(capture ? ["screen_capture"] : [])], forbidden: [] });
  const child = spawnSync(process.execPath, [gateway, "run", "--provider", "codex", "--profile", probeProfile, "--level", "prototype", "--role", "browser_worker", "--capability-requirements", requirements, "--task-file", taskFile, "--output-schema", schemaFile, "--project", project, "--task", `codex-browser-smoke-${crypto.randomUUID()}`], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, AGENT_GATEWAY_POLICY: policyFile, AGENT_GATEWAY_DB: database, AGENT_GATEWAY_DATA: root, AGENT_GATEWAY_TEMP: path.join(root, "temp") }
  });
  const receipt = parsedReceipt(child.stdout);
  let modelResult = null;
  try { modelResult = JSON.parse(extractModelText(receipt?.output)); } catch { /* reported below */ }
  const carriedPlugins = receipt?.environment?.provider_environment?.plugins?.carried?.map(item => item.id) ?? [];
  const carriedMcp = receipt?.environment?.provider_environment?.mcp_servers?.carried?.map(item => item.name) ?? [];
  const providerError = String(receipt?.error ?? child.stderr ?? "").trim().replaceAll(root, "<probe-root>").replaceAll(os.tmpdir(), "<system-temp>").slice(0, 4000);
  const confirmed = receipt?.status === "completed" && modelResult?.status === "observed" && modelResult.title === title && modelResult.body === body && modelResult.screenshot === capture && carriedPlugins.includes(plugin) && carriedMcp.includes("node_repl");
  const modelReportedUnavailable = receipt?.status === "completed" && ["unavailable", "blocked", "failed"].includes(modelResult?.status) && carriedPlugins.includes(plugin) && carriedMcp.includes("node_repl");
  const report = {
    probe: capture ? "codex_browser_worker_capture" : "codex_browser_worker", status: confirmed ? "browser_confirmed" : modelReportedUnavailable ? "model_reported_unavailable" : "inconclusive", receipt_id: receipt?.receiptId ?? null,
    gateway_exit_code: child.status, provider_status: receipt?.status ?? null, plugin, expected: { title, body },
    reported: modelResult, carried_plugins: carriedPlugins, carried_mcp_servers: carriedMcp,
    provider_error: providerError, temporary_database: cli.keep ? "<probe-root>/gateway.sqlite" : null
  };
  if (cli.report) fs.writeFileSync(path.resolve(String(cli.report)), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!confirmed) process.exitCode = 3;
} finally {
  if (!cli.keep) fs.rmSync(root, { recursive: true, force: true });
}
