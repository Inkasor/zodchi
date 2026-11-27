// Select CI coverage from the checked-out PR merge and run the existing e2e driver.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(script));
const runner = path.join(root, "scripts/e2e.mjs");
const scenarioDir = "scripts/e2e/scenarios/";
const full = { mode: "full", scenarios: [] };

const workflowSources = new Map([
  ["acceptance", ["flow-acceptance"]],
  ["asset-round", ["flow-asset-round"]],
  ["branch-review", ["flow-branch-review", ["flow-claude-experts", "flow-branch-review-"]]],
  ["code-package", [
    "flow-agent", "flow-budget", "flow-check-records", "flow-check-slot", "flow-claude",
    "flow-cleanup", "flow-edits-recovery", "flow-entry", "flow-isolated", "flow-project-verify",
    "flow-server", "flow-worker", "flow-writer-env",
  ]],
  ["design-brief", ["flow-design-brief"]],
  ["incident-triage", ["flow-incident-triage"]],
  ["method-question", ["flow-method-question"]],
  ["ops-script", ["flow-ops-script"]],
  ["research", [
    "flow-research", ["flow-claude-experts", "flow-research-"], ["flow-client-plugin", "flow-research-"],
  ]],
  ["rubric-probe", ["flow-rubric-probe"]],
  ["unity-check", ["flow-unity-check"]],
  ["video", ["flow-video", "video-manifest"]],
  ["workspace-audit", ["flow-workspace-audit"]],
  ["youtube-publish", [["flow-video", "flow-youtube-publish-"]]],
]);

// These code-package scenarios are still registered inline in scripts/e2e.mjs.
const inlineCodePackage = [
  "flow-round-exhaustion", "flow-outside-claim", "flow-protected", "flow-protected-worktree",
  "flow-cleaned-job", "flow-no-review-md", "flow-staged-after-commit", "flow-private-checks",
];

const jsonManifests = new Set([
  "package.json",
  "plugins/claude-code/core/.claude-plugin/plugin.json",
  "plugins/claude-code/domains/gamedev-unity/.claude-plugin/plugin.json",
  "plugins/claude-code/domains/web-apps/.claude-plugin/plugin.json",
]);
const versionFiles = new Set(["rust/Cargo.toml", "rust/Cargo.lock", ...jsonManifests]);
const localCrates = new Set([
  "zodchi-cli", "zodchi-core", "zodchi-server", "zodchi-flow", "zodchi-flow-engine", "zodchi-flow-voiceover",
  ...Array.from(workflowSources.keys(), name => "zodchi-flow-" + name),
]);

const stableVersion = /"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"/;
const cargoVersion = new RegExp(`^version = ${stableVersion.source}$`, "m");
const manifestVersion = new RegExp(`^(\\[workspace\\.package\\]\\n)version = ${stableVersion.source}$`, "m");
const jsonVersion = new RegExp(`^(\\{\\n  "name": "[^"\\n]+",\\n  "version": )${stableVersion.source},(?=\\n|$)`);

function normalizeVersion(file, text) {
  if (file === "rust/Cargo.toml") return text.replace(manifestVersion, "$1version = \0");
  if (file === "rust/Cargo.lock") {
    return text.split(/(?=^\[\[package\]\]$)/m).map(block => {
      const name = /^\[\[package\]\]\nname = "([^"]+)"$/m.exec(block)?.[1];
      return localCrates.has(name) && !/^(?:source|checksum) = /m.test(block)
        ? block.replace(cargoVersion, "version = \0")
        : block;
    }).join("");
  }
  return text.replace(jsonVersion, "$1\0,");
}

export function versionOnlyChange(file, before, after) {
  return versionFiles.has(file) && before !== after && !before.includes("\0") && !after.includes("\0") &&
    normalizeVersion(file, before) === normalizeVersion(file, after);
}

function isDocumentation(file) {
  if (file.startsWith("docs/") || file === "rust/README.md" || file === scenarioDir + "README.md") return true;
  // Markdown in these trees can be a prompt, a plugin input, or a fixture.
  return file.endsWith(".md") &&
    !/^(?:\.agents|\.claude|\.github|\.zodchi|install|plugins|roles|rust|scripts|skills|workflows)\//.test(file);
}

const scenarioName = /^[a-z0-9][a-z0-9-]*$/;

