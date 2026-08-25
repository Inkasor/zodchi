import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import { packageAcceptanceGates, simulateOneCCheckOutcome } from "../src/package-contracts.mjs";
import { applyWorkflowImport, parseWorkflowPackage, proposeWorkflowImport, serializeWorkflowPackage, validateWorkflowPackage } from "../src/workflow-package.mjs";
import { inspectWorkflowBundle, parseWorkflowBundle } from "../src/workflow-bundle.mjs";
import { PACKAGE_DEFINITIONS } from "../packages/definitions.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function temporaryRoot(prefix) { const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, prefix)); }

test("all twelve registered project packages are complete, generated and free of local identity", () => {
  assert.deepEqual(PACKAGE_DEFINITIONS.map(item => item.key), ["indie-studio.project-m", "indie-studio.project-r", "shared-map-engine.core", "shared-lore.canon", "one-c.development", "zodchi.product-development", "company-web.marketplaces-data", "company-web.dashboard", "company-web.photo-hub", "company-web.mapping-hub", "company-web.interior-hub", "company-operations.core"]);
  for (const packageValue of PACKAGE_DEFINITIONS) {
    validateWorkflowPackage(packageValue);
    const file = path.join(repositoryRoot, "packages", "generated", `${packageValue.key}.xml`), source = fs.readFileSync(file, "utf8");
    assert.equal(source, serializeWorkflowPackage(packageValue)); assert.equal(parseWorkflowPackage(source).key, packageValue.key);
    assert.equal(/[A-Za-z]:[\\/]/.test(source), false); assert.equal(source.includes("model_id"), false); assert.equal(source.includes("profile_id"), false); assert.equal(source.includes("api_key"), false);
    assert.equal(packageValue.roles.every(role => role.contract.purpose && role.contract.result_schema_key && role.contract.allowed_profile_keys.length), true);
    assert.equal(packageValue.workflows.every(workflow => workflow.steps.length && workflow.transitions.length === workflow.steps.length - 1), true);
  }
});

test("Zodchi develops from source, verifies the assembled release and keeps local data external", () => {
  const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === "zodchi.product-development");
  assert.deepEqual(packageValue.documents.map(item => item.path), ["README.md", "docs/ARCHITECTURE.md", "product.json", "CHANGELOG.md"]);
  assert.equal(packageValue.checks.find(item => item.key === "zodchi_static").bindings.some(item => item.quality_mode_key === "prototype"), true);
  assert.equal(packageValue.checks.find(item => item.key === "zodchi_tests").bindings.some(item => item.quality_mode_key === "mvp"), true);
  assert.equal(packageValue.checks.find(item => item.key === "zodchi_release_build").bindings.some(item => item.quality_mode_key === "production"), true);
  assert.equal(packageValue.purpose.includes("local data boundaries"), true);
});

