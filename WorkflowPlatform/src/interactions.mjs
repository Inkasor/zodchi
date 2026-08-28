import crypto from "node:crypto";
import { id, now } from "./db.mjs";
import { appendEvent, canTransition } from "./state-machine.mjs";

// Two different waits, and they are not interchangeable.
//
// A clarification is a question only a person can answer: a choice, an authority, an intention. It ends
// when that person answers, withdraws it, or replaces it with a better question.
//
// An external evidence request is a fact that does not exist in anything the platform can read: a live
// information base, a runtime, a device, a closed contour. No amount of typing produces it. It ends when
// a packet arrives that satisfies the contract it declared, or when the owner cancels or refuses. Text
// that merely asserts the fact leaves it open, because an assertion is not the evidence it stands for.
//
// Both used to be one status on one table, settled by whatever message happened to arrive next. That is
// how an unproven claim could reach a passed gate: the question guarding it was cancelled by an unrelated
// message, and nothing was left to notice.

export const CLARIFICATION_KINDS = Object.freeze(new Set(["clarification", "planner_clarification"]));
export const EXTERNAL_EVIDENCE_KIND = "external_evidence";
export const OPEN_STATUS = "pending";
const CLOSED_STATUSES = Object.freeze(new Set(["approved", "rejected", "cancelled", "superseded", "expired"]));

