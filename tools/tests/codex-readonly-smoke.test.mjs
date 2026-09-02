import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

test("Codex capability smoke hashes the complete provider error before truncating its display", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-codex-smoke-error-"));
  const project = path.join(root, "project"), policy = path.join(root, "policy.json"), gateway = path.join(root, "gateway.mjs");
  fs.mkdirSync(project);
  fs.writeFileSync(policy, "{}\n", "utf8");
  const rawError = `blocked by policy ${"x".repeat(2500)}`;
  fs.writeFileSync(gateway, `
const rawError = ${JSON.stringify(rawError)};
process.stderr.write(rawError);
process.stdout.write(JSON.stringify({
  receiptId: "fake-receipt", status: "completed", error: null,
  output: JSON.stringify({ status: "blocked", value: null, evidence: "model report" })
}) + "\\n");
`, "utf8");

  const smoke = path.resolve("tools", "codex-readonly-smoke.mjs");
  const child = spawnSync(process.execPath, [smoke, "--project", project, "--policy", policy, "--profile", "read-only", "--probe", "exec", "--gateway", gateway], {
    cwd: path.resolve("."), encoding: "utf8", windowsHide: true
  });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.provider_error.length, 2000);
  assert.equal(report.provider_error_raw_bytes, Buffer.byteLength(rawError));
  assert.equal(report.provider_error_truncated, true);
  assert.equal(report.provider_error_raw_sha256, crypto.createHash("sha256").update(rawError).digest("hex"));
  assert.notEqual(report.provider_error_raw_sha256, crypto.createHash("sha256").update(report.provider_error).digest("hex"));
  fs.rmSync(root, { recursive: true, force: true });
});