export async function selectChanges(files, versionOnly = new Set()) {
  if (!files.length) return full;
  const sources = new Set();
  const names = new Set();
  for (const file of files) {
    if (/(?:^|\/)fixtures\//.test(file)) return full;
    if (isDocumentation(file) || file === "install/release-notes.json" || versionOnly.has(file)) continue;

    const crate = /^rust\/crates\/zodchi-flow-([^/]+)\//.exec(file)?.[1];
    if (crate) {
      const mapped = workflowSources.get(crate);
      if (!mapped) return full;
      for (const source of mapped) sources.add(source);
      if (crate === "code-package") for (const name of inlineCodePackage) names.add(name);
      continue;
    }
    const module = file.startsWith(scenarioDir) && /^([a-z0-9-]+)\.mjs$/.exec(file.slice(scenarioDir.length));
    if (!module) return full;
    sources.add(module[1]);
    if (module[1] === "gateway-batch") sources.add("gateway-batch-list-fields");
  }
  if (!sources.size) return { mode: "skip", scenarios: [] };

  try {
    for (const source of sources) {
      const [module, prefix = ""] = Array.isArray(source) ? source : [source];
      const url = pathToFileURL(path.join(root, scenarioDir, module + ".mjs"));
      const { default: register } = await import(url.href);
      const registered = [];
      // Scenario modules register callbacks here. The e2e driver invokes them later.
      await register({ ROOT: root, scenario: name => registered.push(name) });
      const matching = registered.filter(name => name.startsWith(prefix));
      if (!matching.length || !matching.every(name => scenarioName.test(name))) return full;
      for (const name of matching) names.add(name);
    }
  } catch {
    // A deleted scenario file or an unrecognized registration runs the full suite.
    return full;
  }
  return { mode: "selected", scenarios: [...names].sort() };
}

async function selectPullRequest() {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const base = "HEAD^1";
  try {
    git("rev-parse", "--verify", "HEAD^2");
    // Disable rename detection so a move also classifies the path it removes.
    const fields = git("diff", "--raw", "--no-renames", "-z", base, "HEAD", "--").split("\0");
    const files = [];
    const versions = new Set();
    for (let i = 0; i < fields.length - 1; i += 2) {
      const modes = /^:(100644|000000) (100644|000000) [0-9a-f]+ [0-9a-f]+ ([ADM])$/.exec(fields[i]);
      const file = fields[i + 1];
      if (!modes || !file) return full;
      files.push(file);
      if (modes[3] === "M" && versionFiles.has(file)) {
        if (versionOnlyChange(file, git("show", `${base}:${file}`), git("show", `HEAD:${file}`))) versions.add(file);
      }
    }
    return await selectChanges(files, versions);
  } catch {
    console.warn("Could not classify the PR diff. Running the full suite.");
    return full;
  }
}

export function shardScenarios(names, count) {
  const shards = Array.from({ length: count }, () => []);
  for (const name of [...names].sort()) {
    const hash = createHash("sha256").update(name).digest().readUInt32BE(0);
    shards[hash % count].push(name);
  }
  return shards.filter(shard => shard.length);
}

function listAllScenarios() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-ci-list-"));
  try {
    // The runner prints its complete registry for an unknown name, before any build or scenario.
    const sentinel = ":ci-list-scenarios:";
    const listing = spawnSync(process.execPath, [runner, "--no-build", "--out", path.join(scratch, "traces"), sentinel], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TMP: scratch, TEMP: scratch, TMPDIR: scratch },
      timeout: 30_000,
    });
    const prefix = `No scenario ${sentinel}. Scenarios: `;
    const message = listing.stderr?.trim();
    if (listing.status !== 1 || !message?.startsWith(prefix)) return [];
    const names = message.slice(prefix.length).split(", ");
    return names.every(name => scenarioName.test(name)) ? [...new Set(names)] : [];
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

function runShard(names, out) {
  const args = [runner, "--cargo-profile", "dev", "--no-build", "--out", out];
  if (process.platform === "win32") {
    // --bin-dir gives each Windows runner process its own copy for detached workers.
    const target = process.env.CARGO_TARGET_DIR || "rust/target";
    args.push("--bin-dir", path.resolve(root, target, "debug"));
  }
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...args, ...names], { cwd: root, stdio: "inherit" });
    child.once("error", error => {
      console.error(error.message);
      resolve(1);
    });
    child.once("exit", code => resolve(code === 0 || code === 2 ? code : 1));
  });
}

async function runE2e(plan, out) {
  const names = plan.mode === "selected" ? plan.scenarios : listAllScenarios();
  const shards = plan.mode === "selected" ? [names] : shardScenarios(names, 2);
  if (!shards.length) {
    console.warn("Scenario listing unavailable. Running the driver with its default full suite.");
    shards.push([]);
  }
  const results = await Promise.all(shards.map((shard, i) => runShard(shard, path.join(out, `shard-${i + 1}`))));
  return results.includes(1) ? 1 : Math.max(...results);
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const [command, out] = process.argv.slice(2);
  if (command === "select") {
    const plan = process.env.GITHUB_EVENT_NAME === "pull_request" ? await selectPullRequest() : full;
    console.log(`CI coverage: ${plan.mode}${plan.scenarios.length ? " (" + plan.scenarios.join(", ") + ")" : ""}`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `mode=${plan.mode}\nplan=${JSON.stringify(plan)}\n`);
  } else if (command === "run" && out) {
    const plan = JSON.parse(process.env.CI_E2E_PLAN);
    process.exitCode = await runE2e(plan, out);
  } else {
    throw new Error("Expected select or run <trace-directory>");
  }
}
