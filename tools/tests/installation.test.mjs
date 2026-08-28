import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyHookInstallation, planHookInstallation } from "../../WorkflowPlatform/src/hook-installation.mjs";
import { defaultInstallationPaths } from "../installation-paths.mjs";
import { installRelease, rollbackRelease, uninstallRelease } from "../install.mjs";
import { selectReleaseAssets } from "../install-latest.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
function temporaryRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-installer-")); }
function release(root, version) {
  fs.mkdirSync(path.join(root, "WorkflowPlatform", "hooks"), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, "WorkflowPlatform", "hooks", "user-prompt-submit.mjs"), path.join(root, "WorkflowPlatform", "hooks", "user-prompt-submit.mjs"));
  fs.cpSync(path.join(repositoryRoot, "configs"), path.join(root, "configs"), { recursive: true });
  fs.writeFileSync(path.join(root, "product.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "release-marker.txt"), version);
  return root;
}

test("platform defaults keep replaceable application files separate from mutable data", () => {
  const winHome = "C:" + "\\Users\\test";
  const win = defaultInstallationPaths({ LOCALAPPDATA: winHome + "\\AppData\\Local" }, "win32", winHome);
  assert.notEqual(win.application, win.data);
  const mac = defaultInstallationPaths({}, "darwin", "/" + "Users/test");
  assert.match(mac.application, /Library[\\/]Application Support[\\/]Zodchi[\\/]app$/);
  const linuxData = "/" + "tmp/data";
  const linux = defaultInstallationPaths({ XDG_DATA_HOME: linuxData }, "linux", "/" + "home/test");
  assert.equal(linux.application, `${linuxData}/zodchi/app`);
});

test("latest installer accepts exactly one universal CI-published archive", () => {
  const asset = (name, login = "github-actions[bot]") => ({ name, uploader: { login } });
  const selected = selectReleaseAssets({ assets: [asset("Zodchi-v0.6.0.zip"), asset("SHA256SUMS.txt"), asset("zodchi-release-manifest.json")] });
  assert.equal(selected.archive.name, "Zodchi-v0.6.0.zip");
  assert.throws(() => selectReleaseAssets({ assets: [asset("Zodchi-v0.6.0-windows.zip"), asset("SHA256SUMS.txt"), asset("zodchi-release-manifest.json")] }), /INSTALL_RELEASE_ASSET_AMBIGUOUS/);
  assert.throws(() => selectReleaseAssets({ assets: [asset("Zodchi-v0.6.0.zip", "human"), asset("SHA256SUMS.txt"), asset("zodchi-release-manifest.json")] }), /INSTALL_RELEASE_NOT_CI_PUBLISHED/);
});

test("clean install applies an explicitly authorized hook manifest", () => {
  const root = temporaryRoot(), source = release(path.join(root, "source"), "0.6.0-rc.1"), destination = path.join(root, "installed"), dataRoot = path.join(root, "data"), project = path.join(root, "clean project");
  try {
    fs.mkdirSync(project);
    const healthCheck = candidate => assert.equal(fs.existsSync(path.join(candidate, "release-marker.txt")), true);
    const installed = installRelease({ source, destination, dataRoot, hooks: [{ projectRoot: project, harness: "codex" }], healthCheck });
    assert.equal(installed.hook_results.length, 1);
    assert.equal(fs.existsSync(path.join(project, ".codex", ".zodchi-hook.json")), true);
    assert.match(fs.readFileSync(path.join(project, ".codex", "hooks.json"), "utf8"), /user-prompt-submit\.mjs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("update and rollback swap exact releases, migrate owned hooks and preserve data", () => {
  const root = temporaryRoot(), sourceA = release(path.join(root, "a"), "0.5.24"), sourceB = release(path.join(root, "b"), "0.6.0-rc.1"), destination = path.join(root, "installed"), dataRoot = path.join(root, "data"), project = path.join(root, "проект 😀");
  fs.mkdirSync(project); fs.mkdirSync(dataRoot); fs.writeFileSync(path.join(dataRoot, "owner-data.txt"), "preserve me");
  const healthCheck = candidate => assert.equal(fs.existsSync(path.join(candidate, "release-marker.txt")), true);
  installRelease({ source: sourceA, destination, dataRoot, healthCheck });
  applyHookInstallation(planHookInstallation({ projectRoot: project, harness: "codex", root: path.join(destination, "WorkflowPlatform"), configsRoot: path.join(destination, "configs") }));
  const hookManifest = [{ projectRoot: project, harness: "codex" }];
  const updated = installRelease({ source: sourceB, destination, dataRoot, hooks: hookManifest, healthCheck });
  assert.equal(updated.version, "0.6.0-rc.1");
  assert.match(fs.readFileSync(path.join(project, ".codex", "hooks.json"), "utf8"), /installed/);
  assert.equal(fs.readFileSync(path.join(dataRoot, "owner-data.txt"), "utf8"), "preserve me");
  const rolledBack = rollbackRelease({ destination, dataRoot, healthCheck });
  assert.equal(rolledBack.version, "0.5.24");
  assert.equal(fs.readFileSync(path.join(destination, "release-marker.txt"), "utf8"), "0.5.24");
  assert.equal(fs.readFileSync(path.join(dataRoot, "owner-data.txt"), "utf8"), "preserve me");
  fs.rmSync(root, { recursive: true, force: true });
});

test("failed update restores both release and exact hook files", () => {
  const root = temporaryRoot(), sourceA = release(path.join(root, "a"), "0.5.24"), sourceB = release(path.join(root, "b"), "0.6.0-rc.1"), destination = path.join(root, "installed"), dataRoot = path.join(root, "data"), project = path.join(root, "project");
  fs.mkdirSync(project);
  const healthy = candidate => assert.equal(fs.existsSync(path.join(candidate, "release-marker.txt")), true);
  installRelease({ source: sourceA, destination, dataRoot, healthCheck: healthy });
  applyHookInstallation(planHookInstallation({ projectRoot: project, harness: "claude-code", root: path.join(destination, "WorkflowPlatform"), configsRoot: path.join(destination, "configs") }));
  const hookFile = path.join(project, ".claude", "settings.local.json"), markerFile = path.join(project, ".claude", ".zodchi-hook.json");
  const hookBefore = fs.readFileSync(hookFile), markerBefore = fs.readFileSync(markerFile);
  let checks = 0;
  assert.throws(() => installRelease({ source: sourceB, destination, dataRoot, hooks: [{ projectRoot: project, harness: "claude-code" }], healthCheck: candidate => { checks += 1; healthy(candidate); if (checks === 3) throw new Error("POST_SWAP_HEALTH_FAILED"); } }), /POST_SWAP_HEALTH_FAILED/);
  assert.equal(fs.readFileSync(path.join(destination, "release-marker.txt"), "utf8"), "0.5.24");
  assert.deepEqual(fs.readFileSync(hookFile), hookBefore);
  assert.deepEqual(fs.readFileSync(markerFile), markerBefore);
  fs.rmSync(root, { recursive: true, force: true });
});

test("uninstall removes only owned hooks and leaves mutable data recoverable", () => {
  const root = temporaryRoot(), source = release(path.join(root, "source"), "0.5.24"), destination = path.join(root, "installed"), dataRoot = path.join(root, "data"), project = path.join(root, "project"); fs.mkdirSync(project);
  const healthCheck = candidate => assert.equal(fs.existsSync(path.join(candidate, "release-marker.txt")), true);
  installRelease({ source, destination, dataRoot, healthCheck });
  applyHookInstallation(planHookInstallation({ projectRoot: project, harness: "codex", root: path.join(destination, "WorkflowPlatform"), configsRoot: path.join(destination, "configs") }));
  const result = uninstallRelease({ destination, dataRoot, hooks: [{ projectRoot: project, harness: "codex" }] });
  assert.equal(result.user_data_preserved, true);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(result.recoverable_release), true);
  assert.equal(fs.existsSync(path.join(project, ".codex", ".zodchi-hook.json")), false);
  assert.equal(fs.existsSync(path.join(dataRoot, "installation-state.json")), true);
  fs.rmSync(root, { recursive: true, force: true });
});
