import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expandEnvironmentTemplate, providerCommandInvocation, resolveProviderCommand } from "../src/command.mjs";

test("provider commands resolve from the platform and Windows wrappers use the command processor explicitly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-command-"));
  const executable = path.join(root, process.platform === "win32" ? "opencode.exe" : "opencode"); fs.writeFileSync(executable, "fixture");
  const config = { command: "opencode" };
  assert.equal(resolveProviderCommand(config, { platform: process.platform, env: { PATH: root } }), executable);
  assert.throws(() => resolveProviderCommand({ command: "missing-provider" }, { platform: process.platform, env: { PATH: root } }), /PROVIDER_COMMAND_UNAVAILABLE/);
  assert.equal(expandEnvironmentTemplate("%MISSING%\\tool.exe", {}), "%MISSING%\\tool.exe");
  const invocation = providerCommandInvocation("tool.cmd", ["one"], { platform: "win32", env: { ComSpec: "command-processor.exe" } });
  assert.deepEqual(invocation, { executable: "command-processor.exe", args: ["/d", "/s", "/c", '\"\"tool.cmd\" \"one\"\"'], windowsVerbatimArguments: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("Windows provider wrappers execute from an absolute path containing spaces", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway command "));
  try {
    const command = path.join(root, "provider fixture.cmd");
    fs.writeFileSync(command, "@echo off\r\nif \"%~1\"==\"ok\" (echo provider-ok& exit /b 0) else (exit /b 9)\r\n");
    const invocation = providerCommandInvocation(command, ["ok"]);
    const result = spawnSync(invocation.executable, invocation.args, { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /provider-ok/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
