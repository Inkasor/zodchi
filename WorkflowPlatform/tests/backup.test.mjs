import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { backupInstallation, restoreInstallation } from "../src/backup.mjs";
import { openDb, now } from "../src/db.mjs";

function temporaryRoot(prefix) { const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, prefix)); }
function gatewayFixture(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new DatabaseSync(file); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE receipts(id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO receipts VALUES('receipt','completed')"); db.close(); }

test("installation backup snapshots both live SQLite databases and restore is checksum-bound and non-overwriting", async () => {
  const root = temporaryRoot("workflow-backup-"), workflow = path.join(root, "source", "workflow.sqlite"), gateway = path.join(root, "source", "gateway.sqlite"), backupDir = path.join(root, "backup");
  const db = openDb(workflow); db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(path.join(root, "project"), now()); db.close(); gatewayFixture(gateway);
  const created = await backupInstallation({ workflowDatabase: workflow, gatewayDatabase: gateway, outputDirectory: backupDir }); assert.equal(created.status, "backed_up"); assert.equal(created.files.length, 2);
  const restoredWorkflow = path.join(root, "restored", "workflow.sqlite"), restoredGateway = path.join(root, "restored", "gateway.sqlite"), restored = restoreInstallation({ backupDirectory: backupDir, workflowDatabase: restoredWorkflow, gatewayDatabase: restoredGateway }); assert.equal(restored.status, "restored");
  let verified = new DatabaseSync(restoredWorkflow, { readOnly: true }); assert.equal(verified.prepare("SELECT name FROM projects WHERE id='project'").get().name, "Project"); verified.close(); verified = new DatabaseSync(restoredGateway, { readOnly: true }); assert.equal(verified.prepare("SELECT status FROM receipts WHERE id='receipt'").get().status, "completed"); verified.close();
  assert.throws(() => restoreInstallation({ backupDirectory: backupDir, workflowDatabase: restoredWorkflow, gatewayDatabase: path.join(root, "other.sqlite") }), /RESTORE_TARGET_EXISTS/);
  const gatewayBackup = path.join(backupDir, "gateway.sqlite"), original = fs.readFileSync(gatewayBackup); fs.appendFileSync(gatewayBackup, "tamper"); assert.throws(() => restoreInstallation({ backupDirectory: backupDir, workflowDatabase: path.join(root, "tampered", "workflow.sqlite"), gatewayDatabase: path.join(root, "tampered", "gateway.sqlite") }), /RESTORE_CHECKSUM_MISMATCH/); fs.writeFileSync(gatewayBackup, original);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