function parseJson(text, fallback = null) {
  if (typeof text !== "string" || !text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function row(db, interactionId) {
  return db.prepare("SELECT * FROM approvals WHERE id=?").get(interactionId) ?? null;
}

export function readInteraction(db, interactionId) {
  const found = row(db, interactionId);
  if (!found) return null;
  return {
    ...found,
    detail: parseJson(found.detail_json, null),
    affected_steps: parseJson(found.affected_steps_json, []),
    answer: parseJson(found.answer_json, null)
  };
}

// A wait belongs to the run that opened it, and that run cannot be left with a lease outstanding or a
// child still running: the owner is being asked precisely because nothing else can move, and a step that
// keeps its lease while the run is parked either expires into a recovery it did not need or resumes into
// work whose answer has since changed. Everything active is brought to a state that names why it stopped.
export function quiesceRun(db, runId, reason) {
  const at = now();
  const quiesced = { leases: [], steps: [], attempts: [] };
  for (const lease of db.prepare("SELECT id,step_id FROM leases WHERE released_at IS NULL AND step_id IN (SELECT id FROM workflow_steps WHERE run_id=?)").all(runId)) {
    db.prepare("UPDATE leases SET released_at=?,release_reason='interaction_opened' WHERE id=?").run(at, lease.id);
    appendEvent(db, { entityType: "workflow_step", entityId: lease.step_id, kind: "lease_released", payload: { lease_id: lease.id, reason } });
    quiesced.leases.push(lease.id);
  }
  for (const attempt of db.prepare("SELECT a.id,a.state FROM attempts a JOIN workflow_steps ws ON ws.id=a.step_id WHERE ws.run_id=? AND a.state IN ('pending','running')").all(runId)) {
    if (!canTransition("attempt", attempt.state, "cancelled")) continue;
    db.prepare("UPDATE attempts SET state='cancelled',finished_at=? WHERE id=?").run(at, attempt.id);
    appendEvent(db, { entityType: "attempt", entityId: attempt.id, kind: "state_transition", fromState: attempt.state, toState: "cancelled", payload: { reason } });
    quiesced.attempts.push(attempt.id);
  }
  // A leased step returns to ready because nothing of it ran; a running one is blocked because part of it
  // did, and resuming has to decide what to do with that part rather than silently start it again.
  for (const step of db.prepare("SELECT id,state FROM workflow_steps WHERE run_id=? AND state IN ('leased','running')").all(runId)) {
    const target = step.state === "leased" ? "ready" : "blocked";
    if (!canTransition("workflow_step", step.state, target)) continue;
    db.prepare("UPDATE workflow_steps SET state=?,updated_at=? WHERE id=?").run(target, at, step.id);
    appendEvent(db, { entityType: "workflow_step", entityId: step.id, kind: "state_transition", fromState: step.state, toState: target, payload: { reason } });
    quiesced.steps.push({ id: step.id, state: target });
  }
  return quiesced;
}

function open(db, { taskId, runId, stepId = null, kind, question, detail, affectedSteps, expiresAt }) {
  const interactionId = id("approval");
  db.prepare("INSERT INTO approvals(id,task_id,run_id,step_id,kind,question,status,created_at,detail_json,affected_steps_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(interactionId, taskId, runId, stepId, kind, question, OPEN_STATUS, now(), JSON.stringify(detail), JSON.stringify(affectedSteps), expiresAt);
  appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: "interaction_opened", payload: { interaction_id: interactionId, interaction_kind: kind, affected_steps: affectedSteps, expires_at: expiresAt } });
  return interactionId;
}

export function openClarification(db, { taskId, runId, stepId = null, kind = "clarification", question, reason = null, missing = [], affectedSteps = [], expiresAt = null }) {
  if (!CLARIFICATION_KINDS.has(kind)) throw new Error(`CLARIFICATION_KIND_INVALID: ${kind}`);
  if (typeof question !== "string" || !question.trim()) throw new Error("CLARIFICATION_QUESTION_REQUIRED");
  // What is missing is recorded as structure, not only inside the sentence: a person can answer a question
  // and still not have granted the authority it was asking for, and only the named field says which.
  const detail = { reason, missing: missing.map(item => ({ kind: item.kind ?? "fact", name: String(item.name ?? ""), options: item.options ?? [] })) };
  return open(db, { taskId, runId, stepId, kind, question: question.trim(), detail, affectedSteps, expiresAt });
}

// The contract is what makes a delivered packet checkable. Without the resource identity a packet from
// the wrong information base passes; without expected completeness a fragment passes; without the claims
// it stands for, nothing downstream knows what it was allowed to prove.
export function validateEvidenceContract(contract) {
  const need = (condition, field) => { if (!condition) throw new Error(`EXTERNAL_EVIDENCE_CONTRACT_INCOMPLETE: ${field}`); };
  need(contract && typeof contract === "object" && !Array.isArray(contract), "contract");
  need(typeof contract.evidence_kind === "string" && contract.evidence_kind.trim(), "evidence_kind");
  need(contract.resource && typeof contract.resource === "object", "resource");
  need(typeof contract.resource?.kind === "string" && contract.resource.kind.trim(), "resource.kind");
  need(typeof contract.resource?.identity === "string" && contract.resource.identity.trim(), "resource.identity");
  need(contract.expected_provenance && typeof contract.expected_provenance === "object", "expected_provenance");
  need(typeof contract.expected_provenance?.source === "string" && contract.expected_provenance.source.trim(), "expected_provenance.source");
  need(contract.expected_completeness && typeof contract.expected_completeness === "object", "expected_completeness");
  need(typeof contract.expected_completeness?.rule === "string" && contract.expected_completeness.rule.trim(), "expected_completeness.rule");
  need(Array.isArray(contract.expected_completeness?.must_cover), "expected_completeness.must_cover");
  need(Array.isArray(contract.claims) && contract.claims.length > 0, "claims");
  need(contract.command === null || contract.command === undefined || typeof contract.command === "string", "command");
  return Object.freeze({
    evidence_kind: contract.evidence_kind.trim(),
    resource: { kind: contract.resource.kind.trim(), identity: contract.resource.identity.trim() },
    expected_provenance: { source: contract.expected_provenance.source.trim(), collected_by: contract.expected_provenance.collected_by ?? "owner", at_or_after: contract.expected_provenance.at_or_after ?? null },
    expected_completeness: { rule: contract.expected_completeness.rule.trim(), must_cover: contract.expected_completeness.must_cover.map(String) },
    claims: contract.claims.map(String),
    command: contract.command ?? null
  });
}

export function openExternalEvidenceRequest(db, { taskId, runId, stepId = null, question, contract, affectedSteps = [], expiresAt = null }) {
  if (typeof question !== "string" || !question.trim()) throw new Error("EXTERNAL_EVIDENCE_QUESTION_REQUIRED");
  // An evidence request that names no step is a request nothing is waiting on, and resuming would have
  // nowhere to return to. The affected steps are what the answer is allowed to unblock.
  if (!Array.isArray(affectedSteps) || !affectedSteps.length) throw new Error("EXTERNAL_EVIDENCE_CONTRACT_INCOMPLETE: affected_steps");
  return open(db, { taskId, runId, stepId, kind: EXTERNAL_EVIDENCE_KIND, question: question.trim(), detail: validateEvidenceContract(contract), affectedSteps, expiresAt });
}

// Evidence has to arrive with the thing it is evidence of. A packet that only states a hash states a
// number: there is nothing to compute it from, so any 64 hex digits pass and the record proves only that
// someone typed a hash. The content travels with the packet and the hash is derived from it here, which
// is also why it is bounded — evidence too large to carry is evidence that has to be reduced to what the
// claim needs before it can be checked at all.
const EVIDENCE_CONTENT_LIMIT = 1_048_576;

// A packet closes the request only when it is a packet about the thing that was asked for. Every check
// here names a way a wrong packet would otherwise be accepted as the right one.
export function validateEvidencePacket(contract, packet) {
  const refuse = field => { throw new Error(`EXTERNAL_EVIDENCE_PACKET_INVALID: ${field}`); };
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) refuse("packet");
  // The kind is what the request asked for. A log export answering a request for a configuration dump is
  // about the same information base by the same person and still not the fact that was asked for.
  if (packet.evidence_kind !== contract.evidence_kind) refuse("evidence_kind");
  if (packet.resource?.kind !== contract.resource.kind || packet.resource?.identity !== contract.resource.identity) refuse("resource");
  if (typeof packet.provenance?.source !== "string" || packet.provenance.source !== contract.expected_provenance.source) refuse("provenance.source");
  // Who collected it is part of the provenance the contract declared: the same export taken by the owner
  // and taken by an automated job carry different authority, and only the stated collector says which.
  if ((packet.provenance?.collected_by ?? null) !== contract.expected_provenance.collected_by) refuse("provenance.collected_by");
  if (contract.expected_provenance.at_or_after) {
    const collected = Date.parse(packet.collected_at ?? "");
    if (!Number.isFinite(collected) || collected < Date.parse(contract.expected_provenance.at_or_after)) refuse("collected_at");
  }
  // The rule is how the packet says it is complete. Covering the named items under a different rule is a
  // different statement about coverage, and accepting it would settle the request on the wrong one.
  if (packet.completeness?.rule !== contract.expected_completeness.rule) refuse("completeness.rule");
  const covered = new Set((packet.completeness?.covered ?? []).map(String));
  const uncovered = contract.expected_completeness.must_cover.filter(item => !covered.has(item));
  if (uncovered.length) throw new Error(`EXTERNAL_EVIDENCE_PACKET_INCOMPLETE: ${uncovered.slice(0, 5).join(",")}`);
  // The claims are what the request was allowed to prove. A packet that stands for fewer of them settles
  // a request whose remaining claims nothing downstream ever established.
  const claimed = new Set((packet.claims ?? []).map(String));
  const unsupported = contract.claims.filter(item => !claimed.has(item));
  if (unsupported.length) throw new Error(`EXTERNAL_EVIDENCE_PACKET_INCOMPLETE: ${unsupported.slice(0, 5).map(item => `claim:${item}`).join(",")}`);
  if (typeof packet.content !== "string" || !packet.content.length) refuse("content");
  if (Buffer.byteLength(packet.content, "utf8") > EVIDENCE_CONTENT_LIMIT) refuse("content_too_large");
  const contentHash = crypto.createHash("sha256").update(packet.content, "utf8").digest("hex");
  if (packet.content_hash !== undefined && packet.content_hash !== null && packet.content_hash !== contentHash) refuse("content_hash");
  return Object.freeze({
    ...packet, content_hash: contentHash, claims: [...claimed],
    resource: { ...packet.resource }, provenance: { ...packet.provenance },
    completeness: { ...packet.completeness, covered: [...covered] }
  });
}

