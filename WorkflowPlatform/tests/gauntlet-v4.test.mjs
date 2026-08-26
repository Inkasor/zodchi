import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "../src/runtime.mjs";
import { ExecutionQueue } from "../src/execution-queue.mjs";
import { BudgetManager } from "../src/budget.mjs";
import { now } from "../src/db.mjs";
import { buildReviewEvidence, captureRunBaselines, recordRunEvidence, runChangeEvidence } from "../src/run-evidence.mjs";
import { applyRunControlAtBoundary, blockerFingerprint, requestRunControl } from "../src/progress-supervisor.mjs";
import { targetedSteps } from "../src/work-executor.mjs";
import { callGateway } from "../src/gateway.mjs";
import { transactionAwaitViolations } from "../src/transaction-guard.mjs";

const CLASSIFICATION = { kind: "task", domain: "workflow", discipline: "general", risk: "low", level: "L2", quality: "mvp", planning_required: true, human_required: false, document_required: false };
const temp = prefix => fs.mkdtempSync(path.join(process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(), prefix));
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });

function fixture(prefix, message = "Точная исходная формулировка владельца — без пересказа.") {
  const root = temp(prefix), projectRoot = path.join(root, "project"), runtime = new Runtime(path.join(root, "workflow.sqlite"));
  fs.mkdirSync(projectRoot, { recursive: true });
  runtime.db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(projectRoot, now());
  runtime.db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status) VALUES('workflow','Workflow','project','mvp','L2','active')").run();
  const runId = runtime.create(message, { project_id: "project", workflow_id: "workflow", event_source: "test" });
  runtime.db.prepare("INSERT INTO conversation_messages(id,project_id,run_id,role,content,created_at,language) VALUES('owner-message','project',?,'user',?,?, 'ru')").run(runId, message, now());
  runtime.classify(runId, CLASSIFICATION);
  runtime.plan(runId, { objective: "planner may paraphrase", steps: [{ key: "worker" }] });
  runtime.setState(runId, "executing");
  return { root, projectRoot, runtime, runId, queue: new ExecutionQueue(runtime.db), budgets: new BudgetManager(runtime.db), close() { runtime.db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function initGit(root) {
  git(root, "init", "-q"); git(root, "config", "user.email", "gauntlet@example.invalid"); git(root, "config", "user.name", "Gauntlet Test");
  fs.writeFileSync(path.join(root, "allowed.js"), "export const allowed = 1;\n");
  fs.writeFileSync(path.join(root, "outside.js"), "export const outside = 1;\n");
  git(root, "add", "."); git(root, "commit", "-qm", "baseline");
}

test("A: reviewer evidence preserves the verbatim owner objective and canonical blockers", () => {
  const fx = fixture("gauntlet-owner-");
  try {
    captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
    const evidence = buildReviewEvidence(fx.runtime.db, fx.runId, { plan: { completion_criteria: ["planner claim"] }, gate: { status: "passed", checks: [] }, workerResults: [], allowedPaths: [] });
    assert.equal(evidence.owner_objective.verbatim, "Точная исходная формулировка владельца — без пересказа.");
    assert.equal(evidence.owner_objective.source, "conversation_messages");
    assert.ok(Array.isArray(evidence.canonical_completion.blockers));
    assert.equal(evidence.planner_advisory.authority, "advisory");
  } finally { fx.close(); }
});

test("B: analytical review retains conclusion and primary source evidence with an empty diff", () => {
  const fx = fixture("gauntlet-analytical-");
  try {
    captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
    fx.runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,step_id,kind,outcome,source,structured_json,active,created_at) VALUES('finding',?,? ,NULL,'artifact:finding','COMPLETED','worker',?,1,?)")
      .run(fx.runtime.get(fx.runId).task_id, fx.runId, JSON.stringify({ artifact_key: "finding", path: null, conclusion: "Importer misses the bootstrap edge" }), now());
    recordRunEvidence(fx.runtime.db, fx.runId, null, "worker_source", { code_intelligence: { anchors: ["importBootstrap"] }, files: [{ path: "src/importer.ts", text: "function importBootstrap() {}" }] });
    const evidence = buildReviewEvidence(fx.runtime.db, fx.runId, { plan: { completion_criteria: [] }, gate: { status: "passed", checks: [] }, workerResults: [{ plan_step: "research", summary: "Importer misses the bootstrap edge", evidence: ["src/importer.ts"] }], allowedPaths: [] });
    assert.equal(evidence.type, "analytical");
    assert.equal(evidence.change_evidence, null);
    assert.equal(evidence.analytical_evidence.decision_artifacts[0].conclusion, "Importer misses the bootstrap edge");
    assert.equal(evidence.source_evidence[0].files[0].path, "src/importer.ts");
  } finally { fx.close(); }
});

test("review evidence compacts large source and gate payloads under its measured envelope", () => {
  const fx = fixture("gauntlet-review-budget-");
  try {
    captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
    recordRunEvidence(fx.runtime.db, fx.runId, null, "worker_source", { code_intelligence: { anchors: ["criticalSymbol"] }, files: Array.from({ length: 12 }, (_, index) => ({ path: `src/${index}.ts`, text: `criticalSymbol${index}\n${"x".repeat(12_000)}` })) });
    const evidence = buildReviewEvidence(fx.runtime.db, fx.runId, { plan: { completion_criteria: [] }, gate: { status: "failed", checks: Array.from({ length: 20 }, (_, index) => ({ id: `gate-${index}`, required: true, status: "failed", failure: "failure ".repeat(2_000), execution_project_id: "project", execution_root: fx.projectRoot })) }, workerResults: [], allowedPaths: [] });
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 40_000);
    assert.equal(evidence.source_evidence[0].code_intelligence.anchors[0], "criticalSymbol");
    assert.equal(evidence.source_evidence[0].files[0].path, "src/0.ts");
    assert.equal(evidence.verification.gate.checks[0].execution_project_id, "project");
  } finally { fx.close(); }
});

