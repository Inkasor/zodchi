import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { applyHookInstallation, planHookInstallation } from "../../WorkflowPlatform/src/hook-installation.mjs";
import { defaultInstallationPaths } from "../installation-paths.mjs";
import { ensureDirectory, installRelease, rollbackRelease, uninstallRelease } from "../install.mjs";
import { requireProvenanceAttestation, selectReleaseAssets } from "../install-latest.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
function temporaryRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-installer-")); }
function release(root, version) {
  fs.mkdirSync(path.join(root, "WorkflowPlatform", "hooks"), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, "WorkflowPlatform", "hooks", "user-prompt-submit.mjs"), path.join(root, "WorkflowPlatform", "hooks", "user-prompt-submit.mjs"));
  fs.copyFileSync(path.join(repositoryRoot, "WorkflowPlatform", "hooks", "session-router.mjs"), path.join(root, "WorkflowPlatform", "hooks", "session-router.mjs"));
  fs.cpSync(path.join(repositoryRoot, "configs"), path.join(root, "configs"), { recursive: true });
  fs.cpSync(path.join(repositoryRoot, "integrations"), path.join(root, "integrations"), { recursive: true });
  fs.writeFileSync(path.join(root, "product.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "release-marker.txt"), version);
  return root;
}
function skillRoots(root) { return { "claude-code": path.join(root, "skills-claude"), codex: path.join(root, "skills-codex") }; }
function sessionHookFiles(root) { return { "claude-code": path.join(root, "hooks-claude", "settings.json"), codex: path.join(root, "hooks-codex", "hooks.json") }; }

test("an existing filesystem root is a valid parent for a specific installation directory", () => {
  const filesystemRoot = path.parse(process.cwd()).root;
  assert.equal(ensureDirectory(filesystemRoot, "DESTINATION_PARENT"), filesystemRoot);
});

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

test("latest installer requires a repository provenance record for the archive digest", () => {
  const hash = "a".repeat(64);
  assert.deepEqual(requireProvenanceAttestation({ attestations: [{ repository_id: 42, bundle_url: "https://example.invalid/bundle.json" }] }, hash), { subject_digest: `sha256:${hash}`, records: 1 });
  assert.throws(() => requireProvenanceAttestation({ attestations: [] }, hash), /INSTALL_RELEASE_ATTESTATION_MISSING/);
  assert.throws(() => requireProvenanceAttestation({ attestations: [{ repository_id: 42, bundle_url: "http:\/\/example.invalid\/bundle.json" }] }, hash), /INSTALL_RELEASE_ATTESTATION_INVALID/);
});

// An isolated installation (release smoke, acceptance) must be able to keep the explicit commands
// inside its own throwaway directory. Without the flag such a run rewrites the operator's real
// `/zodchi` to point at a path it deletes when it finishes.
test("the installer command line can direct client skills away from the operator home", () => {
  const root = temporaryRoot(), source = release(path.join(root, "source"), "0.6.0-rc.1"), roots = skillRoots(root);
  const installer = path.join(repositoryRoot, "tools", "install.mjs"), rootsFile = path.join(root, "skill-roots.json");
  const run = (destination, dataRoot) => execFileSync(process.execPath, [installer, "install", "--source", source, "--destination", path.join(root, destination), "--data-root", path.join(root, dataRoot), "--skill-roots", rootsFile], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
  try {
    fs.mkdirSync(path.join(source, "tools"), { recursive: true });
    fs.writeFileSync(path.join(source, "tools", "release-lint.mjs"), "process.exitCode = 0;\n", "utf8");
    fs.writeFileSync(rootsFile, `${JSON.stringify(roots, null, 2)}\n`, "utf8");
    run("installed", "data");
    for (const client of ["claude-code", "codex"]) assert.equal(fs.existsSync(path.join(roots[client], "zodchi", "SKILL.md")), true, client);
    fs.writeFileSync(rootsFile, `${JSON.stringify({ codex: roots.codex }, null, 2)}\n`, "utf8");
    assert.throws(() => run("installed-2", "data-2"), /INSTALL_SKILL_ROOTS_INVALID/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("clean install deploys explicit client skills and does not install project hooks", () => {
  const root = temporaryRoot(), source = release(path.join(root, "source"), "0.6.0-rc.1"), destination = path.join(root, "installed"), dataRoot = path.join(root, "data"), project = path.join(root, "clean project");
  try {
    fs.mkdirSync(project);
    const healthCheck = candidate => assert.equal(fs.existsSync(path.join(candidate, "release-marker.txt")), true);
    const roots = skillRoots(root);
    const installed = installRelease({ source, destination, dataRoot, skillRoots: roots, healthCheck });
    assert.equal(installed.hook_results.length, 0);
    assert.equal(installed.skill_results.length, 2);
    assert.equal(fs.existsSync(path.join(project, ".codex", ".zodchi-hook.json")), false);
    assert.match(fs.readFileSync(path.join(roots.codex, "zodchi", "SKILL.md"), "utf8"), /session router/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("update removes owned legacy hooks, refreshes skills, rollback keeps hooks absent and preserves data", () => {
  const root = temporaryRoot(), sourceA = release(path.join(root, "a"), "0.5.24"), sourceB = release(path.join(root, "b"), "0.6.0-rc.1"), destination = path.join(root, "installed"), dataRoot = path.join(root, "data"), project = path.join(root, "проект 😀");
  fs.mkdirSync(project); fs.mkdirSync(dataRoot); fs.writeFileSync(path.join(dataRoot, "owner-data.txt"), "preserve me");
  const healthCheck = candidate => assert.equal(fs.existsSync(path.join(candidate, "release-marker.txt")), true), roots = skillRoots(root);
  installRelease({ source: sourceA, destination, dataRoot, skillRoots: roots, healthCheck });
  applyHookInstallation(planHookInstallation({ projectRoot: project, harness: "codex", root: path.join(destination, "WorkflowPlatform"), configsRoot: path.join(destination, "configs") }));
  const hookManifest = [{ projectRoot: project, harness: "codex" }];
  const updated = installRelease({ source: sourceB, destination, dataRoot, hooks: hookManifest, skillRoots: roots, healthCheck });
  assert.equal(updated.version, "0.6.0-rc.1");
  assert.equal(fs.existsSync(path.join(project, ".codex", ".zodchi-hook.json")), false);
  assert.match(fs.readFileSync(path.join(roots["claude-code"], "zodchi", "SKILL.md"), "utf8"), /session router/);
  assert.equal(fs.readFileSync(path.join(dataRoot, "owner-data.txt"), "utf8"), "preserve me");
  const rolledBack = rollbackRelease({ destination, dataRoot, skillRoots: roots, healthCheck });
  assert.equal(rolledBack.version, "0.5.24");
  assert.equal(fs.readFileSync(path.join(destination, "release-marker.txt"), "utf8"), "0.5.24");
  assert.equal(fs.readFileSync(path.join(dataRoot, "owner-data.txt"), "utf8"), "preserve me");
  assert.equal(fs.existsSync(path.join(project, ".codex", ".zodchi-hook.json")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("failed update restores release, exact legacy hook files and exact skill files", () => {
  const root = temporaryRoot(), sourceA = release(path.join(root, "a"), "0.5.24"), sourceB = release(path.join(root, "b"), "0.6.0-rc.1"), destination = path.join(root, "installed"), dataRoot = path.join(root, "data"), project = path.join(root, "project");
  fs.mkdirSync(project);
  const healthy = candidate => assert.equal(fs.existsSync(path.join(candidate, "release-marker.txt")), true), roots = skillRoots(root);
  installRelease({ source: sourceA, destination, dataRoot, skillRoots: roots, healthCheck: healthy });
  applyHookInstallation(planHookInstallation({ projectRoot: project, harness: "claude-code", root: path.join(destination, "WorkflowPlatform"), configsRoot: path.join(destination, "configs") }));
  const hookFile = path.join(project, ".claude", "settings.local.json"), markerFile = path.join(project, ".claude", ".zodchi-hook.json");
  const hookBefore = fs.readFileSync(hookFile), markerBefore = fs.readFileSync(markerFile);
  const skillBefore = fs.readFileSync(path.join(roots.codex, "zodchi", "SKILL.md"));
  let checks = 0;
  assert.throws(() => installRelease({ source: sourceB, destination, dataRoot, hooks: [{ projectRoot: project, harness: "claude-code" }], skillRoots: roots, healthCheck: candidate => { checks += 1; healthy(candidate); if (checks === 3) throw new Error("POST_SWAP_HEALTH_FAILED"); } }), /POST_SWAP_HEALTH_FAILED/);
  assert.equal(fs.readFileSync(path.join(destination, "release-marker.txt"), "utf8"), "0.5.24");
  assert.deepEqual(fs.readFileSync(hookFile), hookBefore);
  assert.deepEqual(fs.readFileSync(markerFile), markerBefore);
  assert.deepEqual(fs.readFileSync(path.join(roots.codex, "zodchi", "SKILL.md")), skillBefore);
  fs.rmSync(root, { recursive: true, force: true });
});

// A second installation in the same home must not be able to disarm the first one's explicit
// commands, neither by installing over them nor by uninstalling itself.
test("a second installation neither takes over nor removes the first one's explicit commands", () => {
  const root = temporaryRoot(), source = release(path.join(root, "source"), "0.6.0-rc.1"), roots = skillRoots(root);
  const healthCheck = candidate => assert.equal(fs.existsSync(path.join(candidate, "release-marker.txt")), true);
  const first = path.join(root, "first"), second = path.join(root, "second");
  try {
    installRelease({ source, destination: first, dataRoot: path.join(root, "data-1"), skillRoots: roots, healthCheck });
    const skill = path.join(roots.codex, "zodchi", "SKILL.md"), before = fs.readFileSync(skill);
    assert.throws(() => installRelease({ source, destination: second, dataRoot: path.join(root, "data-2"), skillRoots: roots, healthCheck }), /SKILL_OWNED_BY_OTHER_INSTALLATION/);
    assert.deepEqual(fs.readFileSync(skill), before);
    const uninstalled = uninstallRelease({ destination: second, dataRoot: path.join(root, "data-2"), skillRoots: roots });
    assert.equal(uninstalled.skills.filter(item => item.name === "zodchi").every(item => item.status === "different_installation"), true);
    assert.deepEqual(fs.readFileSync(skill), before);
    assert.equal(uninstallRelease({ destination: first, dataRoot: path.join(root, "data-1"), skillRoots: roots }).skills.filter(item => item.name === "zodchi").every(item => item.status === "removed"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("uninstall removes owned skills and legacy hooks while leaving mutable data recoverable", () => {
  const root = temporaryRoot(), source = release(path.join(root, "source"), "0.5.24"), destination = path.join(root, "installed"), dataRoot = path.join(root, "data"), project = path.join(root, "project"); fs.mkdirSync(project);
  const healthCheck = candidate => assert.equal(fs.existsSync(path.join(candidate, "release-marker.txt")), true);
  const roots = skillRoots(root);
  installRelease({ source, destination, dataRoot, skillRoots: roots, healthCheck });
  applyHookInstallation(planHookInstallation({ projectRoot: project, harness: "codex", root: path.join(destination, "WorkflowPlatform"), configsRoot: path.join(destination, "configs") }));
  const result = uninstallRelease({ destination, dataRoot, hooks: [{ projectRoot: project, harness: "codex" }], skillRoots: roots });
  assert.equal(result.user_data_preserved, true);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(result.recoverable_release), true);
  assert.equal(fs.existsSync(path.join(project, ".codex", ".zodchi-hook.json")), false);
    assert.equal(result.skills.filter(item => item.status === "removed").length, 2);
  assert.equal(fs.existsSync(path.join(dataRoot, "installation-state.json")), true);
  fs.rmSync(root, { recursive: true, force: true });
});
