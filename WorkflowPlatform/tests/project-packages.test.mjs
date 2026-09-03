import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db.mjs";
import { applyWorkflowImport, parseWorkflowPackage, proposeWorkflowImport, serializeWorkflowPackage, validateWorkflowPackage } from "../src/workflow-package.mjs";
import { inspectWorkflowBundle, parseWorkflowBundle } from "../src/workflow-bundle.mjs";
import { loadPackageDefinitions } from "../packages/definitions.mjs";
import { companyWebPackage, role } from "../packages/builders.mjs";
import { canonicalTool } from "../../AgentGateway/src/tool-usage.mjs";

// Package definitions are an installation's own material and a configured source may be private, so
// these tests assert the contract every package must satisfy rather than the content of any one
// project. They run against the example this repository ships and nothing else: a test that follows an
// environment variable tests whatever that machine happens to point at, which is a different suite on
// every machine and no suite at all in CI.
const { packages: PACKAGE_DEFINITIONS, bundles: PACKAGE_BUNDLES, generatedDirectory: generatedPackagesDirectory } = await loadPackageDefinitions();
const packagesRoot = path.dirname(path.dirname(generatedPackagesDirectory));
function temporaryRoot(prefix) { const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, prefix)); }
const generatedFile = key => path.join(generatedPackagesDirectory, `${key}.xml`);

test("new role contracts use a measured-prompt allowance above the old 24KB default", () => {
  const ordinary = role("analyst", "Inspect bounded evidence.", ["research"], ["document"]);
  const deliberatelySmall = role("fixture", "Exercise fitting.", ["research"], ["document"], { context: 24000 });
  assert.equal(ordinary.contract.context_limit_bytes, 65536);
  assert.equal(deliberatelySmall.contract.context_limit_bytes, 24000);
});

test("documentator contracts propose from a read-only profile while the platform owns the write", () => {
  const packageValue = companyWebPackage({ key: "sdk.documentator", version: "1.0.0", purpose: "Documentator write-boundary fixture.", checks: [], documents: [] });
  const documentator = packageValue.roles.find(item => item.key === "documentator");
  assert.equal(documentator.contract.result_schema_key, "documentator.v1");
  assert.equal(documentator.contract.boundaries.writes, false);
  assert.equal(documentator.contract.allowed_tools.includes("apply_patch"), false);
});

test("controlled document bodies default to researcher access and classifier access stays explicit", () => {
  const packageValue = companyWebPackage({
    key: "sdk.document-authority", version: "1.0.0", purpose: "Document authority fixture.", checks: [],
    documents: [{ key: "authority", path: "docs/authority.md", type: "reference", authority: "owner" }]
  });
  const documentValue = packageValue.documents[0];
  assert.equal(documentValue.bindings.some(item => item.role_key === "researcher" && item.read === true), true);
  assert.equal(documentValue.bindings.some(item => item.role_key === "classifier"), false);
});

test("release and access operators are read-only proposal roles before exact owner approval", () => {
  for (const packageValue of PACKAGE_DEFINITIONS) {
    for (const [roleKey, schemaKey, workflowSuffix] of [["release_operator", "release_operation.v1", ".release"], ["access_administrator", "access_change.v1", ".access"]]) {
      const roleValue = packageValue.roles.find(item => item.key === roleKey);
      if (!roleValue) continue;
      assert.equal(roleValue.contract.boundaries.writes, false, `${packageValue.key}/${roleKey}`);
      assert.equal(roleValue.contract.boundaries.execution, false, `${packageValue.key}/${roleKey}`);
      assert.deepEqual(roleValue.contract.allowed_tools, [], `${packageValue.key}/${roleKey}`);
      assert.equal(roleValue.contract.result_schema_key, schemaKey, `${packageValue.key}/${roleKey}`);
      const workflow = packageValue.workflows.find(item => item.key.endsWith(workflowSuffix));
      assert.ok(workflow, `${packageValue.key}/${workflowSuffix}`);
      const proposal = workflow.steps.findIndex(item => item.role_key === roleKey && item.output_schema_key === schemaKey);
      const approval = workflow.steps.findIndex(item => item.irreversible && !item.role_key);
      assert.ok(proposal >= 0 && approval > proposal, `${packageValue.key}/${roleKey}: proposal must precede approval`);
      assert.equal(workflow.steps.slice(approval + 1).some(item => item.role_key === roleKey), false, `${packageValue.key}/${roleKey}: model must not execute after approval`);
    }
  }
});

