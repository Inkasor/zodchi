import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { loadGatewayPolicy } from "../AgentGateway/src/policy.mjs";
import { readBrowserSentinelEvidence, startBrowserSentinel } from "./browser-sentinel.mjs";

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
function screenshotEvidence(file) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return { status: "unknown", enforcement: "unknown", source: "artifact_missing", artifact: null };
  const content = fs.readFileSync(file), signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (content.length < signature.length || !content.subarray(0, signature.length).equals(signature)) return { status: "unknown", enforcement: "unknown", source: "artifact_not_png", artifact: null };
  return {
    status: "available",
    enforcement: "technical",
    source: "retained_png_artifact",
    artifact: { path: "<probe-root>/browser-proof.png", bytes: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") }
  };
}

const cli = argsObject(process.argv.slice(2));
const project = path.resolve(String(cli.project ?? ""));
const policyPath = path.resolve(String(cli.policy ?? ""));
const provider = String(cli.provider ?? "");
const profileName = String(cli.profile ?? "");
const capture = String(cli.capture ?? "true") !== "false";
const gatewayRoot = path.resolve(import.meta.dirname, "..", "AgentGateway");
const gateway = path.resolve(String(cli.gateway ?? path.join(gatewayRoot, "src", "cli.mjs")));
if (!cli.project || !fs.statSync(project, { throwIfNoEntry: false })?.isDirectory()) fail("MCP_BROWSER_SMOKE_PROJECT_REQUIRED", 2);
if (!cli.policy || !fs.statSync(policyPath, { throwIfNoEntry: false })?.isFile()) fail("MCP_BROWSER_SMOKE_POLICY_REQUIRED", 2);
if (!new Set(["codex", "claude", "opencode"]).has(provider)) fail(`MCP_BROWSER_SMOKE_PROVIDER_UNSUPPORTED: ${provider}`, 2);
if (!profileName) fail("MCP_BROWSER_SMOKE_PROFILE_REQUIRED", 2);
if (!fs.statSync(gateway, { throwIfNoEntry: false })?.isFile()) fail(`MCP_BROWSER_SMOKE_GATEWAY_MISSING: ${gateway}`, 2);
const policy = loadGatewayPolicy({ root: gatewayRoot, policyPath });
const profile = policy.providers?.[provider]?.profiles?.[profileName];
if (!profile) fail(`MCP_BROWSER_SMOKE_PROFILE_UNKNOWN: ${provider}/${profileName}`, 2);
const server = profile.browserMcpServer;
if (typeof server !== "string" || !(profile.allowedMcpServers ?? []).includes(server)) fail(`MCP_BROWSER_SMOKE_CONTOUR_REQUIRED: ${provider}/${profileName}`, 2);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-mcp-browser-smoke-"));
const taskFile = path.join(root, "task.md"), schemaFile = path.join(root, "result.schema.json"), database = path.join(root, "gateway.sqlite"), requestLog = path.join(root, "sentinel-requests.jsonl"), screenshotFile = path.join(root, "browser-proof.png");
const route = `/zodchi-browser-${crypto.randomUUID()}`, title = `Zodchi ${crypto.randomUUID()}`, body = `Body ${crypto.randomUUID()}`, resourceToken = crypto.randomUUID();
const sentinel = await startBrowserSentinel({ route, title, body, requestLog, resourceToken });
const task = [
  `Use only the registered ${server} MCP server to navigate a real browser to this exact local URL: ${sentinel.url}`,
  "Read the rendered document title and main text after the page script executes.",
  capture ? `Save one PNG screenshot through that MCP server to this exact absolute path: ${screenshotFile}` : "Do not take a screenshot in this probe.",
  "Do not use a shell, subprocess, direct HTTP client, desktop browser plugin, or another agent.",
  "Return only the required structured result."
].join("\n");
const schema = {
  type: "object", additionalProperties: false, required: ["status", "title", "body", "screenshot", "evidence"],
  properties: {
    status: { type: "string", enum: ["observed", "unavailable", "blocked", "failed"] },
    title: { type: ["string", "null"] }, body: { type: ["string", "null"] }, screenshot: { type: "boolean" }, evidence: { type: "string" }
  }
};
fs.writeFileSync(taskFile, task, "utf8");
fs.writeFileSync(schemaFile, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

try {
  const requirements = JSON.stringify({ required: ["context_input"], forbidden: [] });
  const child = spawnSync(process.execPath, [gateway, "run", "--provider", provider, "--profile", profileName, "--level", "prototype", "--role", "worker", "--capability-requirements", requirements, "--task-file", taskFile, "--output-schema", schemaFile, "--project", project, "--task", `mcp-browser-smoke-${crypto.randomUUID()}`], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, AGENT_GATEWAY_POLICY: policyPath, AGENT_GATEWAY_DB: database, AGENT_GATEWAY_DATA: root, AGENT_GATEWAY_TEMP: path.join(root, "temp") }
  });
  const receipt = parsedReceipt(child.stdout);
  let modelResult = null;
  try { modelResult = JSON.parse(extractModelText(receipt?.output)); } catch { /* represented as inconclusive */ }
  const carried = receipt?.environment?.provider_environment?.mcp_servers?.carried?.map(item => item.name) ?? [];
  const sentinelEvidence = readBrowserSentinelEvidence(requestLog, sentinel.routes);
  const browserConfirmed = receipt?.status === "completed" && modelResult?.status === "observed" && modelResult.title === title && modelResult.body === body && sentinelEvidence.confirmed && carried.includes(server);
  const captureEvidence = capture ? screenshotEvidence(screenshotFile) : { status: "not_probed", enforcement: "none", source: "capture_disabled", artifact: null };
  const modelReportedUnavailable = receipt?.status === "completed" && ["unavailable", "blocked", "failed"].includes(modelResult?.status) && carried.includes(server);
  const report = {
    schema_version: 1,
    finding: "The MCP smoke observes the browser request sequence and retained screenshot artifact independently, but a deliberately adversarial writable profile can still replay requests or forge a PNG. Deterministic WorkflowPlatform checks and owner acceptance remain separate authorities.",
    probe: "registered_mcp_browser",
    status: browserConfirmed ? "browser_confirmed" : modelReportedUnavailable ? "model_reported_unavailable" : "inconclusive",
    provider, profile: profileName, browser_mcp_server: server, receipt_id: receipt?.receiptId ?? null, gateway_exit_code: child.status, provider_status: receipt?.status ?? null,
    expected: { title, body }, reported: modelResult,
    capability_evidence: {
      browser_automation: { status: browserConfirmed ? "available" : "unknown", enforcement: browserConfirmed ? "technical" : "unknown", source: "sentinel_request_sequence" },
      screen_capture: browserConfirmed ? captureEvidence : { status: "unknown", enforcement: "unknown", source: "browser_not_confirmed", artifact: null }
    },
    sentinel_evidence: sentinelEvidence,
    carried_mcp_servers: carried,
    provider_error: String(receipt?.error ?? child.stderr ?? "").trim().replaceAll(root, "<probe-root>").replaceAll(os.tmpdir(), "<system-temp>").slice(0, 4000),
    database_retained: cli.keep === true,
    temporary_database: cli.keep === true ? "<probe-root>/gateway.sqlite" : null
  };
  if (cli.report) fs.writeFileSync(path.resolve(String(cli.report)), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!browserConfirmed) process.exitCode = 3;
} finally {
  sentinel.child.kill();
  if (cli.keep !== true) fs.rmSync(root, { recursive: true, force: true });
}
