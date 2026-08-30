import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db.mjs";
import { activateChatSession, endChatSession, parseZodchiCommand, routeChatPrompt } from "../src/chat-session.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-chat-session-"));
  const project = path.join(root, "project"), nested = path.join(project, "src");
  fs.mkdirSync(nested, { recursive: true });
  const db = openDb(path.join(root, "workflow.sqlite"));
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, new Date().toISOString());
  return { root, project, nested, db };
}

test("only the single public /zodchi command enters chat mode", () => {
  assert.deepEqual(parseZodchiCommand("/zodchi"), { command: "/zodchi", message: null });
  assert.deepEqual(parseZodchiCommand(" /zodchi  Проверь импорт "), { command: "/zodchi", message: "Проверь импорт" });
  assert.equal(parseZodchiCommand("/zod"), null);
  assert.equal(parseZodchiCommand("/zodchi-status"), null);
  assert.equal(parseZodchiCommand("status"), null);
});

test("ordinary prompts are ignored until the exact client session enters Zodchi mode", () => {
  const value = fixture();
  try {
    assert.equal(routeChatPrompt(value.db, { client: "codex", sessionId: "one", origin: value.nested, prompt: "обычный чат" }).action, "pass");
    assert.equal(routeChatPrompt(value.db, { client: "codex", sessionId: "one", origin: value.nested, prompt: "/zodchi" }).action, "activated");
    assert.equal(routeChatPrompt(value.db, { client: "codex", sessionId: "one", origin: value.nested, prompt: "теперь работаем" }).action, "route");
    assert.equal(routeChatPrompt(value.db, { client: "codex", sessionId: "two", origin: value.nested, prompt: "соседний чат" }).action, "pass");
    assert.equal(routeChatPrompt(value.db, { client: "claude-code", sessionId: "one", origin: value.nested, prompt: "другой клиент" }).action, "pass");
  } finally { value.db.close(); fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("a session cannot silently move to another registered project", () => {
  const value = fixture();
  try {
    const other = path.join(value.root, "other"); fs.mkdirSync(other);
    value.db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('other','Other',?,?)").run(other, new Date().toISOString());
    activateChatSession(value.db, { client: "codex", sessionId: "one", origin: value.project });
    assert.throws(() => routeChatPrompt(value.db, { client: "codex", sessionId: "one", origin: other, prompt: "продолжай" }), /ZODCHI_SESSION_PROJECT_MISMATCH/);
  } finally { value.db.close(); fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("SessionEnd closes routing without needing a public exit command", () => {
  const value = fixture();
  try {
    activateChatSession(value.db, { client: "codex", sessionId: "one", origin: value.project });
    assert.equal(endChatSession(value.db, { client: "codex", sessionId: "one" }), true);
    assert.equal(routeChatPrompt(value.db, { client: "codex", sessionId: "one", origin: value.project, prompt: "обычный чат снова" }).action, "pass");
  } finally { value.db.close(); fs.rmSync(value.root, { recursive: true, force: true }); }
});