test("package lint enforces the configurable one-to-three consilium contract", () => {
  const invalid = structuredClone(PACKAGE_DEFINITIONS[0]);
  invalid.operational_levels.find(item => item.level === "mvp").escalation.max_parallel_consilium_members = 4;
  assert.throws(() => validateWorkflowPackage(invalid), /max_parallel_consilium_members/);

  const noJudge = structuredClone(PACKAGE_DEFINITIONS[0]);
  const policy = noJudge.operational_levels.find(item => item.level === "mvp");
  policy.improvement_strategy = "gauntlet";
  policy.escalation.max_parallel_consilium_members = 2;
  noJudge.roles = noJudge.roles.filter(roleValue => roleValue.key !== "judge");
  noJudge.profiles = noJudge.profiles.filter(profile => profile.role_key !== "judge");
  noJudge.prompt_templates = noJudge.prompt_templates.filter(template => template.role_key !== "judge");
  assert.throws(() => validateWorkflowPackage(noJudge), /requires judge/);
});

test("at least one package is configured and every one is generated and free of local identity", () => {
  assert.equal(PACKAGE_DEFINITIONS.length >= 1, true);
  for (const packageValue of PACKAGE_DEFINITIONS) {
    validateWorkflowPackage(packageValue);
    const source = fs.readFileSync(generatedFile(packageValue.key), "utf8");
    assert.equal(source, serializeWorkflowPackage(packageValue)); assert.equal(parseWorkflowPackage(source).key, packageValue.key);
    assert.equal(/[A-Za-z]:[\\/]/.test(source), false); assert.equal(source.includes("model_id"), false); assert.equal(source.includes("profile_id"), false); assert.equal(source.includes("api_key"), false);
    assert.equal(packageValue.roles.every(role => role.contract.purpose && role.contract.result_schema_key && role.contract.allowed_profile_keys.length), true);
    assert.equal(packageValue.roles.filter(role => role.contract.allowed_tools.includes("apply_patch")).every(role => role.contract.boundaries.writes === true), true);
    const documentator = packageValue.roles.find(role => role.key === "documentator");
    if (documentator) { assert.equal(documentator.contract.boundaries.writes, false); assert.equal(documentator.contract.allowed_tools.includes("apply_patch"), false); }
    assert.equal(packageValue.workflows.every(workflow => workflow.steps.length && workflow.transitions.length === workflow.steps.length - 1), true);
    assert.equal(packageValue.documents.every(item => !path.isAbsolute(item.path)), true);
  }
});

test("every portable role tool has a matching Gateway canonicalization", () => {
  const contractTools = [...new Set(PACKAGE_DEFINITIONS.flatMap(packageValue => packageValue.roles.flatMap(roleValue => roleValue.contract.allowed_tools)))];
  for (const tool of contractTools) assert.equal(canonicalTool(tool), tool, `Gateway canonicalization is missing for contract tool ${tool}`);
});

test("public catalog versions and files are generated from the package definitions", () => {
  const publicCatalog = JSON.parse(fs.readFileSync(path.join(packagesRoot, "catalog.json"), "utf8"));
  assert.deepEqual(publicCatalog.packages.map(item => ({ key: item.key, version: item.version })), PACKAGE_DEFINITIONS.map(item => ({ key: item.key, version: item.version })));
  for (const item of publicCatalog.packages) {
    const source = fs.readFileSync(path.join(packagesRoot, item.file), "utf8");
    const parsed = parseWorkflowPackage(source);
    assert.equal(parsed.key, item.key);
    assert.equal(parsed.version, item.version);
  }
  assert.deepEqual(publicCatalog.aliases, [{ key: "example.web-app", target: "software.web-application", deprecated: true, remove_after: "0.6.x" }]);
  assert.deepEqual(Object.fromEntries(publicCatalog.packages.map(item => [item.key, item.support_status])), {
    "software.web-application": "support-grade",
    "one-c.development": "support-grade",
    "game.web": "preview",
    "game.unity": "preview",
    "data.analytics": "preview",
    "infra.operations": "preview",
    "marketing.content-operations": "preview"
  });
});

