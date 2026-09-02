import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

test("Codex browser smoke requires independently observed browser requests and avoids circular admission", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-codex-browser-smoke-contract-"));
  const project = path.join(root, "project"), policy = path.join(root, "policy.json"), gateway = path.join(root, "gateway.mjs"), capture = path.join(root, "capture.json");
  fs.mkdirSync(project);
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, providers: { codex: { profiles: { writer: { readOnly: false } } } } }), "utf8");
  fs.writeFileSync(gateway, `
import fs from "node:fs";
import http from "node:http";
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
const task = fs.readFileSync(value("--task-file"), "utf8");
const url = task.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\/zodchi-browser-[a-f0-9-]+/u)?.[0];
const browserHeaders = (dest, mode = "no-cors", referer = undefined) => ({
  "user-agent": "Mozilla/5.0 Chrome/125.0.0.0 Safari/537.36",
  "sec-fetch-mode": mode,
  "sec-fetch-dest": dest,
  ...(referer ? { referer } : {})
});
const request = (target, headers) => new Promise((resolve, reject) => {
  http.get(target, { headers }, response => {
    const chunks = [];
    response.on("data", chunk => chunks.push(chunk));
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  }).on("error", reject);
});
const html = process.env.SMOKE_BROWSER_SEQUENCE === "true"
  ? await request(url, browserHeaders("document", "navigate"))
  : await (await fetch(url)).text();
const title = html.match(/<title>([^<]+)<\\/title>/u)[1];
const body = html.match(/<main>([^<]+)<\\/main>/u)[1];
if (process.env.SMOKE_BROWSER_SEQUENCE === "true") {
  const scriptUrl = new URL(html.match(/<script src='([^']+)'/u)[1], url).href;
  const imageUrl = new URL(html.match(/<img[^>]+src='([^']+)'/u)[1], url).href;
  const script = await request(scriptUrl, browserHeaders("script", "no-cors", url));
  await request(imageUrl, browserHeaders("image", "no-cors", url));
  const beaconUrl = new URL(script.match(/fetch\\(\"([^\"]+)\"/u)[1], url).href;
  await request(beaconUrl, browserHeaders("empty", "cors", url));
}
fs.writeFileSync(process.env.SMOKE_CAPTURE, JSON.stringify({ args, task }));
process.stdout.write(JSON.stringify({
  receiptId: "browser-proof-receipt", status: "completed", error: null,
  output: JSON.stringify({ status: "observed", title, body, screenshot: true, evidence: "sentinel observed" }),
  environment: { provider_environment: { plugins: { carried: [{ id: "browser@openai-bundled" }] }, mcp_servers: { carried: [{ name: "node_repl" }] } } }
}) + "\\n");
`, "utf8");

  const smoke = path.resolve("tools", "codex-browser-smoke.mjs");
  const child = spawnSync(process.execPath, [smoke, "--project", project, "--policy", policy, "--profile", "writer", "--gateway", gateway], {
    cwd: path.resolve("."), encoding: "utf8", windowsHide: true, env: { ...process.env, SMOKE_CAPTURE: capture, SMOKE_BROWSER_SEQUENCE: "true" }
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.sentinel_evidence.confirmed, true);
  assert.equal(report.sentinel_evidence.requests.length, 4);
  assert.deepEqual(report.capability_evidence.browser_automation, { status: "available", enforcement: "technical", source: "sentinel_request_sequence" });
  assert.deepEqual(report.capability_evidence.screen_capture, { status: "unknown", enforcement: "model_reported", source: "model_result_only" });
  const invocation = JSON.parse(fs.readFileSync(capture, "utf8"));
  const requirements = JSON.parse(invocation.args[invocation.args.indexOf("--capability-requirements") + 1]);
  assert.deepEqual(requirements, { required: ["context_input", "project_write"], forbidden: [] });
  assert.equal(invocation.args[invocation.args.indexOf("--role") + 1], "worker");
  assert.match(invocation.task, /scripts\/browser-client\.mjs/u);
  assert.match(invocation.task, /setupBrowserRuntime\(\)/u);
  assert.match(invocation.task, /not assume it is a pre-existing global/u);

  const plainFetch = spawnSync(process.execPath, [smoke, "--project", project, "--policy", policy, "--profile", "writer", "--gateway", gateway], {
    cwd: path.resolve("."), encoding: "utf8", windowsHide: true, env: { ...process.env, SMOKE_CAPTURE: capture, SMOKE_BROWSER_SEQUENCE: "false" }
  });
  assert.equal(plainFetch.status, 3, plainFetch.stderr || plainFetch.stdout);
  const plainReport = JSON.parse(plainFetch.stdout);
  assert.equal(plainReport.status, "inconclusive");
  assert.equal(plainReport.sentinel_evidence.confirmed, false);
  assert.equal(plainReport.capability_evidence.browser_automation.status, "unknown");
  assert.equal(plainReport.capability_evidence.screen_capture.enforcement, "model_reported");
  assert.equal(plainReport.reported.screenshot, true, "a model-reported screenshot must not prove browser use");
  fs.rmSync(root, { recursive: true, force: true });
});
