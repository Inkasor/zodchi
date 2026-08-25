import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db.mjs";
import { applyWorkflowImport, parseWorkflowPackage, proposeWorkflowImport, serializeWorkflowPackage, validateWorkflowPackage } from "../src/workflow-package.mjs";
import { inspectWorkflowBundle, parseWorkflowBundle } from "../src/workflow-bundle.mjs";
import { PACKAGE_BUNDLES, PACKAGE_DEFINITIONS, generatedPackagesDirectory } from "../packages/definitions.mjs";

// Package definitions are an installation's own material and the configured source may be private, so
// these tests assert the contract every package must satisfy rather than the content of any one
// project. Whatever `packageDefinitions` points at is what they run against; by default that is the
// example this repository ships.
function temporaryRoot(prefix) { const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, prefix)); }
const generatedFile = key => path.join(generatedPackagesDirectory, `${key}.xml`);

test("at least one package is configured and every one is generated and free of local identity", () => {
  assert.equal(PACKAGE_DEFINITIONS.length >= 1, true);
  for (const packageValue of PACKAGE_DEFINITIONS) {
    validateWorkflowPackage(packageValue);
    const source = fs.readFileSync(generatedFile(packageValue.key), "utf8");
    assert.equal(source, serializeWorkflowPackage(packageValue)); assert.equal(parseWorkflowPackage(source).key, packageValue.key);
    assert.equal(/[A-Za-z]:[\\/]/.test(source), false); assert.equal(source.includes("model_id"), false); assert.equal(source.includes("profile_id"), false); assert.equal(source.includes("api_key"), false);
    assert.equal(packageValue.roles.every(role => role.contract.purpose && role.contract.result_schema_key && role.contract.allowed_profile_keys.length), true);
    assert.equal(packageValue.workflows.every(workflow => workflow.steps.length && workflow.transitions.length === workflow.steps.length - 1), true);
    assert.equal(packageValue.documents.every(item => !path.isAbsolute(item.path)), true);
  }
});

test("classification is routed by the model and every declared route reaches a declared workflow", () => {
  for (const packageValue of PACKAGE_DEFINITIONS) {
    const classifier = packageValue.roles.find(item => item.key === "classifier");
    if (classifier) assert.equal(classifier.contract.boundaries.keyword_routing, false);
    const workflowKeys = new Set(packageValue.workflows.map(item => item.key));
    for (const route of packageValue.routes) assert.equal(workflowKeys.has(route.workflow_key), true, `${packageValue.key}: ${route.work_type_key}`);
  }
});

test("an irreversible step is never taken by a role, and deployment is approved before it happens", () => {
  for (const packageValue of PACKAGE_DEFINITIONS) {
    for (const workflow of packageValue.workflows) for (const step of workflow.steps) if (step.irreversible) assert.equal(step.role_key, null, `${workflow.key}: ${step.key}`);
    const release = packageValue.workflows.find(item => item.key.endsWith(".release"));
    if (!release) continue;
    assert.equal(release.default_quality, "production", packageValue.key);
    // Not every release deploys: a package may end at the owner's publication decision. Where a step
    // does act on the outside world, an irreversible approval has to come before it and not after.
    const acting = release.steps.findIndex(item => ["deploy", "publish"].includes(item.key));
    if (acting < 0) { assert.equal(release.steps.some(item => item.irreversible), true, packageValue.key); continue; }
    assert.equal(release.steps.findIndex(item => item.irreversible && !item.role_key) >= 0, true, packageValue.key);
    assert.equal(release.steps.findIndex(item => item.irreversible && !item.role_key) < acting, true, packageValue.key);
  }
});

// The workflow names itself production work, and the level it declares is also the floor a classifier
// cannot drop below, so declaring MVP would quietly reduce a production incident to one check.
// A route without a declared planning step is executed exactly as it was declared, and nothing in that
// derivation can produce an allowed path. A worker role that may write therefore has to be given its
// paths by a planner, or it would be turned loose on the whole project.
test("a workflow whose workers may write declares a planning step", () => {
  for (const packageValue of PACKAGE_DEFINITIONS) {
    const writes = new Map(packageValue.roles.map(role => [role.key, (role.contract.allowed_tools ?? []).length > 0]));
    for (const workflow of packageValue.workflows) {
      const worker = workflow.steps.filter(step => step.role_key && step.output_schema_key === "worker.v1");
      const writing = worker.filter(step => writes.get(step.role_key));
      if (!writing.length) continue;
      assert.equal(workflow.steps.some(step => step.output_schema_key === "planner.v1"), true, `${packageValue.key}/${workflow.key}: ${writing.map(step => step.key).join(",")}`);
    }
  }
});