test("the canonical Web package is SDK-composed and requires anchored API-to-UI transitions", () => {
  const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === "software.web-application");
  assert.ok(packageValue);
  for (const workType of ["implementation", "data_change", "release", "incident", "access_management", "project_bootstrap", "documentation", "security_review"]) assert.equal(packageValue.routes.some(item => item.work_type_key === workType), true, workType);
  assert.deepEqual(packageValue.roles.map(item => item.key).sort(), ["access_administrator", "adversarial_reviewer", "classifier", "coordinator", "editor", "evidence_reviewer", "judge", "release_operator", "researcher", "reviewer", "strategy_reviewer", "worker"]);
  assert.equal(packageValue.documents.length, 0);
  assert.equal(packageValue.operational_levels.find(item => item.level === "prototype").improvement_strategy, "gauntlet");
  assert.equal(packageValue.operational_levels.find(item => item.level === "prototype").correction_limit, 3);
  assert.equal(packageValue.operational_levels.find(item => item.level === "prototype").budgets.calls, 12);
  assert.equal(packageValue.operational_levels.find(item => item.level === "mvp").improvement_strategy, "gauntlet");
  const flow = packageValue.evidence_flows.find(item => item.key === "typescript.api_to_ui");
  assert.deepEqual(flow.required_edges, ["producer->api", "api->client_mapping", "client_mapping->state_model", "state_model->ui_consumer"]);
  assert.deepEqual(flow.transition, { adapter: "typescript-compiler", method: "assignment_continuity" });
});

test("an installation catalog is generated and checked from its named definitions", () => {
  const installation = temporaryRoot("workflow-installation-packages-");
  const definitionsFile = path.join(installation, "definitions.mjs");
  const packageValue = structuredClone(PACKAGE_DEFINITIONS[0]);
  fs.writeFileSync(definitionsFile, `export default () => (${JSON.stringify({ packages: [packageValue], bundles: [] })});\n`, "utf8");
  const generator = path.resolve(packagesRoot, "..", "scripts", "generate-packages.mjs");
  const run = (...args) => spawnSync(process.execPath, [generator, ...args, "--definitions", definitionsFile], { encoding: "utf8" });

  const generated = run();
  assert.equal(generated.status, 0, generated.stderr);
  const catalogFile = path.join(installation, "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  assert.deepEqual(catalog.packages.map(item => ({ key: item.key, version: item.version })), [{ key: packageValue.key, version: packageValue.version }]);
  assert.equal(parseWorkflowPackage(fs.readFileSync(path.join(installation, catalog.packages[0].file), "utf8")).version, packageValue.version);
  assert.equal(run("--check").status, 0);

  catalog.packages[0].version = "0.0.0-stale";
  fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const stale = run("--check");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /INSTALLATION_PACKAGE_CATALOG_STALE/);
  fs.rmSync(installation, { recursive: true, force: true });
});

test("the public classifier vocabulary has an explicit 1C domain and seven routes", () => {
  const catalogs = JSON.parse(fs.readFileSync(path.resolve(packagesRoot, "..", "..", "configs", "catalogs.json"), "utf8"));
  assert.equal(catalogs.domains.includes("one-c"), true);
  assert.equal(catalogs.disciplines.includes("one-c-development"), true);
  assert.equal(catalogs.work_types.filter(item => item.startsWith("one-c.")).length, 7);
});

