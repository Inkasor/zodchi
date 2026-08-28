import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, now, id } from "../src/db.mjs";
import { Runtime } from "../src/runtime.mjs";
import { applyWorkflowImport, proposeWorkflowImport } from "../src/workflow-package.mjs";
import { callGateway } from "../src/gateway.mjs";
import { loadRoleContract, parseRoleReceipt, rolePrompt } from "../src/role-contracts.mjs";
import { runProjectGate } from "../src/gates.mjs";
import { workflowRunStatistics } from "../src/statistics.mjs";
import { registerImplicitResources } from "../src/project-resources.mjs";
import { assertProjectBaselineUnchanged, captureProjectBaseline } from "./project-baseline.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function argsObject(argv) { const result = {}; for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) result[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i]; return result; }

const args = argsObject(process.argv.slice(2)); if (!args.config) throw new Error("Usage: node scripts/run-package-boundary-evidence.mjs --config <json>");
const config = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8")), outputRoot = path.resolve(config.output_root), dbFile = path.join(outputRoot, "workflow-evidence.sqlite"), gatewayDb = path.join(outputRoot, "gateway-evidence.sqlite");
if (fs.existsSync(outputRoot)) throw new Error(`EVIDENCE_OUTPUT_ALREADY_EXISTS: ${outputRoot}`); fs.mkdirSync(outputRoot, { recursive: true });
const fakeProvider = path.join(repositoryRoot, "tests", "fixtures", "deterministic-workflow-provider.mjs"), policyFile = path.join(outputRoot, "gateway-policy.json"), providerHome = path.join(outputRoot, "empty-provider-home"); fs.mkdirSync(providerHome);
process.env.CODEX_SOURCE_HOME = providerHome; process.env.AGENT_GATEWAY_TEMP = path.join(outputRoot, "gateway-temp");
const profileKeys = [...new Set(config.projects.flatMap(item => item.roles.map(role => `${item.package_key}.${role}.mvp`)))], profiles = Object.fromEntries(profileKeys.map(key => [key, { model: "deterministic-contract-v1", reasoningEffort: "low", readOnly: true }]));
fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, levels: { mvp: { maxCalls: 2, maxCorrectionCycles: 1, timeoutSec: 3600 } }, providers: { codex: { command: process.execPath, args: [fakeProvider], profiles } } }, null, 2));
let db = openDb(dbFile); for (const item of config.projects) { const rootPath = path.resolve(item.root_path); db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(item.project_id, item.name, rootPath, now()); registerImplicitResources(db, { projectId: item.project_id, rootPath }); } db.close();
const summaries = [];
for (const item of config.projects) {
  const before = captureProjectBaseline(item.root_path), proposalFile = path.join(outputRoot, `${item.project_id}.import-proposal.json`);
  proposeWorkflowImport(dbFile, path.resolve(item.package_file), proposalFile, item.project_id); applyWorkflowImport(dbFile, proposalFile, item.project_id, { confirmedBy: "checkpoint9-reversible-local-import" });
  db = openDb(dbFile);
  const workflowId = db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id=? AND p.package_key=? AND p.status='applied' AND m.entity_type='workflow' AND m.semantic_key=? ORDER BY p.applied_at DESC LIMIT 1`).get(item.project_id, item.package_key, item.workflow_key)?.local_id;
  if (item.consumer_roots) {
    const mappedCheck = semantic => db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id=? AND p.package_key=? AND p.status='applied' AND m.entity_type='check' AND m.semantic_key=? ORDER BY p.applied_at DESC LIMIT 1`).get(item.project_id, item.package_key, semantic)?.local_id;
    const projectMCheck = mappedCheck("project_m_compatibility"), projectRCheck = mappedCheck("project_r_compatibility");
    if (!projectMCheck || !projectRCheck) throw new Error("CONSUMER_CHECK_MAPPING_MISSING");
    db.prepare("UPDATE check_definitions SET kind='command',config_json=?,timeout_seconds=1200 WHERE id=?").run(JSON.stringify({ command: "corepack.cmd", args: ["pnpm", "--dir", path.resolve(item.consumer_roots.project_m), "--filter", "@empolicy/map-render", "test"] }), projectMCheck);
    db.prepare("UPDATE check_definitions SET kind='command',config_json=?,timeout_seconds=900 WHERE id=?").run(JSON.stringify({ command: "npm.cmd", args: ["--prefix", path.resolve(item.consumer_roots.project_r), "run", "test:map-engine"] }), projectRCheck);
  }
  for (const role of item.roles) { const key = `${item.package_key}.${role}.mvp`; db.prepare("INSERT OR IGNORE INTO profiles(id,provider,name,role_id) VALUES(?,'codex',?,?)").run(key, key, role); db.prepare("INSERT OR REPLACE INTO role_profile_assignments(project_id,role_id,profile_id,operational_level,enabled) VALUES(?,?,?,'mvp',1)").run(item.project_id, role, key); }
  db.close();
  const runtime = new Runtime(dbFile), runId = runtime.create(item.message, { project_id: item.project_id, workflow_id: workflowId, event_source: "checkpoint9", event_key: item.project_id });
  runtime.classify(runId, { schema_version: 1, kind: item.work_type, artifact_type: item.artifact_type, domain: item.domain, discipline: item.discipline, risk: "low", level: "L2", quality: "mvp", planning_required: true, human_required: item.owner_gate, document_required: false, reply_mode: "work", needs_questions: false, questions: [], reason: item.reason, human_response: "" });
  runtime.plan(runId, { objective: item.message, authority: "registered project documents", steps: item.roles.map((role, index) => ({ key: `${index + 1}-${role}`, role, max_attempts: 1 })) }); runtime.setState(runId, "executing");
  for (const [index, role] of item.roles.entries()) {
    const step = runtime.db.prepare("SELECT * FROM workflow_steps WHERE run_id=? AND step_key=?").get(runId, `${index + 1}-${role}`), attemptId = id("attempt"), contract = loadRoleContract(runtime.db, item.project_id, role, "mvp"), schemaKey = contract.result_schema_key;
    runtime.db.prepare("UPDATE workflow_steps SET state='running',updated_at=? WHERE id=?").run(now(), step.id); runtime.db.prepare("INSERT INTO attempts(id,step_id,ordinal,state,provider,profile,started_at) VALUES(?,?,1,'running','codex',?,?)").run(attemptId, step.id, contract.profile, now());
    const taskFile = path.join(outputRoot, `${item.project_id}-${role}.md`), packageContract = { objective: item.message, allowed_paths: [], artifact_keys: [], check_ids: [] };
    fs.writeFileSync(taskFile, rolePrompt({ contract, packageContract, context: { project: item.project_id, documents: [], decisions: [], pending_interactions: [] }, resultSchema: schemaKey }));
    const receipt = await callGateway({ gateway: path.resolve(config.gateway_entry), gatewayDatabase: gatewayDb, gatewayPolicy: policyFile, provider: "codex", profile: contract.profile, level: "mvp", role, taskFile, project: path.resolve(item.root_path), taskId: `${runId}:${role}`, workflowRunId: runId, attemptNo: 1 });
    parseRoleReceipt(receipt, schemaKey, schemaKey === "worker.v1" ? { contract, packageContract } : {}); runtime.linkGateway(runId, { ...receipt, step_id: step.id, attempt_id: attemptId });
    runtime.db.prepare("UPDATE attempts SET state='succeeded',finished_at=?,receipt_id=? WHERE id=?").run(now(), receipt.receiptId, attemptId); runtime.db.prepare("UPDATE workflow_steps SET state='completed',result_schema_key=?,updated_at=? WHERE id=?").run(schemaKey, now(), step.id);
  }
  runtime.db.close();
  const gate = await runProjectGate(path.resolve(item.root_path), "mvp", dbFile, `${runId}:gate`, { runId, allowedPaths: [], artifactType: item.artifact_type });
  const resumed = new Runtime(dbFile); resumed.recordGate(runId, gate, "project", true); resumed.setState(runId, "verifying");
  if (item.owner_gate) { const taskId = resumed.get(runId).task_id; resumed.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'owner_decision',?,'pending',?)").run(id("approval"), taskId, runId, item.owner_question, now()); resumed.setState(runId, "approval_required", { reason: "owner decision remains separate" }); }
  else if (gate.status === "passed") resumed.setState(runId, "completed", { reason: "registered package boundary checks passed" }); else resumed.setState(runId, "blocked", { reason: "required consumer compatibility check unavailable" });
  resumed.db.close(); const after = captureProjectBaseline(item.root_path); assertProjectBaselineUnchanged(before, after, item.project_id);
  const statistics = workflowRunStatistics(dbFile, runId), result = { project_id: item.project_id, run_id: runId, package_key: item.package_key, workflow_key: item.workflow_key, gate_status: gate.status, final_state: statistics.final_state, calls: statistics.calls.length, checks: statistics.gates[0].checks, worktree_unchanged: true, consumer_roots_registered_locally: Boolean(item.consumer_roots), owner_acceptance: item.owner_gate ? "pending_separate" : "not_applicable", statistics };
  fs.writeFileSync(path.join(outputRoot, `${item.project_id}.statistics.json`), JSON.stringify(result, null, 2)); summaries.push({ project_id: item.project_id, run_id: runId, gate_status: gate.status, final_state: statistics.final_state, calls: statistics.calls.length, worktree_unchanged: true, owner_acceptance: result.owner_acceptance });
}
const summary = { schema_version: 1, created_at: new Date().toISOString(), results: summaries }; fs.writeFileSync(path.join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