// Settling is idempotent on purpose. A duplicate answer is a normal thing to receive — the same message
// sent twice, two people answering the same question — and the second must neither overwrite the first
// nor throw away the run that carried it. It is recorded and reported as already settled.
export function settleInteraction(db, interactionId, { status, answeredRunId = null, answer = null, decisionId = null, actor = "owner" }) {
  if (!CLOSED_STATUSES.has(status)) throw new Error(`INTERACTION_STATUS_INVALID: ${status}`);
  const found = row(db, interactionId);
  if (!found) throw new Error(`INTERACTION_NOT_FOUND: ${interactionId}`);
  if (found.status !== OPEN_STATUS) {
    appendEvent(db, { entityType: "workflow_run", entityId: answeredRunId ?? found.run_id, kind: "interaction_response_duplicate", payload: { interaction_id: interactionId, already: found.status, attempted: status } });
    return { settled: false, status: found.status, first_answered_run_id: found.answered_run_id ?? null };
  }
  const changed = db.prepare("UPDATE approvals SET status=?,resolved_at=?,answered_run_id=?,answer_json=?,decision_id=COALESCE(?,decision_id) WHERE id=? AND status=?")
    .run(status, now(), answeredRunId, answer === null ? null : JSON.stringify(answer), decisionId, interactionId, OPEN_STATUS);
  // Another delivery may have won between the read and the conditional write. The predicate is the
  // concurrency control; ignoring `changes` made the loser emit a second settled event and report that it
  // owned the answer even though SQLite changed no row.
  if (changed.changes === 0) {
    const current = row(db, interactionId);
    appendEvent(db, { entityType: "workflow_run", entityId: answeredRunId ?? current.run_id, kind: "interaction_response_duplicate", payload: { interaction_id: interactionId, already: current.status, attempted: status } });
    return { settled: false, status: current.status, first_answered_run_id: current.answered_run_id ?? null };
  }
  appendEvent(db, { entityType: "workflow_run", entityId: found.run_id, kind: "interaction_settled", payload: { interaction_id: interactionId, interaction_kind: found.kind, status, actor, answered_run_id: answeredRunId } });
  return { settled: true, status, interaction: readInteraction(db, interactionId) };
}

