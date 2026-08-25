import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import { DEFAULT_QUALITY_CONTRACTS, floorOperationalLevel, operationalPoliciesLint, parseQualityContracts, qualityContractsLint, qualityModesThrough, reviewerRequirement, serializeQualityContracts } from "../src/quality-contracts.mjs";
import { applyWorkflowImport, proposeWorkflowImport, serializeWorkflowPackage } from "../src/workflow-package.mjs";
import * as builders from "../packages/builders.mjs";
import defineExample from "../packages/example/definitions.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The example package is built here rather than read from disk, so these tests do not depend on
// which definition source the installation configured.
const examplePackageFile = directory => { const file = path.join(directory, "example.web-app.xml"); fs.writeFileSync(file, serializeWorkflowPackage(defineExample(builders).packages[0]), "utf8"); return file; };
function temporaryRoot(prefix) { const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, prefix)); }

test("the universal quality contract round-trips through limited XML", () => {
  const source = serializeQualityContracts();
  assert.equal(qualityContractsLint(source).status, "passed");
  assert.deepEqual(parseQualityContracts(source).map(item => item.level), ["prototype", "mvp", "production", "security-audit"]);
  assert.equal(qualityContractsLint(source.replace('id="mvp"', 'id="prototype"')).status, "failed");
});

test("review escalation follows quality, risk and correction evidence", () => {
  const contract = level => DEFAULT_QUALITY_CONTRACTS.find(item => item.level === level);
  const low = { risk: "low", work_type: "implementation", artifact_type: "code" };
  assert.equal(reviewerRequirement(contract("prototype"), low).required, false);
  assert.equal(reviewerRequirement(contract("mvp"), low).required, false);
  assert.equal(reviewerRequirement(contract("mvp"), { ...low, risk: "high" }).required, true);
  assert.equal(reviewerRequirement(contract("mvp"), low, 1).required, true);
  assert.equal(reviewerRequirement(contract("production"), low).required, true);
  assert.equal(reviewerRequirement(contract("security-audit"), low).required, true);
});

test("higher quality levels inherit every preceding quality mode", () => {
  assert.deepEqual(qualityModesThrough("prototype"), ["prototype"]);
  assert.deepEqual(qualityModesThrough("mvp"), ["prototype", "mvp"]);
  assert.deepEqual(qualityModesThrough("production"), ["prototype", "mvp", "production"]);
  assert.deepEqual(qualityModesThrough("security-audit"), ["prototype", "mvp", "production", "security"]);
  assert.deepEqual(qualityModesThrough("security"), ["prototype", "mvp", "production", "security"]);
});

test("an imported software package has four normalized and checkable quality policies", () => {
  const root = temporaryRoot("workflow-quality-policy-");
  const dbFile = path.join(root, "workflow.sqlite"), proposalFile = path.join(root, "proposal.json"), projectRoot = path.join(root, "project-r");
  fs.mkdirSync(projectRoot);
  let db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project-r','Project R',?,?)").run(projectRoot, new Date().toISOString());
  db.close();
  const packageFile = examplePackageFile(root);
  proposeWorkflowImport(dbFile, packageFile, proposalFile, "project-r");
  applyWorkflowImport(dbFile, proposalFile, "project-r", { confirmedBy: "contract-test-owner" });
  db = openDb(dbFile);
  const result = operationalPoliciesLint(db, "project-r");
  assert.deepEqual(result, { kind: "operational_policies", status: "passed", errors: [], projects: 1, packages: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM operational_level_budget_limits WHERE project_id='project-r'").get().count, 12);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a workflow's declared quality is a floor the classifier cannot go below", () => {
  assert.equal(floorOperationalLevel("prototype", "mvp"), "mvp");
  assert.equal(floorOperationalLevel("prototype", "production"), "production");
  assert.equal(floorOperationalLevel("mvp", "security"), "security-audit");
});

test("the floor never lowers a level the classifier raised, and is inert without a workflow quality", () => {
  assert.equal(floorOperationalLevel("production", "mvp"), "production");
  assert.equal(floorOperationalLevel("security-audit", "prototype"), "security-audit");
  assert.equal(floorOperationalLevel("prototype", "prototype"), "prototype");
  assert.equal(floorOperationalLevel("prototype", null), "prototype");
});
