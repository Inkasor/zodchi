import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackageDefinitions } from "../packages/definitions.mjs";
import { resolveWorkflowSettings } from "../src/paths.mjs";
import { serializeWorkflowPackage, validateWorkflowPackage } from "../src/workflow-package.mjs";
import { inspectWorkflowBundle, serializeWorkflowBundle } from "../src/workflow-bundle.mjs";
import { structuredHash } from "../src/role-contracts.mjs";
import { DEFAULT_QUALITY_CONTRACTS, qualityContractsLint, serializeQualityContracts } from "../src/quality-contracts.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checkOnly = process.argv.includes("--check");

// Which definitions this run works on is stated on the command line, never inherited. With no argument
// it is the example this repository ships, so `packages:check` verifies the repository against itself on
// any machine and in CI. An installation generates its own packages by naming its file, or by asking for
// the one its configuration declares.
const FLAG = "--definitions";
const flagged = process.argv.find(item => item.startsWith(`${FLAG}=`));
const positional = process.argv[process.argv.indexOf(FLAG) + 1];
const named = flagged ? flagged.slice(FLAG.length + 1) : process.argv.includes(FLAG) ? positional : null;
if (process.argv.includes(FLAG) && (!named || named.startsWith("--"))) throw new Error(`PACKAGE_DEFINITIONS_REQUIRED: ${FLAG} needs a file`);
const source = process.argv.includes("--installation") ? resolveWorkflowSettings().packageDefinitions : named;
const { packages: PACKAGE_DEFINITIONS, bundles: PACKAGE_BUNDLES, generatedDirectory: outputDirectory, file: packageDefinitionsFile } = await loadPackageDefinitions(source ?? undefined);
const results = [];
// Generated packages live beside the source that declares them, which is outside the repository for a
// configured installation, so paths are reported relative to that directory rather than to the root.
const report = file => path.relative(path.dirname(outputDirectory), file).replaceAll("\\", "/");
const qualityContractsFile = path.join(root, "contracts", "quality-contracts.xml");
const qualityContractsSource = serializeQualityContracts(DEFAULT_QUALITY_CONTRACTS);
if (checkOnly) {
  if (!fs.existsSync(qualityContractsFile) || fs.readFileSync(qualityContractsFile, "utf8") !== qualityContractsSource) throw new Error("GENERATED_QUALITY_CONTRACTS_STALE");
} else {
  fs.mkdirSync(path.dirname(qualityContractsFile), { recursive: true });
  fs.writeFileSync(qualityContractsFile, qualityContractsSource, "utf8");
}
const qualityLint = qualityContractsLint(fs.readFileSync(qualityContractsFile, "utf8"));
if (qualityLint.status !== "passed") throw new Error(`GENERATED_QUALITY_CONTRACTS_INVALID: ${qualityLint.errors.join(", ")}`);
for (const packageValue of PACKAGE_DEFINITIONS) {
  validateWorkflowPackage(packageValue);
  const file = path.join(outputDirectory, `${packageValue.key}.xml`), source = serializeWorkflowPackage(packageValue);
  if (checkOnly) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== source) throw new Error(`GENERATED_PACKAGE_STALE: ${packageValue.key}`);
  } else {
    fs.mkdirSync(outputDirectory, { recursive: true }); fs.writeFileSync(file, source, "utf8");
  }
  results.push({ key: packageValue.key, version: packageValue.version, file: report(file) });
}
const bundles = [];
for (const spec of PACKAGE_BUNDLES) {
  const members = new Set(spec.member_keys);
  const bundleFile = path.join(outputDirectory, spec.file);
  const bundle = {
    schema_version: 1,
    key: spec.key,
    version: spec.version,
    purpose: spec.purpose,
    packages: PACKAGE_DEFINITIONS.filter(item => members.has(item.key)).map(item => ({
      key: item.key,
      version: item.version,
      file: `${item.key}.xml`,
      hash: `sha256:${structuredHash(item)}`,
      activation: item.key === spec.activate_first ? "activate-first" : "prepare-only"
    }))
  };
  const bundleSource = serializeWorkflowBundle(bundle);
  if (checkOnly) {
    if (!fs.existsSync(bundleFile) || fs.readFileSync(bundleFile, "utf8") !== bundleSource) throw new Error(`GENERATED_WORKFLOW_BUNDLE_STALE: ${spec.key}`);
  } else fs.writeFileSync(bundleFile, bundleSource, "utf8");
  const bundleLint = inspectWorkflowBundle(bundleFile);
  if (bundleLint.status !== "passed") throw new Error(`GENERATED_WORKFLOW_BUNDLE_INVALID: ${bundleLint.errors.join(", ")}`);
  bundles.push({ key: bundle.key, version: bundle.version, file: report(bundleFile), packages: bundle.packages.length });
}
process.stdout.write(`${JSON.stringify({ status: checkOnly ? "checked" : "generated", definitions: path.basename(packageDefinitionsFile), quality_contracts: { file: path.relative(root, qualityContractsFile).replaceAll("\\", "/"), contracts: qualityLint.contracts }, packages: results, bundles })}\n`);
