import test from "node:test";
import assert from "node:assert/strict";
import { expandEnvironmentTemplate, resolveProviderCommand } from "../src/command.mjs";

test("provider command uses a portable Windows executable template without a shell", () => {
  const config = { command: "opencode", windowsCommand: "%APPDATA%\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe" };
  assert.equal(resolveProviderCommand(config, { platform: "win32", env: { APPDATA: "profile-root" } }), "profile-root\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe");
  assert.equal(resolveProviderCommand(config, { platform: "linux", env: {} }), "opencode");
  assert.equal(expandEnvironmentTemplate("%MISSING%\\tool.exe", {}), "%MISSING%\\tool.exe");
});
