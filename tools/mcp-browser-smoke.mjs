import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { loadGatewayPolicy } from "../AgentGateway/src/policy.mjs";
import { readBrowserSentinelEvidence, startBrowserSentinel } from "./browser-sentinel.mjs";

const PROBE_VIEWPORT = Object.freeze({ width: 800, height: 600 });

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
function parseStructuredModelResult(text) {
  const parseCandidate = value => {
    if (value && typeof value === "object" && !Array.isArray(value) && ["observed", "unavailable", "blocked", "failed"].includes(value.status)) return value;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    const direct = parsedJson(trimmed);
    if (direct) return parseCandidate(direct);
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1];
    if (fenced) return parseCandidate(fenced);
    const first = trimmed.indexOf("{"), last = trimmed.lastIndexOf("}");
    return first >= 0 && last > first ? parseCandidate(trimmed.slice(first, last + 1)) : null;
  };
  const values = [];
  const collect = value => {
    if (value === null || value === undefined) return;
    values.push(value);
    if (value && typeof value === "object" && !Array.isArray(value)) values.push(value.structured_output, value.result, value.text, value.item?.text);
  };
  collect(parsedJson(text));
  for (const line of String(text ?? "").split(/\r?\n/u).reverse()) collect(parsedJson(line));
  collect(String(text ?? "").trim());
  for (const value of values) {
    const parsed = parseCandidate(value);
    if (parsed) return parsed;
  }
  return null;
}
function portableReportValue(value, replacements) {
  if (typeof value === "string") return replacements.reduce((text, [source, replacement]) => text.replaceAll(source, replacement).replaceAll(source.replaceAll("\\", "/"), replacement), value);
  if (Array.isArray(value)) return value.map(item => portableReportValue(item, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portableReportValue(item, replacements)]));
  return value;
}
function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left), upDistance = Math.abs(estimate - up), upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
}
function decodePngPixels(content) {
  const width = content.readUInt32BE(16), height = content.readUInt32BE(20), bitDepth = content[24], colorType = content[25], interlace = content[28];
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) throw new Error("PNG_PIXEL_FORMAT_UNSUPPORTED");
  const chunks = [];
  for (let offset = 8; offset + 12 <= content.length;) {
    const length = content.readUInt32BE(offset), type = content.subarray(offset + 4, offset + 8).toString("ascii"), end = offset + 12 + length;
    if (end > content.length) throw new Error("PNG_CHUNK_TRUNCATED");
    if (type === "IDAT") chunks.push(content.subarray(offset + 8, offset + 8 + length));
    offset = end;
  }
  if (chunks.length === 0) throw new Error("PNG_IDAT_MISSING");
  const channels = colorType === 2 ? 3 : 4, stride = width * channels, encoded = zlib.inflateSync(Buffer.concat(chunks));
  if (encoded.length !== height * (stride + 1)) throw new Error("PNG_SCANLINES_INVALID");
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const encodedOffset = y * (stride + 1), rowOffset = y * stride, filter = encoded[encodedOffset];
    if (filter > 4) throw new Error("PNG_FILTER_UNSUPPORTED");
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[encodedOffset + 1 + x], left = x >= channels ? pixels[rowOffset + x - channels] : 0, up = y > 0 ? pixels[rowOffset - stride + x] : 0, upperLeft = y > 0 && x >= channels ? pixels[rowOffset - stride + x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paethPredictor(left, up, upperLeft);
      pixels[rowOffset + x] = (raw + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}
function screenshotContainsMarker(decoded, marker) {
  for (const scale of [1, 2, 3]) {
    const right = (marker.left + marker.columns * marker.cellSize) * scale, bottom = (marker.top + marker.rows * marker.cellSize) * scale;
    if (right > decoded.width || bottom > decoded.height) continue;
    const matched = marker.bits.every((bit, index) => {
      const column = index % marker.columns, row = Math.floor(index / marker.columns);
      const x = Math.floor((marker.left + column * marker.cellSize + marker.cellSize / 2) * scale), y = Math.floor((marker.top + row * marker.cellSize + marker.cellSize / 2) * scale);
      const pixel = (y * decoded.width + x) * decoded.channels;
      return marker.colors[bit].every((channel, channelIndex) => decoded.pixels[pixel + channelIndex] === channel);
    });
    if (matched) return { matched: true, scale };
  }
  return { matched: false, scale: null };
}
function screenshotEvidence(file, marker, artifactPath = "<probe-root>/browser-proof.png") {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return { status: "unknown", enforcement: "unknown", source: "artifact_missing", artifact: null };
  const content = fs.readFileSync(file), signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (content.length < signature.length || !content.subarray(0, signature.length).equals(signature)) return { status: "unknown", enforcement: "unknown", source: "artifact_not_png", artifact: null };
  if (content.length < 24 || content.subarray(12, 16).toString("ascii") !== "IHDR") return { status: "unknown", enforcement: "unknown", source: "artifact_png_ihdr_missing", artifact: null };
  const width = content.readUInt32BE(16), height = content.readUInt32BE(20);
  if (width < PROBE_VIEWPORT.width || height < PROBE_VIEWPORT.height) {
    return { status: "unknown", enforcement: "unknown", source: "artifact_below_probe_viewport", artifact: { path: artifactPath, bytes: content.length, width, height, sha256: crypto.createHash("sha256").update(content).digest("hex") } };
  }
  let markerMatch;
  try { markerMatch = screenshotContainsMarker(decodePngPixels(content), marker); }
  catch (error) {
    return { status: "unknown", enforcement: "unknown", source: "artifact_pixels_unverifiable", artifact: { path: artifactPath, bytes: content.length, width, height, sha256: crypto.createHash("sha256").update(content).digest("hex"), marker_sha256: marker.sha256, detail: error.message } };
  }
  if (!markerMatch.matched) {
    return { status: "unknown", enforcement: "unknown", source: "sentinel_marker_missing", artifact: { path: artifactPath, bytes: content.length, width, height, sha256: crypto.createHash("sha256").update(content).digest("hex"), marker_sha256: marker.sha256 } };
  }
  return {
    status: "available",
    enforcement: "technical",
    source: "retained_sentinel_png_artifact",
    artifact: { path: artifactPath, bytes: content.length, width, height, sha256: crypto.createHash("sha256").update(content).digest("hex"), marker_sha256: marker.sha256, marker_scale: markerMatch.scale }
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
const taskFile = path.join(root, "task.md"), schemaFile = path.join(root, "result.schema.json"), database = path.join(root, "gateway.sqlite"), requestLog = path.join(root, "sentinel-requests.jsonl");
const screenshotFile = cli.screenshot ? path.resolve(String(cli.screenshot)) : path.join(root, "browser-proof.png");
const screenshotRelative = path.relative(project, screenshotFile);
if (cli.screenshot && (screenshotRelative.startsWith("..") || path.isAbsolute(screenshotRelative))) fail(`MCP_BROWSER_SMOKE_SCREENSHOT_OUTSIDE_PROJECT: ${screenshotFile}`, 2);
if (!fs.statSync(path.dirname(screenshotFile), { throwIfNoEntry: false })?.isDirectory()) fail(`MCP_BROWSER_SMOKE_SCREENSHOT_PARENT_MISSING: ${path.dirname(screenshotFile)}`, 2);
if (fs.existsSync(screenshotFile)) fail(`MCP_BROWSER_SMOKE_SCREENSHOT_EXISTS: ${screenshotFile}`, 2);
const screenshotArtifactPath = cli.screenshot ? screenshotRelative.replaceAll("\\", "/") : "<probe-root>/browser-proof.png";
const route = `/zodchi-browser-${crypto.randomUUID()}`, title = `Zodchi ${crypto.randomUUID()}`, body = `Body ${crypto.randomUUID()}`, resourceToken = crypto.randomUUID();
const sentinel = await startBrowserSentinel({ route, title, body, requestLog, resourceToken });
const task = [
  `Use only the registered ${server} MCP server to navigate a real browser to this exact local URL: ${sentinel.url}`,
  `Set the browser viewport to at least ${PROBE_VIEWPORT.width}x${PROBE_VIEWPORT.height} before capture.`,
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
  const modelResult = parseStructuredModelResult(receipt?.output);
  const carried = receipt?.environment?.provider_environment?.mcp_servers?.carried?.map(item => item.name) ?? [];
  const sentinelEvidence = readBrowserSentinelEvidence(requestLog, sentinel.routes);
  const browserConfirmed = receipt?.status === "completed" && modelResult?.status === "observed" && modelResult.title === title && modelResult.body === body && sentinelEvidence.confirmed && carried.includes(server);
  const captureEvidence = capture ? screenshotEvidence(screenshotFile, sentinel.screenshotMarker, screenshotArtifactPath) : { status: "not_probed", enforcement: "none", source: "capture_disabled", artifact: null };
  const modelReportedUnavailable = receipt?.status === "completed" && ["unavailable", "blocked", "failed"].includes(modelResult?.status) && carried.includes(server);
  const portableReported = portableReportValue(modelResult, [[project, "<project>"], [root, "<probe-root>"], [os.tmpdir(), "<system-temp>"]]);
  const report = {
    schema_version: 2,
    finding: "The MCP smoke independently observes the browser request sequence and verifies that the retained PNG contains a random sentinel marker. A deliberately adversarial writable profile can still emulate the protocol and forge both signals, so this is bounded capability evidence rather than a deterministic project gate or owner acceptance.",
    probe: "registered_mcp_browser",
    registration_scope: "isolated_probe_policy",
    status: browserConfirmed ? "browser_confirmed" : modelReportedUnavailable ? "model_reported_unavailable" : "inconclusive",
    provider, profile: profileName, browser_mcp_server: server, receipt_id: receipt?.receiptId ?? null, gateway_exit_code: child.status, provider_status: receipt?.status ?? null,
    expected: { title, body }, reported: portableReported,
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