test("review evidence compacts repeated TS graph and exact-scan metadata without losing paths or counts", () => {
  const fx = fixture("gauntlet-review-real-metadata-");
  try {
    captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
    const code_intelligence = { strategy: "lexical_to_language_graph", adapters: [{ name: "typescript-compiler", files: 102, compiler_available: true, definitions: 12_143, resolved_references: 9_200, unresolved_calls: 15_770, unresolved_call_categories: { standard_library: 8663, external_dependency: 24, dynamic_or_untyped: 5779, project_internal_unmapped: 1304 }, unresolved_call_samples: { dynamic_or_untyped: Array.from({ length: 20 }, (_, index) => ({ path: `scripts/${index}.mjs`, line: index + 1, expression: "dynamicCall".repeat(100) })) }, semantic_diagnostics: 0 }] };
    for (let step = 0; step < 6; step += 1) recordRunEvidence(fx.runtime.db, fx.runId, null, "worker_source", { plan_step: `trace-${step}`, code_intelligence, files: Array.from({ length: 4 }, (_, file) => ({ path: `src/${step}-${file}.ts`, segments: [{ start_line: 1, end_line: 20, reason: "objective_match", complete: true }], exact_term_scan: { scope: "complete_file", match: "literal_case_insensitive", occurrences: Array.from({ length: 12 }, (_, term) => ({ term: `anchor-${term}`, count: term + 1, matched_lines: term + 1, locations: Array.from({ length: 8 }, (_, line) => ({ line: line + 1, text: "relevant source line ".repeat(50) })), locations_truncated: false })) }, text: "source body ".repeat(1_000), supplied_bytes: 12_000 })) });
    const workerResults = Array.from({ length: 6 }, (_, index) => ({ plan_step: `trace-${index}`, summary: "evidence-backed conclusion ".repeat(300), evidence: Array.from({ length: 20 }, (_, ref) => `src/${index}-${ref % 4}.ts:${ref + 1} ${"proof ".repeat(100)}`) }));
    const evidence = buildReviewEvidence(fx.runtime.db, fx.runId, { plan: { completion_criteria: [] }, gate: { status: "passed", checks: [] }, workerResults, allowedPaths: [] });
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 40_000);
    assert.equal(evidence.source_evidence.length, 6);
    assert.equal(evidence.source_evidence[5].files[3].path, "src/5-3.ts");
    assert.equal(evidence.source_evidence[0].files[0].exact_term_scan.occurrences[11].count, 12);
    assert.equal(evidence.source_evidence[0].code_intelligence.adapters[0].unresolved_call_categories.project_internal_unmapped, 1304);
  } finally { fx.close(); }
});

test("C-D: committed and initially dirty files remain visible in the run-relative Git delta", () => {
  for (const initiallyDirty of [false, true]) {
    const fx = fixture(`gauntlet-git-${initiallyDirty}-`);
    try {
      initGit(fx.projectRoot);
      if (initiallyDirty) fs.writeFileSync(path.join(fx.projectRoot, "outside.js"), "export const outside = 2;\n");
      captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
      fs.writeFileSync(path.join(fx.projectRoot, "outside.js"), `export const outside = ${initiallyDirty ? 3 : 2};\n`);
      git(fx.projectRoot, "add", "outside.js"); git(fx.projectRoot, "commit", "-qm", "worker commit");
      assert.equal(git(fx.projectRoot, "status", "--porcelain"), "");
      const delta = runChangeEvidence(fx.runtime.db, fx.runId, ["allowed.js"]);
      assert.ok(delta.run_changed_paths.includes("outside.js"));
      assert.ok(delta.unauthorized_changes.includes("outside.js"));
    } finally { fx.close(); }
  }
});

