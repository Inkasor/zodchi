import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activateChatSession, bindChatSessionResult, touchChatSession } from "../src/chat-session.mjs";
import { openDb } from "../src/db.mjs";
import { turnResult } from "../src/turn-result.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-turn-result-")), project = path.join(root, "project");
  fs.mkdirSync(project);
  const file = path.join(root, "workflow.sqlite"), db = openDb(file), timestamp = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, timestamp);
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status) VALUES('workflow','Workflow','project','prototype','L0','active')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','Task','completed',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,user_message,created_at,updated_at,completed_at,response_language) VALUES('run','task','project','workflow','completed','hello',?,?,?,'ru')").run(timestamp, timestamp, timestamp);
  db.prepare("INSERT INTO conversation_messages(id,project_id,run_id,role,content,created_at,language) VALUES('answer','project','run','assistant','Готовый ответ',?,'ru')").run(timestamp);
  return { root, project, file, db };
}

test("the exact active session reads its prepared result without mutating the database", () => {
  const value = fixture();
  try {
    activateChatSession(value.db, { client: "codex", sessionId: "session", origin: value.project, turnKey: "turn-1" });
    bindChatSessionResult(value.db, { client: "codex", sessionId: "session", runId: "run", turnKey: "turn-1" });
    value.db.close();
    const before = fs.statSync(value.file).mtimeMs;
    assert.deepEqual(turnResult({ dbFile: value.file, client: "codex", sessionId: "session" }), { status: "ready", response: "Готовый ответ", response_language: "ru" });
    assert.equal(turnResult({ dbFile: value.file, client: "codex", sessionId: "other" }).status, "inactive");
    assert.equal(fs.statSync(value.file).mtimeMs, before);
  } finally { try { value.db.close(); } catch {} fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("a new turn makes the preceding result stale until the router binds a new run", () => {
  const value = fixture();
  try {
    activateChatSession(value.db, { client: "codex", sessionId: "session", origin: value.project, turnKey: "turn-1" });
    bindChatSessionResult(value.db, { client: "codex", sessionId: "session", runId: "run", turnKey: "turn-1" });
    touchChatSession(value.db, { client: "codex", sessionId: "session", origin: value.project, turnKey: "turn-2" });
    value.db.close();
    assert.deepEqual(turnResult({ dbFile: value.file, client: "codex", sessionId: "session" }), { status: "active", reason: "result_not_ready" });
  } finally { try { value.db.close(); } catch {} fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("a late result from an older turn cannot replace the current turn", () => {
  const value = fixture();
  try {
    activateChatSession(value.db, { client: "codex", sessionId: "session", origin: value.project, turnKey: "turn-1" });
    touchChatSession(value.db, { client: "codex", sessionId: "session", origin: value.project, turnKey: "turn-2" });
    assert.throws(
      () => bindChatSessionResult(value.db, { client: "codex", sessionId: "session", runId: "run", turnKey: "turn-1" }),
      /ZODCHI_SESSION_TURN_MISMATCH/
    );
    value.db.close();
    assert.deepEqual(turnResult({ dbFile: value.file, client: "codex", sessionId: "session" }), { status: "active", reason: "result_not_ready" });
  } finally { try { value.db.close(); } catch {} fs.rmSync(value.root, { recursive: true, force: true }); }
});
