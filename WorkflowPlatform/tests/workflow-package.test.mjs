import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db.mjs";
import { onboardProject } from "../src/onboarding.mjs";
import { exportWorkflowPackage, inspectWorkflowPackage, parseWorkflowPackage, serializeWorkflowPackage, proposeWorkflowImport, proposeWorkflowMigration, applyWorkflowImport, validateWorkflowPackage } from "../src/workflow-package.mjs";
import { createExperienceProposal, evaluateExperienceProposal, applyExperienceProposal, recordExperienceObservation } from "../src/experience.mjs";
import { structuredHash } from "../src/role-contracts.mjs";
import { registerProjectResource } from "../src/project-resources.mjs";

function temporaryRoot(prefix) { const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, prefix)); }
const promptHash = text => `sha256:${structuredHash(text)}`;

function roleContract(role, schema, artifactTypes, checks = []) {
  return { id: `contract.${role}`, role_id: role, version: "1.0.0", purpose: `${role} contract`, boundaries: { edits: role === "worker" }, allowed_work_types: ["implementation"], allowed_artifact_types: artifactTypes, allowed_tools: role === "worker" ? ["apply_patch"] : [], allowed_skills: [], required_checks: checks, allowed_transitions: ["executing", "verifying"], allowed_profiles: ["*"], context_limit_bytes: 16000, max_calls: 2, max_correction_cycles: 1, timeout_seconds: 300, result_schema_key: schema, prompt_template_version: "1.0.0", escalation: { after_failures: 1 } };
}

function seedSource(root) {
  const dbFile = path.join(root, "source.sqlite"), projectRoot = path.join(root, "source-project"), template = "Return the registered structured result only.";
  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true }); fs.writeFileSync(path.join(projectRoot, "docs", "Current.md"), "<document id=\"current\"></document>\n", "utf8");
  onboardProject(dbFile, {
    project: { id: "source", name: "Source package", root_path: projectRoot }, workflow: { id: "main", name: "Main", package_key: "demo.package", package_version: "1.0.0", default_quality: "mvp", default_level: "L2", discovery: { git: false } },
    resources: [{ alias: "runtime.ib", kind: "1c.server", purpose: "Isolated test information base", declaration: { server: "test-host:1541", infobase: "test" } }],
    domains: [{ id: "software", name: "Software" }], disciplines: [{ id: "software", name: "Software" }],
    work_types: [{ id: "implementation", name: "Implementation", category: "work" }], quality_modes: [{ id: "prototype", name: "Prototype", ordinal: 0 }, { id: "mvp", name: "MVP", ordinal: 1 }, { id: "production", name: "Production", ordinal: 2 }, { id: "security", name: "Security audit", ordinal: 3 }], planning_levels: [{ id: "L2", name: "L2", ordinal: 2 }], artifact_types: [{ id: "code", name: "Code", category: "code" }, { id: "document", name: "Document", category: "document" }],
    roles: ["planner", "worker", "reviewer", "documentator"].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
    profiles: [{ id: "local-model-profile", provider: "codex", name: "Local model profile", role_id: "worker" }], role_assignments: [{ role_id: "worker", profile_id: "local-model-profile", operational_level: "mvp" }],
    profile_requirements: [{ key: "worker.mvp", role_id: "worker", provider_family: "codex", capabilities: ["code"], operational_levels: ["mvp"] }],
    checks: [{ id: "check.green", name: "Green", runner: "fixture", kind: "fixture", config: { status: "passed" }, timeout_seconds: 10 }], project_checks: ["prototype", "mvp", "production", "security"].map(quality_mode_id => ({ check_id: "check.green", quality_mode_id, artifact_type_id: "code", required: true })),
    documents: [{ id: "doc.current", path: "docs/Current.md", document_type: "authority", authority: "owner", status: "active" }], role_documents: [{ role_id: "documentator", document_id: "doc.current", read_access: true, write_access: true, purpose: "accepted state", priority: 1 }],
    routes: [{ work_type_id: "implementation", workflow_id: "main", enabled: true, priority: 10 }],
    role_contracts: [roleContract("planner", "planner.v1", ["code", "document"], ["check.green"]), roleContract("worker", "worker.v1", ["code"], ["check.green"]), roleContract("reviewer", "reviewer.v1", ["code"], ["check.green"]), roleContract("documentator", "documentator.v1", ["document"])],
    workflow_steps: [
      { key: "plan", ordinal: 1, role_id: "planner", input_schema_key: "request.v1", output_schema_key: "planner.v1", artifact_type_keys: [], check_keys: [] },
      { key: "implement", ordinal: 2, role_id: "worker", input_schema_key: "package.v1", output_schema_key: "worker.v1", artifact_type_keys: ["code"], check_keys: ["check.green"], resources: [{ alias: "runtime.ib", mode: "shared" }], correction: { max: 1 } },
      { key: "review", ordinal: 3, role_id: "reviewer", input_schema_key: "review-input.v1", output_schema_key: "reviewer.v1", artifact_type_keys: ["code"], check_keys: ["check.green"] },
      { key: "document", ordinal: 4, role_id: "documentator", input_schema_key: "document-input.v1", output_schema_key: "documentator.v1", artifact_type_keys: ["document"], check_keys: [] }
    ], workflow_transitions: [{ from: "plan", to: "implement", condition: { outcome: "planned" } }, { from: "implement", to: "review", condition: { gates: "passed" } }, { from: "review", to: "document", condition: { decision: "PASS" } }],
    workflow_questions: [{ key: "scope", phase: "planning", prompt: "Какие границы пакета?", answer_schema: { type: "string" }, required: true }],
    operational_levels: [
      { level: "prototype", improvement_strategy: "standard", budgets: { calls: 4, duration_ms: 600000, correction_cycles: 0, cost_usd: 0.5 }, required_check_keys: ["check.green"], correction_limit: 0, escalation: {} },
      { level: "mvp", improvement_strategy: "standard", budgets: { calls: 12, duration_ms: 3600000, correction_cycles: 1, cost_usd: 2 }, required_check_keys: ["check.green"], correction_limit: 1, escalation: { reviewer: true } },
      { level: "production", improvement_strategy: "standard", budgets: { calls: 18, duration_ms: 7200000, correction_cycles: 1, cost_usd: 8 }, required_check_keys: ["check.green"], correction_limit: 1, escalation: { reviewer: true } },
      { level: "security-audit", improvement_strategy: "standard", budgets: { calls: 8, duration_ms: 3600000, correction_cycles: 0, cost_usd: 4 }, required_check_keys: ["check.green"], correction_limit: 0, escalation: { reviewer: true } }
    ],
    prompt_templates: [{ id: "prompt.worker", key: "worker.default", version: "1.0.0", role_id: "worker", result_schema_key: "worker.v1", template, content_hash: promptHash(template) }],
    test_scenarios: [{ id: "scenario.basic", key: "basic", package_version: "1.0.0", input: { work_type: "implementation", artifact_type: "code" }, expected: { final_state: "completed", gates: "passed" }, anonymized: true }],
    package_release: { id: "release.demo.1", key: "demo.package", version: "1.0.0", purpose: "Portable implementation workflow", prompt_builder_version: "1.0.0", manifest_hash: "sha256:source" }
  });
  return dbFile;
}

