import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeExplicitTask } from "../src/explicit-invocation.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-explicit-"));
  const project = path.join(root, "проект 😀"), messageFile = path.join(root, "message.txt");
  fs.mkdirSync(project); fs.writeFileSync(messageFile, "Проверь цепочку API → UI 😀\n", "utf8");
  return { root, project, messageFile };
}

test("explicit invocation preserves UTF-8 task bytes and removes the transfer file", async () => {
  const value = fixture(), calls = [];
  try {
    const result = await invokeExplicitTask({ client: "codex", origin: value.project, messageFile: value.messageFile, deleteMessageFile: true, dbFile: "workflow.sqlite" }, {
      processMessage: async input => { calls.push(input); return { run_id: "run-1", route: "work", response_language: "ru", response: "Готово" }; }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, "Проверь цепочку API → UI 😀\n");
    assert.equal(calls[0].origin, value.project);
    assert.equal(calls[0].eventSource, "codex-skill");
    assert.equal(calls[0].execute, true);
    assert.equal(result.response, "Готово");
    assert.equal(result.source_bytes, Buffer.byteLength(calls[0].message));
    assert.equal(fs.existsSync(value.messageFile), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
test("explicit invocation fails closed for invalid clients, empty messages and oversized files", async () => {
  const value = fixture();
  try {
    await assert.rejects(() => invokeExplicitTask({ client: "other", origin: value.project, messageFile: value.messageFile }), /EXPLICIT_CLIENT_INVALID/);
    fs.writeFileSync(value.messageFile, "  \n", "utf8");
    await assert.rejects(() => invokeExplicitTask({ client: "claude-code", origin: value.project, messageFile: value.messageFile }), /EXPLICIT_MESSAGE_EMPTY/);
    fs.writeFileSync(value.messageFile, Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(() => invokeExplicitTask({ client: "claude-code", origin: value.project, messageFile: value.messageFile }), /EXPLICIT_MESSAGE_TOO_LARGE/);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
