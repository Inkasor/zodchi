import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { onboardProject } from "../src/onboarding.mjs";
import { openDb } from "../src/db.mjs";
import { processMessage } from "../src/workflow-app.mjs";
import { classificationCatalog } from "../src/classifier.mjs";
import { loadRoleContract, parseRoleReceipt, rolePrompt, validateDocumentatorResult, validatePlannerResult, validateReviewerResult, validateWorkerResult } from "../src/role-contracts.mjs";
import { BudgetManager } from "../src/budget.mjs";
import { loadQualityContract } from "../src/quality-contracts.mjs";

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
    pending_interaction_id: null, reason: documentRequired ? "Нужно обновить зарегистрированный документ." : "Нужен ограниченный пакет кода.", questions: [], human_response: null
  };
}

function roleContract(roleId, schema, artifacts) {
  return {
    id: `contract-${roleId}`, role_id: roleId, version: "1.0.0", purpose: `${roleId} test contract`, boundaries: { writes: roleId === "worker" || roleId === "documentator" },
    allowed_work_types: ["*"], allowed_artifact_types: artifacts, allowed_tools: [], allowed_skills: [], required_checks: ["check-ok"],
    allowed_transitions: [], allowed_profiles: ["*"], context_limit_bytes: 65536, max_calls: roleId === "worker" ? 2 : 1, max_correction_cycles: roleId === "worker" || roleId === "planner" ? 1 : 0,
    timeout_seconds: 60, result_schema_key: schema, prompt_template_version: "1.0.0", escalation: { on_invalid: "blocked" }
  };
}

