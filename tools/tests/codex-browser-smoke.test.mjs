import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

test("Codex browser smoke proves an unknown capability instead of requiring it circularly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-codex-browser-smoke-contract-"));
  const project = path.join(root, "project"), policy = path.join(root, "policy.json"), gateway = path.join(root, "gateway.mjs"), capture = path.join(root, "capture.json");
  fs.mkdirSync(project);
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, providers: { codex: { profiles: { writer: { readOnly: false } } } } }), "utf8");
  fs.writeFileSync(gateway, `
import fs from "node:fs";
const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
const task = fs.readFileSync(value("--task-file"), "utf8");
const url = task.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\/zodchi-browser-[a-f0-9-]+/u)?.[0];
const html = await (await fetch(url)).text();
const title = html.match(/<title>([^<]+)<\\/title>/u)[1];
const body = html.match(/<main>([^<]+)<\\/main>/u)[1];
fs.writeFileSync(process.env.SMOKE_CAPTURE, JSON.stringify({ args, task }));
process.stdout.write(JSON.stringify({
  receiptId: "browser-proof-receipt", status: "completed", error: null,
  output: JSON.stringify({ status: "observed", title, body, screenshot: true, evidence: "sentinel observed" }),
  environment: { provider_environment: { plugins: { carried: [{ id: "browser@openai-bundled" }] }, mcp_servers: { carried: [{ name: "node_repl" }] } } }
}) + "\\n");
`, "utf8");

  const smoke = path.resolve("tools", "codex-browser-smoke.mjs");
  const child = spawnSync(process.execPath, [smoke, "--project", project, "--policy", policy, "--profile", "writer", "--gateway", gateway], {
    cwd: path.resolve("."), encoding: "utf8", windowsHide: true, env: { ...process.env, SMOKE_CAPTURE: capture }
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const invocation = JSON.parse(fs.readFileSync(capture, "utf8"));
  const requirements = JSON.parse(invocation.args[invocation.args.indexOf("--capability-requirements") + 1]);
  assert.deepEqual(requirements, { required: ["context_input", "project_write"], forbidden: [] });
  assert.equal(invocation.args[invocation.args.indexOf("--role") + 1], "worker");
  assert.match(invocation.task, /scripts\/browser-client\.mjs/u);
  assert.match(invocation.task, /setupBrowserRuntime\(\)/u);
  assert.match(invocation.task, /not assume it is a pre-existing global/u);
  fs.rmSync(root, { recursive: true, force: true });
});
