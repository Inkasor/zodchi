import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installSessionHooks, removeSessionHooks, restoreSessionHooks, sessionHookDocumentUsesScript, sessionHookParameters, snapshotSessionHooks } from "../session-hook-installation.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-session-hooks-")), application = path.join(root, "application");
  fs.mkdirSync(path.join(application, "WorkflowPlatform", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(application, "WorkflowPlatform", "hooks", "session-router.mjs"), "// router\n");
  return {
    root, application,
    files: { codex: path.join(root, "codex", "hooks.json"), "claude-code": path.join(root, "claude", "settings.json") },
    skillRoots: { codex: path.join(root, "codex skills"), "claude-code": path.join(root, "claude skills") }
  };
}

test("session hooks merge two conditional events and preserve foreign configuration", () => {
  const value = fixture();
  try {
    fs.mkdirSync(path.dirname(value.files.codex), { recursive: true });
    const foreign = { hooks: [{ type: "command", command: "node foreign.mjs" }] };
    fs.writeFileSync(value.files.codex, JSON.stringify({ setting: "kept", hooks: { UserPromptSubmit: [foreign] } }));
    const installed = installSessionHooks({ applicationRoot: value.application, files: value.files, skillRoots: value.skillRoots });
    const script = path.join(value.application, "WorkflowPlatform", "hooks", "session-router.mjs");
    for (const file of Object.values(value.files)) {
      assert.equal(sessionHookDocumentUsesScript(JSON.parse(fs.readFileSync(file, "utf8")), script), true);
    }
    const document = JSON.parse(fs.readFileSync(value.files.codex, "utf8"));
    assert.equal(document.setting, "kept");
    assert.equal(document.hooks.UserPromptSubmit.length, 2);
    assert.equal(document.hooks.SessionEnd.length, 1);
    assert.deepEqual(document.hooks.UserPromptSubmit[0], foreign);
    assert.equal(document.hooks.UserPromptSubmit[1].hooks[0].timeout, 3600);
    assert.match(document.hooks.UserPromptSubmit[1].hooks[0].command, /--skill-path/);
    assert.match(document.hooks.UserPromptSubmit[1].hooks[0].command, /codex skills/);
    assert.match(document.hooks.UserPromptSubmit[1].hooks[0].command, /--delivery-mode advisory/);
    assert.doesNotMatch(document.hooks.UserPromptSubmit[1].hooks[0].command, /--delivery-mode final/);
    for (const client of ["codex", "claude-code"]) {
      const parameters = sessionHookParameters({ applicationRoot: value.application, client, event: "UserPromptSubmit", skillRoots: value.skillRoots });
      assert.equal(parameters.includes("advisory"), true, client);
      assert.equal(parameters.includes("final"), false, client);
    }
    assert.equal(document.hooks.SessionEnd[0].hooks[0].timeout, 3);
    assert.equal(installed.find(item => item.client === "codex").runtime_status, "requires_user_trust_verification");
    installSessionHooks({ applicationRoot: value.application, files: value.files, skillRoots: value.skillRoots });
    assert.equal(JSON.parse(fs.readFileSync(value.files.codex, "utf8")).hooks.UserPromptSubmit.length, 2);
    removeSessionHooks({ applicationRoot: value.application, files: value.files });
    assert.deepEqual(JSON.parse(fs.readFileSync(value.files.codex, "utf8")).hooks.UserPromptSubmit, [foreign]);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("session-hook installation snapshots restore exact bytes", () => {
  const value = fixture();
  try {
    fs.mkdirSync(path.dirname(value.files.codex), { recursive: true }); fs.writeFileSync(value.files.codex, "{\"before\":true}\n");
    const snapshots = snapshotSessionHooks({ files: value.files });
    installSessionHooks({ applicationRoot: value.application, files: value.files });
    restoreSessionHooks(snapshots);
    assert.equal(fs.readFileSync(value.files.codex, "utf8"), "{\"before\":true}\n");
    assert.equal(fs.existsSync(path.join(path.dirname(value.files.codex), ".zodchi-session-hooks.json")), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
