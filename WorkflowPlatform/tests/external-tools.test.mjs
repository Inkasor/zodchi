import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db.mjs";
import { externalTools, registerExternalTool } from "../src/external-tools.mjs";

test("external tool registry preserves the security facts readiness compares with role authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-external-tools-"));
  const db = openDb(path.join(root, "workflow.sqlite"));
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,'2026-01-01T00:00:00.000Z')").run(root);
  const registered = registerExternalTool(db, {
    projectId: "project", name: "database-agent", transport: "http", endpoint: "http://127.0.0.1:7777",
    readOnlyMode: { field: "read_only", value: true }, arbitraryExecution: true, containsModel: true,
    selfLiftableBoundary: true, doublesAsProvider: true, pinnedVersion: "sha256:fixture"
  });
  assert.deepEqual({
    name: registered.name, transport: registered.transport, endpoint: registered.endpoint,
    read_only_mode: registered.read_only_mode, arbitrary_execution: registered.arbitrary_execution,
    contains_model: registered.contains_model, self_liftable_boundary: registered.self_liftable_boundary,
    doubles_as_provider: registered.doubles_as_provider, pinned_version: registered.pinned_version
  }, {
    name: "database-agent", transport: "http", endpoint: "http://127.0.0.1:7777",
    read_only_mode: { field: "read_only", value: true }, arbitrary_execution: true, contains_model: true,
    self_liftable_boundary: true, doubles_as_provider: true, pinned_version: "sha256:fixture"
  });
  assert.equal(externalTools(db, "project").length, 1);
  assert.throws(() => registerExternalTool(db, { projectId: "project", name: "bad", transport: "pipe", endpoint: "x", pinnedVersion: "1" }), /REGISTRATION_INVALID/u);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});
