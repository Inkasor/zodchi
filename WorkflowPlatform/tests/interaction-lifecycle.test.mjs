import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { onboardProject } from "../src/onboarding.mjs";
import { openDb, now } from "../src/db.mjs";
import { deliverExternalEvidencePacket, processMessage } from "../src/workflow-app.mjs";
import { classificationCatalog, validateClassificationDecision } from "../src/classifier.mjs";
import {
  cancelInteraction, deliverEvidence, expireInteractions, openClarification, openExternalEvidenceRequest,
  pendingInteractions, quiesceRun, readInteraction, settleInteraction, supersedeInteraction, validateEvidenceContract
} from "../src/interactions.mjs";

// A wait is not a pause. These cases are about which of the two waits a run is in, and what it takes to
// end it: a person's answer, a delivered evidence packet, an explicit cancellation, a supersede, or the
// deadline the wait declared for itself. Nothing else ends one — least of all the next message to arrive.

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function roleContract(roleId, schema, artifacts) {
  return {
    id: `contract-${roleId}`, role_id: roleId, version: "1.0.0", purpose: `${roleId} test contract`, boundaries: { writes: roleId === "worker" },
    allowed_work_types: ["*"], allowed_artifact_types: artifacts, allowed_tools: [], allowed_skills: [], required_checks: ["check-ok"],
    allowed_transitions: [], allowed_profiles: ["*"], context_limit_bytes: 65536, max_calls: 3, max_correction_cycles: 1,
    timeout_seconds: 60, result_schema_key: schema, prompt_template_version: "1.0.0", escalation: { on_invalid: "blocked" }
  };
}

function fixture(prefix) {
  const root = temporaryRoot(prefix);
  const project = path.join(root, "project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "context.mjs"), "export function inspect(value) { return value; }\n");
  const roles = [["planner", "planner.v1", ["code"]], ["worker", "worker.v1", ["code"]], ["reviewer", "reviewer.v1", ["code"]]];
  onboardProject(dbFile, {
    project: { id: "project", name: "Project", root_path: project },
    workflow: { id: "workflow", name: "Workflow", discovery: { git: false }, history_budget_bytes: 8192 },
    profiles: roles.map(([role]) => ({ id: `profile-${role}`, provider: "codex", name: `local-${role}`, role_id: role })),
    routes: [{ work_type_id: "implementation" }],
    checks: [{ id: "check-ok", name: "Test check", runner: "fixture", kind: "fixture", config: { status: "passed" } }],
    project_checks: [{ check_id: "check-ok", quality_mode_id: "mvp", required: true }],
    role_contracts: roles.map(([role, schema, artifacts]) => roleContract(role, schema, artifacts)),
    role_assignments: roles.map(([role]) => ({ role_id: role, profile_id: `profile-${role}`, operational_level: "mvp" }))
  });
  return { root, project, dbFile };
}

function bareFixture(prefix) {
  const root = temporaryRoot(prefix);
  const project = path.join(root, "project");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(project);
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, now());
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES('workflow','Workflow','project','mvp','L2','active','{\"git\":false}',4096)").run();
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','waiting','executing',?,?)").run(now(), now());
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at) VALUES('waiting','task','project','workflow','executing','mvp','waiting',?,?)").run(now(), now());
  return { root, dbFile, db };
}

function contract(overrides = {}) {
  return {
    evidence_kind: "posting_log",
    resource: { kind: "one_c_infobase", identity: "srvr=erp-prod;ref=trade" },
    expected_provenance: { source: "1c_event_log", collected_by: "owner", at_or_after: null },
    expected_completeness: { rule: "every posting of document 000123 in the period", must_cover: ["register:stock", "register:settlements"] },
    claims: ["the posting writes both registers"],
    command: null,
    ...overrides
  };
}

function packet(overrides = {}) {
  return {
    resource: { kind: "one_c_infobase", identity: "srvr=erp-prod;ref=trade" },
    provenance: { source: "1c_event_log" },
    completeness: { covered: ["register:stock", "register:settlements"] },
    collected_at: new Date().toISOString(),
    content_hash: "a".repeat(64),
    ...overrides
  };
}

