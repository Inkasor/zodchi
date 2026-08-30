import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, now } from "../src/db.mjs";
import { applyWorkflowImport, proposeWorkflowImport } from "../src/workflow-package.mjs";
import { processMessage } from "../src/workflow-app.mjs";
import { callGateway } from "../src/gateway.mjs";
import { workflowRunStatistics } from "../src/statistics.mjs";
import { registerImplicitResources, registerProjectResource } from "../src/project-resources.mjs";
import { assertProjectBaselineUnchanged, captureProjectBaseline } from "./project-baseline.mjs";
import { registerCanaryChecks } from "./canary-checks.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function argsObject(argv) { const result = {}; for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) result[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i]; return result; }
function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function deterministicScenarioMessage(item) {
  const scenario = item.classification;
  if (!scenario || typeof scenario !== "object" || !scenario.work_type || !scenario.artifact_type || !scenario.domain || !scenario.discipline) throw new Error(`CANARY_CLASSIFICATION_REQUIRED: ${item.project_id}`);
  for (const [key, value] of Object.entries(scenario)) if (!/^[a-z0-9._-]+$/.test(String(value))) throw new Error(`CANARY_CLASSIFICATION_VALUE_INVALID: ${item.project_id}: ${key}`);
  const original = item.message ?? "Run the registered read-only technical verification scenario. Do not edit source files and do not make owner acceptance decisions.";
  return `${original}\nSCENARIO_WORK_TYPE=${scenario.work_type} SCENARIO_ARTIFACT=${scenario.artifact_type} SCENARIO_DOMAIN=${scenario.domain} SCENARIO_DISCIPLINE=${scenario.discipline}`;
}

const args = argsObject(process.argv.slice(2));
if (!args.config) throw new Error("Usage: node scripts/run-e2e-evidence.mjs --config <json>");
const config = json(path.resolve(args.config)), outputRoot = path.resolve(config.output_root), dbFile = path.join(outputRoot, "workflow-evidence.sqlite"), gatewayDb = path.join(outputRoot, "gateway-evidence.sqlite");
if (fs.existsSync(outputRoot)) throw new Error(`EVIDENCE_OUTPUT_ALREADY_EXISTS: ${outputRoot}`);
fs.mkdirSync(outputRoot, { recursive: true });
const fakeProvider = path.join(repositoryRoot, "tests", "fixtures", "deterministic-workflow-provider.mjs"), policyFile = path.join(outputRoot, "gateway-policy.json"), providerHome = path.join(outputRoot, "empty-provider-home"), gatewayTemp = path.join(outputRoot, "gateway-temp");
fs.mkdirSync(providerHome); process.env.CODEX_SOURCE_HOME = providerHome; process.env.AGENT_GATEWAY_TEMP = gatewayTemp;
let db = openDb(dbFile);
for (const item of config.projects) {
  const rootPath = path.resolve(item.root_path);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(item.project_id, item.name, rootPath, now());
  registerImplicitResources(db, { projectId: item.project_id, rootPath });
}
db.close();