test("company web packages use model classification, project checks and explicit human deployment approval", () => {
  const company = PACKAGE_DEFINITIONS.filter(item => item.key.startsWith("company-web.") || item.key === "company-operations.core");
  assert.equal(company.length, 6);
  for (const packageValue of company) {
    const classifier = packageValue.roles.find(item => item.key === "classifier");
    assert.equal(classifier.contract.boundaries.keyword_routing, false);
    assert.equal(packageValue.routes.some(item => item.work_type_key === "conversation"), true);
    assert.equal(packageValue.routes.some(item => item.work_type_key === "incident"), true);
    assert.equal(packageValue.routes.some(item => item.work_type_key === "deployment"), true);
    const release = packageValue.workflows.find(item => item.key.endsWith(".release"));
    const approval = release.steps.findIndex(item => item.key === "deployment_approval" && item.irreversible);
    const deploy = release.steps.findIndex(item => item.key === "deploy");
    assert.equal(approval >= 0 && deploy > approval, true);
    assert.equal(packageValue.test_scenarios.find(item => item.key === "deployment_approval").expected.keyword_trigger, false);
  }
  const marketplaces = PACKAGE_DEFINITIONS.find(item => item.key === "company-web.marketplaces-data");
  assert.deepEqual(marketplaces.documents.map(item => item.path), ["AGENTS.md", "docs/CURRENT_CHANGE.md", "docs/CURRENT_PRODUCTION.md", "docs/DEPLOYMENT.md", "package.json"]);
  assert.deepEqual(marketplaces.roles.find(item => item.key === "data_engineer").contract.boundaries, { live_data_writes: false, backup_required_before_apply: true });
  // Deployment evidence is only worth declaring if it can actually run: the three checks that answer
  // "did the release reach production" call registered project scripts instead of staying disabled.
  for (const key of ["marketplaces_ci", "marketplaces_deployed_revision", "marketplaces_public_health"]) {
    const check = marketplaces.checks.find(item => item.key === key);
    assert.equal(check.kind, "command");
    assert.equal(check.bindings.every(item => item.required), true);
  }
  assert.equal(marketplaces.checks.some(item => item.key === "marketplaces_health" && item.kind === "command"), true);
  // Live collection spends real API requests, so it is routed on its own and the owner approves the
  // exact identifiers after a measured dry run, not before it.
  const collection = marketplaces.workflows.find(item => item.key === "company_web_marketplaces_data.collection");
  assert.equal(collection.default_quality, "production");
  assert.deepEqual(collection.steps.map(item => item.key), ["plan", "dry_run", "review", "collection_approval", "collect", "verify", "document"]);
  assert.equal(collection.steps.find(item => item.key === "collection_approval").irreversible, true);
  assert.equal(collection.steps.findIndex(item => item.key === "dry_run") < collection.steps.findIndex(item => item.key === "collection_approval"), true);
  assert.equal(marketplaces.routes.some(item => item.work_type_key === "data_collection" && item.workflow_key === "company_web_marketplaces_data.collection"), true);
  assert.deepEqual(marketplaces.roles.find(item => item.key === "collection_operator").contract.boundaries, { write_requests: false, explicit_approval_required: true, unlisted_endpoints: false, credential_output: false });
  // A production incident is production work: the level it declares is also the floor a classifier
  // cannot drop below, and at mvp it would have carried a single required check.
  for (const key of ["company-web.marketplaces-data", "company-web.dashboard", "zodchi.product-development"]) {
    const incident = PACKAGE_DEFINITIONS.find(item => item.key === key).workflows.find(item => item.key.endsWith(".incident"));
    assert.equal(incident.default_quality, "production");
  }
  assert.equal(PACKAGE_DEFINITIONS.filter(item => item.routes.some(value => value.work_type_key === "data_collection")).length, 1);
  const operations = PACKAGE_DEFINITIONS.find(item => item.key === "company-operations.core");
  assert.equal(operations.checks.filter(item => item.kind === "disabled").every(item => item.config.reason.startsWith("requires_")), true);
  assert.equal(operations.checks.some(item => item.kind === "secret_scan"), true);
  assert.equal(operations.checks.filter(item => item.kind === "command" && ["gitleaks.exe", "osv-scanner.exe"].includes(item.config.command)).length, 2);
  for (const key of ["company-web.photo-hub", "company-web.mapping-hub", "company-web.interior-hub"]) assert.equal(PACKAGE_DEFINITIONS.find(item => item.key === key).routes.some(item => item.work_type_key === "content"), true);
});

test("company workflow bundle verifies all portable packages and keeps staged activation explicit", () => {
  const file = path.join(repositoryRoot, "packages", "generated", "company-workflows.xml");
  const result = inspectWorkflowBundle(file);
  assert.equal(result.status, "passed");
  assert.equal(result.packages.length, 6);
  assert.deepEqual(result.packages.filter(item => item.activation === "activate-first").map(item => item.key), ["company-web.marketplaces-data"]);
  assert.equal(result.packages.filter(item => item.activation === "prepare-only").length, 5);
  assert.throws(() => parseWorkflowBundle(fs.readFileSync(file, "utf8").replace('activation="prepare-only"', 'activation="automatic"')), /WORKFLOW_BUNDLE_PACKAGE_INVALID/);
});

