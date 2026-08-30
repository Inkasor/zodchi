import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildRelease } from "../scripts/build-release.mjs";
import { installRelease, rollbackRelease, uninstallRelease } from "./install.mjs";
import { resolveCommandCapability } from "../WorkflowPlatform/src/command-resolver.mjs";
import { openDb } from "../WorkflowPlatform/src/db.mjs";

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
  for (const client of ["claude-code", "codex"]) for (const name of ["zodchi"]) {
    const directory = path.join(roots[client], name), markerFile = path.join(directory, ".zodchi-skill.json"), skillFile = path.join(directory, "SKILL.md");
    ensure(fs.existsSync(markerFile) && fs.existsSync(skillFile), "ACCEPTANCE_SKILL_MISSING", `${client}:${name}`);
    const marker = json(markerFile);
    ensure(marker.owner === "zodchi" && marker.client === client && marker.name === name, "ACCEPTANCE_SKILL_OWNER_INVALID", `${client}:${name}`);
    ensure(samePath(marker.application_root, installedRoot), "ACCEPTANCE_SKILL_TARGET_MISMATCH", marker.application_root);
    ensure(fs.readFileSync(skillFile, "utf8").includes("session router"), "ACCEPTANCE_SKILL_COMMAND_MISSING", `${client}:${name}`);
    results.push({ client, name, directory });
  }
  return results;
}

function installedHook(files, client, event, installedRoot) {
  const document = json(files[client]);
  const script = path.join(installedRoot, "WorkflowPlatform", "hooks", "session-router.mjs");
  const candidates = (document.hooks?.[event] ?? []).flatMap(entry => entry.hooks ?? []);
  const hook = candidates.find(item => {
    const command = [item.command, ...(Array.isArray(item.args) ? item.args : [])].join(" ");
    return command.includes(script);
  });
  ensure(hook, "ACCEPTANCE_SESSION_HOOK_MISSING", `${client}:${event}`);
  return hook;
}

function invokeInstalledHook(hook, event, environment) {
  const options = {
    encoding: "utf8",
    windowsHide: true,
    input: JSON.stringify(event),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"]
  };
  const result = Array.isArray(hook.args)
    ? spawnSync(hook.command, hook.args, options)
    : spawnSync(hook.commandWindows ?? hook.command, [], { ...options, shell: true });
  ensure(result.status === 0, "ACCEPTANCE_SESSION_HOOK_FAILED", String(result.stderr || result.error?.message || result.status));
  const output = String(result.stdout ?? "").trim();
  return output ? JSON.parse(output) : null;
}

function sessionActivationStatus({ files, skillRoots, installedRoot, workflowDatabase, projectRoot }) {
  const environment = { ...process.env, WORKFLOW_DB: workflowDatabase };
  for (const key of ["WORKFLOW_PLATFORM_CONFIG", "WORKFLOW_PROJECT", "WORKFLOW_ID", "ZODCHI_DELIVERY_MODE"]) delete environment[key];
  const results = [];
  for (const client of ["codex", "claude-code"]) {
    const sessionId = `platform-acceptance-${client}`;
    const submit = installedHook(files, client, "UserPromptSubmit", installedRoot);
    const end = installedHook(files, client, "SessionEnd", installedRoot);
    const baseEvent = { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: projectRoot };
    const ordinary = client === "codex"
      ? { ...baseEvent, turn_id: `${sessionId}:ordinary`, prompt: "ordinary chat" }
      : { ...baseEvent, prompt_id: `${sessionId}:ordinary`, prompt: "ordinary chat" };
    ensure(invokeInstalledHook(submit, ordinary, environment) === null, "ACCEPTANCE_ORDINARY_CHAT_INTERCEPTED", client);
    const skillPath = path.join(skillRoots[client], "zodchi", "SKILL.md");
    const prompt = client === "codex" ? `[$zodchi](${skillPath})` : "/zodchi";
    const activation = client === "codex"
      ? { ...baseEvent, turn_id: `${sessionId}:activate`, prompt }
      : { ...baseEvent, prompt_id: `${sessionId}:activate`, prompt };
    const response = invokeInstalledHook(submit, activation, environment);
    ensure(response?.decision === "block" && /Zodchi/i.test(response.reason ?? ""), "ACCEPTANCE_SESSION_NOT_ACTIVATED", JSON.stringify({ client, prompt, skillPath, response }));
    let db = openDb(workflowDatabase);
    const active = db.prepare("SELECT state,project_id FROM zodchi_chat_sessions WHERE client=? AND session_id=?").get(client, sessionId);
    db.close();
    ensure(active?.state === "active" && active.project_id === "platform-acceptance", "ACCEPTANCE_SESSION_STATE_INVALID", client);
    const endEvent = { hook_event_name: "SessionEnd", session_id: sessionId, cwd: projectRoot };
    ensure(invokeInstalledHook(end, endEvent, environment) === null, "ACCEPTANCE_SESSION_END_OUTPUT", client);
    db = openDb(workflowDatabase);
    const ended = db.prepare("SELECT state FROM zodchi_chat_sessions WHERE client=? AND session_id=?").get(client, sessionId);
    db.close();
    ensure(ended?.state === "ended", "ACCEPTANCE_SESSION_NOT_ENDED", client);
    results.push({ client, ordinary_chat: "passed_through", activation: "active", session_end: "ended" });
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
    const sessionHookFiles = { "claude-code": path.join(root, "claude-hooks", "settings.json"), codex: path.join(root, "codex-hooks", "hooks.json") };
    initializeProject(projectRoot);
    const installedBaseline = installRelease({ source: baseline, destination: installed, dataRoot, skillRoots, sessionHookFiles });
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
    const sessionActivations = sessionActivationStatus({ files: sessionHookFiles, skillRoots, installedRoot: installed, workflowDatabase, projectRoot });

    const updated = installRelease({ source: candidate, destination: installed, dataRoot, workflowDatabase, skillRoots, sessionHookFiles });
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

    const rolledBack = rollbackRelease({ destination: installed, dataRoot, skillRoots, sessionHookFiles });
    const rollbackSkills = skillStatus(skillRoots, installed);
    const presetLint = runJson(process.execPath, [path.join(installed, "WorkflowPlatform", "src", "cli.mjs"), "preset-lint"]);
    ensure(presetLint.status === "passed" && presetLint.presets === 15, "ACCEPTANCE_PRESET_CATALOG_FAILED");
    const uninstalled = uninstallRelease({ destination: installed, dataRoot, skillRoots, sessionHookFiles });
    ensure(uninstalled.skills.filter(item => item.name === "zodchi").every(item => item.status === "removed"), "ACCEPTANCE_SKILL_SURVIVED_UNINSTALL");
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
        explicit_skills: { status: "installed", commands: initialSkills.length, scenarios: explicitRun.results.length, session_activations: sessionActivations },
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
