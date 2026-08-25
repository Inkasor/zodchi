import { spawn } from "node:child_process";
import { resolveWorkflowSettings } from "./paths.mjs";

export function callGateway({ gateway, gatewayDatabase, gatewayPolicy, provider = "codex", profile, level = "mvp", role = "worker", taskFile, project, writeDirs = [], taskId, workflowRunId = null, attemptNo = null, artifactRef = null, decisionRef = null }) {
  const settings = resolveWorkflowSettings();
  gateway ??= settings.gatewayEntry;
  gatewayDatabase ??= settings.gatewayDatabasePath;
  gatewayPolicy ??= settings.gatewayPolicyPath;
  if (!profile) throw new Error("Gateway profile is required; assign it during onboarding");
  return new Promise((resolve, reject) => {
    const args = [gateway, "run", "--provider", provider, "--profile", profile, "--level", level, "--role", role, "--task-file", taskFile, "--task", taskId ?? taskFile];
    if (project) args.push("--project", project);
    // Only a writable root reaches the provider. What a role reads was collected before the call and
    // travels inside the prompt, so a read-only root is never handed to the process at all: a directory
    // the sandbox was never given cannot be touched by mistake. Each writable root travels as its own
    // flag because the receipt has to record which directories the call could change, and a single
    // project path cannot state that for several.
    for (const directory of writeDirs) args.push("--write-dir", directory);
    if (workflowRunId) args.push("--workflow-run", workflowRunId);
    if (attemptNo) args.push("--attempt", String(attemptNo));
    if (artifactRef) args.push("--artifact-ref", artifactRef);
    if (decisionRef) args.push("--decision-ref", decisionRef);
    const child = spawn(process.execPath, args, { windowsHide: true, env: { ...process.env, AGENT_GATEWAY_POLICY: gatewayPolicy, AGENT_GATEWAY_DB: gatewayDatabase } });
    let out = "", err = "", settled = false, pendingReceipt = null;
    const captureReceipt = () => {
      if (settled || pendingReceipt) return;
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      let receipt;
      try { receipt = JSON.parse(lines.at(-1)); } catch { return; }
      if (!receipt?.receiptId) return;
      pendingReceipt = { ...receipt, receipt_id: receipt.receiptId, gateway_task_id: receipt.taskId };
    };
    child.stdout.on("data", x => { out += x; captureReceipt(); });
    child.stderr.on("data", x => err += x);
    child.on("error", error => { if (!settled) { settled = true; reject(error); } });
    child.on("exit", code => {
      if (settled) return;
      captureReceipt(); settled = true;
      if (pendingReceipt) resolve(pendingReceipt);
      else { const text = err || out; reject(new Error(`Gateway exited before receipt (${code}): ${text}`)); }
    });
  });
}
