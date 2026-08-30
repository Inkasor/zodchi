import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db.mjs";
import { routeSessionEvent } from "../src/session-router.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-session-router-"));
  const project = path.join(root, "project"); fs.mkdirSync(project);
  const file = path.join(root, "workflow.sqlite"), db = openDb(file);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, new Date().toISOString());
  db.close();
  return { root, project, file };
}

const event = (root, prompt, session = "session") => ({ hook_event_name: "UserPromptSubmit", session_id: session, turn_id: `${session}:turn`, cwd: root, prompt });

test("the conditional router emits nothing outside an active session", async () => {
  const value = fixture();
  try { assert.equal(await routeSessionEvent({ event: event(value.project, "ordinary chat"), client: "codex", dbFile: value.file }), null); }
  finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("/zodchi activates only the current session and later prompts route through the platform", async () => {
  const value = fixture(), calls = [];
  try {
    const activated = await routeSessionEvent({ event: event(value.project, "/zodchi"), client: "codex", dbFile: value.file, preferredLanguage: "ru" });
    assert.equal(activated.decision, "block");
    assert.match(activated.reason, /Режим Zodchi включён/);
    const routed = await routeSessionEvent({ event: event(value.project, "Сделай импорт"), client: "codex", dbFile: value.file }, {
      processMessage: async input => { calls.push(input); return { route: "conversation", response: "Профиль подготовлен", response_language: "ru" }; }
    });
    assert.equal(routed.reason, "Профиль подготовлен");
    assert.equal(calls[0].message, "Сделай импорт");
    assert.equal(calls[0].prepareOnly, true);
    assert.equal(calls[0].project, "project");
    assert.equal(await routeSessionEvent({ event: event(value.project, "Соседний чат", "other"), client: "codex", dbFile: value.file }), null);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("prepared work starts from an ordinary confirmation without a public execute command", async () => {
  const value = fixture(), calls = [];
  try {
    await routeSessionEvent({ event: event(value.project, "/zodchi"), client: "codex", dbFile: value.file });
    await routeSessionEvent({ event: event(value.project, "Реализуй импорт"), client: "codex", dbFile: value.file }, {
      processMessage: async input => { calls.push(input); return { route: "prepared", response: "Профиль", response_language: "ru", run_profile: { quality_mode: "mvp", execution_mode: "goal", verification_mode: "gauntlet", planning_mode: "single" } }; }
    });
    await routeSessionEvent({ event: event(value.project, "делай"), client: "codex", dbFile: value.file }, {
      processMessage: async input => { calls.push(input); return { route: "work", response: "Готово", response_language: "ru" }; }
    });
    assert.equal(calls[1].message, "Реализуй импорт");
    assert.equal(calls[1].prepareOnly, false);
    assert.deepEqual(calls[1].runProfileOverrides, { quality_mode: "mvp", execution_mode: "goal", verification_mode: "gauntlet", planning_mode: "single" });
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("/zodchi with text activates and routes the same text once", async () => {
  const value = fixture(), calls = [];
  try {
    await routeSessionEvent({ event: event(value.project, "/zodchi Исследуй проблему"), client: "claude-code", dbFile: value.file }, {
      processMessage: async input => { calls.push(input); return { route: "conversation", response: "Начал", response_language: "ru" }; }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, "Исследуй проблему");
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("a host-expanded skill marker activates the session without treating skill instructions as a task", async () => {
  const value = fixture(), calls = [];
  try {
    const activated = await routeSessionEvent({ event: event(value.project, "internal skill text\nZODCHI_SESSION_ACTIVATION_V1"), client: "codex", dbFile: value.file }, { processMessage: async input => calls.push(input) });
    assert.match(activated.reason, /Zodchi/);
    assert.equal(calls.length, 0);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("SessionEnd restores ordinary chat behavior", async () => {
  const value = fixture();
  try {
    await routeSessionEvent({ event: event(value.project, "/zodchi"), client: "codex", dbFile: value.file });
    assert.equal(await routeSessionEvent({ event: { hook_event_name: "SessionEnd", session_id: "session", cwd: value.project }, client: "codex", dbFile: value.file }), null);
    assert.equal(await routeSessionEvent({ event: event(value.project, "обычный чат"), client: "codex", dbFile: value.file }), null);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
