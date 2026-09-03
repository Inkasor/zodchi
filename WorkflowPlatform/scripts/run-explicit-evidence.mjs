import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, now } from "../src/db.mjs";
import { invokeExplicitTask } from "../src/explicit-invocation.mjs";
import { applyWorkflowImport, proposeWorkflowImport } from "../src/workflow-package.mjs";
import { workflowRunStatistics } from "../src/statistics.mjs";
import { registerImplicitResources } from "../src/project-resources.mjs";
import { assertProjectBaselineUnchanged, captureProjectBaseline } from "./project-baseline.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function argsObject(argv) { const result = {}; for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) result[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i]; return result; }
const args = argsObject(process.argv.slice(2));
if (!args.config) throw new Error("Usage: node scripts/run-explicit-evidence.mjs --config <json>");
const config = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
const outputRoot = path.resolve(config.output_root), dbFile = path.join(outputRoot, "workflow-evidence.sqlite"), gatewayDb = path.join(outputRoot, "gateway-evidence.sqlite");
if (fs.existsSync(outputRoot)) throw new Error(`EVIDENCE_OUTPUT_ALREADY_EXISTS: ${outputRoot}`);
fs.mkdirSync(outputRoot, { recursive: true });

let db = openDb(dbFile);
const projectRoot = path.resolve(config.root_path);
db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(config.project_id, config.name, projectRoot, now());
registerImplicitResources(db, { projectId: config.project_id, rootPath: projectRoot });
db.close();
const proposalFile = path.join(outputRoot, "import-proposal.json");
proposeWorkflowImport(dbFile, path.resolve(config.package_file), proposalFile, config.project_id);
applyWorkflowImport(dbFile, proposalFile, config.project_id, { confirmedBy: "explicit-skill-acceptance" });
db = openDb(dbFile);
const workflowId = db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type='workflow' AND m.semantic_key=? ORDER BY p.applied_at DESC LIMIT 1`).get(config.project_id, config.workflow_key)?.local_id;
if (!workflowId) throw new Error(`WORKFLOW_MAPPING_MISSING: ${config.workflow_key}`);
const requirements = db.prepare("SELECT role_id,profile_key FROM portable_profile_requirements WHERE project_id=? AND package_key=? ORDER BY role_id").all(config.project_id, config.package_key);
if (!requirements.length) throw new Error(`PACKAGE_PROFILE_REQUIREMENTS_MISSING: ${config.package_key}`);
// Classifier, researcher and conversation responder are host-runtime roles. A portable package can use them without containing a
// productive researcher step, so its portable requirements are not sufficient to construct a runnable
// chat installation. Acceptance must bind both explicitly or it can mistake a failed research route for
// a successful invocation merely because the platform returned a human-readable controlled-stop message.
const bindings = [...requirements];
for (const roleId of ["classifier", "researcher", "conversation_responder"]) {
  if (!bindings.some(binding => binding.role_id === roleId)) bindings.push({ role_id: roleId, profile_key: `${config.package_key}.${roleId}.mvp`, direct: true });
}
const contractWrites = new Map(db.prepare("SELECT role_id,boundaries_json FROM role_contracts WHERE project_id=? AND status='active'").all(config.project_id).map(row => {
  let boundaries = {};
  try { boundaries = JSON.parse(row.boundaries_json ?? "{}"); } catch { /* imported contract validation owns malformed JSON */ }
  return [row.role_id, boundaries.writes === true];
}));
for (const binding of bindings) binding.requires_write = binding.direct ? false : contractWrites.get(binding.role_id) === true;
for (const binding of bindings) {
  db.prepare("INSERT OR IGNORE INTO profiles(id,provider,name,role_id) VALUES(?,'codex',?,?)").run(binding.profile_key, binding.profile_key, binding.role_id);
  db.prepare("INSERT OR REPLACE INTO role_profile_assignments(project_id,role_id,profile_id,operational_level,enabled,satisfies_profile_key) VALUES(?,?,?,'mvp',1,?)").run(config.project_id, binding.role_id, binding.profile_key, binding.direct ? null : binding.profile_key);
}
db.close();

const fakeProvider = path.join(repositoryRoot, "tests", "fixtures", "deterministic-workflow-provider.mjs"), policyFile = path.join(outputRoot, "gateway-policy.json"), providerHome = path.join(outputRoot, "empty-provider-home");
fs.mkdirSync(providerHome);
const profiles = Object.fromEntries(bindings.map(binding => [binding.profile_key, { model: "deterministic-contract-v1", reasoningEffort: "low", readOnly: !binding.requires_write }]));
fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, levels: { prototype: { maxCalls: 2, maxCorrectionCycles: 0, timeoutSec: 60 }, mvp: { maxCalls: 3, maxCorrectionCycles: 1, timeoutSec: 3600 } }, providers: { codex: { command: process.execPath, args: [fakeProvider], profiles } } }, null, 2));
Object.assign(process.env, {
  AGENT_GATEWAY_ENTRY: path.resolve(config.gateway_entry),
  AGENT_GATEWAY_POLICY: policyFile,
  AGENT_GATEWAY_DB: gatewayDb,
  AGENT_GATEWAY_TEMP: path.join(outputRoot, "gateway-temp"),
  WORKFLOW_TEMP: path.join(outputRoot, "workflow-temp"),
  CODEX_SOURCE_HOME: providerHome
});

const before = captureProjectBaseline(projectRoot);
const scenarios = [
  { key: "codex", client: "codex", message: "SCENARIO:research Кратко проверь зарегистрированный технический контекст проекта." },
  { key: "claude-code", client: "claude-code", message: "SCENARIO:research Кратко проверь зарегистрированный технический контекст проекта." }
];
const results = [];
for (const scenario of scenarios) {
  const messageFile = path.join(outputRoot, `${scenario.key}-message.txt`);
  fs.writeFileSync(messageFile, scenario.message, "utf8");
  const receipt = await invokeExplicitTask({ client: scenario.client, origin: projectRoot, messageFile, dbFile, workflow: workflowId, eventKey: `explicit-${scenario.key}`, preferredLanguage: "ru", deleteMessageFile: true });
  if (!receipt.run_id) throw new Error(`EXPLICIT_RUN_MISSING: ${scenario.key}`);
  db = openDb(dbFile);
  const recordedClient = db.prepare("SELECT client FROM workflow_runs WHERE id=?").get(receipt.run_id)?.client;
  db.close();
  if (recordedClient !== scenario.client) throw new Error(`EXPLICIT_CLIENT_MISMATCH ${scenario.key}: expected ${scenario.client}, recorded ${recordedClient}`);
  const statistics = workflowRunStatistics(dbFile, receipt.run_id);
  if (statistics.final_state !== "completed") throw new Error(`EXPLICIT_RUN_NOT_COMPLETED: ${scenario.key}:${statistics.final_state}`);
  const calledRoles = statistics.calls.map(call => call.role);
  if (calledRoles.join(",") !== "classifier,researcher") throw new Error(`EXPLICIT_RUN_ROLE_SEQUENCE_INVALID: ${scenario.key}:${calledRoles.join(",")}`);
  const record = { scenario: scenario.key, receipt, statistics };
  fs.writeFileSync(path.join(outputRoot, `${scenario.key}.statistics.json`), JSON.stringify(record, null, 2));
  results.push({ scenario: scenario.key, client: recordedClient, run_id: receipt.run_id, final_state: statistics.final_state, calls: calledRoles, response_returned: typeof receipt.response === "string" && receipt.response.length > 0 });
}
const after = captureProjectBaseline(projectRoot);
assertProjectBaselineUnchanged(before, after, config.project_id);
const summary = { schema_version: 1, created_at: new Date().toISOString(), project_id: config.project_id, invocation: "explicit_skill", worktree_unchanged: true, results };
fs.writeFileSync(path.join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
