import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const rootArgument = args.find(value => !value.startsWith("--"));
if (!rootArgument) throw new Error("Usage: node scripts/release-lint.mjs <release-root> [--write-manifest]");
const root = path.resolve(rootArgument);
const manifestPath = path.join(root, "bundle-manifest.json");
const shouldWriteManifest = args.includes("--write-manifest");

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function relative(file) { return path.relative(root, file).replaceAll("\\", "/"); }
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

const required = [
  "README.md",
  "QUICKSTART.md",
  "ONBOARDING_PROMPT.md",
  "LICENSE",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "THIRD_PARTY_NOTICES.md",
  "UPDATE.md",
  "product.json",
  "package.json",
  "docs/ARCHITECTURE.md",
  "docs/ru/README.md",
  "docs/ru/CHANGELOG.md",
  "docs/ru/CONTRIBUTING.md",
  "docs/ru/SECURITY.md",
  "docs/ru/THIRD_PARTY_NOTICES.md",
  "WorkflowPlatform/package.json",
  "WorkflowPlatform/src/cli.mjs",
  "WorkflowPlatform/src/backup.mjs",
  "WorkflowPlatform/src/statistics.mjs",
  "WorkflowPlatform/src/db.mjs",
  "WorkflowPlatform/src/budget.mjs",
  "WorkflowPlatform/src/execution-queue.mjs",
  "WorkflowPlatform/src/role-contracts.mjs",
  "WorkflowPlatform/src/work-executor.mjs",
  "WorkflowPlatform/src/workflow-package.mjs",
  "WorkflowPlatform/src/workflow-bundle.mjs",
  "WorkflowPlatform/src/limited-xml.mjs",
  "WorkflowPlatform/src/experience.mjs",
  "WorkflowPlatform/src/package-contracts.mjs",
  "WorkflowPlatform/src/one-c-bsl-check.mjs",
  "WorkflowPlatform/src/paths.mjs",
  "WorkflowPlatform/src/project-roots.mjs",
  "WorkflowPlatform/src/source-context.mjs",
  "WorkflowPlatform/src/code-intelligence.mjs",
  "WorkflowPlatform/src/run-evidence.mjs",
  "WorkflowPlatform/src/progress-supervisor.mjs",
  "WorkflowPlatform/src/transaction-guard.mjs",
  "WorkflowPlatform/src/language.mjs",
  "WorkflowPlatform/migrations/001_normalized_runtime.sql",
  "WorkflowPlatform/migrations/003_reliable_execution.sql",
  "WorkflowPlatform/migrations/004_classification_and_context.sql",
  "WorkflowPlatform/migrations/005_role_contracts.sql",
  "WorkflowPlatform/migrations/006_portable_packages_and_experience.sql",
  "WorkflowPlatform/migrations/007_scenario_statistics.sql",
  "WorkflowPlatform/migrations/008_quality_contracts.sql",
  "WorkflowPlatform/migrations/009_model_harnesses.sql",
  "WorkflowPlatform/migrations/010_check_baselines.sql",
  "WorkflowPlatform/migrations/011_diagnostic_catalogs.sql",
  "WorkflowPlatform/migrations/012_response_language.sql",
  "WorkflowPlatform/migrations/015_project_roots.sql",
  "WorkflowPlatform/migrations/016_evidence_gauntlet.sql",
  "WorkflowPlatform/catalogs/bsl-language-server-1.0.7.json",
  "WorkflowPlatform/scripts/generate-bsl-diagnostic-catalog.mjs",
  "WorkflowPlatform/scripts/generate-packages.mjs",
  "WorkflowPlatform/scripts/project-baseline.mjs",
  "WorkflowPlatform/scripts/run-e2e-evidence.mjs",
  "WorkflowPlatform/scripts/run-hook-evidence.mjs",
  "WorkflowPlatform/scripts/run-owner-boundary-evidence.mjs",
  "WorkflowPlatform/scripts/run-package-boundary-evidence.mjs",
  "WorkflowPlatform/packages/catalog.json",
  "WorkflowPlatform/presets/catalog.json",
  "WorkflowPlatform/packages/definitions.mjs",
  "WorkflowPlatform/packages/builders.mjs",
  "WorkflowPlatform/packages/example/definitions.mjs",
  "WorkflowPlatform/packages/example/generated/software.web-application.xml",
  "WorkflowPlatform/packages/example/generated/one-c.development.xml",
  "WorkflowPlatform/docs/ProjectPackages.md",
  "WorkflowPlatform/docs/WorkflowPlatform.md",
  "AgentGateway/package.json",
  "AgentGateway/docs/AgentGateway.md",
  "AgentGateway/policy.json",
  "AgentGateway/model-providers.json",
  "AgentGateway/src/cli.mjs",
  "AgentGateway/src/openai-compatible.mjs",
  "AgentGateway/src/db.mjs",
  "AgentGateway/src/paths.mjs",
  "AgentGateway/migrations/001_gateway_receipts.sql",
  "AgentGateway/migrations/003_model_harnesses.sql",
  "scripts/build-release.ps1",
  "scripts/build-release.mjs",
  "scripts/build-release-archive.mjs",
  "scripts/build-release-manifest.mjs",
  "scripts/validate-source.mjs",
  "tools/install-or-update.ps1",
  "tools/install-latest.ps1",
  "tools/install-latest.mjs",
  "tools/install-latest.sh",
  "tools/install.mjs",
  "tools/installation-paths.mjs",
  "tools/lib/zip.mjs",
  "tools/release-smoke.mjs",
  "tools/platform-acceptance.mjs",
  "tools/release-lint.mjs"
];

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`RELEASE_ROOT_MISSING: ${root}`);
const missing = required.filter(item => !fs.existsSync(path.join(root, item)));
if (missing.length) throw new Error(`RELEASE_MISSING_FILES: ${missing.join(", ")}`);

