import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activationStatus } from "../src/activation-status.mjs";
import { activateChatSession, endChatSession } from "../src/chat-session.mjs";
import { openDb } from "../src/db.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-activation-status-"));
  const project = path.join(root, "project"); fs.mkdirSync(project);
  const file = path.join(root, "workflow.sqlite"), db = openDb(file);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, new Date().toISOString());
  activateChatSession(db, { client: "codex", sessionId: "active-session", origin: project });
  db.close();
  return { root, project, file };
}

test("activation status accepts only the exact active client session", () => {
  const value = fixture();
  try {
    assert.deepEqual(activationStatus({ dbFile: value.file, client: "codex", sessionId: "active-session" }), { status: "active" });
    assert.deepEqual(activationStatus({ dbFile: value.file, client: "codex", sessionId: "other-session" }), { status: "inactive", reason: "session_not_found" });
    assert.deepEqual(activationStatus({ dbFile: value.file, client: "codex", sessionId: "" }), { status: "inactive", reason: "session_id_missing" });
    const db = openDb(value.file); endChatSession(db, { client: "codex", sessionId: "active-session" }); db.close();
    assert.deepEqual(activationStatus({ dbFile: value.file, client: "codex", sessionId: "active-session" }), { status: "inactive", reason: "session_not_active" });
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("the Codex verifier reads the current session identity from the host environment", () => {
  const value = fixture(), script = path.resolve(import.meta.dirname, "..", "hooks", "activation-status.mjs");
  try {
    const env = { ...process.env, WORKFLOW_DB: value.file, CODEX_SESSION_ID: "active-session" };
    delete env.WORKFLOW_PLATFORM_CONFIG;
    const active = spawnSync(process.execPath, [script, "--client", "codex"], { encoding: "utf8", env, windowsHide: true });
    assert.equal(active.status, 0, active.stderr);
    assert.deepEqual(JSON.parse(active.stdout), { status: "active" });
    env.CODEX_SESSION_ID = "wrong-session";
    const inactive = spawnSync(process.execPath, [script, "--client", "codex"], { encoding: "utf8", env, windowsHide: true });
    assert.equal(inactive.status, 0, inactive.stderr);
    assert.deepEqual(JSON.parse(inactive.stdout), { status: "inactive", reason: "session_not_found" });
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

