import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildRelease } from "../scripts/build-release.mjs";
import { installRelease, rollbackRelease, uninstallRelease } from "./install.mjs";
import { hookInstallationStatus } from "../WorkflowPlatform/src/hook-installation.mjs";
import { resolveCommandCapability } from "../WorkflowPlatform/src/command-resolver.mjs";

function argsObject(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) {
    const key = argv[index].slice(2);
    result[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function samePath(left, right) { const a = path.resolve(left), b = path.resolve(right); return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function ensure(condition, code, detail = "") { if (!condition) throw new Error(`${code}${detail ? `: ${detail}` : ""}`); }

function commandProbe(command, parameters) {
  const result = spawnSync(command, parameters, { encoding: "utf8", windowsHide: true });
  return Object.freeze({ command, status: result.status, version: String(result.stdout || result.stderr).trim().split(/\r?\n/)[0] || null });
}

function preflight() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  ensure(nodeMajor >= 24, "ACCEPTANCE_NODE_TOO_OLD", process.versions.node);
  const git = commandProbe("git", ["--version"]);
  ensure(git.status === 0, "ACCEPTANCE_GIT_UNAVAILABLE", git.version ?? "git");
  const npm = resolveCommandCapability("node.package_manager");
  return Object.freeze({
    platform: process.platform,
    arch: process.arch,
    node: { command: process.execPath, version: process.versions.node },
    npm: { command: npm.command, source: npm.source },
    git,
    model_auth: "not_exercised: deterministic local provider",
    optional_domain_adapters: "not_required_for_platform_acceptance"
  });
}

function rewriteBaselineVersion(releaseRoot) {
  const productFile = path.join(releaseRoot, "product.json"), packageFile = path.join(releaseRoot, "package.json");
  const product = json(productFile), rootPackage = json(packageFile);
  const baselineVersion = product.version.includes("-") ? `${product.version}.acceptance-base` : `${product.version}-acceptance-base`;
  writeJson(productFile, { ...product, version: baselineVersion });
  writeJson(packageFile, { ...rootPackage, version: baselineVersion });
  execFileSync(process.execPath, [path.join(releaseRoot, "tools", "release-lint.mjs"), releaseRoot, "--write-manifest"], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
  return baselineVersion;
}

function git(cwd, ...parameters) {
  execFileSync("git", parameters, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe" });
}

function initializeProject(projectRoot) {
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "README.md"), "# Zodchi platform acceptance\n", "utf8");
  writeJson(path.join(projectRoot, "package.json"), {
    name: "zodchi-platform-acceptance",
    version: "1.0.0",
    private: true,
    scripts: {
      lint: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\""
    }
  });
  git(projectRoot, "init", "--quiet");
  git(projectRoot, "-c", "user.email=acceptance@zodchi.invalid", "-c", "user.name=Zodchi Acceptance", "add", ".");
  git(projectRoot, "-c", "user.email=acceptance@zodchi.invalid", "-c", "user.name=Zodchi Acceptance", "commit", "--quiet", "-m", "acceptance baseline");
}

function hookStatus(projectRoot, installedRoot) {
  const status = hookInstallationStatus({ projectRoot, harness: "codex" });
  ensure(status.installed && status.owned && !status.changed, "ACCEPTANCE_HOOK_NOT_OWNED");
  ensure(samePath(status.installation_root, path.join(installedRoot, "WorkflowPlatform", "hooks")), "ACCEPTANCE_HOOK_TARGET_MISMATCH", status.installation_root);
  return status;
}

function runJson(command, parameters) {
  const env = { ...process.env };
  for (const key of ["WORKFLOW_PLATFORM_CONFIG", "ZODCHI_PACKAGE_DEFINITIONS", "WORKFLOW_DB", "WORKFLOW_PROJECT", "WORKFLOW_ID", "ZODCHI_DELIVERY_MODE"]) delete env[key];
  return JSON.parse(execFileSync(command, parameters, { encoding: "utf8", windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] }));
}

export function runPlatformAcceptance({ repositoryRoot = path.resolve(import.meta.dirname, ".."), work, keep = false } = {}) {
  const root = path.resolve(work ?? fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-platform-acceptance-")));
  if (work) {
    ensure(!fs.existsSync(root), "ACCEPTANCE_WORK_ALREADY_EXISTS", root);
    fs.mkdirSync(root, { recursive: true });
  }
  const evidence = { root, preserve: keep };
  try {
    const checked = preflight();
    const candidate = path.join(root, "candidate"), baseline = path.join(root, "baseline");
    buildRelease({ repositoryRoot, output: candidate, stageRoot: root });
    fs.cpSync(candidate, baseline, { recursive: true, force: false, errorOnExist: true });
    const candidateVersion = json(path.join(candidate, "product.json")).version, baselineVersion = rewriteBaselineVersion(baseline);

    const projectRoot = path.join(root, "временный проект 😀"), installed = path.join(root, "installed"), dataRoot = path.join(root, "data");
    initializeProject(projectRoot);
    const hooks = [{ projectRoot, harness: "codex" }];
    const installedBaseline = installRelease({ source: baseline, destination: installed, dataRoot, hooks });
    const initialHook = hookStatus(projectRoot, installed);

    const hookEvidenceRoot = path.join(root, "hook-evidence"), hookConfig = path.join(root, "hook-config.json");
    writeJson(hookConfig, {
      output_root: hookEvidenceRoot,
      project_id: "platform-acceptance",
      name: "Platform acceptance",
      root_path: projectRoot,
      package_key: "software.web-application",
      package_file: path.join(installed, "WorkflowPlatform", "packages", "example", "generated", "software.web-application.xml"),
      workflow_key: "software_web_application.runtime",
      gateway_entry: path.join(installed, "AgentGateway", "src", "cli.mjs")
    });
    const hookRun = runJson(process.execPath, [path.join(installed, "WorkflowPlatform", "scripts", "run-hook-evidence.mjs"), "--config", hookConfig]);
    ensure(hookRun.worktree_unchanged && hookRun.results?.every(item => item.response_in_same_chat), "ACCEPTANCE_HOOK_RUN_FAILED");
    const workflowDatabase = path.join(hookEvidenceRoot, "workflow-evidence.sqlite");

    const updated = installRelease({ source: candidate, destination: installed, dataRoot, workflowDatabase, hooks });
    const updatedHook = hookStatus(projectRoot, installed);
    const workflowEvidenceRoot = path.join(root, "workflow-evidence"), workflowConfig = path.join(root, "workflow-config.json");
    writeJson(workflowConfig, {
      output_root: workflowEvidenceRoot,
      gateway_entry: path.join(installed, "AgentGateway", "src", "cli.mjs"),
      projects: [{
        project_id: "candidate-acceptance",
        name: "Candidate acceptance",
        root_path: projectRoot,
        package_key: "software.web-application",
        package_file: path.join(installed, "WorkflowPlatform", "packages", "example", "generated", "software.web-application.xml"),
        workflow_key: "software_web_application.runtime"
      }]
    });
    const workflowRun = runJson(process.execPath, [path.join(installed, "WorkflowPlatform", "scripts", "run-e2e-evidence.mjs"), "--config", workflowConfig]);
    const candidateRun = workflowRun.results?.[0];
    ensure(candidateRun?.final_state === "completed" && candidateRun.gate_status === "passed" && candidateRun.worktree_unchanged, "ACCEPTANCE_CANDIDATE_RUN_FAILED", JSON.stringify(candidateRun ?? null));

    const rolledBack = rollbackRelease({ destination: installed, dataRoot });
    const rollbackHook = hookStatus(projectRoot, installed);
    const presetLint = runJson(process.execPath, [path.join(installed, "WorkflowPlatform", "src", "cli.mjs"), "preset-lint"]);
    ensure(presetLint.status === "passed" && presetLint.presets === 15, "ACCEPTANCE_PRESET_CATALOG_FAILED");
    const uninstalled = uninstallRelease({ destination: installed, dataRoot, hooks });
    const finalHook = hookInstallationStatus({ projectRoot, harness: "codex" });
    ensure(!finalHook.owned, "ACCEPTANCE_HOOK_SURVIVED_UNINSTALL");

    const report = Object.freeze({
      schema_version: 1,
      status: "passed",
      acceptance_class: "MECHANICS_ONLY",
      checked_at: new Date().toISOString(),
      preflight: checked,
      versions: { baseline: baselineVersion, candidate: candidateVersion },
      lifecycle: {
        install: { status: installedBaseline.status, version: installedBaseline.version },
        hook: { status: initialHook.installed ? "installed" : "failed", scenarios: hookRun.results.length },
        run: { final_state: candidateRun.final_state, gate_status: candidateRun.gate_status, calls: candidateRun.calls },
        update: { status: updated.status, version: updated.version, hook_target_updated: updatedHook.owned },
        rollback: { status: rolledBack.status, version: rolledBack.version, hook_target_restored: rollbackHook.owned },
        preset_catalog: presetLint,
        uninstall: { status: uninstalled.status, hook_removed: !finalHook.owned, user_data_preserved: uninstalled.user_data_preserved }
      },
      limits: [
        "deterministic provider proves platform delivery and gates, not model quality",
        "synthetic repository proves mechanics, not domain truth or product fit",
        "macOS owner acceptance is proven only when this report is produced on the owner's Mac"
      ]
    });
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
    return report;
  } catch (error) {
    error.acceptance_work = evidence.root;
    throw error;
  }
}

function main() {
  const cli = argsObject(process.argv.slice(2));
  const report = runPlatformAcceptance({
    repositoryRoot: path.resolve(String(cli.repository ?? path.resolve(import.meta.dirname, ".."))),
    work: cli.work ? path.resolve(String(cli.work)) : undefined,
    keep: cli.keep === true
  });
  if (cli.out) writeJson(path.resolve(String(cli.out)), report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { process.stderr.write(`${error.stack ?? error.message}\nacceptance_work=${error.acceptance_work ?? "unknown"}\n`); process.exitCode = 1; }
}
