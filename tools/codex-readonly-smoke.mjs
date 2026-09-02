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
function parsedJson(text) { try { return JSON.parse(String(text).trim()); } catch { return null; } }
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

function readProbe(project) {
  const relativePath = path.join("WorkflowPlatform", "src", "work-executor.mjs");
  const target = path.join(project, relativePath);
  if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) fail(`SMOKE_TARGET_MISSING: ${target}`, 2);
  const lines = fs.readFileSync(target, "utf8").split(/\r?\n/u);
  const candidates = lines
    .map((value, index) => ({ value, line: index + 1 }))
    .filter(item => item.value.trim().length >= 48 && item.value.trim().length <= 500);
  if (!candidates.length) fail(`SMOKE_READ_LINE_MISSING: ${target}`, 2);
  const selected = candidates[crypto.randomInt(candidates.length)];
  return {
    kind: "read",
    expected: selected.value,
    target: relativePath.replaceAll("\\", "/"),
    task: [
      `Use a native file-reading tool to read line ${selected.line} of ${relativePath.replaceAll("\\", "/")} from the supplied project and return that complete line exactly, including its original leading and trailing whitespace.`,
      "This probe tests file reading independently from process execution. Do not use a shell, subprocess, exec_command, PowerShell, cmd, Node.js, Python, or any command-running tool.",
      "Do not infer or reconstruct the line. If no native file-reading tool is available, return status=unavailable. If policy blocks the native read, return status=blocked and copy the exact error into evidence.",
      "Do not write or modify any file. Return only the structured result required by the output schema."
    ].join("\n"),
    schema: {
      type: "object", additionalProperties: false, required: ["status", "value", "evidence"],
      properties: {
        status: { type: "string", enum: ["read", "unavailable", "blocked", "failed"] },
        value: { type: ["string", "null"] },
        evidence: { type: "string" }
      }
    },
    classify(modelResult, technicalEvidence) {
      if (modelResult?.status === "read" && modelResult.value === selected.value) return "read_confirmed";
      if (modelResult?.status === "unavailable") return "read_unavailable";
      if (modelResult?.status === "blocked" || /blocked by policy|CreateProcess \{ message: "Rejected"/iu.test(technicalEvidence)) return "read_blocked_by_policy";
      return "inconclusive";
    }
  };
}

function execProbe() {
  const sentinel = `zodchi-exec-${crypto.randomUUID()}`;
  return {
    kind: "exec",
    expected: sentinel,
    target: null,
    task: [
      `Launch a local process in the supplied project that prints exactly this value and return its stdout: ${sentinel}`,
      "This probe tests process execution only. Do not read any project file and do not write or modify any file.",
      "If policy blocks process execution, return status=blocked and copy the exact policy error into evidence.",
      "Return only the structured result required by the output schema."
    ].join("\n"),
    schema: {
      type: "object", additionalProperties: false, required: ["status", "value", "evidence"],
      properties: {
        status: { type: "string", enum: ["executed", "blocked", "failed"] },
        value: { type: ["string", "null"] },
        evidence: { type: "string" }
      }
    },
    classify(modelResult, technicalEvidence) {
      if (modelResult?.status === "executed" && modelResult.value === sentinel) return "exec_confirmed";
      if (modelResult?.status === "blocked" || /blocked by policy|CreateProcess \{ message: "Rejected"/iu.test(technicalEvidence)) return "exec_blocked_by_policy";
      return "inconclusive";
    }
  };
}

const cli = argsObject(process.argv.slice(2));
const project = path.resolve(String(cli.project ?? ""));
const policy = path.resolve(String(cli.policy ?? ""));
const profile = String(cli.profile ?? "");
const probeName = String(cli.probe ?? "");
const gateway = path.resolve(String(cli.gateway ?? path.join(import.meta.dirname, "..", "AgentGateway", "src", "cli.mjs")));
if (!cli.project || !fs.statSync(project, { throwIfNoEntry: false })?.isDirectory()) fail("SMOKE_PROJECT_REQUIRED: pass --project <existing directory>", 2);
if (!cli.policy || !fs.statSync(policy, { throwIfNoEntry: false })?.isFile()) fail("SMOKE_POLICY_REQUIRED: pass --policy <policy.local.json>", 2);
if (!profile) fail("SMOKE_PROFILE_REQUIRED: pass --profile <read-only Codex profile>", 2);
if (!new Set(["read", "exec"]).has(probeName)) fail("SMOKE_PROBE_REQUIRED: pass --probe read or --probe exec", 2);
if (!fs.statSync(gateway, { throwIfNoEntry: false })?.isFile()) fail(`SMOKE_GATEWAY_MISSING: ${gateway}`, 2);

const probe = probeName === "read" ? readProbe(project) : execProbe();
const root = fs.mkdtempSync(path.join(os.tmpdir(), `zodchi-codex-readonly-${probe.kind}-smoke-`));
const taskFile = path.join(root, "task.md");
const schemaFile = path.join(root, "result.schema.json");
const database = path.join(root, "gateway.sqlite");
fs.writeFileSync(taskFile, probe.task, "utf8");
fs.writeFileSync(schemaFile, `${JSON.stringify(probe.schema, null, 2)}\n`, "utf8");

try {
  const child = spawnSync(process.execPath, [gateway, "run", "--provider", "codex", "--profile", profile, "--level", "prototype", "--role", "researcher", "--requires-write", "false", "--task-file", taskFile, "--output-schema", schemaFile, "--project", project, "--task", `codex-readonly-${probe.kind}-smoke-${crypto.randomUUID()}`], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, AGENT_GATEWAY_POLICY: policy, AGENT_GATEWAY_DB: database, AGENT_GATEWAY_DATA: root, AGENT_GATEWAY_TEMP: path.join(root, "temp") }
  });
  const receipt = parsedOutput(child.stdout);
  let modelResult = null;
  try { modelResult = JSON.parse(extractModelText(receipt?.output)); } catch { /* included in report */ }
  const modelEvidence = String(modelResult?.evidence ?? "").trim().slice(0, 2000);
  const rawProviderError = String(receipt?.error ?? child.stderr ?? "").trim();
  const providerError = rawProviderError.slice(0, 2000);
  const technicalEvidence = [modelEvidence, providerError].filter(Boolean).join("\n");
  const report = {
    probe: probe.kind,
    status: probe.classify(modelResult, technicalEvidence),
    receipt_id: receipt?.receiptId ?? null,
    gateway_exit_code: child.status,
    provider_status: receipt?.status ?? null,
    target: probe.target,
    expected_value: probe.expected,
    reported_value: modelResult?.value ?? null,
    model_evidence: modelEvidence,
    provider_error: providerError,
    provider_error_raw_sha256: crypto.createHash("sha256").update(rawProviderError).digest("hex"),
    provider_error_raw_bytes: Buffer.byteLength(rawProviderError),
    provider_error_truncated: providerError.length < rawProviderError.length,
    temporary_database: cli.keep ? database : null
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const conclusive = new Set(["read_confirmed", "read_unavailable", "read_blocked_by_policy", "exec_confirmed", "exec_blocked_by_policy"]);
  if (!conclusive.has(report.status)) process.exitCode = 3;
} finally {
  if (!cli.keep) fs.rmSync(root, { recursive: true, force: true });
}