function seedTarget(root, name = "target") { const dbFile = path.join(root, `${name}.sqlite`), db = openDb(dbFile); db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(name, `Target ${name}`, path.join(root, name), new Date().toISOString()); db.close(); return dbFile; }

test("limited package grammar rejects declarations, unknown envelope fields and entities", () => {
  assert.throws(() => parseWorkflowPackage("<!DOCTYPE x><workflow_package></workflow_package>"), /DECLARATION_FORBIDDEN/);
  assert.throws(() => parseWorkflowPackage("<workflow_package key=\"a\" version=\"1.0.0\" schema_version=\"1\" extra=\"x\"><purpose>x</purpose><payload format=\"application\/json\">{}</payload></workflow_package>"), /ATTRIBUTES_INVALID/);
  assert.throws(() => parseWorkflowPackage("<workflow_package key=\"a\" version=\"1.0.0\" schema_version=\"1\"><purpose>&boom;</purpose><payload format=\"application\/json\">{}</payload></workflow_package>"), /ENTITY_FORBIDDEN/);
});

test("legacy packages fail with an explicit migration requirement", () => {
  assert.throws(() => validateWorkflowPackage({ schema_version: 1 }), /WORKFLOW_PACKAGE_SCHEMA_MIGRATION_REQUIRED: schema_version 1 -> 4/);
  assert.throws(() => validateWorkflowPackage({ schema_version: 2 }), /WORKFLOW_PACKAGE_SCHEMA_MIGRATION_REQUIRED: schema_version 2 -> 4/);
  assert.throws(() => validateWorkflowPackage({ schema_version: 3 }), /WORKFLOW_PACKAGE_SCHEMA_MIGRATION_REQUIRED: schema_version 3 -> 4/);
  assert.throws(() => parseWorkflowPackage('<workflow_package key="tj-analyzer.desktop-software" version="1.0.0" schema_version="1"><purpose>Legacy private package contract fixture</purpose><payload format="application/json">{&quot;schema_version&quot;:1}</payload></workflow_package>'), /WORKFLOW_PACKAGE_SCHEMA_MIGRATION_REQUIRED: schema_version 1 -> 4/);
  assert.throws(() => parseWorkflowPackage('<workflow_package key="tj-analyzer.desktop-software" version="1.0.0" schema_version="2"><purpose>Legacy private package contract fixture</purpose><payload format="application/json">{&quot;schema_version&quot;:2}</payload></workflow_package>'), /WORKFLOW_PACKAGE_SCHEMA_MIGRATION_REQUIRED: schema_version 2 -> 4/);
});

