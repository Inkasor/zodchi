import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildRelease } from "../scripts/build-release.mjs";
import { installRelease, rollbackRelease, uninstallRelease } from "./install.mjs";
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

function skillStatus(roots, installedRoot) {
  const results = [];
  for (const client of ["claude-code", "codex"]) for (const name of ["zodchi", "zod"]) {
    const directory = path.join(roots[client], name), markerFile = path.join(directory, ".zodchi-skill.json"), skillFile = path.join(directory, "SKILL.md");
    ensure(fs.existsSync(markerFile) && fs.existsSync(skillFile), "ACCEPTANCE_SKILL_MISSING", `${client}:${name}`);
    const marker = json(markerFile);
    ensure(marker.owner === "zodchi" && marker.client === client && marker.name === name, "ACCEPTANCE_SKILL_OWNER_INVALID", `${client}:${name}`);
    ensure(samePath(marker.application_root, installedRoot), "ACCEPTANCE_SKILL_TARGET_MISMATCH", marker.application_root);
    ensure(fs.readFileSync(skillFile, "utf8").includes("explicit-invoke.mjs"), "ACCEPTANCE_SKILL_COMMAND_MISSING", `${client}:${name}`);
    results.push({ client, name, directory });
  }
  return results;
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
    const skillRoots = { "claude-code": path.join(root, "claude-skills"), codex: path.join(root, "codex-skills") };
    initializeProject(projectRoot);
    const installedBaseline = installRelease({ source: baseline, destination: installed, dataRoot, skillRoots });
    const initialSkills = skillStatus(skillRoots, installed);

    const explicitEvidenceRoot = path.join(root, "explicit-evidence"), explicitConfig = path.join(root, "explicit-config.json");
    writeJson(explicitConfig, {
      output_root: explicitEvidenceRoot,
      project_id: "platform-acceptance",
      name: "Platform acceptance",
      root_path: projectRoot,
      package_key: "software.web-application",
      package_file: path.join(installed, "WorkflowPlatform", "packages", "example", "generated", "software.web-application.xml"),
      workflow_key: "software_web_application.runtime",
      gateway_entry: path.join(installed, "AgentGateway", "src", "cli.mjs")
    });
    const explicitRun = runJson(process.execPath, [path.join(installed, "WorkflowPlatform", "scripts", "run-explicit-evidence.mjs"), "--config", explicitConfig]);
    ensure(explicitRun.worktree_unchanged && explicitRun.results?.every(item => item.response_returned), "ACCEPTANCE_EXPLICIT_RUN_FAILED");
    const workflowDatabase = path.join(explicitEvidenceRoot, "workflow-evidence.sqlite");

    const updated = installRelease({ source: candidate, destination: installed, dataRoot, workflowDatabase, skillRoots });
    const updatedSkills = skillStatus(skillRoots, installed);
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
        workflow_key: "software_web_application.runtime",
        classification: { work_type: "verification", artifact_type: "test_report", domain: "software", discipline: "software" }
      }]
    });
    const workflowRun = runJson(process.execPath, [path.join(installed, "WorkflowPlatform", "scripts", "run-e2e-evidence.mjs"), "--config", workflowConfig]);
    const candidateRun = workflowRun.results?.[0];
    ensure(candidateRun?.final_state === "completed" && candidateRun.gate_status === "passed" && candidateRun.worktree_unchanged, "ACCEPTANCE_CANDIDATE_RUN_FAILED", JSON.stringify(candidateRun ?? null));

    const rolledBack = rollbackRelease({ destination: installed, dataRoot, skillRoots });
    const rollbackSkills = skillStatus(skillRoots, installed);
    const presetLint = runJson(process.execPath, [path.join(installed, "WorkflowPlatform", "src", "cli.mjs"), "preset-lint"]);
    ensure(presetLint.status === "passed" && presetLint.presets === 15, "ACCEPTANCE_PRESET_CATALOG_FAILED");
    const uninstalled = uninstallRelease({ destination: installed, dataRoot, skillRoots });
    ensure(uninstalled.skills.every(item => item.status === "removed"), "ACCEPTANCE_SKILL_SURVIVED_UNINSTALL");
    ensure(!fs.existsSync(path.join(projectRoot, ".codex")) && !fs.existsSync(path.join(projectRoot, ".claude")), "ACCEPTANCE_PROJECT_HOOK_CREATED");

    const report = Object.freeze({
      schema_version: 1,
      status: "passed",
      acceptance_class: "MECHANICS_ONLY",
      checked_at: new Date().toISOString(),
      preflight: checked,
      versions: { baseline: baselineVersion, candidate: candidateVersion },
      lifecycle: {
        install: { status: installedBaseline.status, version: installedBaseline.version },
        explicit_skills: { status: "installed", commands: initialSkills.length, scenarios: explicitRun.results.length },
        run: { final_state: candidateRun.final_state, gate_status: candidateRun.gate_status, calls: candidateRun.calls },
        update: { status: updated.status, version: updated.version, skill_targets_updated: updatedSkills.length },
        rollback: { status: rolledBack.status, version: rolledBack.version, skill_targets_restored: rollbackSkills.length },
        preset_catalog: presetLint,
        uninstall: { status: uninstalled.status, skills_removed: true, project_hooks_absent: true, user_data_preserved: uninstalled.user_data_preserved }
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