// Which roles a run needs is decided by routing, not by the scenario's nominal worker, so every role
// the package registers gets a profile. The assignment also has to declare which portable requirement
// it fulfils: a contract with declared allowed_profiles refuses an assignment that does not, and the
// package registers exactly one requirement per role, so the link is read from the import rather than
// reconstructed from a naming convention.
const profileKeys = new Set();
const prepared = [];
for (const item of config.projects) {
  const proposalFile = path.join(outputRoot, `${item.project_id}.import-proposal.json`);
  proposeWorkflowImport(dbFile, path.resolve(item.package_file), proposalFile, item.project_id);
  applyWorkflowImport(dbFile, proposalFile, item.project_id, { confirmedBy: "checkpoint9-reversible-local-import" });
  db = openDb(dbFile);
  for (const resource of item.resources ?? []) registerProjectResource(db, { projectId: item.project_id, alias: resource.alias, kind: resource.kind, purpose: resource.purpose ?? "Acceptance-bound local resource", declaration: resource.declaration });
  const workflowId = db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id
    WHERE p.target_project_id=? AND p.package_key=? AND p.status='applied' AND m.entity_type='workflow' AND m.semantic_key=? ORDER BY p.applied_at DESC LIMIT 1`).get(item.project_id, item.package_key, item.workflow_key)?.local_id;
  if (!workflowId) throw new Error(`WORKFLOW_MAPPING_MISSING: ${item.workflow_key}`);
  deterministicScenarioMessage(item);
  const routed = db.prepare("SELECT 1 FROM workflow_routes WHERE project_id=? AND workflow_id=? AND work_type_id=? AND enabled=1").get(item.project_id, workflowId, item.classification?.work_type);
  if (!routed) throw new Error(`CANARY_CLASSIFICATION_ROUTE_MISMATCH: ${item.project_id}: ${item.classification?.work_type ?? "missing"}: ${item.workflow_key}`);
  const requirements = db.prepare("SELECT role_id,profile_key FROM portable_profile_requirements WHERE project_id=? AND package_key=?").all(item.project_id, item.package_key);
  if (!requirements.length) throw new Error(`PACKAGE_PROFILE_REQUIREMENTS_MISSING: ${item.package_key}`);
  const bindings = [...requirements];
  for (const roleId of ["classifier", "researcher"]) {
    if (!bindings.some(binding => binding.role_id === roleId)) bindings.push({ role_id: roleId, profile_key: `${item.package_key}.${roleId}.mvp`, direct: true });
  }
  for (const binding of bindings) {
    db.prepare("INSERT OR IGNORE INTO profiles(id,provider,name,role_id) VALUES(?,'codex',?,?)").run(binding.profile_key, binding.profile_key, binding.role_id);
    db.prepare("INSERT OR REPLACE INTO role_profile_assignments(project_id,role_id,profile_id,operational_level,enabled,satisfies_profile_key) VALUES(?,?,?,'mvp',1,?)").run(item.project_id, binding.role_id, binding.profile_key, binding.direct ? null : binding.profile_key);
    profileKeys.add(binding.profile_key);
  }
  db.close();
  const checks = registerCanaryChecks(dbFile, item);
  if (checks) fs.writeFileSync(path.join(outputRoot, `${item.project_id}.checks.json`), JSON.stringify(checks, null, 2), "utf8");
  prepared.push({ item, workflowId, checks, directProfiles: Object.fromEntries(bindings.filter(binding => ["classifier", "researcher"].includes(binding.role_id)).map(binding => [binding.role_id, binding.profile_key])) });
}

const profiles = Object.fromEntries([...profileKeys].map(key => [key, { model: "deterministic-contract-v1", reasoningEffort: "low", readOnly: true }]));
fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, levels: { prototype: { maxCalls: 2, maxCorrectionCycles: 0, timeoutSec: 60 }, mvp: { maxCalls: 2, maxCorrectionCycles: 1, timeoutSec: 3600 } }, providers: { codex: { command: process.execPath, args: [fakeProvider], profiles } } }, null, 2), "utf8");

const results = [];
for (const { item, workflowId, checks, directProfiles } of prepared) {
  const before = captureProjectBaseline(item.root_path), gateway = request => callGateway({ ...request, gateway: path.resolve(config.gateway_entry), gatewayDatabase: gatewayDb, gatewayPolicy: policyFile });
  const providerMessage = deterministicScenarioMessage(item);
  const outcome = await processMessage({
    message: providerMessage,
    project: path.resolve(item.root_path), dbFile, workflow: workflowId,
    workflowDefinition: { id: workflowId, authority: "registered project documents", roles: {
      classifier: { provider: "codex", profile: directProfiles.classifier, role: "classifier" },
      researcher: { provider: "codex", profile: directProfiles.researcher, role: "researcher" }
    } },
    execute: true, eventSource: "checkpoint9", eventKey: item.project_id, gatewayCall: gateway
  });
  const after = captureProjectBaseline(item.root_path);
  assertProjectBaselineUnchanged(before, after, item.project_id);
  const statistics = workflowRunStatistics(dbFile, outcome.run_id);
  const record = { project_id: item.project_id, package_key: item.package_key, workflow_key: item.workflow_key, requested_scenario: item.message ?? null, deterministic_classification: item.classification, source_baseline_before: before, source_baseline_after: after, outcome, statistics, owner_acceptance: "pending_separate" };
  fs.writeFileSync(path.join(outputRoot, `${item.project_id}.statistics.json`), JSON.stringify(record, null, 2), "utf8");
  results.push({ project_id: item.project_id, run_id: outcome.run_id, route: outcome.route, execution_status: outcome.execution?.status ?? null, gate_status: outcome.execution?.gate?.status ?? null, final_state: statistics.final_state, calls: statistics.calls.length, tokens: statistics.tokens, worktree_unchanged: true, checks: checks ? { check_id: checks.check_id, kind: checks.kind, baseline_id: checks.baseline.baseline_id, tool_version: checks.baseline.tool_version, accepted_revision: checks.baseline.accepted_revision, confirmed_by: item.checks.one_c_bsl.confirmed_by } : null, owner_acceptance: "pending_separate" });
}
const summary = { schema_version: 1, created_at: new Date().toISOString(), provider_mode: "deterministic contract through real AgentGateway process", database: path.basename(dbFile), gateway_database: path.basename(gatewayDb), results };
fs.writeFileSync(path.join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
