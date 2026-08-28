import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, now, id } from "../src/db.mjs";
import { Runtime } from "../src/runtime.mjs";
import { applyWorkflowImport, proposeWorkflowImport } from "../src/workflow-package.mjs";
import { callGateway } from "../src/gateway.mjs";
import { loadRoleContract, parseRoleReceipt, rolePrompt } from "../src/role-contracts.mjs";
import { workflowRunStatistics } from "../src/statistics.mjs";
import { registerImplicitResources } from "../src/project-resources.mjs";
import { assertProjectBaselineUnchanged, captureProjectBaseline } from "./project-baseline.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function argsObject(argv) { const result = {}; for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) result[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i]; return result; }
const args = argsObject(process.argv.slice(2)); if (!args.config) throw new Error("Usage: node scripts/run-owner-boundary-evidence.mjs --config <json>");
const config = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8")), outputRoot = path.resolve(config.output_root), dbFile = path.join(outputRoot, "workflow-evidence.sqlite"), gatewayDb = path.join(outputRoot, "gateway-evidence.sqlite");
if (fs.existsSync(outputRoot)) throw new Error(`EVIDENCE_OUTPUT_ALREADY_EXISTS: ${outputRoot}`); fs.mkdirSync(outputRoot, { recursive: true });
let db = openDb(dbFile); for (const project of config.projects) { const rootPath = path.resolve(project.root_path); db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(project.project_id, project.name, rootPath, now()); registerImplicitResources(db, { projectId: project.project_id, rootPath }); } db.close();
const fakeProvider = path.join(repositoryRoot, "tests", "fixtures", "deterministic-workflow-provider.mjs"), policyFile = path.join(outputRoot, "gateway-policy.json"), providerHome = path.join(outputRoot, "empty-provider-home"); fs.mkdirSync(providerHome); process.env.CODEX_SOURCE_HOME = providerHome; process.env.AGENT_GATEWAY_TEMP = path.join(outputRoot, "gateway-temp");
const profileKeys = [...new Set(config.projects.flatMap(project => project.scenarios.flatMap(scenario => scenario.roles.map(role => `${project.package_key}.${role}.mvp`))))], profiles = Object.fromEntries(profileKeys.map(key => [key, { model: "deterministic-contract-v1", reasoningEffort: "low", readOnly: true }]));
fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, levels: { mvp: { maxCalls: 3, maxCorrectionCycles: 0, timeoutSec: 120 } }, providers: { codex: { command: process.execPath, args: [fakeProvider], profiles } } }, null, 2));
const results = [];
for (const project of config.projects) {
  const before = captureProjectBaseline(project.root_path), proposalFile = path.join(outputRoot, `${project.project_id}.proposal.json`); proposeWorkflowImport(dbFile, path.resolve(project.package_file), proposalFile, project.project_id); applyWorkflowImport(dbFile, proposalFile, project.project_id, { confirmedBy: "checkpoint9-reversible-local-import" });
  db = openDb(dbFile); for (const role of [...new Set(project.scenarios.flatMap(scenario => scenario.roles))]) { const key = `${project.package_key}.${role}.mvp`; db.prepare("INSERT OR IGNORE INTO profiles(id,provider,name,role_id) VALUES(?,'codex',?,?)").run(key, key, role); db.prepare("INSERT OR REPLACE INTO role_profile_assignments(project_id,role_id,profile_id,operational_level,enabled) VALUES(?,?,?,'mvp',1)").run(project.project_id, role, key); } db.close();
  for (const scenario of project.scenarios) {
    db = openDb(dbFile); const workflowId = db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type='workflow' AND m.semantic_key=?`).get(project.project_id, scenario.workflow_key)?.local_id; db.close();
    const runtime = new Runtime(dbFile), runId = runtime.create(scenario.message, { project_id: project.project_id, workflow_id: workflowId, event_source: "checkpoint9-owner-boundary", event_key: `${project.project_id}:${scenario.key}` });
    runtime.classify(runId, { schema_version: 1, kind: scenario.work_type, artifact_type: scenario.artifact_type, domain: "game-development", discipline: scenario.discipline, risk: "low", level: "L2", quality: "mvp", planning_required: true, human_required: true, document_required: false, reply_mode: "work", needs_questions: false, questions: [], reason: "Concrete owner acceptance remains separate", human_response: "" });
    runtime.plan(runId, { objective: scenario.message, authority: "registered project documents", steps: scenario.roles.map((role, index) => ({ key: `${index + 1}-${role}`, role, max_attempts: 1 })) }); runtime.setState(runId, "executing");
    for (const [index, role] of scenario.roles.entries()) {
      const step = runtime.db.prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_key=?").get(runId, `${index + 1}-${role}`), attemptId = id("attempt"), contract = loadRoleContract(runtime.db, project.project_id, role, "mvp"), packageContract = { objective: scenario.message, allowed_paths: [], artifact_keys: [], check_ids: [] };
      runtime.db.prepare("UPDATE workflow_steps SET state='running',updated_at=? WHERE id=?").run(now(), step.id); runtime.db.prepare("INSERT INTO attempts(id,step_id,ordinal,state,provider,profile,started_at) VALUES(?,?,1,'running','codex',?,?)").run(attemptId, step.id, contract.profile, now());
      const taskFile = path.join(outputRoot, `${project.project_id}-${scenario.key}-${index + 1}.md`); fs.writeFileSync(taskFile, rolePrompt({ contract, packageContract, context: { project: project.project_id, documents: [], decisions: [], pending_interactions: [] }, resultSchema: contract.result_schema_key }));
      const receipt = await callGateway({ gateway: path.resolve(config.gateway_entry), gatewayDatabase: gatewayDb, gatewayPolicy: policyFile, provider: "codex", profile: contract.profile, level: "mvp", role, taskFile, project: path.resolve(project.root_path), taskId: `${runId}:${index + 1}:${role}`, workflowRunId: runId, attemptNo: 1 }); parseRoleReceipt(receipt, contract.result_schema_key, { contract, packageContract }); runtime.linkGateway(runId, { ...receipt, step_id: step.id, attempt_id: attemptId });
      runtime.db.prepare("UPDATE attempts SET state='succeeded',finished_at=?,receipt_id=? WHERE id=?").run(now(), receipt.receiptId, attemptId); runtime.db.prepare("UPDATE workflow_steps SET state='completed',result_schema_key=?,updated_at=? WHERE id=?").run(contract.result_schema_key, now(), step.id);
    }
    const taskId = runtime.get(runId).task_id, timestamp = now(), provenance = { schema_version: 1, source: "checkpoint9_anonymized_proposal", generator: "not_run_without_owner_brief", technical_contract: scenario.technical_contract, rights_review: "pending", owner_acceptance: "pending" };
    runtime.db.prepare("INSERT INTO artifacts(id,task_id,run_id,kind,uri,status,provenance_json,created_at,updated_at) VALUES(?,?,?,?,?,'proposed',?,?,?)").run(id("artifact"), taskId, runId, scenario.artifact_type, `proposal://${project.project_id}/${scenario.key}`, JSON.stringify(provenance), timestamp, timestamp);
    if (scenario.technical_contract === "passed") runtime.recordGate(runId, { status: "passed", checks: [{ id: `${scenario.key}_technical_contract`, required: true, status: "passed" }] }, "technical", true);
    runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'owner_acceptance',?,'pending',?)").run(id("approval"), taskId, runId, scenario.owner_question, timestamp); runtime.setState(runId, "approval_required", { reason: "owner acceptance remains separate" }); runtime.db.close();
    const statistics = workflowRunStatistics(dbFile, runId); fs.writeFileSync(path.join(outputRoot, `${project.project_id}-${scenario.key}.statistics.json`), JSON.stringify({ project_id: project.project_id, scenario: scenario.key, run_id: runId, owner_acceptance: "pending_separate", statistics }, null, 2)); results.push({ project_id: project.project_id, scenario: scenario.key, run_id: runId, final_state: statistics.final_state, calls: statistics.calls.map(call => call.role), artifact_status: statistics.artifacts[0].status, owner_acceptance: "pending_separate" });
  }
  const after = captureProjectBaseline(project.root_path); assertProjectBaselineUnchanged(before, after, project.project_id);
}
const summary = { schema_version: 1, created_at: new Date().toISOString(), worktrees_unchanged: true, results }; fs.writeFileSync(path.join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
