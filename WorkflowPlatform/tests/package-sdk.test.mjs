import assert from "node:assert/strict";
import test from "node:test";
import { activityOperations, backupRestore, composedPackage, contentProduction, coreLifecycle, domainAdapter, ownerAcceptance, releaseCapability, sourceChange } from "../packages/builders.mjs";
import { structuredHash } from "../src/role-contracts.mjs";
import { validateWorkflowPackage } from "../src/workflow-package.mjs";

const core = preset => coreLifecycle({ key: `sdk.${preset}`, version: "1.0.0", purpose: "SDK composition fixture", rolePreset: preset, domains: ["software"], disciplines: ["software"], documents: [{ key: "rules", path: "AGENTS.md", type: "authority" }] });

test("minimal composition has coordinator and worker but no ceremonial reviewer or editor", () => {
  const packageValue = validateWorkflowPackage(composedPackage(core("minimal"), sourceChange()));
  const roles = packageValue.roles.map(item => item.key);
  assert.equal(roles.includes("coordinator"), true);
  assert.equal(roles.includes("worker"), true);
  assert.equal(roles.includes("reviewer"), false);
  assert.equal(roles.includes("editor"), false);
  assert.deepEqual(packageValue.workflows.find(item => item.key.endsWith(".change")).steps.map(item => item.role_key), ["coordinator", "worker"]);
});

test("Gauntlet persistence does not require review roles", () => {
  const packageValue = composedPackage(core("minimal"), sourceChange());
  const prototype = packageValue.operational_levels.find(item => item.level === "prototype");
  prototype.improvement_strategy = "gauntlet";
  prototype.budgets = { calls: 12, duration_ms: 3600000, correction_cycles: 3, cost_usd: 2 };
  prototype.correction_limit = 3;
  prototype.escalation = {};
  assert.doesNotThrow(() => validateWorkflowPackage(packageValue));
});

test("capabilities add only the roles and approval boundary they execute", () => {
  const packageValue = validateWorkflowPackage(composedPackage(core("full"), sourceChange(), contentProduction(), releaseCapability()));
  const roles = new Set(packageValue.roles.map(item => item.key));
  for (const expected of ["coordinator", "worker", "reviewer", "editor", "release_operator"]) assert.equal(roles.has(expected), true);
  const releaseFlow = packageValue.workflows.find(item => item.key.endsWith(".release"));
  assert.equal(releaseFlow.steps.some(item => item.key === "release_approval" && item.irreversible), true);
  assert.equal(releaseFlow.steps.findIndex(item => item.key === "release_approval") < releaseFlow.steps.findIndex(item => item.key === "release"), true);
});

test("composition order is deterministic and material adapters require an evidence policy", () => {
  const a = composedPackage(core("reviewed"), sourceChange(), releaseCapability());
  const b = composedPackage(core("reviewed"), releaseCapability(), sourceChange());
  assert.equal(structuredHash(a), structuredHash(b));
  assert.throws(() => domainAdapter({ key: "material", materialClaims: true }), /PACKAGE_SDK_EVIDENCE_POLICY_REQUIRED/);
});

test("owner acceptance stays separate from technical review", () => {
  const packageValue = validateWorkflowPackage(composedPackage(
    core("reviewed"),
    ownerAcceptance({ workTypes: ["game.visual-acceptance"], artifactKeys: ["visual_asset", "test_report"] })
  ));
  const flow = packageValue.workflows.find(item => item.key.endsWith(".acceptance"));
  assert.deepEqual(flow.steps.map(item => item.key), ["coordinate", "evidence", "review", "owner_acceptance"]);
  assert.equal(flow.steps.at(-1).role_key, null);
  assert.equal(flow.steps.at(-1).irreversible, true);
  assert.deepEqual(packageValue.routes.filter(item => item.work_type_key === "game.visual-acceptance").map(item => item.workflow_key), [flow.key]);
});

test("capability resources are executable step requirements rather than decorative package metadata", () => {
  const coreWithResource = coreLifecycle({ key: "sdk.resource", version: "1.0.0", purpose: "Resource fixture", rolePreset: "minimal", domains: ["software"], disciplines: ["software"], resources: [{ alias: "runtime", kind: "project.worktree", purpose: "Exclusive runtime" }] });
  const packageValue = validateWorkflowPackage(composedPackage(coreWithResource, sourceChange({ resources: [{ alias: "runtime", mode: "exclusive" }] })));
  assert.deepEqual(packageValue.workflows.find(item => item.key.endsWith(".change")).steps.find(item => item.key === "work").resources, [{ alias: "runtime", mode: "exclusive" }]);
});

test("backup restore and activity execution require approval before external action", () => {
  const backup = validateWorkflowPackage(composedPackage(core("minimal"), backupRestore()));
  assert.deepEqual(backup.workflows.find(item => item.key.endsWith(".backup_restore")).steps.map(item => item.key), ["coordinate", "verify_backup", "restore_approval", "restore", "verify_health"]);
  const activity = validateWorkflowPackage(composedPackage(core("editorial"), contentProduction({ ownerAcceptance: true }), activityOperations()));
  assert.deepEqual(activity.workflows.find(item => item.key.endsWith(".content")).steps.map(item => item.key), ["coordinate", "produce", "edit", "owner_acceptance"]);
  assert.deepEqual(activity.workflows.find(item => item.key.endsWith(".activity")).steps.map(item => item.key), ["coordinate", "schedule", "execution_approval", "execute", "measure"]);
  assert.deepEqual(activity.roles.find(item => item.key === "worker").contract.allowed_tools.sort(), ["apply_patch", "exec_command"]);
});

test("package lint rejects purposeless roles and gates without a runner", () => {
  const packageValue = composedPackage(core("minimal"), sourceChange());
  const purposeless = structuredClone(packageValue); purposeless.roles.find(item => item.key === "worker").contract.purpose = "";
  assert.throws(() => validateWorkflowPackage(purposeless), /executable purpose is required/);
  const runnerless = structuredClone(packageValue); runnerless.checks[0].runner = "";
  assert.throws(() => validateWorkflowPackage(runnerless), /executable runner is required/);
  const duplicateQuality = structuredClone(packageValue);
  duplicateQuality.checks[0].bindings.push({ quality_mode_key: "mvp", artifact_type_key: "code", required: true });
  assert.throws(() => validateWorkflowPackage(duplicateQuality), /bindings_by_quality: duplicate mvp/);
});
