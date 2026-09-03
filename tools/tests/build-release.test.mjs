import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildRelease } from "../../scripts/build-release.mjs";
import { installRelease } from "../install.mjs";
import { execFileSync } from "node:child_process";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");

test("platform-neutral builder produces a lintable archive root that the canonical installer accepts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-build-test-"));
  try {
    const output = path.join(root, "release"), installed = path.join(root, "installed"), dataRoot = path.join(root, "data");
    const skillRoots = { "claude-code": path.join(root, "claude-skills"), codex: path.join(root, "codex-skills") };
    const built = buildRelease({ repositoryRoot, output });
    assert.equal(built.status, "built");
    assert.equal(fs.existsSync(path.join(root, ".zodchi-stage")), true);
    assert.deepEqual(fs.readdirSync(path.join(root, ".zodchi-stage")), []);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "bundle-manifest.json"), "utf8"));
    assert.equal(manifest.files.some(item => item.path === "tools/install.mjs"), true);
    for (const tool of ["browser-sentinel.mjs", "codex-browser-smoke.mjs", "codex-readonly-smoke.mjs", "kimi-write-boundary-smoke.mjs", "mcp-browser-smoke.mjs"]) {
      assert.equal(manifest.files.some(item => item.path === `tools/${tool}`), true, tool);
    }
    assert.equal(manifest.files.some(item => item.path === "WorkflowPlatform/src/command-resolver.mjs"), true);
    assert.equal(manifest.files.some(item => item.path === "WorkflowPlatform/presets/catalog.json"), true);
    assert.equal(manifest.files.some(item => item.path === "WorkflowPlatform/scripts/project-baseline.mjs"), true);
    assert.equal(manifest.files.some(item => item.path === "tools/release-lint.mjs"), true);
    assert.equal(manifest.files.some(item => item.path === "scripts/build-release-manifest.mjs"), true);
    assert.equal(manifest.files.some(item => item.path === "scripts/build-release-archive.mjs"), true);
    const installation = installRelease({ source: output, destination: installed, dataRoot, skillRoots });
    assert.equal(installation.status, "installed");
    assert.equal(fs.existsSync(path.join(installed, "WorkflowPlatform", "scripts", "explicit-invoke.mjs")), true);
    assert.equal(fs.existsSync(path.join(skillRoots.codex, "zodchi", ".zodchi-skill.json")), true);
    const baseline = await import(pathToFileURL(path.join(installed, "WorkflowPlatform", "scripts", "project-baseline.mjs")).href);
    assert.equal(typeof baseline.captureProjectBaseline, "function");
    const presets = JSON.parse(execFileSync(process.execPath, [path.join(installed, "WorkflowPlatform", "src", "cli.mjs"), "preset-lint"], { encoding: "utf8", windowsHide: true }));
    assert.deepEqual(presets, { status: "passed", presets: 15 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
