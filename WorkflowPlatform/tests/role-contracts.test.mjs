import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { onboardProject } from "../src/onboarding.mjs";
import { openDb } from "../src/db.mjs";
import { deliverExternalControlResult, processMessage as scopedProcessMessage } from "../src/workflow-app.mjs";
import { classificationCatalog } from "../src/classifier.mjs";
import { RESULT_SCHEMA_SHAPES, loadRoleContract, parseRoleReceipt, rolePrompt, structuredHash, validateDocumentatorResult, validateJudgeResult, validatePlannerResult, validateReviewerResult, validateStrategyReviewResult, validateWorkerResult } from "../src/role-contracts.mjs";
import { BudgetManager } from "../src/budget.mjs";
import { loadQualityContract } from "../src/quality-contracts.mjs";
import { activateChatSession } from "../src/chat-session.mjs";
import { callGateway } from "../src/gateway.mjs";
import { createExternalControlRequest, registerExternalExecutor, registerExternalOperation } from "../src/external-control-plane.mjs";

const statelessProcessMessage = input => scopedProcessMessage({ semanticScope: { mode: "stateless" }, ...input });

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function classification(documentRequired = false, risk = "low") {
  return {
    schema_version: 1, work_type: documentRequired ? "documentation" : "implementation", artifact_type: documentRequired ? "document" : "code",
    domain: "workflow", discipline: documentRequired ? "documentation" : "software", risk, planning_level: "L2", quality_mode: "mvp",
    planning_required: true, human_required: false, needs_questions: false, document_required: documentRequired, reply_mode: "work",
    pending_interaction_id: null, pending_interaction_response: null, reason: documentRequired ? "Нужно обновить зарегистрированный документ." : "Нужен ограниченный пакет кода.", questions: [], human_response: null
  };
}

function roleContract(roleId, schema, artifacts) {
  return {
    id: `contract-${roleId}`, role_id: roleId, version: "1.0.0", purpose: `${roleId} test contract`, boundaries: { writes: roleId === "worker" },
    allowed_work_types: ["*"], allowed_artifact_types: artifacts, allowed_tools: [], allowed_skills: [], required_checks: ["check-ok"],
    allowed_transitions: [], allowed_profiles: ["*"], context_limit_bytes: 65536, max_calls: roleId === "worker" || roleId === "reviewer" || roleId === "planner" ? 2 : 1, max_correction_cycles: roleId === "worker" || roleId === "planner" ? 1 : 0,
    timeout_seconds: 60, result_schema_key: schema, prompt_template_version: "1.0.0", escalation: { on_invalid: "blocked" }
  };
}