test("Project M and Project R Indie Studio packages remain separate and owner gates remain explicit", () => {
  const projectM = PACKAGE_DEFINITIONS.find(item => item.key === "indie-studio.project-m"), projectR = PACKAGE_DEFINITIONS.find(item => item.key === "indie-studio.project-r");
  assert.equal(projectM.workflows.length, 10); assert.equal(projectR.workflows.length, 10);
  assert.equal(projectM.routes.every(item => item.workflow_key.startsWith("project_m.")), true); assert.equal(projectR.routes.every(item => item.workflow_key.startsWith("project_r.")), true);
  assert.equal(projectM.checks.some(item => item.key === "project_m_map_render"), true); assert.equal(projectR.checks.some(item => item.key === "project_r_map_engine"), true);
  assert.equal(projectM.documents.some(item => item.path === "AGENTS.md"), true); assert.equal(projectR.documents.some(item => item.path === "docs/GDD.md"), true);
  for (const packageValue of [projectM, projectR]) assert.deepEqual(packageAcceptanceGates(packageValue), { technical: "configured", gameplay: "owner", visual: "owner", product: "owner", publication: "owner" });
  assert.equal(projectM.test_scenarios.find(item => item.key === "visual_asset").expected.human_acceptance, "pending"); assert.equal(projectR.test_scenarios.find(item => item.key === "audio_asset").expected.human_acceptance, "pending");
});

test("production builds are not part of the MVP gate", () => {
  for (const [packageKey, buildKey] of [
    ["indie-studio.project-m", "project_m_build"],
    ["indie-studio.project-r", "project_r_build"],
    ["company-web.marketplaces-data", "marketplaces_build"],
    ["company-web.dashboard", "dashboard_build"]
  ]) {
    const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === packageKey);
    const build = packageValue.checks.find(item => item.key === buildKey);
    assert.deepEqual(build.bindings.map(item => [item.quality_mode_key, item.artifact_type_key]), [["production", "release_package"]]);
    assert.equal(packageValue.operational_levels.find(item => item.level === "mvp").required_check_keys.includes(buildKey), false);
    assert.equal(packageValue.operational_levels.find(item => item.level === "production").required_check_keys.includes(buildKey), true);
  }
});

test("SharedMapEngine and Lore preserve consumer, canon and human acceptance boundaries", () => {
  const engine = PACKAGE_DEFINITIONS.find(item => item.key === "shared-map-engine.core"), lore = PACKAGE_DEFINITIONS.find(item => item.key === "shared-lore.canon");
  assert.deepEqual(engine.roles.map(item => item.key), ["shared_engine_architect", "shared_engine_programmer", "shared_engine_tester", "shared_engine_reviewer", "documentator"]);
  assert.equal(engine.checks.filter(item => item.key.endsWith("compatibility")).every(item => item.kind === "project_command" && ["project-m", "project-r"].includes(item.config.project_id)), true);
  assert.equal(engine.roles.find(item => item.key === "shared_engine_programmer").contract.allowed_skills.includes("game-production:shared-map-engine"), true);
  assert.equal(lore.workflows[0].steps.some(item => item.key === "owner_decision" && item.irreversible), true); assert.equal(lore.roles.find(item => item.key === "lore_researcher").contract.boundaries.invent_facts, false);
  assert.deepEqual(packageAcceptanceGates(lore), { continuity: "configured_or_unavailable", canon: "owner", consumer_updates: "separate" });
  assert.equal(lore.version, "2.3.0");
  // The change card is written before the owner decides, so a candidate that never becomes canon
  // still leaves a record, and every level keeps the owner gate rather than only mvp.
  const change = lore.workflows.find(item => item.key === "shared-lore.change");
  assert.deepEqual(change.steps.map(item => item.key), ["research", "proposal", "continuity", "change_card", "owner_decision", "canon", "consumer_proposals"]);
  assert.equal(change.steps.findIndex(item => item.key === "change_card") < change.steps.findIndex(item => item.key === "owner_decision"), true);
  assert.deepEqual(change.questions.map(item => item.key), ["shared_fact", "source_sha", "candidate_scope", "project_impact"]);
  assert.equal(change.questions.every(item => item.required), true);
  assert.equal(lore.documents.some(item => item.path === "docs/decisions" && item.bindings.some(binding => binding.role_key === "lore_documentator" && binding.write)), true);
  assert.equal(lore.operational_levels.every(item => item.escalation.owner_canon_decision_required === true), true);
  assert.deepEqual(lore.operational_levels.map(item => item.level).sort(), ["mvp", "production", "prototype", "security-audit"]);
});

