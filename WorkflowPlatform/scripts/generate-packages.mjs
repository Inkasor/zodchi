import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackageDefinitions, repositoryPackageDefinitionsFile } from "../packages/definitions.mjs";
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
const { packages: PACKAGE_DEFINITIONS, bundles: PACKAGE_BUNDLES, aliases: PACKAGE_ALIASES, statuses: PACKAGE_STATUSES, generatedDirectory: outputDirectory, file: packageDefinitionsFile } = await loadPackageDefinitions(source ?? undefined);
const results = [];
const repositoryDefinitions = path.resolve(packageDefinitionsFile) === path.resolve(repositoryPackageDefinitionsFile);
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
// A catalog is generated from the same definitions as its XML envelopes. The repository keeps its
// example definitions one directory below the public catalog; an installation keeps definitions,
// catalog and generated/ as siblings. In both layouts the definitions are the only version authority.
const catalogRoot = repositoryDefinitions ? path.join(root, "packages") : path.dirname(packageDefinitionsFile);
const catalogFile = path.join(catalogRoot, "catalog.json");
const previousCatalog = fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, "utf8")) : { packages: [] };
const acceptance = new Map((previousCatalog.packages ?? []).map(item => [item.key, item.owner_acceptance ?? []]));
for (const alias of PACKAGE_ALIASES) if (!acceptance.has(alias.target) && acceptance.has(alias.key)) acceptance.set(alias.target, acceptance.get(alias.key));
const catalogValue = {
  schema_version: 2,
  packages: PACKAGE_DEFINITIONS.map(item => ({
    key: item.key,
    version: item.version,
    support_status: PACKAGE_STATUSES[item.key] ?? "local",
    file: path.relative(catalogRoot, path.join(outputDirectory, `${item.key}.xml`)).replaceAll("\\", "/"),
    owner_acceptance: acceptance.get(item.key) ?? []
  })),
  aliases: PACKAGE_ALIASES.map(alias => ({ key: alias.key, target: alias.target, deprecated: true, remove_after: alias.remove_after }))
};
const catalogSource = `${JSON.stringify(catalogValue, null, 2)}\n`;
if (checkOnly) {
  if (!fs.existsSync(catalogFile) || fs.readFileSync(catalogFile, "utf8") !== catalogSource) {
    throw new Error(repositoryDefinitions ? "PUBLIC_PACKAGE_CATALOG_STALE" : "INSTALLATION_PACKAGE_CATALOG_STALE");
  }
} else {
  fs.mkdirSync(catalogRoot, { recursive: true });
  fs.writeFileSync(catalogFile, catalogSource, "utf8");
}
const publicCatalog = {
  file: repositoryDefinitions ? path.relative(root, catalogFile).replaceAll("\\", "/") : report(catalogFile),
  packages: catalogValue.packages.length
};
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
process.stdout.write(`${JSON.stringify({ status: checkOnly ? "checked" : "generated", definitions: path.basename(packageDefinitionsFile), quality_contracts: { file: path.relative(root, qualityContractsFile).replaceAll("\\", "/"), contracts: qualityLint.contracts }, public_catalog: publicCatalog, packages: results, bundles })}\n`);