export function deliverEvidence(db, interactionId, packet, { answeredRunId = null } = {}) {
  const interaction = readInteraction(db, interactionId);
  if (!interaction) throw new Error(`INTERACTION_NOT_FOUND: ${interactionId}`);
  if (interaction.kind !== EXTERNAL_EVIDENCE_KIND) throw new Error(`INTERACTION_KIND_UNEXPECTED: ${interaction.kind}`);
  const validated = validateEvidencePacket(interaction.detail, packet);
  return settleInteraction(db, interactionId, { status: "approved", answeredRunId, answer: { evidence: validated }, actor: "owner" });
}

export function cancelInteraction(db, interactionId, reason, { actor = "owner", answeredRunId = null } = {}) {
  return settleInteraction(db, interactionId, { status: "cancelled", answeredRunId, answer: { reason }, actor });
}

// Replacing a question is the owner's act, not a side effect of time passing. The old one records which
// question took its place, so the history reads as one question refined rather than one abandoned.
export function supersedeInteraction(db, interactionId, replacementId, { actor = "owner" } = {}) {
  const result = settleInteraction(db, interactionId, { status: "superseded", answer: { superseded_by: replacementId }, actor });
  if (result.settled) db.prepare("UPDATE approvals SET superseded_by=? WHERE id=?").run(replacementId, interactionId);
  return result;
}

// A wait can only expire against a deadline it declared when it was opened. One that declared none waits
// indefinitely, which is the honest behaviour: the platform has no basis for deciding the person is done.
export function expireInteractions(db, projectId, at = now()) {
  const due = db.prepare(`SELECT id FROM approvals WHERE status=? AND expires_at IS NOT NULL AND expires_at<=?
    AND task_id IN (SELECT id FROM tasks WHERE project_id=?) ORDER BY expires_at,id`).all(OPEN_STATUS, at, projectId);
  const expired = [];
  for (const item of due) {
    if (settleInteraction(db, item.id, { status: "expired", answer: { expired_at: at }, actor: "workflow-platform" }).settled) expired.push(item.id);
  }
  return expired;
}

export function pendingInteractions(db, projectId) {
  return db.prepare(`SELECT id,kind,question,run_id,step_id,created_at,expires_at,detail_json,affected_steps_json
    FROM approvals WHERE status=? AND task_id IN (SELECT id FROM tasks WHERE project_id=?) ORDER BY created_at,id`).all(OPEN_STATUS, projectId)
    .map(item => ({ id: item.id, kind: item.kind, question: item.question, run_id: item.run_id, step_id: item.step_id, created_at: item.created_at, expires_at: item.expires_at, detail: parseJson(item.detail_json, null), affected_steps: parseJson(item.affected_steps_json, []) }));
}
