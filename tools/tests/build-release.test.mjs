import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRelease } from "../../scripts/build-release.mjs";
import { installRelease } from "../install.mjs";
import { execFileSync } from "node:child_process";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");

test("platform-neutral builder produces a lintable archive root that the canonical installer accepts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-build-test-"));
  try {
    const output = path.join(root, "release"), installed = path.join(root, "installed"), dataRoot = path.join(root, "data");
    const built = buildRelease({ repositoryRoot, output, stageRoot: root });
    assert.equal(built.status, "built");
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "bundle-manifest.json"), "utf8"));
    assert.equal(manifest.files.some(item => item.path === "tools/install.mjs"), true);
    assert.equal(manifest.files.some(item => item.path === "WorkflowPlatform/src/command-resolver.mjs"), true);
    assert.equal(manifest.files.some(item => item.path === "WorkflowPlatform/presets/catalog.json"), true);
    const installation = installRelease({ source: output, destination: installed, dataRoot });
    assert.equal(installation.status, "installed");
    assert.equal(fs.existsSync(path.join(installed, "WorkflowPlatform", "hooks", "user-prompt-submit.mjs")), true);
    const presets = JSON.parse(execFileSync(process.execPath, [path.join(installed, "WorkflowPlatform", "src", "cli.mjs"), "preset-lint"], { encoding: "utf8", windowsHide: true }));
    assert.deepEqual(presets, { status: "passed", presets: 15 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