test("E: a local blocker selects exactly the affected plan step", () => {
  const plan = { steps: Array.from({ length: 5 }, (_, index) => ({ key: `step-${index}`, allowed_paths: [`src/${index}.ts`], check_ids: [`check-${index}`] })) };
  const selected = targetedSteps(plan, { gate: { checks: [{ id: "check-3", required: true, status: "failed", execution_project_id: "consumer", execution_root: "registered-consumer-root" }] } });
  assert.deepEqual(selected.map(item => item.key), ["step-3"]);
});

test("F: post-factum cost records the overshooting receipt and denies the next call", () => {
  const fx = fixture("gauntlet-cost-");
  try {
    const scopes = [{ type: "workflow", id: fx.runId }], request = { scopes, taskId: fx.runtime.get(fx.runId).task_id, runId: fx.runId };
    fx.budgets.define({ scopeType: "workflow", scopeId: fx.runId, metric: "cost_usd", limit: 1 });
    fx.budgets.assertModelAdmission(request);
    const settled = fx.budgets.settleActual({ ...request, amount: 1.25, idempotencyKey: "receipt-1" });
    assert.equal(settled.overshoot, 0.25);
    assert.equal(fx.runtime.db.prepare("SELECT used_value FROM budgets WHERE scope_id=? AND metric='cost_usd'").get(fx.runId).used_value, 1.25);
    assert.throws(() => fx.budgets.assertModelAdmission(request), /BUDGET_EXHAUSTED/);
  } finally { fx.close(); }
});

test("G: two admitted parallel costs settle before one lifecycle stop and a third admission is denied", async () => {
  const fx = fixture("gauntlet-parallel-cost-");
  try {
    const taskId = fx.runtime.get(fx.runId).task_id, scopes = [{ type: "workflow", id: fx.runId }], request = { scopes, taskId, runId: fx.runId };
    fx.budgets.define({ scopeType: "workflow", scopeId: fx.runId, metric: "cost_usd", limit: 1 });
    let release; const barrier = new Promise(resolve => { release = resolve; });
    const admitted = (key, amount) => { fx.budgets.assertModelAdmission(request); return barrier.then(() => fx.budgets.settleActual({ ...request, amount, idempotencyKey: key })); };
    const first = admitted("review-a", 0.7), second = admitted("review-b", 0.7); release();
    const receipts = await Promise.all([first, second]);
    assert.equal(receipts.length, 2); assert.equal(fx.runtime.get(fx.runId).state, "executing");
    assert.throws(() => fx.budgets.assertModelAdmission(request), /BUDGET_EXHAUSTED/);
    assert.equal(fx.runtime.get(fx.runId).state, "blocked");
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM events WHERE entity_type='workflow_run' AND entity_id=? AND kind='state_transition' AND to_state='blocked'").get(fx.runId).count, 1);
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM budget_entries WHERE run_id=?").get(fx.runId).count, 2);
  } finally { fx.close(); }
});

test("H: cancelling an active Gateway invocation kills descendants and closes queue lifecycle", async () => {
  const fx = fixture("gauntlet-cancel-tree-");
  try {
    const childFile = path.join(fx.root, "child.mjs"), gatewayFile = path.join(fx.root, "gateway.mjs"), marker = path.join(fx.root, "writes.log");
    fs.writeFileSync(childFile, `import fs from "node:fs"; const file=process.argv[2]; setInterval(()=>fs.appendFileSync(file,"x"),25);\n`);
    fs.writeFileSync(gatewayFile, `import {spawn} from "node:child_process"; import path from "node:path"; spawn(process.execPath,[path.join(import.meta.dirname,"child.mjs"),${JSON.stringify(marker)}],{stdio:"ignore"}); setInterval(()=>{},1000);\n`);
    fx.queue.enqueueRun(fx.runId); const lease = fx.queue.checkout({ ownerId: "worker", runId: fx.runId }); fx.queue.start(lease.token);
    const invocation = callGateway({ gateway: gatewayFile, gatewayDatabase: path.join(fx.root, "gateway.sqlite"), gatewayPolicy: path.join(fx.root, "policy.json"), profile: "fixture", taskFile: childFile, project: fx.projectRoot, taskId: "fixture", workflowRunId: fx.runId });
    const rejected = assert.rejects(invocation, /GATEWAY_INVOCATION_CANCELLED/);
    for (let attempt = 0; attempt < 40 && !fs.existsSync(marker); attempt += 1) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(fs.existsSync(marker), true);
    await invocation.cancel(); fx.queue.cancelRun(fx.runId, { reason: "owner cancel" }); await rejected;
    const size = fs.statSync(marker).size; await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(fs.statSync(marker).size, size);
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM leases WHERE released_at IS NULL").get().count, 0);
    assert.equal(fx.runtime.db.prepare("SELECT state FROM attempts WHERE id=?").get(lease.attemptId).state, "cancelled");
    assert.equal(fx.runtime.get(fx.runId).state, "cancelled");
    assert.equal(fx.queue.complete(lease.token, { receiptId: "late" }).ignored, true);
  } finally { fx.close(); }
});