test("a production incident runs at production quality", () => {
  for (const packageValue of PACKAGE_DEFINITIONS) {
    const incident = packageValue.workflows.find(item => item.key.endsWith(".incident"));
    if (incident) assert.equal(incident.default_quality, "production", packageValue.key);
  }
});

test("a production build is not part of the MVP gate", () => {
  for (const packageValue of PACKAGE_DEFINITIONS) for (const check of packageValue.checks) {
    const productionOnly = check.bindings.length && check.bindings.every(item => item.quality_mode_key === "production");
    if (!productionOnly) continue;
    assert.equal(packageValue.operational_levels.find(item => item.level === "mvp")?.required_check_keys.includes(check.key) ?? false, false, `${packageValue.key}: ${check.key}`);
  }
});

// A gate resolves its own level and every level below it, and a security audit sits above production.
// Bound to the audit alone, a secret scan would never run at the one moment code is published.
test("a secret scan and dependency scan also run on a release", () => {
  for (const packageValue of PACKAGE_DEFINITIONS) for (const check of packageValue.checks) {
    if (!check.bindings.some(item => item.quality_mode_key === "security")) continue;
    assert.equal(check.bindings.some(item => item.quality_mode_key === "production"), true, `${packageValue.key}: ${check.key}`);
  }
});

test("a declared bundle verifies its members and keeps staged activation explicit", () => {
  for (const spec of PACKAGE_BUNDLES) {
    const file = path.join(generatedPackagesDirectory, spec.file);
    const result = inspectWorkflowBundle(file);
    assert.equal(result.status, "passed");
    assert.equal(result.packages.length, spec.member_keys.length);
    assert.deepEqual(result.packages.filter(item => item.activation === "activate-first").map(item => item.key), spec.activate_first ? [spec.activate_first] : []);
    assert.throws(() => parseWorkflowBundle(fs.readFileSync(file, "utf8").replace('activation="prepare-only"', 'activation="automatic"')), /WORKFLOW_BUNDLE_PACKAGE_INVALID/);
  }
});

test("every generated package imports transactionally into a clean local project registry", () => {
  const root = temporaryRoot("workflow-project-packages-"), dbFile = path.join(root, "packages.sqlite"), db = openDb(dbFile);
  for (const packageValue of PACKAGE_DEFINITIONS) db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(packageValue.key, packageValue.key, path.join(root, packageValue.key), new Date().toISOString()); db.close();
  for (const packageValue of PACKAGE_DEFINITIONS) {
    const proposalFile = path.join(root, `${packageValue.key}.proposal.json`), proposal = proposeWorkflowImport(dbFile, generatedFile(packageValue.key), proposalFile, packageValue.key);
    assert.equal(proposal.status, "pending"); assert.equal(applyWorkflowImport(dbFile, proposalFile, packageValue.key, { confirmedBy: "contract-test-owner" }).status, "applied");
  }
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM workflow_package_releases WHERE status='active'").get().count, PACKAGE_DEFINITIONS.length);
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM workflows").get().count, PACKAGE_DEFINITIONS.reduce((total, item) => total + item.workflows.length, 0));
  verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// A role contract names portable requirement keys; an installation satisfies them with local profiles.
// A requirement that no role declares can never be satisfied, and a role whose declared profiles are
// not declared as requirements can never be loaded.
test("every role's allowed profiles are declared as portable requirements", () => {
  for (const packageValue of PACKAGE_DEFINITIONS) {
    const required = new Set(packageValue.profiles.map(item => item.key));
    for (const item of packageValue.roles) {
      const allowed = item.contract.allowed_profile_keys;
      if (allowed.includes("*")) continue;
      for (const key of allowed) assert.equal(required.has(key), true, `${packageValue.key}: ${item.key} allows undeclared requirement ${key}`);
    }
  }
});
