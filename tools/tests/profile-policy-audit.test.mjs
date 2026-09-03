import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { openDb, now } from "../../WorkflowPlatform/src/db.mjs";

test("profile policy audit separates assigned, reserved and orphaned without mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-profile-audit-")), database = path.join(root, "workflow.sqlite"), policy = path.join(root, "policy.local.json");
  const db = openDb(database); db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('p','P',?,?)").run(root, now());
  db.prepare("INSERT INTO profiles(id,provider,name,role_id) VALUES('a','codex','assigned','worker'),('r','codex','reserved','reviewer')").run();
  db.prepare("INSERT INTO role_profile_assignments(project_id,role_id,operational_level,profile_id,enabled) VALUES('p','worker','mvp','a',1)").run(); db.close();
  fs.writeFileSync(policy, JSON.stringify({ providers: { codex: { profiles: { assigned: {}, reserved: {}, orphan: {} } } } }));
  const before = fs.readFileSync(policy);
  const result = spawnSync(process.execPath, ["tools/profile-policy-audit.mjs", "--workflow-db", database, "--policy", policy], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.deepEqual(report.counts, { assigned: 1, reserved_catalog: 1, orphaned: 1 });
  assert.deepEqual(fs.readFileSync(policy), before);
  fs.rmSync(root, { recursive: true, force: true });
});