test("complete package exports deterministically without local profile or model identifiers", () => {
  const root = temporaryRoot("workflow-package-export-"), dbFile = seedSource(root), first = path.join(root, "first.xml"), second = path.join(root, "second.xml");
  const one = exportWorkflowPackage(dbFile, first, "source", "demo.package"), two = exportWorkflowPackage(dbFile, second, "source", "demo.package");
  assert.equal(one.package_hash, two.package_hash); assert.equal(fs.readFileSync(first, "utf8"), fs.readFileSync(second, "utf8"));
  const lint = inspectWorkflowPackage(first); assert.equal(lint.status, "passed"); assert.equal(lint.package.schema_version, 4); assert.equal(lint.package.workflows[0].steps.length, 4); assert.equal(lint.package.workflows[0].questions.length, 1); assert.equal("history_budget_bytes" in lint.package.workflows[0], false); assert.equal(lint.package.state_machine.step_states.includes("changes_requested"), true); assert.equal(lint.package.test_scenarios[0].anonymized, true);
  assert.deepEqual(lint.package.resources, [{ alias: "runtime.ib", kind: "1c.server", purpose: "Isolated test information base" }]);
  assert.deepEqual(lint.package.workflows[0].steps.find(step => step.key === "implement").resources, [{ alias: "runtime.ib", mode: "shared" }]);
  assert.deepEqual(lint.package.catalogs.domains.map(item => item.key), ["software"]);
  const source = fs.readFileSync(first, "utf8"); assert.equal(source.includes("local-model-profile"), false); assert.equal(source.includes("model_id"), false);
  const unknownTool = structuredClone(lint.package); unknownTool.roles[0].contract.allowed_tools = ["future_unregistered_tool"];
  assert.throws(() => validateWorkflowPackage(unknownTool), /unknown allowed tool future_unregistered_tool/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test("import is proposal-first, hash-bound, confirmed and recreates local technical IDs", () => {
  const root = temporaryRoot("workflow-package-import-"), sourceDb = seedSource(root), targetDb = seedTarget(root), packageFile = path.join(root, "package.xml"), proposalFile = path.join(root, "proposal.json"), roundtrip = path.join(root, "roundtrip.xml");
  let db = openDb(targetDb); registerProjectResource(db, { projectId: "target", alias: "runtime.ib", kind: "1c.server", purpose: "Local target binding", declaration: { server: "local-host:1541", infobase: "acceptance" } }); db.close();
  const exported = exportWorkflowPackage(sourceDb, packageFile, "source", "demo.package"), proposal = proposeWorkflowImport(targetDb, packageFile, proposalFile, "target");
  db = openDb(targetDb); assert.equal(db.prepare("SELECT COUNT(*) count FROM workflows WHERE package_key='demo.package'").get().count, 0); assert.equal(db.prepare("SELECT status FROM workflow_import_proposals WHERE id=?").get(proposal.id).status, "pending"); db.close();
  assert.throws(() => applyWorkflowImport(targetDb, proposalFile, "target"), /CONFIRMATION_REQUIRED/);
  const applied = applyWorkflowImport(targetDb, proposalFile, "target", { confirmedBy: "owner" }); assert.equal(applied.status, "applied");
  db = openDb(targetDb); const mapping = db.prepare("SELECT semantic_key,local_id FROM package_import_mappings WHERE proposal_id=? AND entity_type='workflow'").get(proposal.id); assert.equal(mapping.semantic_key, "main"); assert.notEqual(mapping.local_id, "main"); assert.equal(db.prepare("SELECT status FROM workflow_package_releases WHERE project_id='target' AND package_key='demo.package'").get().status, "active"); assert.deepEqual(JSON.parse(db.prepare("SELECT declaration_json FROM project_resources WHERE project_id='target' AND alias='runtime.ib'").get().declaration_json), { kind: "1c.server", server: "local-host:1541", infobase: "acceptance" }); db.close();
  const exportedAgain = exportWorkflowPackage(targetDb, roundtrip, "target", "demo.package"); assert.equal(exportedAgain.package_hash, exported.package_hash);
  const repeated = proposeWorkflowImport(targetDb, roundtrip, path.join(root, "repeat.json"), "target"); assert.equal(repeated.status, "no_changes"); assert.equal(fs.existsSync(path.join(root, "repeat.json")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("package upgrade removes bindings for checks no longer declared by that package", () => {
  const root = temporaryRoot("workflow-package-removed-check-"), sourceDb = seedSource(root), targetDb = seedTarget(root), firstPackage = path.join(root, "first.xml"), firstProposal = path.join(root, "first-proposal.json");
  let db = openDb(sourceDb); db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES('check.retired','Retired','fixture','fixture','{\"status\":\"passed\"}',10)").run(); db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES('source','check.retired','mvp',1,'code')").run(); db.close();
  exportWorkflowPackage(sourceDb, firstPackage, "source", "demo.package"); proposeWorkflowImport(targetDb, firstPackage, firstProposal, "target"); applyWorkflowImport(targetDb, firstProposal, "target", { confirmedBy: "owner" });
  db = openDb(targetDb); const importedCheck = db.prepare("SELECT local_id FROM package_import_mappings WHERE proposal_id=(SELECT id FROM workflow_import_proposals WHERE target_project_id='target' AND package_key='demo.package' AND status='applied' ORDER BY applied_at DESC LIMIT 1) AND entity_type='check' AND semantic_key='check.retired'").get().local_id; assert.equal(db.prepare("SELECT COUNT(*) count FROM project_checks WHERE project_id='target' AND check_id=?").get(importedCheck).count, 1); db.close();
  db = openDb(sourceDb); db.prepare("DELETE FROM project_checks WHERE project_id='source' AND check_id='check.retired'").run(); db.prepare("UPDATE workflow_package_releases SET version='1.0.1' WHERE project_id='source' AND package_key='demo.package' AND status='active'").run(); db.close();
  const secondPackage = path.join(root, "second.xml"), secondProposal = path.join(root, "second-proposal.json"); exportWorkflowPackage(sourceDb, secondPackage, "source", "demo.package"); proposeWorkflowImport(targetDb, secondPackage, secondProposal, "target"); applyWorkflowImport(targetDb, secondProposal, "target", { confirmedBy: "owner" });
  db = openDb(targetDb); assert.equal(db.prepare("SELECT COUNT(*) count FROM project_checks WHERE project_id='target' AND check_id=?").get(importedCheck).count, 0); db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("package upgrade preserves a machine-local runner bound to a disabled portable check", () => {
  const root = temporaryRoot("workflow-package-local-check-"), sourceDb = seedSource(root), targetDb = seedTarget(root);
  const firstPackage = path.join(root, "first.xml"), firstProposal = path.join(root, "first.json");
  exportWorkflowPackage(sourceDb, firstPackage, "source", "demo.package");
  const first = proposeWorkflowImport(targetDb, firstPackage, firstProposal, "target");
  applyWorkflowImport(targetDb, firstProposal, "target", { confirmedBy: "owner" });
  let db = openDb(targetDb);
  const checkId = db.prepare("SELECT local_id FROM package_import_mappings WHERE proposal_id=? AND entity_type='check' AND semantic_key='check.green'").get(first.id).local_id;
  const localConfig = stableLocalConfig(root);
  db.prepare("UPDATE check_definitions SET name='Local BSL LS',runner='one_c_bsl_policy',kind='command',config_json=?,timeout_seconds=1800 WHERE id=?").run(JSON.stringify(localConfig), checkId);
  db.close();

  db = openDb(sourceDb);
  db.prepare("UPDATE check_definitions SET name='Portable BSL hook',runner='bsl_language_server',kind='disabled',config_json=?,timeout_seconds=30 WHERE id='check.green'").run(JSON.stringify({ reason: "requires_local_bsl_binding" }));
  db.prepare("UPDATE workflow_package_releases SET version='1.0.1' WHERE project_id='source' AND package_key='demo.package' AND status='active'").run();
  db.close();
  const secondPackage = path.join(root, "second.xml"), secondProposal = path.join(root, "second.json");
  exportWorkflowPackage(sourceDb, secondPackage, "source", "demo.package");
  proposeWorkflowImport(targetDb, secondPackage, secondProposal, "target");
  applyWorkflowImport(targetDb, secondProposal, "target", { confirmedBy: "owner" });

  db = openDb(targetDb);
  const definition = db.prepare("SELECT name,runner,kind,config_json,timeout_seconds FROM check_definitions WHERE id=?").get(checkId);
  assert.deepEqual({ ...definition, config_json: JSON.parse(definition.config_json) }, { name: "Local BSL LS", runner: "one_c_bsl_policy", kind: "command", config_json: localConfig, timeout_seconds: 1800 });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM project_checks WHERE project_id='target' AND check_id=? AND required=1").get(checkId).count, 4);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an explicit package-key migration reuses local entities and retires the old router atomically", () => {
  const root = temporaryRoot("workflow-package-key-migration-"), sourceDb = seedSource(root), targetDb = seedTarget(root);
  const oldPackage = path.join(root, "old.xml"), oldProposal = path.join(root, "old.json");
  exportWorkflowPackage(sourceDb, oldPackage, "source", "demo.package");
  const imported = proposeWorkflowImport(targetDb, oldPackage, oldProposal, "target");
  applyWorkflowImport(targetDb, oldProposal, "target", { confirmedBy: "owner" });
  let db = openDb(targetDb);
  const oldWorkflowId = db.prepare("SELECT local_id FROM package_import_mappings WHERE proposal_id=? AND entity_type='workflow' AND semantic_key='main'").get(imported.id).local_id;
  db.close();

  const successor = parseWorkflowPackage(fs.readFileSync(oldPackage, "utf8"));
  successor.key = "demo.successor"; successor.version = "2.0.0"; successor.purpose = "Canonical successor package";
  const successorFile = path.join(root, "successor.xml"), migrationFile = path.join(root, "migration.json");
  fs.writeFileSync(successorFile, serializeWorkflowPackage(successor), "utf8");
  const proposal = proposeWorkflowMigration(targetDb, successorFile, migrationFile, "target", "demo.package");
  assert.deepEqual(proposal.diff.migration, { from: "demo.package", to: "demo.successor" });
  assert.throws(() => applyWorkflowImport(targetDb, migrationFile, "target"), /CONFIRMATION_REQUIRED/);
  applyWorkflowImport(targetDb, migrationFile, "target", { confirmedBy: "owner" });

  db = openDb(targetDb);
  assert.equal(db.prepare("SELECT status FROM workflow_package_releases WHERE project_id='target' AND package_key='demo.package'").get().status, "superseded");
  assert.equal(db.prepare("SELECT status FROM workflow_package_releases WHERE project_id='target' AND package_key='demo.successor'").get().status, "active");
  assert.deepEqual({ ...db.prepare("SELECT id,package_key,status FROM workflows WHERE id=?").get(oldWorkflowId) }, { id: oldWorkflowId, package_key: "demo.successor", status: "active" });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM workflow_routes r JOIN workflows w ON w.id=r.workflow_id WHERE r.project_id='target' AND w.package_key='demo.package'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM portable_profile_requirements WHERE project_id='target' AND package_key='demo.package'").get().count, 0);
  db.close();

  const upgraded = { ...successor, version: "2.1.0", purpose: "Canonical successor package, upgraded" };
  const upgradedFile = path.join(root, "successor-upgraded.xml"), upgradedProposal = path.join(root, "successor-upgraded.json");
  fs.writeFileSync(upgradedFile, serializeWorkflowPackage(upgraded), "utf8");
  proposeWorkflowImport(targetDb, upgradedFile, upgradedProposal, "target");
  applyWorkflowImport(targetDb, upgradedProposal, "target", { confirmedBy: "owner" });
  db = openDb(targetDb);
  assert.deepEqual({ ...db.prepare("SELECT id,package_key,status FROM workflows WHERE id=?").get(oldWorkflowId) }, { id: oldWorkflowId, package_key: "demo.successor", status: "active" });
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function stableLocalConfig(root) {
  return { executable: path.join(root, "tools", "bsl-language-server.exe"), platform_bin: path.join(root, "1c", "bin") };
}

test("changed package or target invalidates a pending import", () => {
  const root = temporaryRoot("workflow-package-stale-"), sourceDb = seedSource(root), targetDb = seedTarget(root), packageFile = path.join(root, "package.xml"), proposalFile = path.join(root, "proposal.json");
  exportWorkflowPackage(sourceDb, packageFile, "source", "demo.package"); proposeWorkflowImport(targetDb, packageFile, proposalFile, "target"); fs.appendFileSync(packageFile, " \n", "utf8");
  assert.throws(() => applyWorkflowImport(targetDb, proposalFile, "target", { confirmedBy: "owner" }), /PACKAGE_CHANGED/);
  exportWorkflowPackage(sourceDb, packageFile, "source", "demo.package"); const second = path.join(root, "second.json"); proposeWorkflowImport(targetDb, packageFile, second, "target"); const db = openDb(targetDb); db.prepare("INSERT INTO project_documents(id,project_id,path,document_type,authority,status,active) VALUES('late','target','late.md','working','owner','active',1)").run(); db.close();
  assert.throws(() => applyWorkflowImport(targetDb, second, "target", { confirmedBy: "owner" }), /TARGET_CHANGED/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("package validation rejects missing dependencies and local-only fields", () => {
  const root = temporaryRoot("workflow-package-invalid-"), dbFile = seedSource(root), file = path.join(root, "package.xml"); exportWorkflowPackage(dbFile, file, "source", "demo.package"); const value = parseWorkflowPackage(fs.readFileSync(file, "utf8"));
  const missing = structuredClone(value); missing.checks = []; assert.throws(() => validateWorkflowPackage(missing), /missing check/);
  const local = structuredClone(value); local.profiles[0].model_id = "local-model"; assert.throws(() => serializeWorkflowPackage(local), /exact fields|required|forbidden/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("experience v1 stores only structured evidence, evaluates anonymized scenarios and applies only after confirmation as a new version", async () => {
  const root = temporaryRoot("workflow-experience-"), sourceDb = seedSource(root), targetDb = seedTarget(root), packageFile = path.join(root, "package.xml"), proposalFile = path.join(root, "import.json"); exportWorkflowPackage(sourceDb, packageFile, "source", "demo.package"); proposeWorkflowImport(targetDb, packageFile, proposalFile, "target"); applyWorkflowImport(targetDb, proposalFile, "target", { confirmedBy: "owner" });
  const observation = { schema_version: 1, project_id: "target", package_key: "demo.package", package_version: "1.0.0", scenario_key: "basic", role_key: "worker", structured_result: { status: "completed" }, error_category: null, gate_outcomes: [{ key: "check.green", status: "passed" }], human_feedback: { outcome: "accepted", confirmed_by: "owner", note: "meets the stated contract" }, metrics: { calls: 3, input_tokens: 100, output_tokens: 50, cached_tokens: 20, duration_ms: 4000, cost_usd: null } };
  assert.equal(recordExperienceObservation(targetDb, observation).status, "recorded"); assert.throws(() => recordExperienceObservation(targetDb, { ...observation, raw_output: "forbidden" }), /exact fields/);
  const created = createExperienceProposal(targetDb, { project_id: "target", package_key: "demo.package", base_version: "1.0.0", change_type: "route", target_key: "implementation", change: { workflow_key: "main", enabled: true, priority: 20 }, reason: "Saved scenario shows the explicit route remains reliable" });
  assert.throws(() => applyExperienceProposal(targetDb, created.proposal_id, { confirmedBy: "owner" }), /NOT_EVALUATED/);
  const evaluation = await evaluateExperienceProposal(targetDb, created.proposal_id, ({ variant }) => variant === "current" ? { passed: true, quality_score: 0.8, cost_usd: 0.1, duration_ms: 1000 } : { passed: true, quality_score: 0.9, cost_usd: 0.08, duration_ms: 900 });
  assert.deepEqual(evaluation.comparison.quality_score, { before: 0.8, after: 0.9 }); assert.throws(() => applyExperienceProposal(targetDb, created.proposal_id), /CONFIRMATION_REQUIRED/);
  const applied = applyExperienceProposal(targetDb, created.proposal_id, { confirmedBy: "owner" }); assert.equal(applied.version, "1.0.1");
  const db = openDb(targetDb); assert.equal(db.prepare("SELECT version FROM workflow_package_releases WHERE project_id='target' AND package_key='demo.package' AND status='active'").get().version, "1.0.1"); assert.equal(db.prepare("SELECT status FROM experience_proposals WHERE id=?").get(created.proposal_id).status, "applied"); db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
