import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

function temporaryRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-kimi-boundary-contract-")); }
function run(mode) {
  const root = temporaryRoot();
  const sourceHome = path.join(root, "home");
  const fake = path.join(root, "fake-kimi.mjs");
  fs.mkdirSync(path.join(sourceHome, "credentials"), { recursive: true });
  fs.writeFileSync(path.join(sourceHome, "config.toml"), "[model]\n", "utf8");
  fs.writeFileSync(path.join(sourceHome, "credentials", "account.json"), "{}", "utf8");
  fs.writeFileSync(fake, `import fs from "node:fs";\nconst args=process.argv.slice(2);\nconst prompt=args[args.indexOf("--prompt")+1];\nconst desired=/exactly (after-[0-9a-f-]+) followed/.exec(prompt)?.[1];\nif(!args.includes("--plan")) fs.writeFileSync("boundary.txt", desired+"\\n");\nprocess.stdout.write(JSON.stringify({type:"result",plan:args.includes("--plan")})+"\\n");\n`, "utf8");
  const child = spawnSync(process.execPath, [path.resolve("tools", "kimi-write-boundary-smoke.mjs"), "--mode", mode, "--source-home", sourceHome, "--command", process.execPath, "--command-prefix-json", JSON.stringify([fake])], { cwd: path.resolve("."), encoding: "utf8", windowsHide: true });
  const report = JSON.parse(child.stdout);
  fs.rmSync(root, { recursive: true, force: true });
  return { child, report };
}

test("Kimi boundary smoke observes plan and untrusted workspace writes independently", () => {
  const plan = run("plan");
  assert.equal(plan.child.status, 0, plan.child.stderr);
  assert.equal(plan.report.observation.status, "write_not_observed");
  assert.equal(plan.report.invocation.auto, false);
  assert.equal(plan.report.invocation.plan, true);
  assert.equal(plan.report.invocation.workspace_trusted_before, false);
  assert.equal(plan.report.technical_boundary, "unproven");
  assert.equal(typeof plan.report.provider_output_sha256, "string");
  assert.equal(plan.report.provider_error, "");
  const untrusted = run("workspace-untrusted");
  assert.equal(untrusted.child.status, 0, untrusted.child.stderr);
  assert.equal(untrusted.report.observation.status, "write_observed");
  assert.equal(untrusted.report.invocation.plan, false);
  assert.equal(untrusted.report.invocation.workspace_trusted_before, false);
  assert.equal(untrusted.report.technical_boundary, "unavailable");
});
