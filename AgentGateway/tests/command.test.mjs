import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandEnvironmentTemplate, providerCommandInvocation, resolveProviderCommand } from "../src/command.mjs";

test("provider commands resolve from the platform and Windows wrappers use the command processor explicitly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-command-"));
  const executable = path.join(root, process.platform === "win32" ? "opencode.exe" : "opencode"); fs.writeFileSync(executable, "fixture");
  const config = { command: "opencode" };
  assert.equal(resolveProviderCommand(config, { platform: process.platform, env: { PATH: root } }), executable);
  assert.throws(() => resolveProviderCommand({ command: "missing-provider" }, { platform: process.platform, env: { PATH: root } }), /PROVIDER_COMMAND_UNAVAILABLE/);
  assert.equal(expandEnvironmentTemplate("%MISSING%\\tool.exe", {}), "%MISSING%\\tool.exe");
  const invocation = providerCommandInvocation("tool.cmd", ["one"], { platform: "win32", env: { ComSpec: "command-processor.exe" } });
  assert.deepEqual(invocation, { executable: "command-processor.exe", args: ["/d", "/s", "/c", "tool.cmd", "one"] });
  fs.rmSync(root, { recursive: true, force: true });
});
