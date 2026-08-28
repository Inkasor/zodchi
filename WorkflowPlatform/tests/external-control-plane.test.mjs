import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import {
  acceptExternalControlEvidenceResult, acceptExternalControlResult, createExternalControlRequest,
  pendingExternalControlRequests, registerExternalExecutor, requestExternalControlCancellation
} from "../src/external-control-plane.mjs";
import { openExternalEvidenceRequest, readInteraction } from "../src/interactions.mjs";
import { structuredHash } from "../src/role-contracts.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-external-control-")), dbFile = path.join(root, "workflow.sqlite"), db = openDb(dbFile), timestamp = now();
  fs.mkdirSync(path.join(root, "project"));
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(path.join(root, "project"), timestamp);
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES('workflow','Workflow','project','mvp','L2','active','{\"git\":false}',4096)").run();
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','Task','executing',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at) VALUES('run','task','project','workflow','external_evidence_required','mvp','work',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,state,required,idempotency_key,created_at,updated_at) VALUES('step','run','external',1,'blocked',1,'run:external',?,?)").run(timestamp, timestamp);
  const interactionId = openExternalEvidenceRequest(db, {
    taskId: "task", runId: "run", stepId: "step", question: "Collect runtime evidence", affectedSteps: ["step"],
    contract: {
      evidence_kind: "runtime_probe",
      resource: { kind: "runtime", identity: "project:test" },
      expected_provenance: { source: "test-runtime", collected_by: "executor", at_or_after: null },
      expected_completeness: { rule: "named probe", must_cover: ["health"] },
      claims: ["runtime is healthy"], command: "probe"
    }
  });
  const keys = crypto.generateKeyPairSync("ed25519"), publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });
  registerExternalExecutor(db, { projectId: "project", executorId: "runtime.test", purpose: "Fixture executor", publicKeyPem, keyId: "test-key-v1" });
  return { root, db, interactionId, privateKey: keys.privateKey, publicKeyPem };
}

function close(fx) { fx.db.close(); fs.rmSync(fx.root, { recursive: true, force: true }); }

function signedResult(request, privateKey, payload, overrides = {}) {
  const packet = {
    schema_version: 1,
    request_id: request.request_id,
    request_hash: request.request_hash,
    project_id: request.project_id,
    run_id: request.run_id,
    step_id: request.step_id,
    executor_id: request.executor_id,
    key_id: request.executor_key_id,
    checkpoint_hash: request.checkpoint_hash,
    status: "completed",
    payload,
    payload_hash: structuredHash(payload),
    finished_at: new Date().toISOString(),
    signature: ""
  };
  Object.assign(packet, overrides);
  const core = {
    schema_version: packet.schema_version, request_id: packet.request_id, request_hash: packet.request_hash,
    project_id: packet.project_id, run_id: packet.run_id, step_id: packet.step_id, executor_id: packet.executor_id,
    key_id: packet.key_id, checkpoint_hash: packet.checkpoint_hash, status: packet.status,
    payload_hash: packet.payload_hash, finished_at: packet.finished_at
  };
  packet.signature = crypto.sign(null, Buffer.from(structuredHash(core), "utf8"), privateKey).toString("base64");
  return packet;
}