test("an evidence contract that cannot be checked is refused before anyone is asked for it", () => {
  assert.doesNotThrow(() => validateEvidenceContract(contract()));
  // Each omission is a way a wrong packet would be accepted as the right one: from another information
  // base, without a stated origin, or covering a fragment of what the claim needs.
  for (const [field, value] of [["resource", { resource: undefined }], ["expected_provenance.source", { expected_provenance: {} }], ["expected_completeness.rule", { expected_completeness: { must_cover: [] } }], ["claims", { claims: [] }]]) {
    assert.throws(() => validateEvidenceContract(contract(value)), new RegExp(`EXTERNAL_EVIDENCE_CONTRACT_INCOMPLETE: ${field.replace(".", "\\.")}`));
  }
});

test("only a packet that satisfies the declared contract closes an evidence request", () => {
  const { root, dbFile, db } = bareFixture("workflow-evidence-packet-");
  const interactionId = openExternalEvidenceRequest(db, { taskId: "task", runId: "waiting", question: "Нужен журнал проведения.", contract: contract(), affectedSteps: ["worker"] });

  // A packet from another information base is about a different fact, and a packet that covers one of
  // two registers proves half a claim. Both leave the request open rather than closing it on trust.
  assert.throws(() => deliverEvidence(db, interactionId, packet({ resource: { kind: "one_c_infobase", identity: "srvr=erp-test;ref=trade" } })), /EXTERNAL_EVIDENCE_PACKET_INVALID: resource/);
  assert.throws(() => deliverEvidence(db, interactionId, packet({ completeness: { covered: ["register:stock"] } })), /EXTERNAL_EVIDENCE_PACKET_INCOMPLETE: register:settlements/);
  assert.equal(readInteraction(db, interactionId).status, "pending");

  const delivered = deliverEvidence(db, interactionId, packet(), { answeredRunId: "waiting" });
  assert.equal(delivered.settled, true);
  assert.equal(readInteraction(db, interactionId).answer.evidence.content_hash, "a".repeat(64));

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a wait ends only by an answer, a cancellation, a supersede or the deadline it declared", () => {
  const { root, dbFile, db } = bareFixture("workflow-wait-endings-");
  const past = new Date(Date.now() - 60_000).toISOString();
  const timedOut = openClarification(db, { taskId: "task", runId: "waiting", question: "Успеете до пятницы?", expiresAt: past });
  const openEnded = openClarification(db, { taskId: "task", runId: "waiting", question: "Какой контур считать основным?" });
  const cancelled = openClarification(db, { taskId: "task", runId: "waiting", question: "Отменяемый вопрос." });
  const replaced = openClarification(db, { taskId: "task", runId: "waiting", question: "Ранняя формулировка." });

  // A deadline is the only ending nobody sends, so it is the only one the platform applies by itself.
  // A question that declared none waits indefinitely: the platform has no basis for deciding otherwise.
  assert.deepEqual(expireInteractions(db, "project"), [timedOut]);
  assert.equal(readInteraction(db, openEnded).status, "pending");

  cancelInteraction(db, cancelled, "owner withdrew the question");
  const replacement = openClarification(db, { taskId: "task", runId: "waiting", question: "Уточнённая формулировка." });
  supersedeInteraction(db, replaced, replacement);
  assert.equal(readInteraction(db, replaced).superseded_by, replacement);

  assert.deepEqual(pendingInteractions(db, "project").map(item => item.id), [openEnded, replacement]);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a second answer to the same question is recorded and does not overwrite the first", () => {
  const { root, dbFile, db } = bareFixture("workflow-duplicate-answer-");
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task_a','project','a','received',?,?)").run(now(), now());
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at) VALUES('answer_a','task_a','project','workflow','received','mvp','a',?,?)").run(now(), now());
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task_b','project','b','received',?,?)").run(now(), now());
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at) VALUES('answer_b','task_b','project','workflow','received','mvp','b',?,?)").run(now(), now());
  const interactionId = openClarification(db, { taskId: "task", runId: "waiting", question: "Кто принимает решение?" });

  // Two people answering the same question at once is ordinary. Exactly one answer settles it; the other
  // is reported as already settled rather than silently replacing what the first person said.
  const first = settleInteraction(db, interactionId, { status: "approved", answeredRunId: "answer_a" });
  const second = settleInteraction(db, interactionId, { status: "rejected", answeredRunId: "answer_b" });
  assert.equal(first.settled, true);
  assert.equal(second.settled, false);
  assert.equal(second.status, "approved");
  assert.equal(second.first_answered_run_id, "answer_a");
  assert.equal(readInteraction(db, interactionId).answered_run_id, "answer_a");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind='interaction_response_duplicate'").get().count, 1);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an open wait and its contract survive the process that opened it", () => {
  const { root, dbFile, db } = bareFixture("workflow-wait-restart-");
  const interactionId = openExternalEvidenceRequest(db, { taskId: "task", runId: "waiting", question: "Нужен журнал проведения.", contract: contract({ command: "1cv8 ... /DumpEventLog" }), affectedSteps: ["worker"] });
  db.close();

  // A wait that only lived in memory would be lost on restart and the run would resume without the fact
  // it was waiting for. Reopened, the request is still open and still checkable against its own contract.
  const reopened = openDb(dbFile);
  const restored = readInteraction(reopened, interactionId);
  assert.equal(restored.status, "pending");
  assert.equal(restored.detail.resource.identity, "srvr=erp-prod;ref=trade");
  assert.equal(restored.detail.command, "1cv8 ... /DumpEventLog");
  assert.deepEqual(restored.affected_steps, ["worker"]);
  assert.equal(deliverEvidence(reopened, interactionId, packet()).settled, true);

  reopened.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("opening a wait leaves no lease held and no child half-running", () => {
  const { root, dbFile, db } = bareFixture("workflow-quiesce-");
  const timestamp = now();
  for (const [stepId, key, ordinal, state] of [["step_leased", "leased", 1, "leased"], ["step_running", "running", 2, "running"]]) {
    db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,role_id,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts) VALUES(?,?,?,?,NULL,?,1,0,?,?,?,3)")
      .run(stepId, "waiting", key, ordinal, state, `waiting:${key}`, timestamp, timestamp);
  }
  db.prepare("INSERT INTO leases(id,step_id,owner_id,token_hash,acquired_at,expires_at,heartbeat_at) VALUES('lease_1','step_leased','owner','hash_1',?,?,?)").run(timestamp, timestamp, timestamp);
  db.prepare("INSERT INTO attempts(id,step_id,ordinal,state,started_at) VALUES('attempt_1','step_running',1,'running',?)").run(timestamp);

  const quiesced = quiesceRun(db, "waiting", "external evidence requested");
  assert.deepEqual(quiesced.leases, ["lease_1"]);
  assert.deepEqual(quiesced.attempts, ["attempt_1"]);
  // Nothing ran of the leased step, so it goes back to ready. Part of the running one did, so it blocks:
  // resuming has to decide what to do with that part instead of silently starting it over.
  assert.deepEqual(quiesced.steps, [{ id: "step_leased", state: "ready" }, { id: "step_running", state: "blocked" }]);
  assert.equal(db.prepare("SELECT release_reason FROM leases WHERE id='lease_1'").get().release_reason, "interaction_opened");
  assert.equal(db.prepare("SELECT state FROM attempts WHERE id='attempt_1'").get().state, "cancelled");

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a message asserting an external fact does not close the request that asked for it", () => {
  const { root, dbFile, db } = bareFixture("workflow-evidence-not-text-");
  const interactionId = openExternalEvidenceRequest(db, { taskId: "task", runId: "waiting", question: "Нужен журнал проведения.", contract: contract(), affectedSteps: ["worker"] });
  for (const [table, values] of [["work_types", ["implementation", "conversation", "clarification", "research"]], ["artifact_types", ["code", "none"]], ["domains", ["workflow"]], ["disciplines", ["software"]]]) {
    for (const value of values) db.prepare(`INSERT OR IGNORE INTO ${table}(id,name${table === "artifact_types" || table === "work_types" ? ",category" : ""}) VALUES(?,?${table === "artifact_types" || table === "work_types" ? ",'general'" : ""})`).run(value, value);
  }
  db.prepare("INSERT OR IGNORE INTO quality_modes(id,name,ordinal) VALUES('mvp','mvp',1)").run();
  db.prepare("INSERT OR IGNORE INTO planning_levels(id,name,ordinal) VALUES('L2','L2',2)").run();
  db.prepare("INSERT INTO workflow_routes(project_id,work_type_id,workflow_id,enabled,priority) VALUES('project','implementation','workflow',1,10)").run();

  const base = {
    schema_version: 1, work_type: "conversation", artifact_type: "none", domain: "workflow", discipline: "software",
    risk: "low", planning_level: "L2", quality_mode: "mvp", planning_required: false, human_required: false,
    needs_questions: false, document_required: false, reply_mode: "conversation", pending_interaction_id: interactionId,
    reason: "Владелец утверждает, что оба регистра пишутся.", questions: [], human_response: "Да, пишутся оба."
  };
  const catalog = classificationCatalog(db, "project");
  // The contract travels with the request so the person can tell whether they have what was asked for.
  assert.equal(catalog.pending_interactions.find(item => item.id === interactionId).evidence_contract.resource.identity, "srvr=erp-prod;ref=trade");

  const asserted = validateClassificationDecision({ ...base, pending_interaction_response: "approve" }, catalog);
  assert.equal(asserted.pending_interaction_response, "undecided");
  assert.equal(asserted.external_evidence_claimed_without_packet, true);
  const refused = validateClassificationDecision({ ...base, pending_interaction_response: "decline" }, catalog);
  assert.equal(refused.pending_interaction_response, "decline");

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function classification(overrides = {}) {
  return {
    schema_version: 1, work_type: "implementation", artifact_type: "code", domain: "workflow", discipline: "software",
    risk: "low", planning_level: "L2", quality_mode: "mvp", planning_required: true, human_required: false,
    needs_questions: false, document_required: false, reply_mode: "work", pending_interaction_id: null,
    pending_interaction_response: null, reason: "Нужен ограниченный пакет кода.", questions: [], human_response: null, ...overrides
  };
}

function receipt(role, result) {
  const timestamp = new Date().toISOString();
  return {
    receiptId: `${role}-receipt`, taskId: `${role}-task`, provider: "codex", profile: `local-${role}`, role,
    status: "completed", exitCode: 0, startedAt: timestamp, finishedAt: timestamp, usage: { input_tokens: 10, output_tokens: 5 },
    output: JSON.stringify({ item: { text: JSON.stringify(result) } })
  };
}

function readyPlan() {
  return {
    schema_version: 1, outcome: "ready", scope: { included: ["bounded result"], excluded: [] },
    allowed_paths: ["src/output.txt"], inputs: ["registered context"], checks: ["check-ok"], risks: [],
    artifacts: [{ key: "code-output", type: "code", path: "src/output.txt", required: true }],
    completion_criteria: ["registered gate passes"], questions: [],
    steps: [{ key: "worker", role: "worker", objective: "Create the bounded output", allowed_paths: ["src/output.txt"], artifact_keys: ["code-output"], check_ids: ["check-ok"], required: true, irreversible: false, max_attempts: 1 }]
  };
}

test("an answered clarification continues the run that asked instead of opening another one", async () => {
  const env = fixture("workflow-clarification-resume-");
  const calls = [];
  let plannerCalls = 0;
  let secondPlannerPrompt = "";
  const gatewayCall = async request => {
    calls.push(request.role);
    if (request.role === "planner") {
      plannerCalls += 1;
      if (plannerCalls === 1) return receipt("planner", { ...readyPlan(), outcome: "questions", steps: [], artifacts: [], questions: ["Куда писать результат?"] });
      secondPlannerPrompt = fs.readFileSync(request.taskFile, "utf8");
      return receipt("planner", readyPlan());
    }
    if (request.role === "worker") {
      const file = path.join(env.project, "src", "output.txt");
      fs.writeFileSync(file, "bounded output");
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      return receipt("worker", { schema_version: 1, status: "completed", summary: "Created output.", changed_paths: ["src/output.txt"], artifacts: [{ key: "code-output", type: "code", path: "src/output.txt", content_hash: hash, status: "created" }], evidence: ["file hash"], questions: [], external_evidence_request: null });
    }
    return receipt("reviewer", { schema_version: 1, decision: "PASS", summary: "All criteria passed.", blockers: [], required_actions: [], evidence_refs: ["gate:passed"] });
  };

  const asked = await processMessage({ message: "Сделай ограниченный вывод", project: env.project, dbFile: env.dbFile, execute: true, classificationResult: classification(), gatewayCall, gateRunner: async () => ({ status: "passed", checks: [] }) });
  assert.equal(asked.execution.status, "clarification_required");

  const paused = openDb(env.dbFile);
  const questionId = paused.prepare("SELECT id FROM approvals WHERE status='pending' AND kind='planner_clarification'").get().id;
  paused.close();

  const answered = await processMessage({ message: "В src/output.txt", project: env.project, dbFile: env.dbFile, execute: true, classificationResult: classification({ pending_interaction_id: questionId, reply_mode: "conversation", planning_required: false, artifact_type: "none", work_type: "conversation", human_response: "В src/output.txt" }), gatewayCall, gateRunner: async () => ({ status: "passed", checks: [] }) });

  // The answer belongs to the run that asked. Routing it through a fresh run would replan work already
  // done and pay for every model call again, so the intake run only records the delivery.
  assert.equal(answered.execution?.error ?? answered.route, "work");
  assert.equal(answered.execution.status, "completed");
  const verified = openDb(env.dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(asked.run_id).state, "completed");
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(answered.run_id).state, "completed");
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 2);
  // Replanning appends its steps to the run that asked, prefixed the way a correction cycle is, so the
  // superseded first attempt stays readable instead of being overwritten by the plan that replaced it.
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND step_key='replan_1_worker' AND state='completed'").get(asked.run_id).count, 1);
  assert.equal(verified.prepare("SELECT status FROM approvals WHERE id=?").get(questionId).status, "approved");
  verified.close();

  // The resumed planning carries the answer, or it would ask the same question again.
  assert.match(secondPlannerPrompt, /ANSWERED_BEFORE_RESUMING/);
  assert.match(secondPlannerPrompt, /В src\/output\.txt/);
  assert.deepEqual(calls.filter(role => role === "worker").length, 1);

  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a message that answers nothing stays its own run and leaves the open question open", async () => {
  const env = fixture("workflow-unrelated-message-");
  const gatewayCall = async request => {
    if (request.role === "planner") return receipt("planner", { ...readyPlan(), outcome: "questions", steps: [], artifacts: [], questions: ["Куда писать результат?"] });
    return receipt(request.role, {});
  };
  const asked = await processMessage({ message: "Сделай ограниченный вывод", project: env.project, dbFile: env.dbFile, execute: true, classificationResult: classification(), gatewayCall, gateRunner: async () => ({ status: "passed", checks: [] }) });
  assert.equal(asked.execution.status, "clarification_required");

  const unrelated = await processMessage({ message: "Как дела?", project: env.project, dbFile: env.dbFile, execute: true, classificationResult: classification({ work_type: "conversation", artifact_type: "none", reply_mode: "conversation", planning_required: false, human_response: "Всё в порядке." }), gatewayCall, gateRunner: async () => ({ status: "passed", checks: [] }) });
  assert.equal(unrelated.route, "conversation");

  // The old semantics settled every open question whenever any message arrived, answered or not. A
  // question guarding an unproven claim then disappeared without anyone deciding it should.
  const verified = openDb(env.dbFile);
  const open = verified.prepare("SELECT run_id,status FROM approvals WHERE status='pending'").all();
  assert.equal(open.length, 1);
  assert.equal(open[0].run_id, asked.run_id);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(asked.run_id).state, "clarification_required");
  verified.close();

  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a worker blocked on an external fact parks the run and asks for evidence, not for words", async () => {
  const env = fixture("workflow-worker-evidence-");
  const gatewayCall = async request => {
    if (request.role === "planner") return receipt("planner", readyPlan());
    if (request.role === "worker") return receipt("worker", { schema_version: 1, status: "blocked", summary: "Нужен журнал проведения из рабочей ИБ.", changed_paths: [], artifacts: [], evidence: [], questions: [], external_evidence_request: contract() });
    return receipt(request.role, {});
  };
  const blocked = await processMessage({ message: "Проверь проведение документа", project: env.project, dbFile: env.dbFile, execute: true, classificationResult: classification(), gatewayCall, gateRunner: async () => ({ status: "passed", checks: [] }) });
  assert.equal(blocked.execution.status, "external_evidence_required");

  const verified = openDb(env.dbFile);
  assert.equal(verified.prepare("SELECT state FROM workflow_runs WHERE id=?").get(blocked.run_id).state, "external_evidence_required");
  const request = verified.prepare("SELECT id,kind,detail_json,affected_steps_json FROM approvals WHERE status='pending'").get();
  assert.equal(request.kind, "external_evidence");
  assert.equal(JSON.parse(request.detail_json).resource.identity, "srvr=erp-prod;ref=trade");
  assert.deepEqual(JSON.parse(request.affected_steps_json), ["worker"]);
  // Nothing is left holding a lease while the owner is asked for something only they can supply.
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM leases WHERE released_at IS NULL").get().count, 0);
  verified.close();

  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a delivered evidence packet resumes the run that asked for it", async () => {
  const env = fixture("workflow-evidence-resume-");
  let workerCalls = 0;
  const gatewayCall = async request => {
    if (request.role === "planner") return receipt("planner", readyPlan());
    if (request.role === "worker") {
      workerCalls += 1;
      if (workerCalls === 1) return receipt("worker", { schema_version: 1, status: "blocked", summary: "Нужен журнал проведения.", changed_paths: [], artifacts: [], evidence: [], questions: [], external_evidence_request: contract() });
      const file = path.join(env.project, "src", "output.txt");
      fs.writeFileSync(file, "bounded output");
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      return receipt("worker", { schema_version: 1, status: "completed", summary: "Проверено по журналу.", changed_paths: ["src/output.txt"], artifacts: [{ key: "code-output", type: "code", path: "src/output.txt", content_hash: hash, status: "created" }], evidence: ["evidence packet"], questions: [], external_evidence_request: null });
    }
    return receipt("reviewer", { schema_version: 1, decision: "PASS", summary: "All criteria passed.", blockers: [], required_actions: [], evidence_refs: ["gate:passed"] });
  };
  const gateRunner = async () => ({ status: "passed", checks: [] });

  const blocked = await processMessage({ message: "Проверь проведение документа", project: env.project, dbFile: env.dbFile, execute: true, classificationResult: classification(), gatewayCall, gateRunner });
  assert.equal(blocked.execution.status, "external_evidence_required");
  const waiting = openDb(env.dbFile);
  const interactionId = waiting.prepare("SELECT id FROM approvals WHERE status='pending' AND kind='external_evidence'").get().id;
  waiting.close();

  // Delivery is the only thing that closes the request, and it continues the run that asked rather than
  // opening a new one: the plan, the gate and the calls already made are still that run's history.
  const resumed = await deliverExternalEvidencePacket({ interactionId, packet: packet(), project: env.project, dbFile: env.dbFile, gatewayCall, gateRunner });
  assert.equal(resumed.delivered, true);
  assert.equal(resumed.run_id, blocked.run_id);
  assert.equal(resumed.execution.status, "completed");

  const verified = openDb(env.dbFile);
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get().count, 1);
  assert.equal(verified.prepare("SELECT status FROM approvals WHERE id=?").get(interactionId).status, "approved");
  verified.close();

  fs.rmSync(env.root, { recursive: true, force: true });
});
