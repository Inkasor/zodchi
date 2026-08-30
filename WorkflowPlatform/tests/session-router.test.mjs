import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
    assert.equal(activated.decision, undefined);
    assert.match(activated.additionalContext, /Zodchi mode is now active/);
    const routed = await routeSessionEvent({ event: event(value.project, "Сделай импорт"), client: "codex", dbFile: value.file }, {
      processMessage: async input => { calls.push(input); return { route: "conversation", response: "Профиль подготовлен", response_language: "ru" }; }
    });
    assert.equal(routed.decision, undefined);
    assert.match(routed.additionalContext, /Профиль подготовлен/);
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

test("a quoted profile card followed by confirmation executes the original pending task once", async () => {
  const value = fixture(), calls = [];
  try {
    await routeSessionEvent({ event: event(value.project, "/zodchi"), client: "codex", dbFile: value.file });
    await routeSessionEvent({ event: event(value.project, "Подготовь два документа"), client: "codex", dbFile: value.file }, {
      processMessage: async input => { calls.push(input); return { route: "prepared", response: "Профиль выполнения: Quality=mvp", response_language: "ru", run_profile: { quality_mode: "mvp", execution_mode: "standard", verification_mode: "gauntlet", planning_mode: "single" } }; }
    });
    const quoted = '"Профиль выполнения: Quality=mvp; Execution=standard; Verification=gauntlet; Planning=single.\n\nЕсли профиль подходит, ответьте обычным сообщением — например, «делай»."\n\nДелай';
    await routeSessionEvent({ event: event(value.project, quoted), client: "codex", dbFile: value.file }, {
      processMessage: async input => { calls.push(input); return { route: "work", response: "Готово", response_language: "ru" }; }
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].message, "Подготовь два документа");
    assert.equal(calls[1].prepareOnly, false);
    const db = openDb(value.file);
    try { assert.equal(db.prepare("SELECT pending_message FROM zodchi_chat_sessions WHERE client='codex' AND session_id='session'").get().pending_message, null); }
    finally { db.close(); }
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
    assert.match(activated.additionalContext, /Zodchi/);
    assert.equal(calls.length, 0);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("a real Codex skill mention activates only from the installed skill path and preserves task text", async () => {
  const value = fixture(), calls = [], skill = path.join(value.root, "codex skills", "zodchi", "SKILL.md");
  try {
    const wrong = await routeSessionEvent({
      event: event(value.project, `[$zodchi](${path.join(value.root, "foreign", "SKILL.md")}) Сделай импорт`, "wrong"),
      client: "codex", dbFile: value.file, activationSkillPath: skill
    });
    assert.equal(wrong, null);
    await routeSessionEvent({
      event: event(value.project, `[$zodchi](${skill}) Сделай импорт`, "real"),
      client: "codex", dbFile: value.file, activationSkillPath: skill
    }, { processMessage: async input => { calls.push(input); return { route: "conversation", response: "Начал", response_language: "ru" }; } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, "Сделай импорт");
    assert.equal(calls[0].prepareOnly, true);
    assert.equal((await routeSessionEvent({ event: event(value.project, "обычный чат", "wrong"), client: "codex", dbFile: value.file })), null);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("a Codex skill mention follows a filesystem alias to the installed skill", async () => {
  const value = fixture(), actualRoot = path.join(value.root, "actual skills"), aliasRoot = path.join(value.root, "skill alias");
  const actual = path.join(actualRoot, "zodchi", "SKILL.md"), alias = path.join(aliasRoot, "zodchi", "SKILL.md");
  try {
    fs.mkdirSync(path.dirname(actual), { recursive: true });
    fs.writeFileSync(actual, "zodchi", "utf8");
    fs.symlinkSync(actualRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const activated = await routeSessionEvent({ event: event(value.project, `[$zodchi](${alias})`, "aliased"), client: "codex", dbFile: value.file, activationSkillPath: actual });
    assert.match(activated.additionalContext, /Zodchi/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("the installed hook starts when its CLI path reaches the same file through an alias", () => {
  const value = fixture(), platformRoot = path.resolve(import.meta.dirname, ".."), aliasRoot = path.join(value.root, "platform alias");
  const skill = path.join(value.root, "skills", "zodchi", "SKILL.md");
  try {
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, "zodchi", "utf8");
    fs.symlinkSync(platformRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const script = path.join(aliasRoot, "hooks", "session-router.mjs");
    const payload = event(value.project, `[$zodchi](${skill})`, "aliased-cli");
    const result = spawnSync(process.execPath, [script, "--client", "codex", "--db", value.file, "--skill-path", skill, "--delivery-mode", "final"], {
      encoding: "utf8", input: JSON.stringify(payload), windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, undefined);
    assert.match(output.additionalContext, /Zodchi mode is now active/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("the canonical Codex skill token activates without exposing a second public command", async () => {
  const value = fixture();
  try {
    const activated = await routeSessionEvent({ event: event(value.project, "$zodchi"), client: "codex", dbFile: value.file, preferredLanguage: "en" });
    assert.match(activated.additionalContext, /Zodchi mode is now active/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("activation is non-blocking in both Codex and Claude Code", async () => {
  for (const client of ["codex", "claude-code"]) {
    const value = fixture();
    try {
      const activationEvent = client === "codex"
        ? event(value.project, "/zodchi", `${client}-activation`)
        : { hook_event_name: "UserPromptSubmit", session_id: `${client}-activation`, prompt_id: `${client}:prompt`, cwd: value.project, prompt: "/zodchi" };
      const activated = await routeSessionEvent({ event: activationEvent, client, dbFile: value.file, deliveryMode: "final" });
      assert.equal(activated.decision, undefined, client);
      assert.match(activated.additionalContext, /Zodchi mode is now active/, client);
      const db = openDb(value.file);
      try { assert.equal(db.prepare("SELECT state FROM zodchi_chat_sessions WHERE client=? AND session_id=?").get(client, `${client}-activation`)?.state, "active", client); }
      finally { db.close(); }
    } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
  }
});

test("SessionEnd restores ordinary chat behavior", async () => {
  const value = fixture();
  try {
    await routeSessionEvent({ event: event(value.project, "/zodchi"), client: "codex", dbFile: value.file });
    assert.equal(await routeSessionEvent({ event: { hook_event_name: "SessionEnd", session_id: "session", cwd: value.project }, client: "codex", dbFile: value.file }), null);
    assert.equal(await routeSessionEvent({ event: event(value.project, "обычный чат"), client: "codex", dbFile: value.file }), null);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
