import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractZip } from "./lib/zip.mjs";

// Post-publication smoke. It answers one question only: does the artifact that GitHub actually
// serves install and run? A local build output can never answer it, so nothing here reads the
// working tree — assets come from the Release API and are verified before they are trusted.

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    result[key] = next === undefined || next.startsWith("--") ? true : argv[++index];
  }
  return result;
}

const options = parseArguments(process.argv.slice(2));
if (!options.repository || !options.tag) throw new Error("Usage: node tools/release-smoke.mjs --repository <owner/name> --tag <vX.Y.Z> [--work <dir>] [--out <file>] [--baseline] [--allow-draft]");

// `--baseline` verifies a release published before 0.6.0 made CI the only publisher. It relaxes
// naming, manifest and publisher requirements, never checksum, extraction or the workflow run, and
// stamps the evidence so a relaxed pass can never be read as a release-grade one.
const baseline = options.baseline === true;
const allowDraft = options["allow-draft"] === true;
const repository = String(options.repository);
const tag = String(options.tag);
const work = path.resolve(options.work ? String(options.work) : fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-smoke-")));

function fail(code, detail) { throw new Error(`${code}: ${detail}`); }
function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function headers(accept) {
  const value = { "User-Agent": "Zodchi-Release-Smoke", Accept: accept };
  if (process.env.GITHUB_TOKEN) value.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return value;
}

async function api(url, { allowNotFound = false } = {}) {
  const response = await fetch(url, { headers: headers("application/vnd.github+json") });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) fail("RELEASE_API_FAILED", `${response.status} ${url}`);
  return response.json();
}

async function releaseForTag() {
  const taggedUrl = `https://api.github.com/repos/${repository}/releases/tags/${tag}`;
  const tagged = await api(taggedUrl, { allowNotFound: allowDraft });
  if (tagged) return tagged;

  // GitHub's release-by-tag endpoint intentionally hides draft releases, even from the
  // authenticated workflow that created them. The repository release listing includes drafts.
  // Use that fallback only for the explicit pre-publication smoke path and require one exact tag.
  const releases = await api(`https://api.github.com/repos/${repository}/releases?per_page=100`);
  const matching = releases.filter(candidate => candidate.draft === true && candidate.tag_name === tag);
  if (matching.length !== 1) fail("DRAFT_RELEASE_NOT_UNIQUE", `${tag}: found ${matching.length}`);
  return matching[0];
}

async function download(asset) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, { headers: headers("application/octet-stream"), redirect: "follow" });
  if (!response.ok) fail("RELEASE_ASSET_DOWNLOAD_FAILED", `${response.status} ${asset.name}`);
  return Buffer.from(await response.arrayBuffer());
}

function git(cwd, ...parameters) {
  execFileSync("git", ["-c", "user.email=smoke@zodchi.invalid", "-c", "user.name=Zodchi Smoke", ...parameters], { cwd, encoding: "utf8", windowsHide: true });
}

function productRoots(directory) {
  const roots = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "product.json" && fs.existsSync(path.join(current, "bundle-manifest.json"))) roots.push(current);
    }
  };
  walk(directory);
  return roots;
}

fs.mkdirSync(work, { recursive: true });
const release = await releaseForTag();
if (release.draft && !allowDraft) fail("RELEASE_IS_DRAFT", tag);

const archiveAsset = release.assets.find(asset => /^Zodchi-v.+\.zip$/.test(asset.name));
if (!archiveAsset) fail("RELEASE_ARCHIVE_ASSET_MISSING", tag);
const checksumAsset = release.assets.find(asset => asset.name === "SHA256SUMS.txt")
  ?? (baseline ? release.assets.find(asset => /^SHA256SUMS.*\.txt$/.test(asset.name)) : undefined);
if (!checksumAsset) fail("RELEASE_CHECKSUM_ASSET_MISSING", "SHA256SUMS.txt");

// The publisher identity is the control that failed for every release up to v0.5.24: assets were
// uploaded by a person before the tag workflow ran, so no published asset was ever a CI artifact.
const publishers = [...new Set(release.assets.map(asset => asset.uploader?.login ?? "unknown"))];
if (!baseline && (publishers.length !== 1 || publishers[0] !== "github-actions[bot]")) fail("RELEASE_PUBLISHER_NOT_CI", publishers.join(", "));