function fixture(prefix, { document = false, externalOperation = false } = {}) {
  const root = temporaryRoot(prefix);
  const project = path.join(root, "project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "context.mjs"), "export function inspect(value) { return value.dynamicCall(); }\n");
  if (document) fs.writeFileSync(path.join(project, "docs", "control.md"), '<document id="control" status="working"><section id="summary" status="working">old</section></document>');
  const roles = [
    ["planner", "planner.v1", ["code", "document"]], ["worker", "worker.v1", ["code", "document"]],
    ["coordinator", "planner.v1", ["code", "document"]], ["reviewer", "reviewer.v1", ["code", "document"]],
    ["documentator", "documentator.v1", ["document"]],
    ...(externalOperation ? [["release_operator", "release_operation.v1", ["release_package", "deployment_evidence"]]] : [])
  ];
  onboardProject(dbFile, {
    project: { id: "project", name: "Project", root_path: project },
    workflow: { id: "workflow", name: "Workflow", discovery: { git: false } },
    roles: roles.map(([role]) => ({ id: role, name: role })),
    profiles: roles.map(([role]) => ({ id: `profile-${role}`, provider: role === "coordinator" ? "claude-code" : "codex", name: `local-${role}`, role_id: role })),
    routes: [{ work_type_id: "implementation" }, { work_type_id: "documentation" }, ...(externalOperation ? [{ work_type_id: "release" }] : [])],
    checks: [
      { id: "check-ok", name: "Test check", runner: "fixture", kind: "fixture", config: { status: "passed" } },
      ...(externalOperation ? [{ id: "check-post", name: "Post-operation check", runner: "fixture", kind: "fixture", config: { status: "passed" } }] : [])
    ],
    project_checks: [
      { check_id: "check-ok", quality_mode_id: "mvp", required: true },
      ...(externalOperation ? [{ check_id: "check-post", quality_mode_id: "mvp", required: true, artifact_type_id: "deployment_evidence" }] : [])
    ],
    role_contracts: roles.map(([role, schema, artifacts]) => roleContract(role, schema, artifacts)),
    role_assignments: roles.map(([role]) => ({ role_id: role, profile_id: `profile-${role}`, operational_level: "mvp" })),
    ...(document ? {
      documents: [{ id: "control", path: "docs/control.md", document_type: "authority", authority: "owner", status: "active" }],
      role_documents: [
        { role_id: "planner", document_id: "control", read_access: true },
        { role_id: "reviewer", document_id: "control", read_access: true },
        { role_id: "documentator", document_id: "control", read_access: true, write_access: true }
      ]
    } : {})
  });
  return { root, project, dbFile };
}

function plannerResult({ document = false } = {}) {
  return {
    schema_version: 1, outcome: "ready", scope: { included: ["bounded result"], excluded: ["publication"] },
    allowed_paths: document ? ["docs/control.md"] : ["src/output.txt"], inputs: ["registered context"], checks: ["check-ok"], risks: [],
    artifacts: [{ key: document ? "control-doc" : "code-output", type: document ? "document" : "code", path: document ? "docs/control.md" : "src/output.txt", required: true }],
    completion_criteria: ["registered gate passes", "reviewer returns PASS"], questions: [],
    steps: [{ key: "worker", role: "worker", objective: document ? "Prepare evidence for the document update" : "Create the bounded output", allowed_paths: document ? [] : ["src/output.txt"], artifact_keys: document ? [] : ["code-output"], check_ids: ["check-ok"], resources: [], required: true, irreversible: false, max_attempts: 1 }]
  };
}

function reviewerResult(decision) {
  return decision === "PASS"
    ? { schema_version: 1, decision, summary: "All structured criteria passed.", blockers: [], required_actions: [], evidence_refs: ["gate:passed"] }
    : { schema_version: 1, decision, summary: "Review did not pass.", blockers: [{ code: "review-blocker", message: "A required criterion is not met.", path: null }], required_actions: ["Fix the blocker"], evidence_refs: ["gate:passed"] };
}

function receipt(role, result, suffix = "1", rawSuffix = "") {
  const timestamp = new Date().toISOString();
  return {
    receiptId: `${role}-receipt-${suffix}`, taskId: `${role}-task-${suffix}`, provider: "codex", profile: `local-${role}`, role,
    status: "completed", exitCode: 0, startedAt: timestamp, finishedAt: timestamp, usage: { input_tokens: 10, output_tokens: 5 },
    output: `${JSON.stringify({ item: { text: JSON.stringify(result) } })}${rawSuffix}`
  };
}

function signedExternalResult(request, privateKey, payload, status = "completed") {
  const packet = {
    schema_version: 1, request_id: request.request_id, request_hash: request.request_hash, project_id: request.project_id,
    run_id: request.run_id, step_id: request.step_id, executor_id: request.executor_id, key_id: request.executor_key_id,
    checkpoint_hash: request.checkpoint_hash, status, payload, payload_hash: structuredHash(payload),
    finished_at: new Date().toISOString(), signature: ""
  };
  // External control uses canonical structured hashing rather than JSON insertion order.
  const resultCore = { schema_version: packet.schema_version, request_id: packet.request_id, request_hash: packet.request_hash, project_id: packet.project_id, run_id: packet.run_id, step_id: packet.step_id, executor_id: packet.executor_id, key_id: packet.key_id, checkpoint_hash: packet.checkpoint_hash, status: packet.status, payload_hash: packet.payload_hash, finished_at: packet.finished_at };
  packet.signature = crypto.sign(null, Buffer.from(structuredHash(resultCore), "utf8"), privateKey).toString("base64");
  return packet;
}

async function scenario({ prefix, gateStatus = "passed", gateStatuses = null, reviewDecision = "PASS", invalidFirstPlanner = false, invalidFirstReviewer = false, document = false, invalidDocumentVersion = false, message = null, risk = "high", projectInputTokenLimit = null, runProfileOverrides = {}, longPlannerWork = false, realDocumentatorGateway = false }) {
  const env = fixture(prefix, { document });
  if (projectInputTokenLimit !== null) {
    const budgetDb = openDb(env.dbFile);
    new BudgetManager(budgetDb).define({ scopeType: "project", scopeId: "project", metric: "input_tokens", limit: projectInputTokenLimit });
    budgetDb.close();
  }
  const calls = [];
  let workerPrompt = "";
  let plannerPrompt = "";
  let documentatorPrompt = "";
  let plannerCalls = 0;
  let reviewerCalls = 0;
  const gatewayPolicy = path.join(env.root, "gateway-policy.json"), gatewayDatabase = path.join(env.root, "gateway.sqlite"), providerHome = path.join(env.root, "provider-home");
  if (realDocumentatorGateway) {
    fs.mkdirSync(providerHome);
    fs.writeFileSync(gatewayPolicy, JSON.stringify({ schemaVersion: 1, levels: { mvp: { maxCalls: 1, maxCorrectionCycles: 0, timeoutSec: 30 } }, providers: { codex: { command: process.execPath, args: [path.join(import.meta.dirname, "fixtures", "deterministic-workflow-provider.mjs")], profiles: { "local-documentator": { model: "deterministic-documentator", reasoningEffort: "low", readOnly: true } } } } }));
  }
  const gatewayCall = async request => {
    calls.push(request.role);
    const contractDb = openDb(env.dbFile);
    const expectedWrites = JSON.parse(contractDb.prepare("SELECT boundaries_json FROM role_contracts WHERE project_id='project' AND role_id=? AND status='active'").get(request.role).boundaries_json).writes === true;
    contractDb.close();
    assert.equal(request.requiresWrite, expectedWrites, `${request.role} write requirement must come from its active contract`);
    if (request.role === "planner" || request.role === "coordinator") {
      plannerCalls += 1;
      plannerPrompt = fs.readFileSync(request.taskFile, "utf8");
      if (invalidFirstPlanner && plannerCalls === 1) {
        const invalid = plannerResult({ document });
        invalid.artifacts = invalid.artifacts.map(item => ({ ...item, path: null }));
        return receipt(request.role, invalid, "1");
      }
      if (invalidFirstPlanner) {
        assert.match(plannerPrompt, /schema_repair/);
        assert.match(plannerPrompt, /only artifact type that may use path=null/);
      }
      const plannerReceipt = receipt(request.role, plannerResult({ document }), "1", "\nRAW_PLANNER_PROSE_MARKER");
      if (longPlannerWork && request.role === "planner") plannerReceipt.duration_ms = 10 * 60 * 1000;
      return plannerReceipt;
    }
    if (request.role === "worker") {
      workerPrompt = fs.readFileSync(request.taskFile, "utf8");
      if (!document) {
        const file = path.join(env.project, "src", "output.txt");
        fs.writeFileSync(file, "bounded output");
        const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        return receipt("worker", { schema_version: 1, status: "completed", summary: "Created output.", changed_paths: ["src/output.txt"], artifacts: [{ key: "code-output", type: "code", path: "src/output.txt", content_hash: hash, status: "created" }], evidence: ["file hash"], questions: [], external_evidence_request: null });
      }
      return receipt("worker", { schema_version: 1, status: "completed", summary: "Prepared document evidence.", changed_paths: [], artifacts: [], evidence: ["registered target"], questions: [], external_evidence_request: null });
    }
    if (request.role === "reviewer") {
      reviewerCalls += 1;
      if (invalidFirstReviewer && reviewerCalls === 1) return receipt("reviewer", { ...reviewerResult("PASS"), blockers: [{ code: "gap", message: "Contradictory first result.", path: null }] }, "1");
      if (invalidFirstReviewer) assert.match(fs.readFileSync(request.taskFile, "utf8"), /schema_repair/);
      return receipt("reviewer", reviewerResult(reviewDecision), String(reviewerCalls));
    }
    if (request.role === "documentator") {
      documentatorPrompt = fs.readFileSync(request.taskFile, "utf8");
      if (realDocumentatorGateway) return callGateway({ ...request, gateway: path.resolve(import.meta.dirname, "..", "..", "AgentGateway", "src", "cli.mjs"), gatewayDatabase, gatewayPolicy });
      const file = path.join(env.project, "docs", "control.md");
      const version = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
      return receipt("documentator", {
        schema_version: 1, status: "proposed", document_id: "control", expected_version: invalidDocumentVersion ? `sha256:${"0".repeat(64)}` : version,
        operation: "update_section", authority: "owner", content: "new accepted content", section_id: "summary", decision_id: null,
        evidence_id: null, status_value: null, target_tag: null, target_id: null, replacement_id: null
      });
    }
    throw new Error(`unexpected role ${request.role}`);
  };
  let gateCalls = 0;
  const gateRunner = async () => {
    const currentGateStatus = gateStatuses?.[Math.min(gateCalls++, gateStatuses.length - 1)] ?? gateStatus;
    return { task_id: "gate", project: env.project, level: "mvp", files: document ? ["docs/control.md"] : ["src/output.txt"], status: currentGateStatus, checks: [{ id: "check-ok", name: "Deterministic check", required: true, status: currentGateStatus, exit_code: 0, duration_ms: 17 }], summary: `${currentGateStatus}: deterministic check` };
  };
  const previousProviderHome = process.env.CODEX_SOURCE_HOME;
  if (realDocumentatorGateway) process.env.CODEX_SOURCE_HOME = providerHome;
  let result;
  try {
    result = await statelessProcessMessage({
      message: message ?? (document ? "Update the registered document" : "Implement bounded output"), project: env.project, dbFile: env.dbFile,
      workflowDefinition: { id: "workflow", authority: "registered test authority", roles: {} }, execute: true,
      classificationResult: classification(document, risk), gatewayCall, gateRunner, runProfileOverrides
    });
  } finally {
    if (previousProviderHome === undefined) delete process.env.CODEX_SOURCE_HOME; else process.env.CODEX_SOURCE_HOME = previousProviderHome;
  }
  return { ...env, calls, plannerPrompt, workerPrompt, documentatorPrompt, result };
}

test("role result schemas reject extra fields, path escapes and false reviewer PASS", () => {
  const env = fixture("workflow-role-schema-");
  const db = openDb(env.dbFile);
  const contract = loadRoleContract(db, "project", "planner", "mvp");
  const roles = db.prepare("SELECT id FROM roles").all().map(row => row.id);
  const checks = ["check-ok"], artifacts = db.prepare("SELECT id FROM artifact_types").all().map(row => row.id);
  assert.throws(() => validatePlannerResult({ ...plannerResult(), extra: true }, { contract, registeredRoles: roles, registeredChecks: checks, registeredArtifactTypes: artifacts }), /fields mismatch/);
  const workerContract = loadRoleContract(db, "project", "worker", "mvp");
  assert.throws(() => validateWorkerResult({ schema_version: 1, status: "completed", summary: "x", changed_paths: ["../outside"], artifacts: [], evidence: [], questions: [], external_evidence_request: null }, { contract: workerContract, packageContract: { allowed_paths: ["src/output.txt"], artifact_keys: [] } }), /relative project path/);
  assert.throws(() => validateReviewerResult({ ...reviewerResult("PASS"), blockers: [{ code: "x", message: "hidden blocker", path: null }] }), /PASS cannot contain blockers/);
  const judgePass = { schema_version: 1, decision: "PASS", rationale: "The admissible evidence supports completion.", evidence_refs: ["evidence-1"], primary_gap: null, verification_request: null, state_patch: { schema_version: 1, patch_id: "state_patch_judge", base_projection_hash: "b".repeat(64), changes: [{ operation: "replace_active", path: "decisions.judge_resolution" }] } };
  assert.equal(validateJudgeResult(structuredClone(judgePass)).decision, "PASS");
  assert.throws(() => validateJudgeResult({ ...judgePass, decision: "TARGETED_VERIFICATION" }), /decision payload mismatch/);
  assert.throws(() => validateJudgeResult({ ...judgePass, rationale: "PRIMARY_GAP hidden in prose" , extra: true }), /fields mismatch/);
  const strategy = { schema_version: 1, decision: "SELECT_EXISTING_STEP", rationale: "The bounded source step targets the gap.", selected_step_keys: ["trace"], verification_request: null, replan_intent: null, evidence_refs: ["gap-1"], state_patch: { schema_version: 1, patch_id: "state_patch_test", base_projection_hash: "a".repeat(64), changes: [{ operation: "replace_active", path: "decisions.strategy_recovery" }] } };
  assert.deepEqual(validateStrategyReviewResult(structuredClone(strategy), { availableStepKeys: ["trace"] }).selected_step_keys, ["trace"]);
  assert.throws(() => validateStrategyReviewResult(structuredClone(strategy), { availableStepKeys: ["trace"], statePatchContract: { patch_id: "another", base_projection_hash: "b".repeat(64) } }), /state patch contract mismatch/);
  assert.throws(() => validateStrategyReviewResult({ ...strategy, selected_step_keys: ["invented"] }, { availableStepKeys: ["trace"] }), /unknown selected step/);
  assert.throws(() => validateDocumentatorResult({ schema_version: 1, status: "proposed", document_id: "unknown", expected_version: null, operation: "create_document", authority: "owner", content: "x", section_id: null, decision_id: null, evidence_id: null, status_value: null, target_tag: null, target_id: null, replacement_id: null }, { allowedDocumentIds: ["control"] }), /document not allowed/);
  assert.throws(() => validateDocumentatorResult({ schema_version: 1, status: "proposed", document_id: "control", expected_version: null, operation: "blocked_write_read_only_sandbox", authority: "owner", content: null, section_id: null, decision_id: null, evidence_id: null, status_value: null, target_tag: null, target_id: null, replacement_id: null }, { allowedDocumentIds: ["control"] }), /invalid operation/);
  assert.match(rolePrompt({ contract, qualityContract: loadQualityContract(db, "mvp"), packageContract: { objective: "x" }, context: {}, resultSchema: "planner.v1" }), /<workflow_role_prompt/);
  const workerPrompt = rolePrompt({ contract: workerContract, qualityContract: loadQualityContract(db, "mvp"), packageContract: { objective: "trace absentIdentifier", allowed_paths: ["src/output.txt"] }, context: {}, resultSchema: "worker.v1" });
  assert.match(workerPrompt, /No tool calls are authorized/);
  assert.match(workerPrompt, /analyze only the evidence already present/);
  assert.match(workerPrompt, /complete-file exact term scan with count zero is conclusive negative evidence/);
  assert.match(workerPrompt, /positive count must never be summarized as absent/);
  assert.match(workerPrompt, /do not return blocked or ask for out-of-scope sources/);
  const reviewerContract = loadRoleContract(db, "project", "reviewer", "mvp");
  const reviewerPrompt = rolePrompt({ contract: reviewerContract, qualityContract: loadQualityContract(db, "mvp"), packageContract: { plan: { artifacts: [{ type: "document", required: true }] }, worker_results: [{ artifacts: [], changed_paths: [] }] }, context: {}, resultSchema: "reviewer.v1" });
  assert.match(reviewerPrompt, /before the documentator/);
  assert.match(reviewerPrompt, /absence from worker artifacts or changed_paths is not a blocker/);
  assert.match(reviewerPrompt, /PASS requires blockers=\[\] and required_actions=\[\]/);
  assert.match(reviewerPrompt, /Never return PASS while describing a blocker/);
  const repairPrompt = rolePrompt({ contract: reviewerContract, qualityContract: loadQualityContract(db, "mvp"), packageContract: { schema_repair: { validation_error: "reviewer.v1: PASS cannot contain blockers" } }, context: {}, resultSchema: "reviewer.v1" });
  assert.match(repairPrompt, /schema_repair/);
  assert.match(reviewerPrompt, /Final receipt totals, calls, tokens, cache, total duration/);
  assert.match(reviewerPrompt, /their absence from review_evidence is not a blocker/);
  assert.match(reviewerPrompt, /Use CHANGES_REQUESTED for an evidence gap/);
  assert.equal(parseRoleReceipt(receipt("reviewer", reviewerResult("PASS")), "reviewer.v1", {}).decision, "PASS");
  assert.ok(classificationCatalog(db, "project", { mode: "stateless" }).routes.length >= 2);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("operator receipts can only reference a registered exact operation", () => {
  const release = { schema_version: 1, status: "proposed", operation_id: "release.prod", target_revision: "a".repeat(40), target_environment: "production", artifact_refs: ["artifact:build"], evidence_refs: ["gate:passed"], summary: "Deploy the verified revision." };
  assert.deepEqual(parseRoleReceipt(receipt("release_operator", release), "release_operation.v1", { allowedOperationIds: ["release.prod"] }), release);
  assert.throws(() => parseRoleReceipt(receipt("release_operator", { ...release, operation_id: "shell.anything" }), "release_operation.v1", { allowedOperationIds: ["release.prod"] }), /operation not registered/);
  const access = { schema_version: 1, status: "proposed", operation_id: "access.project", subject: "analyst@example.test", resource: "analytics", grant: ["reader"], revoke: [], expires_at: null, evidence_refs: ["decision:owner"], summary: "Grant the smallest registered role." };
  assert.deepEqual(parseRoleReceipt(receipt("access_administrator", access), "access_change.v1", { allowedOperationIds: ["access.project"] }), access);
  assert.throws(() => parseRoleReceipt(receipt("access_administrator", { ...access, grant: [], revoke: [] }), "access_change.v1", { allowedOperationIds: ["access.project"] }), /empty permission delta/);
});

test("structured planner-worker-gate-reviewer PASS completes and raw planner prose never reaches worker", async () => {
  const env = await scenario({ prefix: "workflow-structured-pass-" });
  assert.equal(env.result.execution.status, "completed");
  assert.deepEqual(env.calls, ["planner", "worker", "reviewer"]);
  assert.equal(env.workerPrompt.includes("RAW_PLANNER_PROSE_MARKER"), false);
  assert.match(env.plannerPrompt, /more than four source paths/);
  assert.match(env.plannerPrompt, /split into sequential read-only investigation steps/);
  assert.match(env.plannerPrompt, /production definitions, their production call sites/);
  assert.match(env.plannerPrompt, /discovered production symbol names and exact line anchors/);
  assert.match(env.plannerPrompt, /Keep separate mechanisms separate/);
  assert.match(env.workerPrompt, /code_intelligence/);
  assert.match(env.workerPrompt, /compiler_available/);
  assert.match(env.plannerPrompt, /set artifact_keys=\[\] on every read-only investigation step/);
  assert.match(env.plannerPrompt, /only the one final path requested by the owner/);
  const db = openDb(env.dbFile);
  assert.equal(db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(env.result.run_id).state, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND state='completed'").get(env.result.run_id).count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM gateway_calls WHERE run_id=? AND length(contract_hash)=64 AND length(result_hash)=64").get(env.result.run_id).count, 3);
  assert.equal(JSON.stringify(db.prepare("SELECT result_json FROM workflow_steps WHERE run_id=?").all(env.result.run_id)).includes("RAW_PLANNER_PROSE_MARKER"), false);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("ensemble planning collects independent candidates before one synthesized executable plan", async () => {
  const env = await scenario({ prefix: "workflow-planning-ensemble-", runProfileOverrides: { execution_mode: "standard", verification_mode: "baseline", planning_mode: "ensemble" } });
  assert.equal(env.result.execution.status, "completed");
  assert.deepEqual(env.calls.slice(0, 3), ["coordinator", "planner", "planner"]);
  const db = openDb(env.dbFile);
  try {
    const evidence = db.prepare("SELECT evidence_json FROM run_evidence WHERE run_id=? AND kind='planning_ensemble'").get(env.result.run_id);
    assert.ok(evidence);
    const packet = JSON.parse(evidence.evidence_json);
    assert.equal(packet.candidate_count, 2);
    assert.equal(packet.candidate_hashes.length, 2);
    assert.equal(packet.synthesis_hash.length, 64);
    const planningSteps = db.prepare("SELECT step_key,state FROM workflow_steps WHERE run_id=? AND step_key LIKE 'planning_%' ORDER BY ordinal").all(env.result.run_id);
    assert.deepEqual(planningSteps.map(item => item.step_key), ["planning_candidate_1", "planning_candidate_2", "planning_synthesis"]);
    assert.equal(planningSteps.every(item => item.state === "completed"), true);
  } finally { db.close(); }
});

test("profile preparation completes before any planner or productive model call", async () => {
  const env = fixture("workflow-profile-prepare-");
  let calls = 0;
  const result = await statelessProcessMessage({
    message: "Implement bounded output", project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "registered test authority", roles: {} }, execute: true, prepareOnly: true,
    classificationResult: classification(false, "high"),
    runProfileOverrides: { execution_mode: "goal", verification_mode: "gauntlet", planning_mode: "ensemble" },
    gatewayCall: async () => { calls += 1; throw new Error("model call must not happen during preparation"); }
  });
  assert.equal(result.route, "prepared");
  assert.equal(calls, 0);
  assert.equal(result.run_profile.execution_mode, "goal");
  assert.equal(result.run_profile.verification_mode, "gauntlet");
  assert.equal(result.run_profile.planning_mode, "ensemble");
  const db = openDb(env.dbFile);
  try { assert.equal(db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "completed"); }
  finally { db.close(); }
});

test("a raised quality decision is shown again instead of silently executing an older prepared profile", async () => {
  const env = fixture("workflow-profile-raised-");
  let calls = 0;
  const result = await statelessProcessMessage({
    message: "Implement bounded output", project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "registered test authority", roles: {} }, execute: true,
    classificationResult: classification(false, "high"),
    runProfileOverrides: { quality_mode: "prototype", execution_mode: "standard", verification_mode: "baseline", planning_mode: "single" },
    gatewayCall: async () => { calls += 1; throw new Error("productive model call must wait for the raised profile confirmation"); }
  });
  assert.equal(result.route, "prepared");
  assert.equal(result.run_profile.quality_mode, "mvp");
  assert.match(result.response, /changed the profile/i);
  assert.equal(calls, 0);
});

test("goal execution is not stopped by the standard correction-cycle count while factual progress continues", async () => {
  const env = await scenario({
    prefix: "workflow-goal-corrections-",
    gateStatuses: ["failed", "failed", "passed"],
    runProfileOverrides: { execution_mode: "goal", verification_mode: "baseline", planning_mode: "single" }
  });
  assert.equal(env.result.execution.status, "completed");
  assert.equal(env.result.execution.correction_cycles, 2);
  const db = openDb(env.dbFile);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) count FROM run_evidence WHERE run_id=? AND kind='goal_correction_cycle'").get(env.result.run_id).count, 2);
    assert.equal(db.prepare("SELECT correction_cycles FROM workflow_runs WHERE id=?").get(env.result.run_id).correction_cycles, 2);
  } finally { db.close(); }
});