test("the support-grade 1C package exposes exactly the seven domain routes and a portable evidence contract", () => {
  const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === "one-c.development");
  assert.ok(packageValue);
  assert.deepEqual(packageValue.routes.filter(item => item.work_type_key.startsWith("one-c.")).map(item => item.work_type_key).sort(), [
    "one-c.change",
    "one-c.diagnosis",
    "one-c.functional-test",
    "one-c.integration",
    "one-c.module-build",
    "one-c.release",
    "one-c.resume"
  ]);
  const bsl = packageValue.checks.find(item => item.key === "bsl_language_server");
  assert.deepEqual({ kind: bsl.kind, runner: bsl.runner, reason: bsl.config.reason }, {
    kind: "disabled",
    runner: "requires_local_bsl_language_server",
    reason: "requires_local_bsl_binding"
  });
  const flow = packageValue.evidence_flows.find(item => item.key === "bsl.source_to_ui");
  assert.deepEqual(flow.required_edges, ["source->calculation", "calculation->structure_attribute", "structure_attribute->form_report"]);
  assert.equal(flow.transition.adapter, "bsl-structural");
});

test("the Unity preview keeps technical evidence and owner acceptance independent", () => {
  const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === "game.unity");
  assert.ok(packageValue);
  assert.match(packageValue.purpose, /Executable preview/);
  assert.deepEqual(packageValue.routes.filter(item => item.work_type_key.startsWith("game.")).map(item => item.work_type_key).sort(), [
    "game.build-test",
    "game.change",
    "game.design-research",
    "game.pipeline-audit",
    "game.product-acceptance",
    "game.release-readiness",
    "game.technical-qa",
    "game.visual-acceptance"
  ]);
  for (const key of ["unity_csharp_boundary", "unity_batch", "unity_checkpoint"]) {
    const check = packageValue.checks.find(item => item.key === key);
    assert.equal(check.kind, "disabled");
    assert.match(check.config.reason, /^requires_local_/);
  }
  const flow = packageValue.evidence_flows.find(item => item.key === "csharp.state_to_runtime_consumer");
  assert.deepEqual(flow.required_edges, ["producer->state_model", "state_model->runtime_consumer"]);
  assert.deepEqual(flow.transition, { adapter: "csharp-ls", method: "semantic_reference_or_verified_call" });
  const acceptance = packageValue.workflows.find(item => item.key.endsWith(".acceptance"));
  assert.deepEqual(packageValue.resources, [{ alias: "unity.project", kind: "project.worktree", purpose: "Explicit single-machine Unity project runtime boundary" }]);
  assert.deepEqual(packageValue.workflows.find(item => item.key.endsWith(".runtime")).steps.find(item => item.key === "verify").resources, [{ alias: "unity.project", mode: "exclusive" }]);
  assert.equal(acceptance.steps.at(-1).key, "owner_acceptance");
  assert.equal(acceptance.steps.at(-1).role_key, null);
  assert.equal(acceptance.steps.at(-1).irreversible, true);
});

test("the Web-game preview traces design to browser proof without folding product acceptance into code review", () => {
  const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === "game.web");
  assert.ok(packageValue);
  assert.match(packageValue.purpose, /Executable preview/);
  for (const workType of ["game.design-research", "game.change", "game.build-test", "game.technical-qa", "game.visual-acceptance", "game.product-acceptance", "game.release-readiness", "game.pipeline-audit", "content", "marketing"]) {
    assert.equal(packageValue.routes.some(item => item.work_type_key === workType), true, workType);
  }
  assert.deepEqual(packageValue.roles.map(item => item.key).sort(), ["adversarial_reviewer", "classifier", "coordinator", "editor", "evidence_reviewer", "judge", "researcher", "reviewer", "strategy_reviewer", "worker"]);
  assert.equal(packageValue.documents.length, 0);
  const flow = packageValue.evidence_flows.find(item => item.key === "game.feature_to_browser_proof");
  assert.deepEqual(flow.required_edges, ["design_decision->technical_task", "technical_task->browser_proof"]);
  assert.equal(flow.transition.adapter, "registered-browser-evidence");
  const content = packageValue.workflows.find(item => item.key.endsWith(".content"));
  assert.equal(content.steps.some(item => item.key === "edit" && item.role_key === "editor"), true);
});