const archive = await download(archiveAsset);
const archiveFile = path.join(work, archiveAsset.name);
fs.writeFileSync(archiveFile, archive);
const checksumBytes = await download(checksumAsset);
const checksums = checksumBytes.toString("utf8").replace(/^\uFEFF/, "");
const archiveHash = sha256(archive);
const checksumLine = checksums.split(/\r?\n/).find(line => line.includes(archiveAsset.name));
if (!checksumLine) fail("RELEASE_CHECKSUM_ENTRY_MISSING", archiveAsset.name);
const expected = checksumLine.trim().split(/\s+/)[0].toLowerCase();
if (!/^[0-9a-f]{64}$/.test(expected)) fail("RELEASE_CHECKSUM_ENTRY_INVALID", checksumLine.trim());
if (expected !== archiveHash) fail("RELEASE_CHECKSUM_MISMATCH", `expected ${expected}, downloaded ${archiveHash}`);

let releaseManifest = null;
const manifestAsset = release.assets.find(asset => asset.name === "zodchi-release-manifest.json");
if (manifestAsset) {
  releaseManifest = JSON.parse((await download(manifestAsset)).toString("utf8"));
  if (releaseManifest.schema_version !== 1) fail("RELEASE_MANIFEST_SCHEMA_UNSUPPORTED", String(releaseManifest.schema_version));
  if (releaseManifest.tag !== tag) fail("RELEASE_MANIFEST_TAG_MISMATCH", `${releaseManifest.tag} != ${tag}`);
  if (releaseManifest.repository !== repository) fail("RELEASE_MANIFEST_REPOSITORY_MISMATCH", `${releaseManifest.repository} != ${repository}`);
  if (!releaseManifest.commit || !releaseManifest.workflow_run) fail("RELEASE_MANIFEST_PROVENANCE_MISSING", "commit or workflow_run");
  if (releaseManifest.archive?.name !== archiveAsset.name) fail("RELEASE_MANIFEST_ARCHIVE_MISMATCH", releaseManifest.archive?.name ?? "missing");
  if (releaseManifest.archive?.size !== archiveAsset.size) fail("RELEASE_MANIFEST_ARCHIVE_SIZE_MISMATCH", `${releaseManifest.archive?.size} != ${archiveAsset.size}`);
  if (releaseManifest.archive?.sha256 !== archiveHash) fail("RELEASE_MANIFEST_CHECKSUM_MISMATCH", releaseManifest.archive?.sha256 ?? "missing");
  if (releaseManifest.checksums?.name !== checksumAsset.name) fail("RELEASE_MANIFEST_CHECKSUM_NAME_MISMATCH", releaseManifest.checksums?.name ?? "missing");
  if (releaseManifest.checksums?.sha256 !== sha256(checksumBytes)) fail("RELEASE_MANIFEST_CHECKSUM_FILE_MISMATCH", releaseManifest.checksums?.sha256 ?? "missing");
} else if (!baseline) {
  fail("RELEASE_MANIFEST_ASSET_MISSING", "zodchi-release-manifest.json");
}

// The uploader and successful workflow checks prove who controlled the GitHub objects. This separate
// Sigstore verification proves that the downloaded archive bytes were attested by this repository's
// release workflow and bind to the exact source commit in the release manifest.
let attestation = null;
if (!baseline) {
  let verified;
  try {
    verified = JSON.parse(execFileSync("gh", [
      "attestation", "verify", archiveFile,
      "--repo", repository,
      "--signer-workflow", `${repository}/.github/workflows/release.yml`,
      "--source-digest", releaseManifest.commit,
      "--format", "json"
    ], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "" }
    }));
  } catch (error) {
    fail("RELEASE_ATTESTATION_INVALID", String(error.stderr ?? error.message).trim());
  }
  if (!Array.isArray(verified) || verified.length === 0) fail("RELEASE_ATTESTATION_MISSING", archiveAsset.name);
  attestation = { verified: true, count: verified.length, signer_workflow: `${repository}/.github/workflows/release.yml`, source_digest: releaseManifest.commit };
}

