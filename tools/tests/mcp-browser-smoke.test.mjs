import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

test("registered MCP browser smoke retains an independently hashed screenshot artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-mcp-browser-smoke-contract-"));
  const project = path.join(root, "project"), policy = path.join(root, "policy.json"), gateway = path.join(root, "gateway.mjs");
  fs.mkdirSync(project);
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, providers: { codex: { profiles: { writer: { readOnly: false, allowedMcpServers: ["playwright"], browserMcpServer: "playwright" } } } } }), "utf8");
  fs.writeFileSync(gateway, `
import fs from "node:fs";
import http from "node:http";
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
const task = fs.readFileSync(value("--task-file"), "utf8");
const url = task.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\/zodchi-browser-[a-f0-9-]+/u)[0];
const screenshot = task.match(/exact absolute path: (.+)$/mu)?.[1];
const headers = (dest, mode = "no-cors") => ({ "user-agent": "Mozilla/5.0 Chrome/125.0.0.0 Safari/537.36", "sec-fetch-mode": mode, "sec-fetch-dest": dest });
const request = (target, requestHeaders) => new Promise((resolve, reject) => http.get(target, { headers: requestHeaders }, response => {
  const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
}).on("error", reject));
const html = await request(url, headers("document", "navigate"));
const scriptUrl = new URL(html.match(/<script src='([^']+)'/u)[1], url).href;
const imageUrl = new URL(html.match(/<img[^>]+src='([^']+)'/u)[1], url).href;
const script = await request(scriptUrl, headers("script"));
await request(imageUrl, headers("image"));
await request(new URL(script.match(/fetch\\(\"([^\"]+)\"/u)[1], url).href, headers("empty", "cors"));
if (screenshot) {
  const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); Buffer.from("IHDR").copy(png, 12); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20); fs.writeFileSync(screenshot, png);
}
const title = html.match(/<title>([^<]+)<\\/title>/u)[1], body = html.match(/<main>([^<]+)<\\/main>/u)[1];
process.stdout.write(JSON.stringify({
  receiptId: "mcp-browser-proof-receipt", status: "completed", error: null,
  output: JSON.stringify({ status: "observed", title, body, screenshot: Boolean(screenshot), evidence: "fixture MCP browser" }),
  environment: { provider_environment: { mcp_servers: { carried: [{ scope: "home", name: "playwright" }] } } }
}) + "\\n");
`, "utf8");

  const smoke = path.resolve("tools", "mcp-browser-smoke.mjs");
  const child = spawnSync(process.execPath, [smoke, "--project", project, "--policy", policy, "--provider", "codex", "--profile", "writer", "--gateway", gateway], { cwd: path.resolve("."), encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, "browser_confirmed");
  assert.deepEqual(report.carried_mcp_servers, ["playwright"]);
  assert.deepEqual(report.capability_evidence.browser_automation, { status: "available", enforcement: "technical", source: "sentinel_request_sequence" });
  assert.equal(report.capability_evidence.screen_capture.status, "available");
  assert.equal(report.capability_evidence.screen_capture.enforcement, "technical");
  assert.equal(report.capability_evidence.screen_capture.artifact.path, "<probe-root>/browser-proof.png");
  assert.deepEqual([report.capability_evidence.screen_capture.artifact.width, report.capability_evidence.screen_capture.artifact.height], [800, 600]);
  assert.equal(report.capability_evidence.screen_capture.artifact.bytes > 8, true);
  assert.match(report.capability_evidence.screen_capture.artifact.sha256, /^[a-f0-9]{64}$/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test("registered MCP browser smoke does not treat a one-pixel PNG as capture evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-mcp-browser-smoke-small-png-"));
  const project = path.join(root, "project"), policy = path.join(root, "policy.json"), gateway = path.join(root, "gateway.mjs");
  fs.mkdirSync(project);
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, providers: { codex: { profiles: { writer: { readOnly: false, allowedMcpServers: ["playwright"], browserMcpServer: "playwright" } } } } }), "utf8");
  fs.writeFileSync(gateway, `
import fs from "node:fs";
import http from "node:http";
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1], task = fs.readFileSync(value("--task-file"), "utf8");
const url = task.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\/zodchi-browser-[a-f0-9-]+/u)[0];
const screenshot = task.match(/exact absolute path: (.+)$/mu)?.[1];
const headers = (dest, mode = "no-cors") => ({ "user-agent": "Mozilla/5.0 Chrome/125.0.0.0 Safari/537.36", "sec-fetch-mode": mode, "sec-fetch-dest": dest });
const request = (target, requestHeaders) => new Promise((resolve, reject) => http.get(target, { headers: requestHeaders }, response => { const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); }).on("error", reject));
const html = await request(url, headers("document", "navigate"));
const scriptUrl = new URL(html.match(/<script src='([^']+)'/u)[1], url).href, imageUrl = new URL(html.match(/<img[^>]+src='([^']+)'/u)[1], url).href;
const script = await request(scriptUrl, headers("script")); await request(imageUrl, headers("image")); await request(new URL(script.match(/fetch\\(\"([^\"]+)\"/u)[1], url).href, headers("empty", "cors"));
if (screenshot) fs.writeFileSync(screenshot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const title = html.match(/<title>([^<]+)<\\/title>/u)[1], body = html.match(/<main>([^<]+)<\\/main>/u)[1];
process.stdout.write(JSON.stringify({ receiptId: "small-png", status: "completed", output: JSON.stringify({ status: "observed", title, body, screenshot: true, evidence: "small fixture" }), environment: { provider_environment: { mcp_servers: { carried: [{ scope: "home", name: "playwright" }] } } } }) + "\\n");
`, "utf8");
  const child = spawnSync(process.execPath, [path.resolve("tools", "mcp-browser-smoke.mjs"), "--project", project, "--policy", policy, "--provider", "codex", "--profile", "writer", "--gateway", gateway], { cwd: path.resolve("."), encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, "browser_confirmed");
  assert.equal(report.capability_evidence.screen_capture.status, "unknown");
  assert.equal(report.capability_evidence.screen_capture.enforcement, "unknown");
  assert.equal(report.capability_evidence.screen_capture.source, "artifact_below_probe_viewport");
  assert.deepEqual([report.capability_evidence.screen_capture.artifact.width, report.capability_evidence.screen_capture.artifact.height], [1, 1]);
  fs.rmSync(root, { recursive: true, force: true });
});
