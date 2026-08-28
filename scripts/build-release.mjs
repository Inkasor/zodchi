import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function argsObject(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) {
    const key = argv[index].slice(2);
    result[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function copyFile(sourceRoot, relative, targetRoot, targetRelative = relative) {
  const source = path.join(sourceRoot, relative), target = path.join(targetRoot, targetRelative);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`RELEASE_SOURCE_FILE_MISSING: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
}

function copyTree(sourceRoot, relative, targetRoot, targetRelative = relative) {
  const source = path.join(sourceRoot, relative), target = path.join(targetRoot, targetRelative);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`RELEASE_SOURCE_TREE_MISSING: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
}

export function buildRelease({ repositoryRoot, output, stageRoot = os.tmpdir(), replace = false }) {
  const repository = path.resolve(repositoryRoot), destination = path.resolve(output), staging = path.resolve(stageRoot);
  if (destination === path.parse(destination).root || staging === path.parse(staging).root) throw new Error("RELEASE_BUILD_PATH_TOO_BROAD");
  if (destination === repository || inside(destination, repository) || inside(path.join(repository, "WorkflowPlatform"), destination) || inside(path.join(repository, "AgentGateway"), destination)) throw new Error("RELEASE_OUTPUT_OVERLAPS_SOURCE");
  fs.mkdirSync(staging, { recursive: true }); fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = path.join(staging, `zodchi-release-${crypto.randomUUID()}`);
  const rollback = `${destination}.rollback-${crypto.randomUUID()}`;
  let previousMoved = false;
  try {
    fs.mkdirSync(stage);
    for (const tree of ["catalogs", "contracts", "migrations", "src", "hooks", "tests", "packages"]) copyTree(path.join(repository, "WorkflowPlatform"), tree, path.join(stage, "WorkflowPlatform"));
    for (const relative of ["package.json", "config/runtime.example.json", "docs/WorkflowPlatform.md", "docs/ProjectPackages.md"]) copyFile(path.join(repository, "WorkflowPlatform"), relative, path.join(stage, "WorkflowPlatform"));
    for (const script of ["generate-bsl-diagnostic-catalog.mjs", "generate-packages.mjs", "run-e2e-evidence.mjs", "run-hook-evidence.mjs", "run-owner-boundary-evidence.mjs", "run-package-boundary-evidence.mjs"]) copyFile(path.join(repository, "WorkflowPlatform"), `scripts/${script}`, path.join(stage, "WorkflowPlatform"));
    for (const tree of ["migrations", "src", "tests", "docs"]) copyTree(path.join(repository, "AgentGateway"), tree, path.join(stage, "AgentGateway"));
    for (const file of ["package.json", "policy.json", "model-providers.json"]) copyFile(path.join(repository, "AgentGateway"), file, path.join(stage, "AgentGateway"));
    for (const tree of ["configs", "docs", "tools/lib", "tools/tests"]) copyTree(repository, tree, stage);
    for (const file of ["README.md", "QUICKSTART.md", "ONBOARDING_PROMPT.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md", "UPDATE.md", "product.json", "package.json"]) copyFile(repository, file, stage);
    for (const file of ["build-release.mjs", "build-release.ps1", "validate-source.mjs"]) copyFile(repository, `scripts/${file}`, stage, `scripts/${file}`);
    for (const file of ["install.mjs", "installation-paths.mjs", "install-or-update.ps1", "install-latest.ps1", "install-latest.mjs", "install-latest.sh", "release-smoke.mjs"]) copyFile(repository, `tools/${file}`, stage, `tools/${file}`);
    copyFile(path.join(repository, "WorkflowPlatform"), "scripts/release-lint.mjs", stage, "tools/release-lint.mjs");
    execFileSync(process.execPath, [path.join(stage, "tools", "release-lint.mjs"), stage, "--write-manifest"], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
    if (fs.existsSync(destination)) {
      if (!replace) throw new Error(`RELEASE_OUTPUT_EXISTS: ${destination}`);
      fs.renameSync(destination, rollback); previousMoved = true;
    }
    fs.renameSync(stage, destination);
    if (previousMoved) fs.rmSync(rollback, { recursive: true, force: true });
    return Object.freeze({ status: "built", output: destination, previous_release_removed: previousMoved, manifest: path.join(destination, "bundle-manifest.json") });
  } catch (error) {
    if (previousMoved && !fs.existsSync(destination) && fs.existsSync(rollback)) fs.renameSync(rollback, destination);
    throw error;
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
}

function main() {
  const cli = argsObject(process.argv.slice(2)), repository = path.resolve(import.meta.dirname, "..");
  const result = buildRelease({ repositoryRoot: repository, output: path.resolve(String(cli.output ?? path.join(repository, "dist", "Zodchi"))), stageRoot: path.resolve(String(cli["stage-root"] ?? os.tmpdir())), replace: cli.replace === true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; }
}