test("a long Goal route presents one helicopter-view reflection to the next model role", async () => {
  const env = await scenario({
    prefix: "workflow-goal-reflection-",
    longPlannerWork: true,
    runProfileOverrides: { execution_mode: "goal", verification_mode: "baseline", planning_mode: "single" }
  });
  assert.equal(env.result.execution.status, "completed");
  assert.match(env.workerPrompt, /reflection_checkpoint/);
  assert.match(env.workerPrompt, /Helicopter-view checkpoint/);
  const db = openDb(env.dbFile);
  try {
    const checkpoints = db.prepare("SELECT trigger_role,status,result_hash FROM run_reflection_checkpoints WHERE run_id=? ORDER BY sequence").all(env.result.run_id);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].trigger_role, "worker");
    assert.equal(checkpoints[0].status, "applied");
    assert.equal(checkpoints[0].result_hash.length, 64);
  } finally { db.close(); }
});

test("a contradictory reviewer result is repaired once inside the same review phase", async () => {
  const env = await scenario({ prefix: "workflow-reviewer-schema-repair-", invalidFirstReviewer: true });
  assert.equal(env.result.execution.status, "completed");
  assert.deepEqual(env.calls, ["planner", "worker", "reviewer", "reviewer"]);
  const db = openDb(env.dbFile);
  const runId = env.result.run_id;
  assert.equal(db.prepare("SELECT COUNT(*) count FROM attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? AND s.result_schema_key='reviewer.v1'").get(runId).count, 2);
  assert.equal(db.prepare("SELECT state FROM workflow_steps WHERE run_id=? AND result_schema_key='reviewer.v1'").get(runId).state, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM run_evidence WHERE run_id=? AND kind='reviewer_schema_repair'").get(runId).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM run_evidence WHERE run_id=? AND kind='role_result_validation_error'").get(runId).count, 1);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a planner artifact schema error is repaired once before the run is failed", async () => {
  const env = await scenario({ prefix: "workflow-planner-schema-repair-", invalidFirstPlanner: true });
  assert.equal(env.result.execution.status, "completed");
  assert.deepEqual(env.calls, ["planner", "planner", "worker", "reviewer"]);
  const db = openDb(env.dbFile);
  const runId = env.result.run_id;
  assert.equal(db.prepare("SELECT COUNT(*) count FROM attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? AND s.result_schema_key='planner.v1'").get(runId).count, 2);
  assert.equal(db.prepare("SELECT state FROM workflow_steps WHERE run_id=? AND result_schema_key='planner.v1'").get(runId).state, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM run_evidence WHERE run_id=? AND kind='planner_schema_repair'").get(runId).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM run_evidence WHERE run_id=? AND kind='role_result_validation_error'").get(runId).count, 1);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("low-risk green MVP still receives its required independent reviewer", async () => {
  const env = await scenario({ prefix: "workflow-structured-low-risk-", risk: "low" });
  assert.equal(env.result.execution.status, "completed");
  assert.deepEqual(env.calls, ["planner", "worker", "reviewer"]);
  assert.equal(env.result.execution.reviewer.decision, "PASS");
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a pathless decision artifact is materialized from worker evidence instead of requiring a file", async () => {
  const env = fixture("workflow-worker-decision-");
  const setup = openDb(env.dbFile);
  for (const role of ["planner", "worker"]) setup.prepare("UPDATE role_contracts SET allowed_artifact_types_json='[\"code\",\"document\",\"decision\"]' WHERE project_id='project' AND role_id=? AND status='active'").run(role);
  setup.close();
  const plan = plannerResult();
  plan.allowed_paths = [];
  plan.artifacts = [{ key: "analysis-findings", type: "decision", path: null, required: true }];
  plan.steps[0] = { ...plan.steps[0], objective: "Establish the finding from supplied sources", allowed_paths: [], artifact_keys: ["analysis-findings"] };
  const result = await statelessProcessMessage({
    message: "Establish a bounded analytical finding", project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, classificationResult: classification(false),
    gatewayCall: async request => {
      if (request.role === "planner") return receipt("planner", plan);
      if (request.role === "worker") return receipt("worker", { schema_version: 1, status: "completed", summary: "The entry point is established.", changed_paths: [], artifacts: [], evidence: ["Form calls the server export procedure."], questions: [], external_evidence_request: null });
      if (request.role === "reviewer") return receipt("reviewer", reviewerResult("PASS"));
      throw new Error(`unexpected role ${request.role}`);
    },
    gateRunner: async () => ({ task_id: "gate", project: env.project, level: "mvp", files: [], status: "passed", checks: [{ id: "check-ok", required: true, status: "passed" }], summary: "passed" })
  });
  assert.equal(result.execution.status, "completed");
  const db = openDb(env.dbFile);
  const decision = db.prepare("SELECT outcome,source,structured_json FROM decisions WHERE run_id=? AND kind='artifact:analysis-findings'").get(result.run_id);
  assert.equal(decision.outcome, "COMPLETED");
  assert.equal(decision.source, "worker");
  assert.match(decision.structured_json, /Form calls the server export procedure/);
  assert.equal(db.prepare("SELECT state FROM workflow_steps WHERE run_id=? AND result_schema_key='worker.v1'").get(result.run_id).state, "completed");
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("final document artifacts stay with the documentator even when a planner assigns them to a worker", async () => {
  const env = fixture("workflow-new-planned-document-");
  const plan = plannerResult({ document: true });
  plan.allowed_paths = ["src/output.txt", "docs/new-analysis.md"];
  plan.artifacts = [{ key: "new-analysis", type: "document", path: "docs/new-analysis.md", required: true }];
  plan.steps[0] = { ...plan.steps[0], allowed_paths: ["src/output.txt"], artifact_keys: ["new-analysis"] };
  let workerPrompt = "";
  const result = await statelessProcessMessage({
    message: "Create a new analysis document", project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, classificationResult: classification(true),
    gatewayCall: async request => {
      if (request.role === "planner") return receipt("planner", plan);
      if (request.role === "worker") { workerPrompt = fs.readFileSync(request.taskFile, "utf8"); return receipt("worker", { schema_version: 1, status: "completed", summary: "Evidence prepared.", changed_paths: [], artifacts: [], evidence: ["bounded source"], questions: [], external_evidence_request: null }); }
      if (request.role === "reviewer") return receipt("reviewer", reviewerResult("PASS"));
      if (request.role === "documentator") { const lookup = openDb(env.dbFile); const documentId = lookup.prepare("SELECT id FROM project_documents WHERE project_id='project' AND path='docs/new-analysis.md'").get().id; lookup.close(); return receipt("documentator", { schema_version: 1, status: "proposed", document_id: documentId, expected_version: null, operation: "create_document", authority: "workflow", content: '<document id="new_analysis" status="working" authority="workflow" version="1.0"><section id="summary" status="working">New analysis</section></document>', section_id: null, decision_id: null, evidence_id: null, status_value: null, target_tag: null, target_id: null, replacement_id: null }); }
      throw new Error(`unexpected role ${request.role}`);
    },
    gateRunner: async () => ({ task_id: "gate", project: env.project, level: "mvp", files: [], status: "passed", checks: [{ id: "check-ok", required: true, status: "passed" }], summary: "passed" })
  });
  assert.equal(result.execution.status, "completed");
  assert.match(workerPrompt, /&quot;artifact_keys&quot;:\[\]/);
  assert.match(fs.readFileSync(path.join(env.project, "docs", "new-analysis.md"), "utf8"), /New analysis/);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a worker artifact verification failure settles the worker step", async () => {
  const env = fixture("workflow-worker-artifact-failure-");
  const result = await statelessProcessMessage({
    message: "Implement bounded output", project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, classificationResult: classification(false),
    gatewayCall: async request => {
      if (request.role === "planner") return receipt("planner", plannerResult());
      if (request.role === "worker") return receipt("worker", { schema_version: 1, status: "completed", summary: "Claimed output.", changed_paths: [], artifacts: [{ key: "code-output", type: "code", path: "src/output.txt", content_hash: null, status: "created" }], evidence: [], questions: [], external_evidence_request: null });
      throw new Error(`unexpected role ${request.role}`);
    }
  });
  assert.equal(result.route, "execution_failed");
  assert.equal(result.execution.error, "WORKER_ARTIFACT_FILE_MISSING");
  const db = openDb(env.dbFile);
  assert.equal(db.prepare("SELECT state FROM workflow_steps WHERE run_id=? AND result_schema_key='worker.v1'").get(result.run_id).state, "blocked");
  assert.equal(db.prepare("SELECT a.state FROM attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? AND s.result_schema_key='worker.v1'").get(result.run_id).state, "failed");
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("planner questions stop before worker and become plain pending clarifications", async () => {
  const env = fixture("workflow-planner-questions-");
  let calls = 0;
  const questions = {
    schema_version: 1, outcome: "questions", scope: { included: [], excluded: [] }, allowed_paths: [], inputs: [], checks: [], risks: [], artifacts: [],
    completion_criteria: [], questions: ["Какой файл разрешено изменить?"], steps: []
  };
  const result = await statelessProcessMessage({
    message: "Change it", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} },
    execute: true, classificationResult: classification(false), gatewayCall: async () => { calls += 1; return receipt("planner", questions); }
  });
  assert.equal(calls, 1);
  assert.equal(result.execution.status, "clarification_required");
  assert.match(result.response, /Какой файл разрешено изменить\?/);
  const db = openDb(env.dbFile);
  assert.equal(db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "clarification_required");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=?").get(result.run_id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE run_id=? AND status='pending'").get(result.run_id).count, 1);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("planner source evidence is fitted to its byte contract and keeps the best matching path", async () => {
  const env = fixture("workflow-planner-source-budget-");
  const matchingLine = suffix => `avgCost = 620008; // себестоимость ${suffix} ${"x".repeat(210)}`;
  fs.writeFileSync(path.join(env.project, "src", "000-relevant.bsl"), Array.from({ length: 6 }, (_, index) => matchingLine(`relevant-${index}`)).join("\n"));
  for (let index = 0; index < 450; index += 1) {
    const name = `noise-${String(index).padStart(3, "0")}.bsl`;
    fs.writeFileSync(path.join(env.project, "src", name), Array.from({ length: 6 }, (_, line) => matchingLine(`${index}-${line}`)).join("\n"));
  }
  const db = openDb(env.dbFile);
  db.prepare("UPDATE role_contracts SET context_limit_bytes=24000 WHERE project_id='project' AND role_id='planner' AND status='active'").run();
  db.close();
  let plannerPrompt = "";
  const questions = {
    schema_version: 1, outcome: "questions", scope: { included: [], excluded: [] }, allowed_paths: [], inputs: [], checks: [], risks: [], artifacts: [],
    completion_criteria: [], questions: ["Остановиться после проверки контекста?"], steps: []
  };
  const result = await statelessProcessMessage({
    message: "Проверь avgCost и себестоимость для артикула 620008", project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, classificationResult: classification(false),
    gatewayCall: async request => { plannerPrompt = fs.readFileSync(request.taskFile, "utf8"); return receipt("planner", questions); }
  });
  assert.equal(result.execution.status, "clarification_required");
  assert.ok(Buffer.byteLength(plannerPrompt) <= 24000);
  assert.match(plannerPrompt, /src\/000-relevant\.bsl/);
  assert.match(plannerPrompt, /budget_truncation/);
  assert.match(plannerPrompt, /exact_term_index/);
  assert.match(plannerPrompt, /A need for more registered source content is a worker investigation step/);
  assert.doesNotMatch(plannerPrompt, /src\/noise-449\.bsl/);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("worker prompt fits the final byte contract and receives requested regions from a large source", async () => {
  const env = fixture("workflow-worker-source-budget-");
  const lines = Array.from({ length: 4500 }, (_, index) => `Строка${index + 1} = "обычный код";`);
  lines[99] = "LocalEntryMarker = ВыполнитьРегламентнуюВыгрузку();";
  lines[2799] = "СебестоимостьМаркер2800 = Источник.Себестоимость;";
  lines[4399] = "СебестоимостьМаркер4400 = Строка.Себестоимость;";
  fs.writeFileSync(path.join(env.project, "src", "large.bsl"), lines.join("\n"));
  const db = openDb(env.dbFile);
  db.prepare("UPDATE role_contracts SET context_limit_bytes=24000 WHERE project_id='project' AND role_id='worker' AND status='active'").run();
  db.close();
  const plan = plannerResult();
  plan.allowed_paths.push("src/large.bsl");
  plan.steps[0].allowed_paths = ["src/large.bsl"];
  // Path-bound task evidence is part of the final prompt envelope. Under the previous fixed 80% source
  // estimate this extra measured evidence forced promptWithinContract to prefix-cut source text after
  // the collector had selected it.
  plan.inputs.push(`bounded-evidence:${"x".repeat(6000)}`);
  // The real planner reduced this to a short objective and kept the exact ranges only in the original
  // request. The collector must retain those global hints when it prepares this worker's source.
  plan.steps[0].objective = "Проследи LocalEntryMarker и точку запуска";
  let workerPrompt = "";
  const result = await statelessProcessMessage({
    message: "Разбери большой BSL-модуль: СебестоимостьМаркер2800 в строках 2750–2850 и СебестоимостьМаркер4400 в строках 4380–4460", project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, classificationResult: classification(false),
    gatewayCall: async request => {
      if (request.role === "planner") return receipt("planner", plan);
      if (request.role === "worker") {
        workerPrompt = fs.readFileSync(request.taskFile, "utf8");
        return receipt("worker", { schema_version: 1, status: "blocked", summary: "Fixture stops after context inspection.", changed_paths: [], artifacts: [], evidence: ["prompt captured"], questions: [], external_evidence_request: null });
      }
      throw new Error(`unexpected role ${request.role}`);
    }
  });
  assert.equal(result.execution.status, "blocked");
  assert.ok(Buffer.byteLength(workerPrompt) <= 24000);
  assert.match(workerPrompt, /LocalEntryMarker/);
  assert.match(workerPrompt, /СебестоимостьМаркер2800/);
  assert.match(workerPrompt, /СебестоимостьМаркер4400/);
  assert.match(workerPrompt, /task_evidence/);
  assert.match(workerPrompt, /plan_inputs/);
  assert.match(workerPrompt, /requested_ranges_and_objective_matches/);
  assert.doesNotMatch(workerPrompt, /"prompt_truncated":true/);
  assert.doesNotMatch(workerPrompt, /Строка1 =/);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("independent plan steps using one role receive independent role call budgets", async () => {
  const env = fixture("workflow-role-budget-per-step-");
  const db = openDb(env.dbFile);
  db.prepare("UPDATE role_contracts SET max_calls=1 WHERE project_id='project' AND role_id='worker' AND status='active'").run();
  db.close();
  const plan = plannerResult();
  plan.allowed_paths = []; plan.artifacts = [];
  plan.steps = ["first-analysis", "second-analysis"].map(key => ({
    key, role: "worker", objective: `Complete ${key}`, allowed_paths: [], artifact_keys: [], check_ids: ["check-ok"], resources: [], required: true, irreversible: false, max_attempts: 1
  }));
  let workerCalls = 0, secondPrompt = "";
  const result = await statelessProcessMessage({
    message: "Run two bounded analysis packages", project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, classificationResult: classification(false),
    gatewayCall: async request => {
      if (request.role === "planner") return receipt("planner", plan);
      if (request.role === "worker") {
        workerCalls += 1;
        if (workerCalls === 2) secondPrompt = fs.readFileSync(request.taskFile, "utf8");
        return receipt("worker", { schema_version: 1, status: "completed", summary: `Completed package ${workerCalls}.`, changed_paths: [], artifacts: [], evidence: [`evidence-from-package-${workerCalls}`], questions: [], external_evidence_request: null }, String(workerCalls));
      }
      if (request.role === "reviewer") return receipt("reviewer", reviewerResult("PASS"));
      throw new Error(`unexpected role ${request.role}`);
    },
    gateRunner: async () => ({ task_id: "gate", project: env.project, level: "mvp", files: [], status: "passed", checks: [{ id: "check-ok", required: true, status: "passed" }], summary: "passed" })
  });
  assert.equal(workerCalls, 2);
  assert.equal(result.execution.status, "completed");
  assert.match(secondPrompt, /prior_worker_results/);
  assert.match(secondPrompt, /Completed package 1\./);
  assert.match(secondPrompt, /evidence-from-package-1/);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("configured project call budget hard-stops the real role wrapper before Gateway invocation", async () => {
  const env = fixture("workflow-structured-budget-stop-");
  const setup = openDb(env.dbFile);
  new BudgetManager(setup).define({ scopeType: "project", scopeId: "project", metric: "calls", limit: 0 });
  setup.close();
  let calls = 0;
  const result = await statelessProcessMessage({
    message: "Implement bounded output", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} },
    execute: true, classificationResult: classification(false), gatewayCall: async () => { calls += 1; return receipt("planner", plannerResult()); }
  });
  assert.equal(calls, 0);
  assert.equal(result.route, "execution_failed");
  assert.equal(result.execution.status, "blocked");
  const db = openDb(env.dbFile);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id=? AND kind='budget_hard_stop'").get(result.run_id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM gateway_calls WHERE run_id=?").get(result.run_id).count, 0);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a receipt is linked even when post-receipt token accounting exhausts the budget", async () => {
  const env = await scenario({ prefix: "workflow-post-receipt-budget-", projectInputTokenLimit: 5 });
  assert.equal(env.result.route, "execution_failed");
  assert.deepEqual(env.calls, ["planner"]);
  const db = openDb(env.dbFile);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM gateway_calls WHERE run_id=? AND role_id='planner'").get(env.result.run_id).count, 1);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

// A route that declares its steps has already been planned by whoever wrote it. Re-deriving that shape
// from a model is what let a plan name steps the route does not have, so a route without a declared
// planning step is executed exactly as declared, with no planning call at all.
test("a route that declares its steps without planning runs them without a planner call", async () => {
  const env = fixture("workflow-derived-plan-");
  const db = openDb(env.dbFile);
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow',?,?,?,1,0,'package.v1',?,'[]','[\"check-ok\"]','{}','{}')").run("inspect", 1, "worker", "worker.v1");
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow',?,?,?,1,0,'package.v1',?,'[]','[\"check-ok\"]','{}','{}')").run("review", 2, "reviewer", "reviewer.v1");
  db.close();
  const calls = [];
  const result = await statelessProcessMessage({
    message: "Проверь зарегистрированный контекст", project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, classificationResult: classification(false),
    gatewayCall: async request => {
      calls.push(request.role);
      if (request.role === "worker") return receipt("worker", { schema_version: 1, status: "completed", summary: "Inspected.", changed_paths: [], artifacts: [], evidence: ["registered context"], questions: [], external_evidence_request: null });
      if (request.role === "reviewer") return receipt("reviewer", reviewerResult("PASS"));
      throw new Error(`unexpected role ${request.role}`);
    },
    gateRunner: async () => ({ task_id: "gate", project: env.project, level: "mvp", files: [], status: "passed", checks: [{ id: "check-ok", required: true, status: "passed" }], summary: "passed" })
  });
  assert.equal(calls.includes("planner"), false);
  assert.equal(result.execution.status, "completed");
  const verified = openDb(env.dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM workflow_steps WHERE run_id=? AND step_key='planning'").get(result.run_id).count, 0);
  assert.equal(verified.prepare("SELECT step_key FROM workflow_steps WHERE run_id=? ORDER BY ordinal LIMIT 1").get(result.run_id).step_key, "inspect");
  verified.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

// Nothing in that derivation can produce an allowed path, and a worker without one may change nothing.
// A route whose workers may write therefore has to declare planning rather than fail inside the worker.
test("a declared route whose worker may write is refused without a planning step", async () => {
  const env = fixture("workflow-derived-plan-writer-");
  const db = openDb(env.dbFile);
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow',?,?,?,1,0,'package.v1',?,'[]','[\"check-ok\"]','{}','{}')").run("apply", 1, "worker", "worker.v1");
  db.prepare("UPDATE role_contracts SET allowed_tools_json='[\"apply_patch\"]' WHERE role_id='worker'").run();
  db.close();
  let calls = 0;
  const result = await statelessProcessMessage({
    message: "Внеси изменение", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} },
    execute: true, classificationResult: classification(false), gatewayCall: async () => { calls += 1; throw new Error("must not be called"); }
  });
  assert.equal(calls, 0);
  assert.equal(result.execution.error, "WORKFLOW_WRITING_STEP_REQUIRES_PLANNING");
  fs.rmSync(env.root, { recursive: true, force: true });
});

// A person asked to authorize an action can also be neither agreeing nor refusing. Reading that as a
// yes takes an action they were still deciding about, so doubt leaves the decision exactly where it was.
async function approvalScenario(prefix, ownerResponse, beforeDecision = null) {
  const env = fixture(prefix);
  const semanticScope = { mode: "session", client: "codex", session_id: `${prefix}chat` };
  const db = openDb(env.dbFile);
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow',?,?,?,1,?,'package.v1',?,'[]','[\"check-ok\"]','{}','{}')").run("owner_approval", 1, null, 1, "approval.v1");
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow',?,?,?,1,?,'package.v1',?,'[]','[\"check-ok\"]','{}','{}')").run("apply", 2, "worker", 0, "worker.v1");
  activateChatSession(db, { client: semanticScope.client, sessionId: semanticScope.session_id, origin: env.project, turnKey: "turn-1" });
  db.close();
  const first = await scopedProcessMessage({
    message: "Разверни изменение", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} },
    execute: true, semanticScope, classificationResult: classification(false), gatewayCall: async () => { throw new Error("must not be called"); }
  });
  assert.equal(first.execution.status, "approval_required");
  const opened = openDb(env.dbFile);
  const approval = opened.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(first.run_id);
  opened.close();
  if (beforeDecision) beforeDecision(env.dbFile, approval.id);
  const calls = [];
  const second = await scopedProcessMessage({
    message: "ответ владельца", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, semanticScope,
    classificationResult: { ...classification(false), work_type: "conversation", artifact_type: "none", planning_required: false, reply_mode: "conversation", human_response: "Записал.", pending_interaction_id: approval.id, pending_interaction_response: ownerResponse },
    gatewayCall: async request => {
      calls.push(request.role);
      if (request.role === "worker") return receipt("worker", { schema_version: 1, status: "completed", summary: "Applied.", changed_paths: [], artifacts: [], evidence: ["bounded"], questions: [], external_evidence_request: null });
      if (request.role === "reviewer") return receipt("reviewer", reviewerResult("PASS"));
      throw new Error(`unexpected role ${request.role}`);
    },
    gateRunner: async () => ({ task_id: "gate", project: env.project, level: "mvp", files: [], status: "passed", checks: [{ id: "check-ok", required: true, status: "passed" }], summary: "passed" })
  });
  const db2 = openDb(env.dbFile);
  const approvalRow = db2.prepare("SELECT status,binding_hash,binding_json,superseded_by FROM approvals WHERE id=?").get(approval.id);
  const state = { approval: approvalRow.status, binding_hash: approvalRow.binding_hash, binding_json: approvalRow.binding_json, superseded_by: approvalRow.superseded_by, run: db2.prepare("SELECT state FROM workflow_runs WHERE id=?").get(first.run_id).state };
  db2.close();
  return { env, first, second, calls, state };
}

test("an unambiguous yes continues the waiting run instead of starting a new one", async () => {
  const { env, first, second, calls, state } = await approvalScenario("workflow-owner-approve-", "approve");
  assert.equal(state.approval, "approved");
  assert.equal(second.route, "work");
  assert.equal(second.execution.status, "completed");
  assert.equal(calls.includes("worker"), true);
  assert.equal(state.run, "completed");
  assert.match(state.binding_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(state.binding_json).action.step_key, "owner_approval");
  assert.notEqual(second.run_id, first.run_id);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a refusal closes the waiting run and takes no action", async () => {
  const { env, second, calls, state } = await approvalScenario("workflow-owner-decline-", "decline");
  assert.equal(state.approval, "rejected");
  assert.equal(state.run, "cancelled");
  assert.deepEqual(calls, []);
  assert.equal(second.route, "owner_decision");
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("doubt is neither consent nor refusal: the decision stays open and nothing is done", async () => {
  const { env, first, second, calls, state } = await approvalScenario("workflow-owner-undecided-", "undecided");
  assert.equal(state.approval, "pending");
  assert.equal(state.run, "approval_required");
  assert.deepEqual(calls, []);
  assert.equal(second.route, "conversation");
  assert.notEqual(second.run_id, first.run_id);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("approval is superseded when its exact plan changes before the action boundary", async () => {
  const mutatePlan = dbFile => {
    const db = openDb(dbFile);
    db.prepare("UPDATE plans SET risks_json='[\"new production radius\"]' WHERE status='authorized'").run();
    db.close();
  };
  const { env, second, calls, state } = await approvalScenario("workflow-owner-stale-binding-", "approve", mutatePlan);
  assert.equal(second.route, "owner_decision_stale");
  assert.equal(state.approval, "superseded");
  assert.equal(state.run, "approval_required");
  assert.deepEqual(calls, []);
  const verified = openDb(env.dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM approvals WHERE id=? AND status='pending'").get(state.superseded_by).count, 1);
  verified.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a workflow whose every step is named for verification still has a role to run it", async () => {
  const env = fixture("workflow-verification-only-");
  const db = openDb(env.dbFile);
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','checks',1,'worker',1,0,'package.v1','worker.v1','[]','[\"check-ok\"]','{}','{}')").run();
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','review',2,'reviewer',1,0,'package.v1','reviewer.v1','[]','[\"check-ok\"]','{}','{}')").run();
  db.close();
  const calls = [];
  const result = await statelessProcessMessage({
    message: "Прогони зарегистрированные проверки", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} },
    execute: true, classificationResult: classification(false),
    gatewayCall: async request => {
      calls.push(request.role);
      if (request.role === "worker") return receipt("worker", { schema_version: 1, status: "completed", summary: "Проверки выполнены.", changed_paths: [], artifacts: [], evidence: ["gate"], questions: [], external_evidence_request: null });
      if (request.role === "reviewer") return receipt("reviewer", reviewerResult("PASS"));
      throw new Error(`unexpected role ${request.role}`);
    },
    gateRunner: async () => ({ task_id: "gate", project: env.project, level: "mvp", files: [], status: "passed", checks: [{ id: "check-ok", required: true, status: "passed" }], summary: "passed" })
  });
  // Excluding steps named for testing keeps the verification phase's own work out of the worker
  // steps. Applied to a route that is nothing but such steps it left no role at all.
  assert.equal(result.execution.status, "completed");
  assert.equal(calls.includes("worker"), true);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a decision that follows the work is continued from what was recorded, not by redoing it", async () => {
  const env = fixture("workflow-owner-approve-after-work-", { document: true });
  const semanticScope = { mode: "session", client: "codex", session_id: "approve-after-work-chat" };
  const db = openDb(env.dbFile);
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','prepare',1,'worker',1,0,'package.v1','worker.v1','[]','[\"check-ok\"]','{}','{}')").run();
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','owner_approval',2,NULL,1,1,'package.v1','approval.v1','[\"decision\"]','[]','{}','{}')").run();
  activateChatSession(db, { client: semanticScope.client, sessionId: semanticScope.session_id, origin: env.project, turnKey: "turn-1" });
  db.close();
  const calls = [];
  const gatewayCall = async request => {
    calls.push(request.role);
    if (request.role === "worker") return receipt("worker", { schema_version: 1, status: "completed", summary: "Prepared document evidence.", changed_paths: [], artifacts: [], evidence: ["registered target"], questions: [], external_evidence_request: null });
    if (request.role === "reviewer") return receipt("reviewer", reviewerResult("PASS"));
    if (request.role === "documentator") {
      const file = path.join(env.project, "docs", "control.md");
      const version = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
      return receipt("documentator", {
        schema_version: 1, status: "proposed", document_id: "control", expected_version: version, operation: "update_section", authority: "owner",
        content: "new accepted content", section_id: "summary", decision_id: null, evidence_id: null, status_value: null, target_tag: null, target_id: null, replacement_id: null
      });
    }
    throw new Error(`unexpected role ${request.role}`);
  };
  const gateRunner = async () => ({ task_id: "gate", project: env.project, level: "mvp", files: ["docs/control.md"], status: "passed", checks: [{ id: "check-ok", required: true, status: "passed" }], summary: "passed" });
  const first = await scopedProcessMessage({
    message: "Обнови зарегистрированный документ", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} },
    execute: true, semanticScope, classificationResult: classification(true), gatewayCall, gateRunner
  });
  assert.equal(first.execution.status, "approval_required");
  assert.equal(calls.includes("worker"), true);
  assert.equal(calls.includes("documentator"), false);
  const opened = openDb(env.dbFile);
  const approval = opened.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(first.run_id);
  opened.close();
  const before = calls.length;
  const second = await scopedProcessMessage({
    message: "Да, принимаем", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, semanticScope,
    classificationResult: { ...classification(true), work_type: "conversation", artifact_type: "none", planning_required: false, document_required: false, reply_mode: "conversation", human_response: "Записал.", pending_interaction_id: approval.id, pending_interaction_response: "approve" },
    gatewayCall, gateRunner
  });
  assert.equal(second.route, "work");
  assert.equal(second.execution.status, "completed");
  // The whole point of continuing from what was recorded: the decision costs exactly the phase it was
  // blocking, and no completed step is executed — or paid for — a second time.
  assert.deepEqual(calls.slice(before), ["documentator"]);
  assert.match(fs.readFileSync(path.join(env.project, "docs", "control.md"), "utf8"), /new accepted content/);
  const verified = openDb(env.dbFile);
  assert.equal(verified.prepare("SELECT status FROM approvals WHERE id=?").get(approval.id).status, "approved");
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(first.run_id).state, "completed");
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM workflow_steps WHERE run_id=? AND step_key='documentation'").get(first.run_id).count, 1);
  verified.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a read-only operator proposes before approval and only a signed registered operation can complete", async () => {
  const env = fixture("workflow-external-release-", { externalOperation: true });
  const semanticScope = { mode: "session", client: "codex", session_id: "external-release-chat" };
  const keys = crypto.generateKeyPairSync("ed25519"), publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });
  const db = openDb(env.dbFile);
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','coordinate',1,'coordinator',1,0,'package.v1','planner.v1','[\"document\"]','[]','{}','{}')").run();
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','proposal',2,'release_operator',1,0,'package.v1','release_operation.v1','[\"release_package\"]','[\"check-ok\"]','{}','{}')").run();
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','deployment_approval',3,NULL,1,1,'package.v1','approval.v1','[\"decision\"]','[]','{}','{}')").run();
  registerExternalExecutor(db, { projectId: "project", executorId: "release.test", purpose: "Test release executor", publicKeyPem, keyId: "release-key-v1" });
  registerExternalOperation(db, { projectId: "project", operationId: "release.prod", executorId: "release.test", operationKind: "release", action: "deploy_revision", config: { environment: "production", verification_check_ids: ["check-post"] } });
  activateChatSession(db, { client: semanticScope.client, sessionId: semanticScope.session_id, origin: env.project, turnKey: "turn-1" });
  db.close();
  const calls = [], gates = [];
  const gateRunner = async (_project, _level, _dbFile, taskId, options) => {
    const checkId = taskId.endsWith(":external") ? "check-post" : "check-ok";
    if (checkId === "check-post") {
      assert.deepEqual(options.checkIds, ["check-post"]);
      assert.deepEqual(options.allowedPaths, ["src/output.txt"], "post-operation verification preserves the run's authorized change scope");
    }
    gates.push({ taskId, checkId });
    return { task_id: taskId, project: env.project, level: "mvp", files: [], status: "passed", checks: [{ id: checkId, required: true, status: "passed" }], summary: "passed" };
  };
  const first = await scopedProcessMessage({
    message: "Разверни проверенную ревизию", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, semanticScope,
    classificationResult: { ...classification(false), work_type: "release", artifact_type: "release_package", human_required: true, reason: "Release requires an exact proposal and owner approval." },
    gatewayCall: async request => {
      calls.push(request.role);
      if (request.role === "coordinator") {
        const plan = plannerResult();
        plan.allowed_paths = ["src/output.txt"];
        plan.artifacts = [];
        plan.steps[0] = { ...plan.steps[0], key: "proposal", role: "release_operator", objective: "Propose the exact registered release operation.", allowed_paths: [], artifact_keys: [] };
        return receipt("coordinator", plan);
      }
      if (request.role === "release_operator") {
        assert.equal(request.requiresWrite, false);
        return receipt("release_operator", { schema_version: 1, status: "proposed", operation_id: "release.prod", target_revision: "a".repeat(40), target_environment: "production", artifact_refs: ["artifact:build"], evidence_refs: ["gate:check-ok"], summary: "Deploy the verified immutable revision." });
      }
      if (request.role === "reviewer") return receipt("reviewer", reviewerResult("PASS"));
      throw new Error(`unexpected role ${request.role}`);
    },
    gateRunner
  });
  assert.equal(first.execution.status, "approval_required");
  fs.writeFileSync(path.join(env.project, "src", "output.txt"), "an authorized change already accepted before the external operation", "utf8");
  const waiting = openDb(env.dbFile);
  const approval = waiting.prepare("SELECT id,binding_hash FROM approvals WHERE run_id=? AND status='pending'").get(first.run_id);
  assert.equal(waiting.prepare("SELECT COUNT(*) count FROM external_control_requests WHERE run_id=?").get(first.run_id).count, 0);
  waiting.close();
  const callsBeforeApproval = calls.length;
  const second = await scopedProcessMessage({
    message: "Да, развертывай именно это", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} }, execute: true, semanticScope,
    classificationResult: { ...classification(false), work_type: "conversation", artifact_type: "none", planning_required: false, human_required: false, reply_mode: "conversation", human_response: "Записал.", pending_interaction_id: approval.id, pending_interaction_response: "approve" },
    gatewayCall: async request => { calls.push(request.role); throw new Error(`model called after approval: ${request.role}`); }, gateRunner
  });
  assert.equal(second.execution.status, "external_action_required");
  assert.equal(calls.length, callsBeforeApproval);
  assert.equal(second.execution.external_request.checkpoint_hash, approval.binding_hash);
  const boundDb = openDb(env.dbFile);
  const boundDefinitionHash = JSON.parse(boundDb.prepare("SELECT contract_json FROM workflow_steps WHERE run_id=? AND result_schema_key='release_operation.v1'").get(first.run_id).contract_json).registered_operations[0].definition_hash;
  const executionBinding = boundDb.prepare("SELECT operation_id,definition_hash,proposal_hash,status FROM external_operation_executions WHERE request_id=?").get(second.execution.external_request.request_id);
  boundDb.close();
  assert.equal(second.execution.dispatch_payload.operation.definition_hash, boundDefinitionHash);
  assert.equal(executionBinding.operation_id, "release.prod");
  assert.equal(executionBinding.definition_hash, boundDefinitionHash);
  assert.equal(executionBinding.status, "pending");
  const request = { ...second.execution.external_request, payload: second.execution.dispatch_payload };
  const wrongTargetPacket = signedExternalResult(request, keys.privateKey, { schema_version: 1, operation_id: "release.prod", applied_revision: "b".repeat(40), target_environment: "production", evidence_refs: ["deployment:wrong"] });
  await assert.rejects(() => deliverExternalControlResult({ packet: { ...wrongTargetPacket, signature: "AAAA" }, project: env.project, dbFile: env.dbFile, execute: true, gateRunner }), /SIGNATURE_INVALID/, "untrusted payload semantics are not disclosed before signature verification");
  await assert.rejects(() => deliverExternalControlResult({ packet: wrongTargetPacket, project: env.project, dbFile: env.dbFile, execute: true, gateRunner }), /TARGET_MISMATCH/);
  const rejectedDb = openDb(env.dbFile);
  assert.equal(rejectedDb.prepare("SELECT COUNT(*) count FROM external_control_results WHERE request_id=?").get(request.request_id).count, 0, "a mismatched target is rejected before persistence");
  rejectedDb.close();
  const resultPacket = signedExternalResult(request, keys.privateKey, { schema_version: 1, operation_id: "release.prod", applied_revision: "a".repeat(40), target_environment: "production", evidence_refs: ["RAW_EXTERNAL_RESULT"] });
  const delivered = await deliverExternalControlResult({
    packet: resultPacket,
    project: env.project, dbFile: env.dbFile, execute: true, gatewayCall: async request => { throw new Error(`unexpected model after external result: ${request.role}`); }, gateRunner
  });
  assert.equal(delivered.operation.status, "completed");
  assert.deepEqual(gates.map(item => item.checkId), ["check-ok", "check-post"], "post-operation verification does not replay the preflight check");
  const verified = openDb(env.dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(first.run_id).state, "completed");
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM workflow_steps WHERE run_id=? AND step_key='external_verification' AND state='completed'").get(first.run_id).count, 1);
  const verificationContract = JSON.parse(verified.prepare("SELECT contract_json FROM workflow_steps WHERE run_id=? AND step_key='external_verification'").get(first.run_id).contract_json);
  assert.deepEqual(verificationContract.allowed_paths, ["src/output.txt"], "the audit contract records the same run paths enforced by the external gate");
  assert.equal(verified.prepare("SELECT status FROM external_operation_executions WHERE request_id=?").get(request.request_id).status, "verified");
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM artifacts WHERE run_id=? AND kind='deployment_evidence' AND status='verified'").get(first.run_id).count, 1);
  const evidenceCount = verified.prepare("SELECT COUNT(*) count FROM run_evidence WHERE run_id=? AND kind='external_operation_result'").get(first.run_id).count;
  assert.equal(JSON.stringify(verified.prepare("SELECT * FROM external_control_results WHERE request_id=?").get(request.request_id)).includes("RAW_EXTERNAL_RESULT"), false);
  verified.close();
  const duplicate = await deliverExternalControlResult({
    packet: resultPacket, project: env.project, dbFile: env.dbFile, execute: true,
    gatewayCall: async request => { throw new Error(`unexpected model after duplicate result: ${request.role}`); }, gateRunner
  });
  assert.equal(duplicate.control.duplicate, true);
  assert.equal(duplicate.operation.duplicate, true);
  const duplicateDb = openDb(env.dbFile);
  assert.equal(duplicateDb.prepare("SELECT COUNT(*) count FROM run_evidence WHERE run_id=? AND kind='external_operation_result'").get(first.run_id).count, evidenceCount);
  assert.equal(duplicateDb.prepare("SELECT COUNT(*) count FROM workflow_steps WHERE run_id=? AND step_key='external_verification'").get(first.run_id).count, 1);
  duplicateDb.close();
  const genericDb = openDb(env.dbFile);
  const generic = createExternalControlRequest(genericDb, {
    projectId: "project", runId: first.run_id, stepId: request.step_id, interactionId: approval.id,
    executorId: "release.test", action: "deploy_revision", checkpointHash: approval.binding_hash,
    payload: { operation: "not-platform-dispatched" }, idempotencyKey: `generic:${first.run_id}`
  }).request;
  genericDb.close();
  await assert.rejects(() => deliverExternalControlResult({
    packet: signedExternalResult(generic, keys.privateKey, { schema_version: 1, operation_id: "release.prod", applied_revision: "b".repeat(40), target_environment: "production", evidence_refs: ["deployment:generic"] }),
    project: env.project, dbFile: env.dbFile, execute: true, gateRunner
  }), /EXTERNAL_OPERATION_RESULT_NOT_FOUND/);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a routed irreversible approval binds an exact plan before any productive role", async () => {
  const env = fixture("workflow-routed-approval-");
  const db = openDb(env.dbFile);
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','plan',1,'planner',1,0,'package.v1','planner.v1','[]','[]','{}','{}')").run();
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','owner_approval',2,NULL,1,1,'package.v1','approval.v1','[\"decision\"]','[]','{}','{}')").run();
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','deploy',3,'worker',1,0,'package.v1','worker.v1','[\"code\"]','[\"check-ok\"]','{}','{}')").run();
  db.close();
  const calls = [];
  const result = await statelessProcessMessage({
    message: "Разверни изменение", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} },
    execute: true, classificationResult: classification(false), gatewayCall: async request => {
      calls.push(request.role);
      if (request.role === "planner") return receipt("planner", plannerResult());
      throw new Error(`productive role ran before approval: ${request.role}`);
    }
  });
  assert.deepEqual(calls, ["planner"]);
  assert.equal(result.execution.status, "approval_required");
  assert.match(result.response, /отдельного решения владельца/i);
  const verified = openDb(env.dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "approval_required");
  const approval = verified.prepare("SELECT binding_hash,binding_json FROM approvals WHERE run_id=? AND status='pending'").get(result.run_id);
  assert.match(approval.binding_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(approval.binding_json).plan.steps.length, 1);
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM workflow_steps WHERE run_id=? AND role_id='worker' AND state='pending'").get(result.run_id).count, 1);
  verified.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("red required gate prevents reviewer and completion", async () => {
  const env = await scenario({ prefix: "workflow-structured-red-gate-", gateStatus: "failed" });
  assert.equal(env.result.execution.status, "changes_requested");
  assert.deepEqual(env.calls, ["planner", "worker", "worker"]);
  const db = openDb(env.dbFile);
  assert.equal(db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(env.result.run_id).state, "changes_requested");
  assert.equal(db.prepare("SELECT status FROM gates WHERE run_id=?").get(env.result.run_id).status, "failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM decisions WHERE run_id=? AND kind='review'").get(env.result.run_id).count, 0);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

for (const reviewDecision of ["CHANGES_REQUESTED", "REJECT"]) {
  test(`reviewer ${reviewDecision} blocks completed`, async () => {
    const env = await scenario({ prefix: `workflow-review-${reviewDecision.toLowerCase()}-`, reviewDecision });
    assert.equal(env.result.execution.status, reviewDecision === "REJECT" ? "rejected" : "changes_requested");
    const db = openDb(env.dbFile);
    assert.notEqual(db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(env.result.run_id).state, "completed");
    assert.equal(db.prepare("SELECT outcome FROM decisions WHERE run_id=? AND kind='review' AND active=1").get(env.result.run_id).outcome, reviewDecision);
    db.close();
    fs.rmSync(env.root, { recursive: true, force: true });
  });
}

test("read-only documentator proposal is applied atomically by the platform after reviewer PASS and lint", async () => {
  const env = await scenario({ prefix: "workflow-document-required-pass-", document: true, realDocumentatorGateway: true });
  assert.equal(env.result.execution.status, "completed");
  assert.deepEqual(env.calls, ["planner", "worker", "reviewer", "documentator"]);
  const contractDb = openDb(env.dbFile);
  assert.equal(JSON.parse(contractDb.prepare("SELECT boundaries_json FROM role_contracts WHERE project_id='project' AND role_id='documentator' AND status='active'").get().boundaries_json).writes, false);
  const resources = JSON.parse(contractDb.prepare("SELECT resources_json FROM workflow_steps WHERE run_id=? AND role_id='documentator'").get(env.result.run_id).resources_json);
  assert.deepEqual({ ...contractDb.prepare("SELECT profile_id,status FROM gateway_calls WHERE run_id=? AND step_id=(SELECT id FROM workflow_steps WHERE run_id=? AND role_id='documentator')").get(env.result.run_id, env.result.run_id) }, { profile_id: "local-documentator", status: "completed" });
  contractDb.close();
  assert.equal(resources.some(item => item.alias === "project.worktree" && item.mode === "exclusive"), true);
  assert.match(fs.readFileSync(path.join(env.project, "docs", "control.md"), "utf8"), /new accepted content/);
  assert.match(env.documentatorPrompt, /document_proposal/);
  assert.match(env.documentatorPrompt, /Do not edit or write the filesystem/);
  assert.match(env.documentatorPrompt, /Prepared document evidence/);
  assert.match(env.documentatorPrompt, /registered target/);
  assert.match(env.documentatorPrompt, /already run/);
  assert.match(env.documentatorPrompt, /never describe a completed check as future work/);
  assert.match(env.documentatorPrompt, /Deterministic check/);
  assert.match(env.documentatorPrompt, /passed: deterministic check/);
  assert.match(env.documentatorPrompt, /duration_ms&quot;:17/);
  assert.match(fs.readFileSync(path.join(env.project, "docs", "control.md"), "utf8"), /<quality_result[^>]+status="verified"[^>]+evidence="verified"[^>]+decision_status="proposed"/);
  const db = openDb(env.dbFile);
  assert.equal(db.prepare("SELECT version FROM project_documents WHERE id='control'").get().version, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_operations WHERE run_id=? AND status='applied'").get(env.result.run_id).count, 1);
  assert.deepEqual({ ...db.prepare("SELECT quality_level,quality_contract_version,evidence_type,decision_status FROM document_operations WHERE run_id=?").get(env.result.run_id) }, { quality_level: "mvp", quality_contract_version: "1.0.0", evidence_type: "verified", decision_status: "proposed" });
  assert.equal(db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(env.result.run_id).state, "completed");
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a free-form narrative confirmation reaches the model-classified document route without keyword or regex authority", async () => {
  const env = await scenario({ prefix: "workflow-free-form-confirmation-", document: true, message: "Да, этот вариант принимаем; запиши его в зарегистрированный смысловой документ." });
  assert.equal(env.result.execution.status, "completed"); assert.deepEqual(env.calls, ["planner", "worker", "reviewer", "documentator"]);
  const db = openDb(env.dbFile); const decision = JSON.parse(db.prepare("SELECT structured_json FROM decisions WHERE run_id=? AND kind='classification'").get(env.result.run_id).structured_json);
  assert.equal(decision.work_type, "documentation"); assert.equal(db.prepare("SELECT COUNT(*) count FROM document_operations WHERE run_id=? AND status='applied'").get(env.result.run_id).count, 1);
  db.close(); fs.rmSync(env.root, { recursive: true, force: true });
});

test("document version conflict preserves original and blocks required completion", async () => {
  const env = await scenario({ prefix: "workflow-document-version-conflict-", document: true, invalidDocumentVersion: true });
  assert.equal(env.result.route, "execution_failed");
  assert.equal(env.result.execution.status, "blocked");
  assert.match(fs.readFileSync(path.join(env.project, "docs", "control.md"), "utf8"), />old</);
  const db = openDb(env.dbFile);
  assert.equal(db.prepare("SELECT version FROM project_documents WHERE id='control'").get().version, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM document_operations WHERE run_id=?").get(env.result.run_id).count, 0);
  assert.notEqual(db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(env.result.run_id).state, "completed");
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

// A package names the profile it requires; onboarding names the profile the installation has. Comparing
// a local id against a portable key made every restricted contract unloadable, and nothing caught it
// because every earlier fixture allowed any profile.
function requirementFixture(prefix, { allowed, satisfies, omitRequirement = false } = {}) {
  const root = temporaryRoot(prefix);
  const project = path.join(root, "project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project, { recursive: true });
  onboardProject(dbFile, {
    project: { id: "project", name: "Project", root_path: project },
    workflow: { id: "workflow", name: "Workflow", package_key: "example.web-app" },
    profiles: [{ id: "local.project.worker", provider: "codex", name: "local worker", role_id: "worker" }],
    role_contracts: [{ ...roleContract("worker", "worker.v1", ["code"]), allowed_profiles: allowed }],
    role_assignments: [{ role_id: "worker", profile_id: "local.project.worker", operational_level: "mvp", ...(satisfies === undefined ? {} : { satisfies_profile_key: satisfies }) }],
    ...(omitRequirement ? {} : { profile_requirements: [{ key: "example.web-app.worker.mvp", role_id: "worker", operational_levels: ["mvp"] }] })
  });
  return { root, dbFile };
}

test("a local profile satisfies a portable requirement instead of being compared to its key", () => {
  const env = requirementFixture("workflow-profile-requirement-", { allowed: ["example.web-app.worker.mvp"] });
  const db = openDb(env.dbFile);
  const contract = loadRoleContract(db, "project", "worker", "mvp");
  assert.equal(contract.profile_id, "local.project.worker");
  assert.equal(contract.satisfies_profile_key, "example.web-app.worker.mvp");
  db.close(); fs.rmSync(env.root, { recursive: true, force: true });
});

test("a profile that fulfils no declared requirement never loads a restricted contract", () => {
  const undeclared = requirementFixture("workflow-profile-undeclared-", { allowed: ["example.web-app.worker.mvp"], satisfies: null, omitRequirement: true });
  const undeclaredDb = openDb(undeclared.dbFile);
  assert.throws(() => loadRoleContract(undeclaredDb, "project", "worker", "mvp"), /ROLE_PROFILE_REQUIREMENT_UNDECLARED/);
  undeclaredDb.close(); fs.rmSync(undeclared.root, { recursive: true, force: true });
  const other = requirementFixture("workflow-profile-other-requirement-", { allowed: ["example.web-app.reviewer.mvp"] });
  const otherDb = openDb(other.dbFile);
  assert.throws(() => loadRoleContract(otherDb, "project", "worker", "mvp"), /ROLE_PROFILE_REQUIREMENT_NOT_ALLOWED/);
  otherDb.close(); fs.rmSync(other.root, { recursive: true, force: true });
});

test("a contract open to any profile still loads without a declared requirement", () => {
  const env = requirementFixture("workflow-profile-any-", { allowed: ["*"], omitRequirement: true });
  const db = openDb(env.dbFile);
  assert.equal(loadRoleContract(db, "project", "worker", "mvp").satisfies_profile_key, null);
  db.close(); fs.rmSync(env.root, { recursive: true, force: true });
});

// The validator accepts an exact field set and the prompt states that set. If the two ever drift, the
// model is told one contract and judged by another, which is exactly what made every structured role
// fail: the prompt named the schema and never said what was in it.
test("the shape shown to a role is the shape its result is validated against", () => {
  for (const [key, shape] of Object.entries(RESULT_SCHEMA_SHAPES)) {
    const env = requirementFixture(`workflow-shape-${key.replace(/\W/g, "-")}-`, { allowed: ["*"], omitRequirement: true });
    const db = openDb(env.dbFile);
    db.prepare("UPDATE role_contracts SET result_schema_key=? WHERE project_id='project' AND role_id='worker'").run(key);
    const contract = loadRoleContract(db, "project", "worker", "mvp");
    const prompt = rolePrompt({ contract, qualityContract: loadQualityContract(db, "mvp"), packageContract: {}, context: { response_language: "en" }, resultSchema: key });
    for (const field of Object.keys(shape)) assert.equal(prompt.includes(`&quot;${field}&quot;`), true, `${key}: ${field} missing from the prompt`);
    assert.throws(() => parseRoleReceipt({ output: JSON.stringify({ schema_version: 1 }) }, key, { contract, packageContract: { allowed_paths: [], artifact_keys: [] }, allowedDocumentIds: [] }), new RegExp(`${key.replace(".", "\.")}: fields mismatch`));
    db.close(); fs.rmSync(env.root, { recursive: true, force: true });
  }
});