function fixture(prefix, { document = false } = {}) {
  const root = temporaryRoot(prefix);
  const project = path.join(root, "project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  if (document) fs.writeFileSync(path.join(project, "docs", "control.md"), '<document id="control" status="working"><section id="summary" status="working">old</section></document>');
  const roles = [
    ["planner", "planner.v1", ["code", "document"]], ["worker", "worker.v1", ["code", "document"]],
    ["reviewer", "reviewer.v1", ["code", "document"]], ["documentator", "documentator.v1", ["document"]]
  ];
  onboardProject(dbFile, {
    project: { id: "project", name: "Project", root_path: project },
    workflow: { id: "workflow", name: "Workflow", discovery: { git: false }, history_budget_bytes: 8192 },
    profiles: roles.map(([role]) => ({ id: `profile-${role}`, provider: "codex", name: `local-${role}`, role_id: role })),
    routes: [{ work_type_id: "implementation" }, { work_type_id: "documentation" }],
    checks: [{ id: "check-ok", name: "Test check", runner: "fixture", kind: "fixture", config: { status: "passed" } }],
    project_checks: [{ check_id: "check-ok", quality_mode_id: "mvp", required: true }],
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
    steps: [{ key: "worker", role: "worker", objective: document ? "Prepare evidence for the document update" : "Create the bounded output", allowed_paths: document ? [] : ["src/output.txt"], artifact_keys: document ? [] : ["code-output"], check_ids: ["check-ok"], required: true, irreversible: false, max_attempts: 1 }]
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

async function scenario({ prefix, gateStatus = "passed", reviewDecision = "PASS", document = false, invalidDocumentVersion = false, message = null, risk = "high" }) {
  const env = fixture(prefix, { document });
  const calls = [];
  let workerPrompt = "";
  const gatewayCall = async request => {
    calls.push(request.role);
    if (request.role === "planner") return receipt("planner", plannerResult({ document }), "1", "\nRAW_PLANNER_PROSE_MARKER");
    if (request.role === "worker") {
      workerPrompt = fs.readFileSync(request.taskFile, "utf8");
      if (!document) {
        const file = path.join(env.project, "src", "output.txt");
        fs.writeFileSync(file, "bounded output");
        const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        return receipt("worker", { schema_version: 1, status: "completed", summary: "Created output.", changed_paths: ["src/output.txt"], artifacts: [{ key: "code-output", type: "code", path: "src/output.txt", content_hash: hash, status: "created" }], evidence: ["file hash"], questions: [] });
      }
      return receipt("worker", { schema_version: 1, status: "completed", summary: "Prepared document evidence.", changed_paths: [], artifacts: [], evidence: ["registered target"], questions: [] });
    }
    if (request.role === "reviewer") return receipt("reviewer", reviewerResult(reviewDecision));
    if (request.role === "documentator") {
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
  const gateRunner = async () => ({ task_id: "gate", project: env.project, level: "mvp", files: document ? ["docs/control.md"] : ["src/output.txt"], status: gateStatus, checks: [{ id: "check-ok", required: true, status: gateStatus }], summary: gateStatus });
  const result = await processMessage({
    message: message ?? (document ? "Update the registered document" : "Implement bounded output"), project: env.project, dbFile: env.dbFile,
    workflowDefinition: { id: "workflow", authority: "registered test authority", roles: {} }, execute: true,
    classificationResult: classification(document, risk), gatewayCall, gateRunner
  });
  return { ...env, calls, workerPrompt, result };
}

test("role result schemas reject extra fields, path escapes and false reviewer PASS", () => {
  const env = fixture("workflow-role-schema-");
  const db = openDb(env.dbFile);
  const contract = loadRoleContract(db, "project", "planner", "mvp");
  const roles = db.prepare("SELECT id FROM roles").all().map(row => row.id);
  const checks = ["check-ok"], artifacts = db.prepare("SELECT id FROM artifact_types").all().map(row => row.id);
  assert.throws(() => validatePlannerResult({ ...plannerResult(), extra: true }, { contract, registeredRoles: roles, registeredChecks: checks, registeredArtifactTypes: artifacts }), /fields mismatch/);
  const workerContract = loadRoleContract(db, "project", "worker", "mvp");
  assert.throws(() => validateWorkerResult({ schema_version: 1, status: "completed", summary: "x", changed_paths: ["../outside"], artifacts: [], evidence: [], questions: [] }, { contract: workerContract, packageContract: { allowed_paths: ["src/output.txt"], artifact_keys: [] } }), /relative project path/);
  assert.throws(() => validateReviewerResult({ ...reviewerResult("PASS"), blockers: [{ code: "x", message: "hidden blocker", path: null }] }), /PASS cannot contain blockers/);
  assert.throws(() => validateDocumentatorResult({ schema_version: 1, status: "proposed", document_id: "unknown", expected_version: null, operation: "create_document", authority: "owner", content: "x", section_id: null, decision_id: null, evidence_id: null, status_value: null, target_tag: null, target_id: null, replacement_id: null }, { allowedDocumentIds: ["control"] }), /document not allowed/);
  assert.match(rolePrompt({ contract, qualityContract: loadQualityContract(db, "mvp"), packageContract: { objective: "x" }, context: {}, resultSchema: "planner.v1" }), /<workflow_role_prompt/);
  assert.equal(parseRoleReceipt(receipt("reviewer", reviewerResult("PASS")), "reviewer.v1", {}).decision, "PASS");
  assert.ok(classificationCatalog(db, "project").routes.length >= 2);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("structured planner-worker-gate-reviewer PASS completes and raw planner prose never reaches worker", async () => {
  const env = await scenario({ prefix: "workflow-structured-pass-" });
  assert.equal(env.result.execution.status, "completed");
  assert.deepEqual(env.calls, ["planner", "worker", "reviewer"]);
  assert.equal(env.workerPrompt.includes("RAW_PLANNER_PROSE_MARKER"), false);
  const db = openDb(env.dbFile);
  assert.equal(db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(env.result.run_id).state, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND state='completed'").get(env.result.run_id).count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM gateway_calls WHERE run_id=? AND length(contract_hash)=64 AND length(result_hash)=64").get(env.result.run_id).count, 3);
  assert.equal(JSON.stringify(db.prepare("SELECT result_json FROM workflow_steps WHERE run_id=?").all(env.result.run_id)).includes("RAW_PLANNER_PROSE_MARKER"), false);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("low-risk green MVP skips the independent reviewer", async () => {
  const env = await scenario({ prefix: "workflow-structured-low-risk-", risk: "low" });
  assert.equal(env.result.execution.status, "completed");
  assert.deepEqual(env.calls, ["planner", "worker"]);
  assert.equal(env.result.execution.reviewer, null);
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("planner questions stop before worker and become plain pending clarifications", async () => {
  const env = fixture("workflow-planner-questions-");
  let calls = 0;
  const questions = {
    schema_version: 1, outcome: "questions", scope: { included: [], excluded: [] }, allowed_paths: [], inputs: [], checks: [], risks: [], artifacts: [],
    completion_criteria: [], questions: ["Какой файл разрешено изменить?"], steps: []
  };
  const result = await processMessage({
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

test("configured project call budget hard-stops the real role wrapper before Gateway invocation", async () => {
  const env = fixture("workflow-structured-budget-stop-");
  const setup = openDb(env.dbFile);
  new BudgetManager(setup).define({ scopeType: "project", scopeId: "project", metric: "calls", limit: 0 });
  setup.close();
  let calls = 0;
  const result = await processMessage({
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

test("a routed irreversible approval blocks productive roles before any Gateway call", async () => {
  const env = fixture("workflow-routed-approval-");
  const db = openDb(env.dbFile);
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','plan',1,'planner',1,0,'package.v1','planner.v1','[]','[]','{}','{}')").run();
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','owner_approval',2,NULL,1,1,'package.v1','approval.v1','[\"decision\"]','[]','{}','{}')").run();
  db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES('project','workflow','deploy',3,'worker',1,0,'package.v1','worker.v1','[\"code\"]','[\"check-ok\"]','{}','{}')").run();
  db.close();
  let calls = 0;
  const result = await processMessage({
    message: "Разверни изменение", project: env.project, dbFile: env.dbFile, workflowDefinition: { id: "workflow", authority: "test", roles: {} },
    execute: true, classificationResult: classification(false), gatewayCall: async () => { calls += 1; throw new Error("must not be called"); }
  });
  assert.equal(calls, 0);
  assert.equal(result.execution.status, "approval_required");
  assert.match(result.response, /отдельного решения владельца/i);
  const verified = openDb(env.dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(result.run_id).state, "approval_required");
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM approvals WHERE run_id=? AND status='pending'").get(result.run_id).count, 1);
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

test("required document patch applies atomically after reviewer PASS and lint", async () => {
  const env = await scenario({ prefix: "workflow-document-required-pass-", document: true });
  assert.equal(env.result.execution.status, "completed");
  assert.deepEqual(env.calls, ["planner", "worker", "reviewer", "documentator"]);
  assert.match(fs.readFileSync(path.join(env.project, "docs", "control.md"), "utf8"), /new accepted content/);
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
