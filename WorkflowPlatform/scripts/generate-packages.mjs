import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_DEFINITIONS } from "../packages/definitions.mjs";
import { serializeWorkflowPackage, validateWorkflowPackage } from "../src/workflow-package.mjs";
import { inspectWorkflowBundle, serializeWorkflowBundle } from "../src/workflow-bundle.mjs";
import { structuredHash } from "../src/role-contracts.mjs";
import { DEFAULT_QUALITY_CONTRACTS, qualityContractsLint, serializeQualityContracts } from "../src/quality-contracts.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDirectory = path.join(root, "packages", "generated");
const checkOnly = process.argv.includes("--check");
const results = [];
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
  results.push({ key: packageValue.key, version: packageValue.version, file: path.relative(root, file).replaceAll("\\", "/") });
}
const companyKeys = new Set(["company-web.marketplaces-data", "company-web.dashboard", "company-web.photo-hub", "company-web.mapping-hub", "company-web.interior-hub", "company-operations.core"]);
const bundleFile = path.join(outputDirectory, "company-workflows.xml");
const bundle = {
  schema_version: 1,
  key: "company-workflows.core",
  version: "2.1.0",
  purpose: "Portable company workflow standard without local paths, models, secrets, or run history.",
  packages: PACKAGE_DEFINITIONS.filter(item => companyKeys.has(item.key)).map(item => ({
    key: item.key,
    version: item.version,
    file: `${item.key}.xml`,
    hash: `sha256:${structuredHash(item)}`,
    activation: item.key === "company-web.marketplaces-data" ? "activate-first" : "prepare-only"
  }))
};
const bundleSource = serializeWorkflowBundle(bundle);
if (checkOnly) {
  if (!fs.existsSync(bundleFile) || fs.readFileSync(bundleFile, "utf8") !== bundleSource) throw new Error("GENERATED_WORKFLOW_BUNDLE_STALE: company-workflows.core");
} else fs.writeFileSync(bundleFile, bundleSource, "utf8");
const bundleLint = inspectWorkflowBundle(bundleFile);
if (bundleLint.status !== "passed") throw new Error(`GENERATED_WORKFLOW_BUNDLE_INVALID: ${bundleLint.errors.join(", ")}`);
process.stdout.write(`${JSON.stringify({ status: checkOnly ? "checked" : "generated", quality_contracts: { file: path.relative(root, qualityContractsFile).replaceAll("\\", "/"), contracts: qualityLint.contracts }, packages: results, bundle: { key: bundle.key, version: bundle.version, file: path.relative(root, bundleFile).replaceAll("\\", "/"), packages: bundle.packages.length } })}\n`);
