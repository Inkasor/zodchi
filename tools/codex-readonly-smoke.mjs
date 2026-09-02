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
function parsedOutput(text) {
  const lines = String(text ?? "").trim().split(/\r?\n/u).filter(Boolean);
  for (const line of lines.reverse()) {
    try { const value = JSON.parse(line); if (value?.receiptId) return value; } catch { /* continue */ }
  }
  return null;
}

const cli = argsObject(process.argv.slice(2));
const project = path.resolve(String(cli.project ?? ""));
const policy = path.resolve(String(cli.policy ?? ""));
const profile = String(cli.profile ?? "");
const gateway = path.resolve(String(cli.gateway ?? path.join(import.meta.dirname, "..", "AgentGateway", "src", "cli.mjs")));
if (!cli.project || !fs.statSync(project, { throwIfNoEntry: false })?.isDirectory()) fail("SMOKE_PROJECT_REQUIRED: pass --project <existing directory>", 2);
if (!cli.policy || !fs.statSync(policy, { throwIfNoEntry: false })?.isFile()) fail("SMOKE_POLICY_REQUIRED: pass --policy <policy.local.json>", 2);
if (!profile) fail("SMOKE_PROFILE_REQUIRED: pass --profile <read-only Codex profile>", 2);
if (!fs.statSync(gateway, { throwIfNoEntry: false })?.isFile()) fail(`SMOKE_GATEWAY_MISSING: ${gateway}`, 2);

const target = path.join(project, "package.json");
if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) fail(`SMOKE_TARGET_MISSING: ${target}`, 2);
const expectedHash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-codex-readonly-smoke-"));
const taskFile = path.join(root, "task.md");
const schemaFile = path.join(root, "result.schema.json");
const database = path.join(root, "gateway.sqlite");
fs.writeFileSync(taskFile, [
  "Read package.json from the supplied project using an actual filesystem read, calculate its SHA-256 digest, and return it.",
  "Do not infer the digest and do not write or modify any file. If the environment blocks the read, return status=blocked and copy the exact policy error into evidence.",
  "Return only the structured result required by the output schema."
].join("\n"), "utf8");
fs.writeFileSync(schemaFile, `${JSON.stringify({
  type: "object", additionalProperties: false, required: ["status", "sha256", "evidence"],
  properties: {
    status: { type: "string", enum: ["read", "blocked", "failed"] },
    sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
    evidence: { type: "string" }
  }
}, null, 2)}\n`, "utf8");

try {
  const child = spawnSync(process.execPath, [gateway, "run", "--provider", "codex", "--profile", profile, "--level", "prototype", "--role", "researcher", "--requires-write", "false", "--task-file", taskFile, "--output-schema", schemaFile, "--project", project, "--task", `codex-readonly-smoke-${crypto.randomUUID()}`], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, AGENT_GATEWAY_POLICY: policy, AGENT_GATEWAY_DB: database, AGENT_GATEWAY_DATA: root, AGENT_GATEWAY_TEMP: path.join(root, "temp") }
  });
  const receipt = parsedOutput(child.stdout);
  let modelResult = null;
  try { modelResult = JSON.parse(String(receipt?.output ?? "").trim()); } catch { /* included in report */ }
  const report = {
    status: modelResult?.status === "read" && modelResult.sha256 === expectedHash ? "read_confirmed"
      : modelResult?.status === "blocked" || /blocked by policy/iu.test(String(receipt?.output ?? receipt?.error ?? child.stderr)) ? "blocked_by_policy"
        : "inconclusive",
    receipt_id: receipt?.receiptId ?? null,
    gateway_exit_code: child.status,
    provider_status: receipt?.status ?? null,
    expected_sha256: expectedHash,
    reported_sha256: modelResult?.sha256 ?? null,
    evidence: modelResult?.evidence ?? String(receipt?.error ?? child.stderr ?? "").trim().slice(0, 1000),
    temporary_database: cli.keep ? database : null
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!new Set(["read_confirmed", "blocked_by_policy"]).has(report.status)) process.exitCode = 3;
} finally {
  if (!cli.keep) fs.rmSync(root, { recursive: true, force: true });
}
