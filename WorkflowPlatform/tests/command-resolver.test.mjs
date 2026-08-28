import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { COMMAND_CAPABILITIES, resolveCommandCapability, resolveCommandConfiguration } from "../src/command-resolver.mjs";

test("portable capabilities resolve a concrete executable and never invent a partial result", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-command-"));
  const executable = path.join(root, process.platform === "win32" ? "gitleaks.exe" : "gitleaks");
  fs.writeFileSync(executable, "fixture");
  const resolved = resolveCommandCapability("security.gitleaks", { env: { PATH: root }, platform: process.platform, execPath: process.execPath });
  assert.equal(resolved.command, executable);
  assert.equal(resolved.source, "path");
  assert.throws(() => resolveCommandCapability("security.osv_scanner", { env: { PATH: root }, platform: process.platform, execPath: process.execPath }), /COMMAND_CAPABILITY_UNAVAILABLE/);
  assert.throws(() => resolveCommandCapability("unknown.tool"), /COMMAND_CAPABILITY_UNKNOWN/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("package manager resolution is platform-aware and configured commands remain compatible", () => {
  const runtime = resolveCommandCapability("node.runtime");
  assert.equal(runtime.command, process.execPath);
  const configured = resolveCommandConfiguration({ command: process.execPath, args: [] });
  assert.equal(configured.source, "configured");
  assert.equal(COMMAND_CAPABILITIES.includes("node.package_manager"), true);
});

test("npm_execpath JavaScript is not mistaken for a Windows executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-npm-resolver-"));
  try {
    const node = path.join(root, "node.exe"), wrapper = path.join(root, "npm.cmd"), cli = path.join(root, "npm-cli.js");
    fs.writeFileSync(node, "fixture"); fs.writeFileSync(wrapper, "fixture"); fs.writeFileSync(cli, "fixture");
    const resolved = resolveCommandCapability("node.package_manager", { env: { PATH: "", npm_execpath: cli }, platform: "win32", execPath: node });
    assert.equal(resolved.command, wrapper);
    assert.equal(resolved.source, "node_directory");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