const workflowPackage = readJson(path.join(root, "WorkflowPlatform", "package.json"));
const gatewayPackage = readJson(path.join(root, "AgentGateway", "package.json"));
const product = readJson(path.join(root, "product.json"));
const rootPackage = readJson(path.join(root, "package.json"));
for (const [component, value] of [["WorkflowPlatform", workflowPackage], ["AgentGateway", gatewayPackage]]) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version ?? "")) throw new Error(`RELEASE_VERSION_INVALID: ${component}`);
  if (value.license !== "MIT") throw new Error(`RELEASE_LICENSE_INVALID: ${component}`);
}
if (product.name !== "zodchi" || product.displayName !== "Zodchi" || product.workingName !== false) throw new Error("RELEASE_PRODUCT_IDENTITY_INVALID");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(product.version ?? "")) throw new Error("RELEASE_PRODUCT_VERSION_INVALID");
if (rootPackage.name !== product.name || rootPackage.version !== product.version || rootPackage.license !== "MIT") throw new Error("RELEASE_ROOT_PACKAGE_MISMATCH");
function filesForManifest() {
  return walk(root)
    .filter(file => path.resolve(file) !== path.resolve(manifestPath))
    .map(file => ({ path: relative(file), size: fs.statSync(file).size, sha256: sha256(file) }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
}

if (shouldWriteManifest) {
  const manifest = {
    schemaVersion: 1,
    name: product.name,
    displayName: product.displayName,
    workingName: false,
    version: product.version,
    releaseChannel: product.releaseChannel,
    components: {
      WorkflowPlatform: workflowPackage.version,
      AgentGateway: gatewayPackage.version
    },
    files: filesForManifest()
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

if (!fs.existsSync(manifestPath)) throw new Error("RELEASE_MANIFEST_MISSING");
const manifest = readJson(manifestPath);
if (manifest.name !== product.name || manifest.workingName !== false || manifest.version !== product.version || manifest.components?.WorkflowPlatform !== workflowPackage.version || manifest.components?.AgentGateway !== gatewayPackage.version) throw new Error("RELEASE_MANIFEST_VERSION_MISMATCH");

const actualFiles = filesForManifest();
const listedFiles = Array.isArray(manifest.files) ? manifest.files : [];
if (JSON.stringify(actualFiles) !== JSON.stringify(listedFiles)) throw new Error("RELEASE_CHECKSUM_MANIFEST_MISMATCH");

const packageCatalog = readJson(path.join(root, "WorkflowPlatform", "packages", "catalog.json"));
for (const item of packageCatalog.packages ?? []) {
  const packageFile = path.join(root, "WorkflowPlatform", "packages", item.file ?? "");
  if (!item.file || !fs.existsSync(packageFile) || !fs.statSync(packageFile).isFile()) throw new Error(`RELEASE_PACKAGE_CATALOG_TARGET_MISSING: ${item.key ?? "unknown"}`);
}

const forbiddenSegments = /(^|\/)(?:\.git|node_modules|coverage|dist|build|data|receipts|sessions|logs|tmp|temp)(?:\/|$)/i;
const forbiddenNames = /(^|\/)(?:auth\.json|cookies?(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|\.env(?:\..*)?|.*\.(?:db|sqlite|sqlite3|wal|shm|log|tmp))$/i;
const taskArtifacts = /(^|\/)(?:\.pipeline-|task-).*\.md$/i;
const textExtensions = new Set([".mjs", ".js", ".json", ".md", ".ps1", ".toml", ".sql", ".txt", ".xml", ".yml", ".yaml"]);
const findings = [];

for (const item of actualFiles) {
  if (forbiddenSegments.test(item.path)) findings.push(`${item.path}: forbidden directory`);
  if (forbiddenNames.test(item.path)) findings.push(`${item.path}: forbidden data or credential filename`);
  if (taskArtifacts.test(item.path)) findings.push(`${item.path}: temporary task artifact`);
  if (!textExtensions.has(path.extname(item.path).toLowerCase()) || item.path === "tools/release-lint.mjs") continue;
  const text = fs.readFileSync(path.join(root, item.path), "utf8");
  if (/\b[A-Za-z]:[\\/]/.test(text) || /\/(?:home|Users)\/[A-Za-z0-9._-]+\//.test(text)) findings.push(`${item.path}: absolute user or drive path`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m.test(text)) findings.push(`${item.path}: private key material`);
  if (/(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})/m.test(text)) findings.push(`${item.path}: credential-shaped value`);
  if (/(?:api[_-]?key|client_secret|password|access_token)\s*[=:]\s*["'][^"']{12,}["']/i.test(text)) findings.push(`${item.path}: secret-shaped assignment`);
}

const policy = readJson(path.join(root, "AgentGateway", "policy.json"));
for (const [provider, config] of Object.entries(policy.providers ?? {})) {
  if (Object.keys(config.profiles ?? {}).length) findings.push(`AgentGateway/policy.json: local profiles embedded for ${provider}`);
}

const universalFiles = actualFiles.filter(item => /^(?:WorkflowPlatform\/(?:src|hooks|config)\/|AgentGateway\/(?:src\/|policy\.json))/.test(item.path));
for (const item of universalFiles) {
  if (!textExtensions.has(path.extname(item.path).toLowerCase())) continue;
  const text = fs.readFileSync(path.join(root, item.path), "utf8");
  if (/\bproject-r\b/i.test(text)) findings.push(`${item.path}: Project R embedded in universal runtime`);
}

const duplicateCandidates = new Map();
for (const item of actualFiles.filter(value => !/(^|\/)LICENSE$/.test(value.path))) {
  const key = `${path.basename(item.path).toLowerCase()}:${item.sha256}`;
  const group = duplicateCandidates.get(key) ?? [];
  group.push(item.path);
  duplicateCandidates.set(key, group);
}
for (const group of duplicateCandidates.values()) if (group.length > 1) findings.push(`duplicate files: ${group.join(", ")}`);

if (findings.length) {
  process.stderr.write(`${JSON.stringify({ status: "failed", findings }, null, 2)}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ status: "passed", version: manifest.version, files: actualFiles.length, checksum: sha256(manifestPath) })}\n`);