const extracted = path.join(work, "extracted");
fs.rmSync(extracted, { recursive: true, force: true });
const extraction = extractZip(archive, extracted);

const roots = productRoots(extracted);
if (roots.length !== 1) fail("RELEASE_PRODUCT_ROOT_AMBIGUOUS", `found ${roots.length}`);
const productRoot = roots[0];
const bundleManifest = JSON.parse(fs.readFileSync(path.join(productRoot, "bundle-manifest.json"), "utf8"));
const product = JSON.parse(fs.readFileSync(path.join(productRoot, "product.json"), "utf8"));
if (`v${product.version}` !== tag) fail("RELEASE_PRODUCT_VERSION_MISMATCH", `${product.version} != ${tag}`);
if (releaseManifest && releaseManifest.product?.version !== product.version) fail("RELEASE_MANIFEST_PRODUCT_MISMATCH", `${releaseManifest.product?.version} != ${product.version}`);
for (const [component, version] of Object.entries(releaseManifest?.components ?? {})) {
  if (bundleManifest.components?.[component] !== version) fail("RELEASE_MANIFEST_COMPONENT_MISMATCH", `${component}: ${version} != ${bundleManifest.components?.[component]}`);
}

// The archive carries a per-file manifest, so integrity is checkable at file level and not only for
// the container. A container whose checksum matches while a file inside does not is exactly the
// case a checksum on the zip cannot see.
const contentFindings = [];
for (const file of bundleManifest.files) {
  const full = path.join(productRoot, file.path);
  if (!fs.existsSync(full)) contentFindings.push(`${file.path}: missing from published archive`);
  else if (sha256(fs.readFileSync(full)) !== file.sha256) contentFindings.push(`${file.path}: content differs from bundle manifest`);
}
if (contentFindings.length) fail("RELEASE_ARCHIVE_CONTENT_MISMATCH", contentFindings.slice(0, 5).join("; "));