test("a signed external result is bound to request, run, step and checkpoint without persisting raw payload", () => {
  const fx = fixture();
  try {
    const marker = "RAW_CONTROL_PAYLOAD_MUST_NOT_PERSIST";
    const created = createExternalControlRequest(fx.db, { projectId: "project", runId: "run", stepId: "step", interactionId: fx.interactionId, executorId: "runtime.test", action: "probe", checkpointHash: "a".repeat(64), payload: { command: marker }, payloadRef: "artifact://request/1", idempotencyKey: "run-step-probe" });
    assert.equal(created.created, true);
    assert.equal(createExternalControlRequest(fx.db, { projectId: "project", runId: "run", stepId: "step", interactionId: fx.interactionId, executorId: "runtime.test", action: "probe", checkpointHash: "a".repeat(64), payload: { command: marker }, payloadRef: "artifact://request/1", idempotencyKey: "run-step-probe" }).created, false);
    assert.throws(() => createExternalControlRequest(fx.db, { projectId: "project", runId: "run", stepId: "step", interactionId: fx.interactionId, executorId: "runtime.test", action: "different", checkpointHash: "a".repeat(64), payload: { command: marker }, idempotencyKey: "run-step-probe" }), /IDEMPOTENCY_CONFLICT/);
    const resultPayload = { status: "healthy", marker: "RAW_RESULT_MUST_NOT_PERSIST" }, packet = signedResult(created.request, fx.privateKey, resultPayload);
    const accepted = acceptExternalControlResult(fx.db, packet);
    assert.equal(accepted.accepted, true);
    assert.equal(acceptExternalControlResult(fx.db, packet).duplicate, true);
    const persisted = fx.db.prepare("SELECT r.*,q.* FROM external_control_results r JOIN external_control_requests q ON q.id=r.request_id WHERE q.id=?").get(created.request.request_id);
    assert.equal(JSON.stringify(persisted).includes(marker), false);
    assert.equal(JSON.stringify(persisted).includes(resultPayload.marker), false);
    const tampered = signedResult({ ...created.request, checkpoint_hash: "b".repeat(64) }, fx.privateKey, resultPayload);
    assert.throws(() => acceptExternalControlResult(fx.db, tampered), /BINDING_MISMATCH/);
  } finally { close(fx); }
});

test("external evidence enters the canonical interaction only after signature and evidence validation", () => {
  const fx = fixture();
  try {
    const created = createExternalControlRequest(fx.db, { projectId: "project", runId: "run", stepId: "step", interactionId: fx.interactionId, executorId: "runtime.test", action: "collect_evidence", checkpointHash: "c".repeat(64), payload: { probe: "health" } });
    const evidencePacket = {
      evidence_kind: "runtime_probe",
      resource: { kind: "runtime", identity: "project:test" },
      provenance: { source: "test-runtime", collected_by: "executor" },
      completeness: { rule: "named probe", covered: ["health"] },
      claims: ["runtime is healthy"], collected_at: new Date().toISOString(), content: "health=ok"
    };
    const packet = signedResult(created.request, fx.privateKey, { evidence_packet: evidencePacket });
    const badSignature = { ...packet, signature: Buffer.from("bad").toString("base64") };
    assert.throws(() => acceptExternalControlEvidenceResult(fx.db, badSignature), /SIGNATURE_INVALID/);
    assert.equal(readInteraction(fx.db, fx.interactionId).status, "pending");
    const accepted = acceptExternalControlEvidenceResult(fx.db, packet);
    assert.equal(accepted.evidence.settled, true);
    assert.equal(readInteraction(fx.db, fx.interactionId).status, "approved");
    assert.equal(readInteraction(fx.db, fx.interactionId).answer.evidence.content_hash.length, 64);
  } finally { close(fx); }
});

test("cancellation is hash-bound and key rotation waits for pending requests", () => {
  const fx = fixture();
  try {
    const created = createExternalControlRequest(fx.db, { projectId: "project", runId: "run", stepId: "step", interactionId: fx.interactionId, executorId: "runtime.test", action: "long_probe", checkpointHash: "d".repeat(64), payload: { probe: "slow" } });
    const rotated = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    assert.throws(() => registerExternalExecutor(fx.db, { projectId: "project", executorId: "runtime.test", publicKeyPem: rotated, keyId: "test-key-v2" }), /KEY_ROTATION_BLOCKED/);
    const cancellation = requestExternalControlCancellation(fx.db, created.request.request_id, { reason: "owner stopped the run" });
    assert.equal(cancellation.requested, true);
    assert.match(cancellation.cancellation.cancel_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(requestExternalControlCancellation(fx.db, created.request.request_id), { requested: false, status: "cancel_requested", request_id: created.request.request_id, cancel_hash: cancellation.cancellation.cancel_hash });
    assert.equal(pendingExternalControlRequests(fx.db, "project")[0].status, "cancel_requested");
    const cancelled = signedResult(created.request, fx.privateKey, { reason: "cancelled" }, { status: "cancelled" });
    assert.equal(acceptExternalControlResult(fx.db, cancelled).status, "cancelled");
    assert.equal(pendingExternalControlRequests(fx.db, "project").length, 0);
  } finally { close(fx); }
});
