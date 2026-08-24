import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openDb, now } from "../src/db.mjs";
import { applyWorkflowImport, proposeWorkflowImport } from "../src/workflow-package.mjs";
import { workflowRunStatistics } from "../src/statistics.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function argsObject(argv) { const result = {}; for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) result[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i]; return result; }
function status(root) { return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8", windowsHide: true }).replaceAll("\\", "/"); }
const args = argsObject(process.argv.slice(2)); if (!args.config) throw new Error("Usage: node scripts/run-hook-evidence.mjs --config <json>");
const config = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8")), outputRoot = path.resolve(config.output_root), dbFile = path.join(outputRoot, "workflow-evidence.sqlite"), gatewayDb = path.join(outputRoot, "gateway-evidence.sqlite");
if (fs.existsSync(outputRoot)) throw new Error(`EVIDENCE_OUTPUT_ALREADY_EXISTS: ${outputRoot}`); fs.mkdirSync(outputRoot, { recursive: true });
let db = openDb(dbFile); db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(config.project_id, config.name, path.resolve(config.root_path), now()); db.close();
const proposalFile = path.join(outputRoot, "import-proposal.json"); proposeWorkflowImport(dbFile, path.resolve(config.package_file), proposalFile, config.project_id); applyWorkflowImport(dbFile, proposalFile, config.project_id, { confirmedBy: "checkpoint9-reversible-local-import" });
db = openDb(dbFile); const workflowId = db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type='workflow' AND m.semantic_key=? ORDER BY p.applied_at DESC LIMIT 1`).get(config.project_id, config.workflow_key)?.local_id;
for (const role of ["classifier", "researcher"]) { const key = `${config.package_key}.${role}.mvp`; db.prepare("INSERT OR IGNORE INTO profiles(id,provider,name,role_id) VALUES(?,'codex',?,?)").run(key, key, role); db.prepare("INSERT OR REPLACE INTO role_profile_assignments(project_id,role_id,profile_id,operational_level,enabled) VALUES(?,?,?,'mvp',1)").run(config.project_id, role, key); }
db.close();
const fakeProvider = path.join(repositoryRoot, "tests", "fixtures", "deterministic-workflow-provider.mjs"), policyFile = path.join(outputRoot, "gateway-policy.json"), providerHome = path.join(outputRoot, "empty-provider-home"); fs.mkdirSync(providerHome);
const profiles = Object.fromEntries(["classifier", "researcher"].map(role => [`${config.package_key}.${role}.mvp`, { model: "deterministic-contract-v1", reasoningEffort: "low", readOnly: true }]));
fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, levels: { prototype: { maxCalls: 2, maxCorrectionCycles: 0, timeoutSec: 60 } }, providers: { codex: { command: process.execPath, args: [fakeProvider], profiles } } }, null, 2));
const before = status(config.root_path), baseEnv = { ...process.env, WORKFLOW_DB: dbFile, WORKFLOW_PROJECT: path.resolve(config.root_path), WORKFLOW_ID: workflowId, WORKFLOW_TEMP: path.join(outputRoot, "workflow-temp"), AGENT_GATEWAY_ENTRY: path.resolve(config.gateway_entry), AGENT_GATEWAY_POLICY: policyFile, AGENT_GATEWAY_DB: gatewayDb, AGENT_GATEWAY_TEMP: path.join(outputRoot, "gateway-temp"), CODEX_SOURCE_HOME: providerHome };
const scenarios = [{ key: "conversation", client: "codex", event: "hook-conversation", message: "SCENARIO:conversation Привет!" }, { key: "research", client: "codex", event: "hook-research", message: "SCENARIO:research Кратко проверь зарегистрированный технический контекст Project R." }, { key: "claude-conversation", client: "claude-code", event: "550e8400-e29b-41d4-a716-446655440000", message: "SCENARIO:conversation Привет!" }], results = [];
function hookInput(scenario, cwd) { return scenario.client === "claude-code" ? { session_id: "hook-evidence-session", prompt_id: scenario.event, transcript_path: "", permission_mode: "default", hook_event_name: "UserPromptSubmit", cwd, prompt: scenario.message } : { session_id: "hook-evidence-session", turn_id: scenario.event, model: "hook-evidence-model", transcript_path: "", permission_mode: "read-only", hook_event_name: "UserPromptSubmit", cwd, prompt: scenario.message }; }
function hookSource(scenario) { return scenario.client === "claude-code" ? "claude-code-hook" : "codex-hook"; }
for (const scenario of scenarios) {
  const execution = spawnSync(process.execPath, [path.join(repositoryRoot, "hooks", "user-prompt-submit.mjs")], { cwd: path.resolve(config.root_path), encoding: "utf8", windowsHide: true, env: baseEnv, input: JSON.stringify(hookInput(scenario, path.resolve(config.root_path))) });
  if (execution.status !== 0) throw new Error(`HOOK_FAILED ${scenario.key}: ${execution.stderr || execution.stdout}`);
  const hook = JSON.parse(execution.stdout.trim()); db = openDb(dbFile); const runId = db.prepare("SELECT run_id FROM inbox_events WHERE project_id=? AND source=? AND event_key=?").get(config.project_id, hookSource(scenario), scenario.event)?.run_id; const recordedClient = runId ? db.prepare("SELECT client FROM workflow_runs WHERE id=?").get(runId)?.client : null; db.close();
  if (recordedClient !== scenario.client) throw new Error(`HOOK_CLIENT_MISMATCH ${scenario.key}: expected ${scenario.client}, recorded ${recordedClient}`);
  if (!hook.additionalContext) throw new Error(`HOOK_WITHOUT_TOP_LEVEL_CONTEXT ${scenario.key}`);
  const statistics = workflowRunStatistics(dbFile, runId), record = { scenario: scenario.key, run_id: runId, hook_output: hook, statistics };
  fs.writeFileSync(path.join(outputRoot, `${scenario.key}.statistics.json`), JSON.stringify(record, null, 2)); results.push({ scenario: scenario.key, client: recordedClient, run_id: runId, final_state: statistics.final_state, calls: statistics.calls.map(call => call.role), response_in_same_chat: Boolean(hook.additionalContext) });
}
const after = status(config.root_path); if (after !== before) throw new Error("PROJECT_WORKTREE_CHANGED_DURING_HOOK_EVIDENCE");
const summary = { schema_version: 1, created_at: new Date().toISOString(), project_id: config.project_id, worktree_unchanged: true, results }; fs.writeFileSync(path.join(outputRoot, "summary.json"), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