test("I: pause requested during work applies only after the current safe unit", () => {
  const fx = fixture("gauntlet-pause-");
  try {
    fx.runtime.db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts) VALUES('next',?,'next',2,'pending',1,0,'next',?,?,1)").run(fx.runId, now(), now());
    fx.queue.enqueueRun(fx.runId); const lease = fx.queue.checkout({ ownerId: "worker", runId: fx.runId }); fx.queue.start(lease.token);
    requestRunControl(fx.runtime.db, fx.runId, "pause", "owner pause");
    assert.equal(fx.runtime.get(fx.runId).state, "executing");
    fx.queue.complete(lease.token); applyRunControlAtBoundary(fx.runtime.db, fx.queue, fx.runId);
    assert.equal(fx.runtime.get(fx.runId).state, "paused");
    assert.equal(fx.queue.checkout({ ownerId: "must-not-start", runId: fx.runId }), null);
  } finally { fx.close(); }
});

test("J: textual separator variants produce a stable blocker fingerprint", () => {
  const first = blockerFingerprint({ code: "SCHEMA_COMPATIBILITY", path: "Src\\Importer.ts", check_id: "Schema" });
  const second = blockerFingerprint({ code: "schema-compatibility", path: "src/importer.ts", check_id: "schema" });
  assert.equal(first.fingerprint, second.fingerprint);
});

test("K: same-ordinal reviewers do not emit queue_drained until both finish", () => {
  const fx = fixture("gauntlet-queue-");
  try {
    fx.runtime.db.prepare("UPDATE workflow_steps SET step_key='review-a',ordinal=1 WHERE run_id=?").run(fx.runId);
    fx.runtime.db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts) VALUES('review-b',?,'review-b',1,'pending',1,0,'review-b',?,?,1)").run(fx.runId, now(), now());
    fx.queue.enqueueRun(fx.runId);
    const a = fx.queue.checkout({ ownerId: "review-a", runId: fx.runId }), b = fx.queue.checkout({ ownerId: "review-b", runId: fx.runId });
    fx.queue.start(a.token); fx.queue.start(b.token); fx.queue.complete(a.token);
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM events WHERE entity_id=? AND kind='queue_drained'").get(fx.runId).count, 0);
    fx.queue.complete(b.token);
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM events WHERE entity_id=? AND kind='queue_drained'").get(fx.runId).count, 1);
  } finally { fx.close(); }
});

test("L: model work may overlap outside DatabaseSync transactions and the static guard rejects await in one", async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; }); let active = 0, maximum = 0;
  const invoke = async () => { active += 1; maximum = Math.max(maximum, active); await barrier; active -= 1; };
  const first = invoke(), second = invoke(); release(); await Promise.all([first, second]);
  assert.equal(maximum, 2);
  assert.deepEqual(transactionAwaitViolations('db.exec("BEGIN IMMEDIATE");\nconst row = db.prepare("SELECT 1").get();\ndb.exec("COMMIT");'), []);
  assert.equal(transactionAwaitViolations('db.exec("BEGIN IMMEDIATE");\nawait invokeRole();\ndb.exec("COMMIT");').length, 1);
  for (const directory of [path.resolve(import.meta.dirname, "../src"), path.resolve(import.meta.dirname, "../../AgentGateway/src")]) {
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith(".mjs"))) assert.deepEqual(transactionAwaitViolations(fs.readFileSync(path.join(directory, file), "utf8"), file), []);
  }
});

test("M: cross-project check provenance is retained while routing by its registered check", () => {
  const gate = { checks: [{ id: "consumer-schema", required: true, status: "failed", execution_project_id: "consumer", execution_root: "registered-consumer-root" }] };
  const selected = targetedSteps({ steps: [{ key: "consumer-fix", allowed_paths: ["src/consumer.ts"], check_ids: ["consumer-schema"] }, { key: "producer", allowed_paths: ["src/producer.ts"], check_ids: [] }] }, { gate });
  assert.equal(gate.checks[0].execution_project_id, "consumer");
  assert.equal(gate.checks[0].execution_root, "registered-consumer-root");
  assert.deepEqual(selected.map(item => item.key), ["consumer-fix"]);
});
