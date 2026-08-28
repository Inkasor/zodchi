import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { now, openDb } from "../src/db.mjs";
import { resolveWorkflowSettings, workflowPlatformRoot } from "../src/paths.mjs";
import { processMessage } from "../src/workflow-app.mjs";

test("relative runtime paths resolve from the installation root", () => {
  const settings = resolveWorkflowSettings({
    WORKFLOW_PLATFORM_DATA: "local-data",
    WORKFLOW_TEMP: "local-temp",
    AGENT_GATEWAY_ROOT: "../GatewaySibling"
  });
  assert.equal(settings.dataRoot, path.join(workflowPlatformRoot, "local-data"));
  assert.equal(settings.databasePath, path.join(workflowPlatformRoot, "local-data", "workflow.sqlite"));
  assert.equal(settings.tempRoot, path.join(workflowPlatformRoot, "local-temp"));
  assert.equal(settings.gatewayRoot, path.resolve(workflowPlatformRoot, "..", "GatewaySibling"));
});

test("runtime has no implicit project or workflow", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-no-route-"));
  const project = path.join(root, "project"), dbFile = path.join(root, "workflow.sqlite"), emptyDbFile = path.join(root, "empty.sqlite");
  // A negative portability test must not open the repository's default mutable database. Besides making
  // the result depend on a previous run, that hid migration changes behind whichever installation data
  // happened to be present on the developer machine.
  await assert.rejects(() => processMessage({ message: "hello", workflowDefinition: { id: "x" }, dbFile: emptyDbFile }), /PROJECT_REQUIRED/);
  fs.mkdirSync(project);
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, now());
  db.close();
  await assert.rejects(() => processMessage({ message: "hello", project, dbFile }), /WORKFLOW_NOT_REGISTERED/);
  fs.rmSync(root, { recursive: true, force: true });
});