test("browser assistance is optional for Web workers and other external runtimes do not inherit it", () => {
  const byKey = new Map(PACKAGE_DEFINITIONS.map(item => [item.key, item]));
  for (const key of ["software.web-application", "game.web"]) {
    const packageValue = byKey.get(key);
    const worker = packageValue.roles.find(item => item.key === "worker");
    assert.equal(packageValue.roles.some(item => item.key === "browser_worker"), false, key);
    assert.deepEqual(worker.contract.boundaries.optional_executor_capabilities, ["browser_automation", "screen_capture"]);
    assert.equal(worker.contract.boundaries.browser_execution, true);
    assert.equal(worker.contract.boundaries.screen_capture, true);
    const required = [...packageValue.profiles.find(item => item.role_key === "worker").capabilities].sort();
    assert.equal(required.includes("browser_automation"), false, key);
    assert.equal(required.includes("screen_capture"), false, key);
    assert.equal(required.includes("context_input"), true, key);
    assert.equal(required.includes("project_write"), true, key);
    assert.equal(packageValue.workflows.find(item => item.key.endsWith(".change")).steps.find(item => item.key === "work").role_key, "worker");
    assert.equal(packageValue.workflows.find(item => item.key.endsWith(".runtime")).steps.find(item => item.key === "verify").role_key, "worker");
  }
  for (const key of ["one-c.development", "game.unity", "data.analytics", "infra.operations"]) {
    const packageValue = byKey.get(key);
    assert.equal(packageValue.roles.some(item => item.key === "browser_worker"), false, key);
    const worker = packageValue.roles.find(item => item.key === "worker");
    assert.equal(worker.contract.boundaries.browser_execution, false, key);
    assert.equal(worker.contract.boundaries.screen_capture, false, key);
    assert.equal("optional_executor_capabilities" in worker.contract.boundaries, false, key);
    assert.equal(packageValue.workflows.find(item => item.key.endsWith(".runtime")).steps.find(item => item.key === "verify").role_key, "worker", key);
  }
});

test("the data preview separates read-only evidence from approval-bound mutation preparation", () => {
  const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === "data.analytics");
  assert.ok(packageValue);
  for (const workType of ["data.discovery", "data.verification", "data_change"]) assert.equal(packageValue.routes.some(item => item.work_type_key === workType), true, workType);
  assert.deepEqual(packageValue.resources, [{ alias: "data.primary", kind: "db", purpose: "Registered database or isolated analytical copy" }]);
  assert.deepEqual(packageValue.workflows.find(item => item.key.endsWith(".runtime")).steps.find(item => item.key === "verify").resources, [{ alias: "data.primary", mode: "shared" }]);
  const change = packageValue.workflows.find(item => item.key.endsWith(".data"));
  assert.deepEqual(change.steps.find(item => item.key === "prepare").resources, [{ alias: "data.primary", mode: "exclusive" }]);
  assert.equal(change.steps.at(-1).key, "apply_approval");
  assert.equal(change.steps.at(-1).role_key, null);
  const flow = packageValue.evidence_flows.find(item => item.key === "data.query_to_invariant");
  assert.deepEqual(flow.required_edges, ["query_definition->isolated_execution", "isolated_execution->invariant_result"]);
});

test("the infrastructure preview has a two-step read-only route and approval-bound risky routes", () => {
  const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === "infra.operations");
  assert.ok(packageValue);
  for (const workType of ["infra.inventory", "infra.backup-restore", "incident", "access_management", "release", "deployment", "implementation", "fix"]) assert.equal(packageValue.routes.some(item => item.work_type_key === workType), true, workType);
  assert.deepEqual(packageValue.roles.map(item => item.key).sort(), ["access_administrator", "adversarial_reviewer", "classifier", "coordinator", "evidence_reviewer", "judge", "release_operator", "researcher", "reviewer", "strategy_reviewer", "worker"]);
  assert.equal(packageValue.documents.length, 0);
  assert.deepEqual(packageValue.workflows.find(item => item.key.endsWith(".runtime")).steps.map(item => item.key), ["coordinate", "verify", "review"]);
  const restore = packageValue.workflows.find(item => item.key.endsWith(".backup_restore"));
  assert.deepEqual(restore.steps.map(item => item.key), ["coordinate", "verify_backup", "restore_approval", "restore", "verify_health"]);
  assert.equal(restore.steps.findIndex(item => item.key === "restore_approval") < restore.steps.findIndex(item => item.key === "restore"), true);
  assert.equal(restore.steps.find(item => item.key === "restore_approval").role_key, null);
  const flow = packageValue.evidence_flows.find(item => item.key === "infra.change_to_health");
  assert.ok(flow);
  assert.deepEqual(flow.workflow_keys, ["infra_operations.backup_restore"]);
  assert.deepEqual(Object.fromEntries(flow.nodes.map(node => [node.key, node.step_keys])), {
    observed_state: ["verify_backup"],
    approved_action: ["restore_approval"],
    applied_action: ["restore"],
    health_result: ["verify_health"]
  });
  assert.deepEqual(flow.required_edges, ["observed_state->approved_action", "approved_action->applied_action", "applied_action->health_result"]);
});

