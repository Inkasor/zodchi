import assert from "node:assert/strict";
import test from "node:test";
import { composedPackage, contentProduction, coreLifecycle, domainAdapter, releaseCapability, sourceChange } from "../packages/builders.mjs";
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

test("package lint rejects purposeless roles and gates without a runner", () => {
  const packageValue = composedPackage(core("minimal"), sourceChange());
  const purposeless = structuredClone(packageValue); purposeless.roles.find(item => item.key === "worker").contract.purpose = "";
  assert.throws(() => validateWorkflowPackage(purposeless), /executable purpose is required/);
  const runnerless = structuredClone(packageValue); runnerless.checks[0].runner = "";
  assert.throws(() => validateWorkflowPackage(runnerless), /executable runner is required/);
});
