import fs from "node:fs";
import path from "node:path";
import { documentLint } from "../WorkflowPlatform/src/lint.mjs";
import { qualityContractsLint } from "../WorkflowPlatform/src/quality-contracts.mjs";
import { transactionAwaitViolations } from "../WorkflowPlatform/src/transaction-guard.mjs";

const root = path.resolve(import.meta.dirname, "..");
const product = JSON.parse(fs.readFileSync(path.join(root, "product.json"), "utf8"));
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const errors = [];

if (product.name !== "zodchi" || product.displayName !== "Zodchi" || product.workingName !== false) errors.push("invalid public product identity");
if (rootPackage.name !== product.name || rootPackage.version !== product.version || rootPackage.license !== "MIT") errors.push("root package does not match product.json");

const semanticDocuments = [
  "README.md",
  "CHANGELOG.md",
  "ONBOARDING_PROMPT.md",
  "QUICKSTART.md",
  "UPDATE.md",
  "configs/WorkflowPlatformArchitecture.template.md",
  "docs/ARCHITECTURE.md",
  "docs/RELEASE_EVIDENCE_0.6.0-rc.1.md",
  "docs/ru/README.md",
  "docs/ru/CHANGELOG.md",
  "WorkflowPlatform/docs/WorkflowPlatform.md",
  "WorkflowPlatform/docs/ProjectPackages.md",
  "WorkflowPlatform/catalogs/README.md",
  "AgentGateway/docs/AgentGateway.md"
];
for (const relative of semanticDocuments) {
  const file = path.join(root, relative);
  const result = documentLint(fs.readFileSync(file, "utf8"), relative);
  if (result.status !== "passed") errors.push(`${relative}: ${result.errors.join("; ")}`);
}

const qualityFile = path.join(root, "WorkflowPlatform/contracts/quality-contracts.xml");
const quality = qualityContractsLint(fs.readFileSync(qualityFile, "utf8"));
if (quality.status !== "passed") errors.push(`quality contracts: ${quality.errors.join("; ")}`);

for (const directory of ["WorkflowPlatform/src", "AgentGateway/src"]) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    const relative = `${directory}/${entry.name}`;
    errors.push(...transactionAwaitViolations(fs.readFileSync(path.join(root, relative), "utf8"), relative));
  }
}

for (const relative of ["WorkflowPlatform/starter", "WorkflowPlatform/docs/BaselineAudit.md", "WorkflowPlatform/docs/GoalProgress.md"]) {
  if (fs.existsSync(path.join(root, relative))) errors.push(`private or obsolete source artifact remains: ${relative}`);
}

if (errors.length) {
  process.stderr.write(`${JSON.stringify({ status: "failed", errors }, null, 2)}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ status: "passed", product: product.name, version: product.version, semantic_documents: semanticDocuments.length })}\n`);