const installed = path.join(work, "installed");
// The installation owns the operator's explicit `/zodchi` and `/zod` commands. This smoke installs
// into a directory it deletes afterwards, so it must keep its skill roots inside the same throwaway
// work directory: otherwise it would repoint the real commands at a path that stops existing.
const smokeSkillRoots = { "claude-code": path.join(work, "client-skills", "claude-code"), codex: path.join(work, "client-skills", "codex") };
const skillRootsFile = path.join(work, "skill-roots.json");
fs.writeFileSync(skillRootsFile, `${JSON.stringify(smokeSkillRoots, null, 2)}\n`, "utf8");
execFileSync(process.execPath, [path.join(productRoot, "tools", "install.mjs"), "install", "--source", productRoot, "--destination", installed, "--data-root", path.join(work, "installation-data"), "--skill-roots", skillRootsFile], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
for (const [client, root] of Object.entries(smokeSkillRoots)) for (const name of ["zodchi", "zod"]) {
  const skillFile = path.join(root, name, "SKILL.md");
  if (!fs.existsSync(skillFile)) fail("RELEASE_SKILL_NOT_INSTALLED", `${client}:${name}`);
  const text = fs.readFileSync(skillFile, "utf8");
  if (!text.includes(path.resolve(installed).replaceAll("\\", "/")) || !text.includes("explicit-invoke.mjs")) fail("RELEASE_SKILL_TARGET_INVALID", `${client}:${name}`);
}
const presetLint = JSON.parse(execFileSync(process.execPath, [path.join(installed, "WorkflowPlatform", "src", "cli.mjs"), "preset-lint"], { encoding: "utf8", windowsHide: true }));
if (presetLint.status !== "passed" || presetLint.presets !== 15) fail("RELEASE_PRESET_CATALOG_INVALID", JSON.stringify(presetLint));

// A real workflow through the real AgentGateway process, with a deterministic provider standing in
// for the model. It proves delivery, routing, gates and receipts; it proves nothing about model
// quality, and the evidence says so.
// The registered checks of `software.web-application` run the project's own npm scripts, so the smoke project
// declares them and they succeed. A project that cannot satisfy its package's gate would make the
// smoke pass on a red gate, and a red gate looks the same whether the product works or not.
const projectRoot = path.join(work, "smoke-project");
fs.mkdirSync(projectRoot, { recursive: true });
fs.writeFileSync(path.join(projectRoot, "README.md"), "# Zodchi published release smoke project\n", "utf8");
fs.writeFileSync(path.join(projectRoot, "package.json"), `${JSON.stringify({
  name: "zodchi-release-smoke-project",
  version: "1.0.0",
  private: true,
  scripts: { lint: "node -e \"process.exit(0)\"", test: "node -e \"process.exit(0)\"", build: "node -e \"process.exit(0)\"" }
}, null, 2)}\n`, "utf8");
git(projectRoot, "init", "--quiet");
git(projectRoot, "add", "README.md", "package.json");
git(projectRoot, "commit", "--quiet", "-m", "smoke baseline");

const evidenceRoot = path.join(work, "workflow-evidence");
const smokeConfig = path.join(work, "smoke-config.json");
fs.writeFileSync(smokeConfig, JSON.stringify({
  output_root: evidenceRoot,
  gateway_entry: path.join(installed, "AgentGateway", "src", "cli.mjs"),
  projects: [{
    project_id: "released-smoke",
    name: "Released package smoke",
    root_path: projectRoot,
    package_key: "software.web-application",
    package_file: path.join(installed, "WorkflowPlatform", "packages", "example", "generated", "software.web-application.xml"),
    workflow_key: "software_web_application.runtime",
    classification: {
      work_type: "verification",
      artifact_type: "test_report",
      domain: "software",
      discipline: "software"
    },
    message: "Run the registered read-only technical verification scenario. Do not edit source files and do not make owner acceptance decisions."
  }]
}, null, 2), "utf8");

const workflowOutput = execFileSync(process.execPath, [path.join(installed, "WorkflowPlatform", "scripts", "run-e2e-evidence.mjs"), "--config", smokeConfig], { encoding: "utf8", windowsHide: true });
const workflow = JSON.parse(workflowOutput);
const result = workflow.results?.[0];
if (!result) fail("RELEASE_SMOKE_WORKFLOW_EMPTY", "no run recorded");
if (!result.run_id) fail("RELEASE_SMOKE_RUN_MISSING", result.project_id);
if (!result.worktree_unchanged) fail("RELEASE_SMOKE_WORKTREE_CHANGED", result.project_id);
// Reaching a terminal state is not the same as working. A run that classifies, plans, executes and
// then blocks on its own gate would satisfy a liveness check and hide every defect this smoke exists
// to catch, so the expected outcome is stated exactly.
if (result.route !== "work") fail("RELEASE_SMOKE_ROUTE_UNEXPECTED", String(result.route));
if (result.execution_status !== "completed") fail("RELEASE_SMOKE_EXECUTION_NOT_COMPLETED", String(result.execution_status));
if (result.gate_status !== "passed") fail("RELEASE_SMOKE_GATE_NOT_PASSED", String(result.gate_status));
if (result.final_state !== "completed") fail("RELEASE_SMOKE_RUN_NOT_COMPLETED", String(result.final_state));

const evidence = {
  schema_version: 1,
  mode: baseline ? "baseline" : "release",
  checked_at: new Date().toISOString(),
  repository,
  tag,
  release: { id: release.id, draft: release.draft, published_at: release.published_at, publishers },
  assets: release.assets.map(asset => ({ id: asset.id, name: asset.name, size: asset.size, uploader: asset.uploader?.login ?? null })),
  archive: { name: archiveAsset.name, sha256: archiveHash, checksums_asset: checksumAsset.name, entries: extraction.entries, manifest_files: bundleManifest.files.length },
  release_manifest: releaseManifest,
  attestation,
  product: { version: product.version, components: bundleManifest.components },
  install: { platform: process.platform, destination: installed, presets: presetLint.presets },
  workflow: { provider_mode: "deterministic provider through real AgentGateway process", model_calls: "none", results: workflow.results },
  limits: [
    "model quality is not exercised: the provider is a deterministic fixture",
    "owner acceptance is not granted by this smoke",
    baseline ? "baseline mode: canonical asset naming, release manifest and CI publisher were not required" : null
  ].filter(Boolean)
};
if (options.out) fs.writeFileSync(path.resolve(String(options.out)), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