test("the marketing preview leaves document selection to the owner and connects edited claims to measured execution", () => {
  const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === "marketing.content-operations");
  assert.ok(packageValue);
  assert.deepEqual(packageValue.roles.map(item => item.key).sort(), ["adversarial_reviewer", "classifier", "coordinator", "editor", "evidence_reviewer", "judge", "researcher", "reviewer", "strategy_reviewer", "worker"]);
  assert.deepEqual(packageValue.documents, []);
  assert.deepEqual(packageValue.workflows.find(item => item.key.endsWith(".content")).steps.map(item => item.key), ["coordinate", "produce", "review", "edit", "owner_acceptance"]);
  assert.deepEqual(packageValue.workflows.find(item => item.key.endsWith(".activity")).steps.map(item => item.key), ["coordinate", "schedule", "execution_approval", "execute", "measure"]);
  const flow = packageValue.evidence_flows.find(item => item.key === "marketing.claim_to_measured_activity");
  assert.deepEqual(flow.required_edges, ["claim->edited_content", "edited_content->scheduled_activity", "scheduled_activity->execution_receipt", "execution_receipt->measurement"]);
});

test("classification is routed by the model and every declared route reaches a declared workflow", () => {
  for (const packageValue of PACKAGE_DEFINITIONS) {
    const classifier = packageValue.roles.find(item => item.key === "classifier");
    const researcher = packageValue.roles.find(item => item.key === "researcher");
    assert.equal(classifier.contract.boundaries.keyword_routing, false);
    assert.equal(classifier.contract.result_schema_key, "classification.v1");
    assert.equal(researcher.contract.result_schema_key, "research.v1");
    assert.equal(researcher.contract.boundaries.writes, false);
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
    const writes = new Map(packageValue.roles.map(role => [role.key, role.contract.boundaries.writes === true]));
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

test("one project reuses versioned role contracts composed by multiple packages", () => {
  const root = temporaryRoot("workflow-composed-packages-"), dbFile = path.join(root, "packages.sqlite"), db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run("combined", "Combined", root, new Date().toISOString());
  db.close();
  for (const packageKey of ["game.unity", "game.web"]) {
    const proposalFile = path.join(root, `${packageKey}.json`);
    let packageFile = generatedFile(packageKey);
    if (packageKey === "game.web") {
      const value = parseWorkflowPackage(fs.readFileSync(packageFile, "utf8"));
      value.workflows = value.workflows.map(workflow => ({ ...workflow, name: `Web ${workflow.name}` }));
      packageFile = path.join(root, "game.web.xml");
      fs.writeFileSync(packageFile, serializeWorkflowPackage(value), "utf8");
    }
    proposeWorkflowImport(dbFile, packageFile, proposalFile, "combined");
    assert.equal(applyWorkflowImport(dbFile, proposalFile, "combined", { confirmedBy: "contract-test-owner" }).status, "applied");
  }
  const verified = openDb(dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM workflow_package_releases WHERE project_id='combined' AND status='active'").get().count, 2);
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM role_contracts WHERE project_id='combined' AND role_id='reviewer' AND version='3.4.1'").get().count, 1);
  assert.equal(verified.prepare(`SELECT COUNT(DISTINCT m.local_id) count FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id
    WHERE p.target_project_id='combined' AND m.entity_type='role_contract' AND m.semantic_key='reviewer'`).get().count, 1);
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