test("1C package uses the existing skill allowlist and requires an explicit local BSL binding", () => {
  const packageValue = PACKAGE_DEFINITIONS.find(item => item.key === "one-c.development"), developer = packageValue.roles.find(item => item.key === "one_c_developer"), bsl = packageValue.checks.find(item => item.key === "bsl_language_server");
  assert.deepEqual(packageValue.roles.map(item => item.key), ["one_c_analyst", "one_c_developer", "one_c_tester", "one_c_reviewer", "one_c_documentator"]);
  for (const skill of ["advertising-project-context", "advertising-workflow", "epf-build", "epf-validate", "form-info", "form-edit", "form-validate", "cfe-diff", "cfe-patch-method", "cfe-validate"]) assert.equal(developer.contract.allowed_skills.includes(skill), true, skill);
  assert.equal(packageValue.version, "2.3.0"); assert.equal(bsl.kind, "disabled"); assert.equal(bsl.config.reason, "requires_local_bsl_binding"); assert.equal(packageValue.checks.some(item => item.key === "one_c_source_structure"), false); assert.equal(packageValue.checks.some(item => item.config.command === "npm.cmd" || item.config.command === "node" || item.config.command === "pnpm.cmd"), false);
  assert.equal(packageValue.workflows[0].questions.length, 4); assert.deepEqual(packageAcceptanceGates(packageValue), { source: "configured_or_unavailable", build: "separate", runtime: "separate", business: "owner", user: "owner" });
  assert.deepEqual(simulateOneCCheckOutcome(packageValue, "passed"), { classification: "implementation", route: "one-c.change", gate_status: "passed", state: "approval_required", human_response: "Technical checks passed; runtime and user acceptance remain separate.", source_acceptance: "passed", build_acceptance: "not_run", runtime_acceptance: "not_run", user_acceptance: "pending" });
  assert.equal(simulateOneCCheckOutcome(packageValue, "failed").state, "changes_requested"); assert.equal(simulateOneCCheckOutcome(packageValue, "timed_out").state, "blocked"); assert.match(simulateOneCCheckOutcome(packageValue, "unavailable").human_response, /requires_local_bsl_binding/);
});

test("every generated package imports transactionally into a clean local project registry", () => {
  const root = temporaryRoot("workflow-project-packages-"), dbFile = path.join(root, "packages.sqlite"), db = openDb(dbFile);
  for (const packageValue of PACKAGE_DEFINITIONS) db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(packageValue.key, packageValue.key, path.join(root, packageValue.key), new Date().toISOString()); db.close();
  for (const packageValue of PACKAGE_DEFINITIONS) {
    const packageFile = path.join(repositoryRoot, "packages", "generated", `${packageValue.key}.xml`), proposalFile = path.join(root, `${packageValue.key}.proposal.json`), proposal = proposeWorkflowImport(dbFile, packageFile, proposalFile, packageValue.key);
    assert.equal(proposal.status, "pending"); assert.equal(applyWorkflowImport(dbFile, proposalFile, packageValue.key, { confirmedBy: "contract-test-owner" }).status, "applied");
  }
  const verified = openDb(dbFile); assert.equal(verified.prepare("SELECT COUNT(*) count FROM workflow_package_releases WHERE status='active'").get().count, 12); assert.equal(verified.prepare("SELECT COUNT(*) count FROM workflows").get().count, 102); assert.equal(verified.prepare("SELECT kind,config_json FROM check_definitions d JOIN project_checks pc ON pc.check_id=d.id WHERE pc.project_id='one-c.development' AND d.name='BSL Language Server diagnostics'").get().kind, "disabled"); verified.close();
  fs.rmSync(root, { recursive: true, force: true });
});
