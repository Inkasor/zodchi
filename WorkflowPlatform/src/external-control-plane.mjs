import crypto from "node:crypto";
import { id, now } from "./db.mjs";
import { appendEvent } from "./state-machine.mjs";
import { structuredHash } from "./role-contracts.mjs";
import { deliverEvidence } from "./interactions.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const HASH = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: object required`);
  const expected = [...fields].sort(), actual = Object.keys(value).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${label}: exact fields required: ${expected.join(",")}`);
}

function requireHash(value, label) {
  if (!HASH.test(String(value ?? ""))) throw new Error(`EXTERNAL_CONTROL_HASH_INVALID: ${label}`);
  return String(value);
}

function requestRow(db, requestId) {
  return db.prepare("SELECT * FROM external_control_requests WHERE id=?").get(requestId) ?? null;
}

function executorRow(db, projectId, executorId) {
  return db.prepare("SELECT * FROM external_executors WHERE project_id=? AND id=? AND active=1").get(projectId, executorId) ?? null;
}

function requestCore({ requestId, projectId, runId, stepId, interactionId, executorId, executorKeyId, action, checkpointHash, payloadHash, payloadRef, idempotencyKey, createdAt }) {
  return {
    schema_version: 1,
    request_id: requestId,
    project_id: projectId,
    run_id: runId,
    step_id: stepId,
    interaction_id: interactionId,
    executor_id: executorId,
    executor_key_id: executorKeyId,
    action,
    checkpoint_hash: checkpointHash,
    payload_hash: payloadHash,
    payload_ref: payloadRef,
    idempotency_key: idempotencyKey,
    created_at: createdAt
  };
}

export function registerExternalExecutor(db, { projectId, executorId, purpose = null, publicKeyPem, keyId }) {
  if (!IDENTIFIER.test(String(executorId ?? ""))) throw new Error(`EXTERNAL_EXECUTOR_ID_INVALID: ${executorId}`);
  if (!IDENTIFIER.test(String(keyId ?? ""))) throw new Error(`EXTERNAL_EXECUTOR_KEY_ID_INVALID: ${keyId}`);
  const project = db.prepare("SELECT id FROM projects WHERE id=?").get(projectId);
  if (!project) throw new Error(`PROJECT_NOT_REGISTERED: ${projectId}`);
  let key;
  try { key = crypto.createPublicKey(publicKeyPem); } catch (error) { throw new Error(`EXTERNAL_EXECUTOR_PUBLIC_KEY_INVALID: ${error.message}`); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`EXTERNAL_EXECUTOR_KEY_TYPE_INVALID: ${key.asymmetricKeyType ?? "unknown"}`);
  const normalized = key.export({ type: "spki", format: "pem" });
  const timestamp = now();
  const existing = db.prepare("SELECT id,public_key_pem,key_id FROM external_executors WHERE project_id=? AND id=?").get(projectId, executorId);
  if (existing && (existing.public_key_pem !== normalized || existing.key_id !== keyId)) {
    const pending = db.prepare("SELECT COUNT(*) count FROM external_control_requests WHERE project_id=? AND executor_id=? AND status IN ('pending','cancel_requested')").get(projectId, executorId).count;
    if (pending) throw new Error(`EXTERNAL_EXECUTOR_KEY_ROTATION_BLOCKED: ${executorId} has ${pending} pending request(s)`);
  }
  if (existing) db.prepare("UPDATE external_executors SET purpose=?,public_key_pem=?,key_id=?,active=1,updated_at=? WHERE id=? AND project_id=?").run(purpose, normalized, keyId, timestamp, executorId, projectId);
  else db.prepare("INSERT INTO external_executors(id,project_id,purpose,public_key_pem,key_id,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)").run(executorId, projectId, purpose, normalized, keyId, timestamp, timestamp);
  return Object.freeze({ project_id: projectId, executor_id: executorId, key_id: keyId, public_key_fingerprint: structuredHash(normalized) });
}

export function createExternalControlRequest(db, { projectId, runId, stepId = null, interactionId = null, executorId, action, checkpointHash, payload, payloadRef = null, idempotencyKey = null }) {
  if (!IDENTIFIER.test(String(executorId ?? ""))) throw new Error(`EXTERNAL_EXECUTOR_ID_INVALID: ${executorId}`);
  if (typeof action !== "string" || !action.trim()) throw new Error("EXTERNAL_CONTROL_ACTION_REQUIRED");
  requireHash(checkpointHash, "checkpoint_hash");
  if (payload === undefined) throw new Error("EXTERNAL_CONTROL_PAYLOAD_REQUIRED");
  if (payloadRef !== null && (typeof payloadRef !== "string" || !payloadRef.trim())) throw new Error("EXTERNAL_CONTROL_PAYLOAD_REF_INVALID");
  const run = db.prepare("SELECT id,project_id FROM workflow_runs WHERE id=?").get(runId);
  if (!run || run.project_id !== projectId) throw new Error(`EXTERNAL_CONTROL_RUN_PROJECT_MISMATCH: ${runId}`);
  if (stepId && !db.prepare("SELECT id FROM workflow_steps WHERE id=? AND run_id=?").get(stepId, runId)) throw new Error(`EXTERNAL_CONTROL_STEP_MISMATCH: ${stepId}`);
  if (interactionId && !db.prepare("SELECT id FROM approvals WHERE id=? AND run_id=?").get(interactionId, runId)) throw new Error(`EXTERNAL_CONTROL_INTERACTION_MISMATCH: ${interactionId}`);
  const executor = executorRow(db, projectId, executorId);
  if (!executor) throw new Error(`EXTERNAL_EXECUTOR_NOT_REGISTERED: ${executorId}`);
  const payloadHash = structuredHash(payload), requestId = id("control"), createdAt = now();
  const effectiveIdempotencyKey = idempotencyKey ?? structuredHash({ runId, stepId, interactionId, executorId, action, checkpointHash, payloadHash });
  const core = requestCore({ requestId, projectId, runId, stepId, interactionId, executorId, executorKeyId: executor.key_id, action: action.trim(), checkpointHash, payloadHash, payloadRef, idempotencyKey: effectiveIdempotencyKey, createdAt });
  const requestHash = structuredHash(core);
  const existing = db.prepare("SELECT * FROM external_control_requests WHERE project_id=? AND idempotency_key=?").get(projectId, effectiveIdempotencyKey);
  if (existing) {
    const comparable = requestCore({ requestId: existing.id, projectId: existing.project_id, runId: existing.run_id, stepId: existing.step_id, interactionId: existing.interaction_id, executorId: existing.executor_id, executorKeyId: existing.executor_key_id, action: existing.action, checkpointHash: existing.checkpoint_hash, payloadHash: existing.payload_hash, payloadRef: existing.payload_ref, idempotencyKey: existing.idempotency_key, createdAt: existing.created_at });
    const sameIntent = structuredHash({ ...comparable, request_id: null, created_at: null }) === structuredHash({ ...core, request_id: null, created_at: null });
    if (!sameIntent) throw new Error(`EXTERNAL_CONTROL_IDEMPOTENCY_CONFLICT: ${effectiveIdempotencyKey}`);
    return Object.freeze({ created: false, request: Object.freeze({ ...comparable, request_hash: existing.request_hash, payload }) });
  }
  db.prepare(`INSERT INTO external_control_requests(id,project_id,run_id,step_id,interaction_id,executor_id,executor_key_id,action,checkpoint_hash,payload_hash,payload_ref,request_hash,idempotency_key,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?)`).run(requestId, projectId, runId, stepId, interactionId, executorId, executor.key_id, action.trim(), checkpointHash, payloadHash, payloadRef, requestHash, effectiveIdempotencyKey, createdAt, createdAt);
  appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: "external_control_requested", payload: { request_id: requestId, request_hash: requestHash, executor_id: executorId, checkpoint_hash: checkpointHash, interaction_id: interactionId } });
  return Object.freeze({ created: true, request: Object.freeze({ ...core, request_hash: requestHash, payload }) });
}

export function requestExternalControlCancellation(db, requestId, { actor = "owner", reason = "cancelled" } = {}) {
  const found = requestRow(db, requestId);
  if (!found) throw new Error(`EXTERNAL_CONTROL_REQUEST_NOT_FOUND: ${requestId}`);
  if (TERMINAL.has(found.status)) return Object.freeze({ requested: false, status: found.status, request_id: requestId });
  if (found.status === "cancel_requested") return Object.freeze({ requested: false, status: found.status, request_id: requestId, cancel_hash: found.cancel_hash });
  const cancelledAt = now();
  const core = { schema_version: 1, request_id: requestId, request_hash: found.request_hash, action: "cancel", actor, reason, requested_at: cancelledAt };
  const cancelHash = structuredHash(core);
  db.prepare("UPDATE external_control_requests SET status='cancel_requested',cancel_hash=?,updated_at=? WHERE id=? AND status IN ('pending','cancel_requested')").run(cancelHash, cancelledAt, requestId);
  appendEvent(db, { entityType: "workflow_run", entityId: found.run_id, kind: "external_control_cancel_requested", payload: { request_id: requestId, request_hash: found.request_hash, cancel_hash: cancelHash, actor } });
  return Object.freeze({ requested: true, cancellation: Object.freeze({ ...core, cancel_hash: cancelHash }) });
}

function resultCore(packet, payloadHash) {
  return {
    schema_version: packet.schema_version,
    request_id: packet.request_id,
    request_hash: packet.request_hash,
    project_id: packet.project_id,
    run_id: packet.run_id,
    step_id: packet.step_id,
    executor_id: packet.executor_id,
    key_id: packet.key_id,
    checkpoint_hash: packet.checkpoint_hash,
    status: packet.status,
    payload_hash: payloadHash,
    finished_at: packet.finished_at
  };
}

export function acceptExternalControlResult(db, packet) {
  exactObject(packet, ["schema_version", "request_id", "request_hash", "project_id", "run_id", "step_id", "executor_id", "key_id", "checkpoint_hash", "status", "payload", "payload_hash", "finished_at", "signature"], "external_control_result");
  if (packet.schema_version !== 1 || !TERMINAL.has(packet.status)) throw new Error("EXTERNAL_CONTROL_RESULT_INVALID: schema_or_status");
  if (!Number.isFinite(Date.parse(packet.finished_at))) throw new Error("EXTERNAL_CONTROL_RESULT_INVALID: finished_at");
  const found = requestRow(db, packet.request_id);
  if (!found) throw new Error(`EXTERNAL_CONTROL_REQUEST_NOT_FOUND: ${packet.request_id}`);
  if (packet.request_hash !== found.request_hash || packet.project_id !== found.project_id || packet.run_id !== found.run_id || packet.step_id !== found.step_id || packet.executor_id !== found.executor_id || packet.checkpoint_hash !== found.checkpoint_hash) throw new Error("EXTERNAL_CONTROL_RESULT_BINDING_MISMATCH");
  requireHash(packet.payload_hash, "payload_hash");
  const payloadHash = structuredHash(packet.payload);
  if (payloadHash !== packet.payload_hash) throw new Error("EXTERNAL_CONTROL_RESULT_PAYLOAD_HASH_MISMATCH");
  if (Buffer.byteLength(JSON.stringify(packet.payload), "utf8") > 1_048_576) throw new Error("EXTERNAL_CONTROL_RESULT_PAYLOAD_TOO_LARGE");
  const executor = executorRow(db, found.project_id, found.executor_id);
  if (!executor || packet.key_id !== found.executor_key_id || packet.key_id !== executor.key_id) throw new Error("EXTERNAL_CONTROL_RESULT_EXECUTOR_MISMATCH");
  const core = resultCore(packet, payloadHash), resultHash = structuredHash(core);
  let signature;
  try { signature = Buffer.from(packet.signature, "base64"); } catch { throw new Error("EXTERNAL_CONTROL_RESULT_SIGNATURE_INVALID"); }
  if (!signature.length || !crypto.verify(null, Buffer.from(resultHash, "utf8"), executor.public_key_pem, signature)) throw new Error("EXTERNAL_CONTROL_RESULT_SIGNATURE_INVALID");
  const existing = db.prepare("SELECT * FROM external_control_results WHERE request_id=?").get(found.id);
  if (existing) {
    if (existing.result_hash !== resultHash) throw new Error(`EXTERNAL_CONTROL_RESULT_CONFLICT: ${found.id}`);
    return Object.freeze({ accepted: false, duplicate: true, request_id: found.id, result_hash: resultHash, status: existing.status, payload: packet.payload });
  }
  const acceptedAt = now();
  db.prepare("INSERT INTO external_control_results(id,request_id,executor_id,key_id,status,payload_hash,result_hash,signature_base64,finished_at,accepted_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id("control_result"), found.id, found.executor_id, packet.key_id, packet.status, payloadHash, resultHash, packet.signature, packet.finished_at, acceptedAt);
  db.prepare("UPDATE external_control_requests SET status=?,updated_at=? WHERE id=?").run(packet.status, acceptedAt, found.id);
  appendEvent(db, { entityType: "workflow_run", entityId: found.run_id, kind: "external_control_result_accepted", payload: { request_id: found.id, request_hash: found.request_hash, result_hash: resultHash, executor_id: found.executor_id, status: packet.status, checkpoint_hash: found.checkpoint_hash } });
  return Object.freeze({ accepted: true, duplicate: false, request_id: found.id, interaction_id: found.interaction_id, result_hash: resultHash, status: packet.status, payload: packet.payload });
}

export function acceptExternalControlEvidenceResult(db, packet) {
  const accepted = acceptExternalControlResult(db, packet);
  if (accepted.status !== "completed") return Object.freeze({ ...accepted, evidence: null });
  const found = requestRow(db, accepted.request_id);
  if (!found.interaction_id) throw new Error(`EXTERNAL_CONTROL_EVIDENCE_INTERACTION_REQUIRED: ${found.id}`);
  if (!accepted.payload?.evidence_packet) throw new Error("EXTERNAL_CONTROL_EVIDENCE_PACKET_REQUIRED");
  const evidence = deliverEvidence(db, found.interaction_id, accepted.payload.evidence_packet, { answeredRunId: found.run_id, actor: `external:${found.executor_id}` });
  return Object.freeze({ ...accepted, evidence });
}

export function pendingExternalControlRequests(db, projectId) {
  return db.prepare("SELECT id,run_id,step_id,interaction_id,executor_id,executor_key_id,action,checkpoint_hash,payload_hash,payload_ref,request_hash,idempotency_key,status,created_at,updated_at,cancel_hash FROM external_control_requests WHERE project_id=? AND status IN ('pending','cancel_requested') ORDER BY created_at,id").all(projectId);
}
