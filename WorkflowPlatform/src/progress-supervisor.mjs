import crypto from "node:crypto";
import { id, now } from "./db.mjs";
import { appendEvent } from "./state-machine.mjs";
import { runChangeEvidence } from "./run-evidence.mjs";

function parse(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function normalizedPath(value) { return String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase(); }

export function normalizeBlockerCode(value) {
  const folded = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "_").replace(/^_+|_+$/g, "");
  return folded || "other";
}

export function blockerFingerprint(blocker, fallback = {}) {
  const evidence = [...new Set([...(blocker?.evidence_refs ?? []), ...(fallback.evidence_refs ?? [])].map(item => normalizedPath(item)))].sort();
  const normalized = {
    code: normalizeBlockerCode(blocker?.code),
    root: normalizedPath(blocker?.root ?? fallback.root),
    path: normalizedPath(blocker?.path ?? fallback.path),
    check_id: String(blocker?.check_id ?? fallback.check_id ?? "").trim().toLowerCase(),
    evidence_refs: evidence
  };
  return { normalized, fingerprint: hash(normalized) };
}

export function gateFailureFingerprints(gate) {
  return (gate?.checks ?? []).filter(check => check.required && check.status !== "passed").map(check => blockerFingerprint({
    code: check.failure_code ?? check.status ?? "other", path: check.failure_path ?? null, check_id: check.id,
    root: check.execution_root ?? null, evidence_refs: [check.id, check.failure ?? ""]
  }));
}

function budgetUsage(db, runId) {
  const rows = db.prepare(`SELECT b.metric,COALESCE(SUM(be.amount),0) AS used,MAX(b.limit_value) AS limit_value
    FROM budgets b LEFT JOIN budget_entries be ON be.budget_id=b.id AND be.run_id=?
    WHERE b.scope_type='workflow' AND b.scope_id=? GROUP BY b.metric`).all(runId, runId);
  return Object.fromEntries(rows.map(row => [row.metric, { used: Number(row.used), limit: Number(row.limit_value) }]));
}

export function recordProgressSnapshot(db, runId, { cycle = 0, gate = null, reviewer = null, allowedPaths = [], verifiedProgress = false } = {}) {
  const changes = runChangeEvidence(db, runId, allowedPaths);
  const failures = gateFailureFingerprints(gate);
  const primary = reviewer?.blockers?.[0] ? blockerFingerprint(reviewer.blockers[0]) : null;
  const usage = budgetUsage(db, runId);
  const gateVector = (gate?.checks ?? []).map(check => `${check.id}:${check.status}`).sort();
  const created = now();
  db.prepare(`INSERT INTO progress_snapshots(id,run_id,cycle,gate_vector_json,failure_fingerprints_json,primary_gap_fingerprint,changed_scope_json,unauthorized_changes_json,calls_used,cost_usd,blast_radius,verified_progress,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id("progress"), runId, cycle, JSON.stringify(gateVector), JSON.stringify(failures.map(item => item.fingerprint)), primary?.fingerprint ?? null,
      JSON.stringify(changes.run_changed_paths), JSON.stringify(changes.unauthorized_changes), usage.calls?.used ?? 0, usage.cost_usd?.used ?? 0, changes.run_changed_paths.length, verifiedProgress ? 1 : 0, created);
  appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: "progress_snapshot", payload: { cycle, gate_vector: gateVector, primary_gap_fingerprint: primary?.fingerprint ?? null, blast_radius: changes.run_changed_paths.length, verified_progress: Boolean(verifiedProgress) } });
  return progressStatus(db, runId);
}

export function progressStatus(db, runId) {
  const snapshots = db.prepare("SELECT * FROM progress_snapshots WHERE run_id=? ORDER BY created_at,id").all(runId).map(row => ({
    ...row, gate_vector: parse(row.gate_vector_json, []), failure_fingerprints: parse(row.failure_fingerprints_json, []),
    changed_scope: parse(row.changed_scope_json, []), unauthorized_changes: parse(row.unauthorized_changes_json, [])
  }));
  const latest = snapshots.at(-1) ?? null;
  let repeated = 0;
  if (latest) {
    const signature = latest.primary_gap_fingerprint || latest.failure_fingerprints.join("|") || latest.gate_vector.join("|");
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const item = snapshots[index], candidate = item.primary_gap_fingerprint || item.failure_fingerprints.join("|") || item.gate_vector.join("|");
      if (!signature || candidate !== signature || item.verified_progress) break;
      repeated += 1;
    }
  }
  const previous = snapshots.at(-2);
  const blastDiverging = Boolean(latest && previous && latest.blast_radius > previous.blast_radius && repeated >= 2);
  return { snapshots: snapshots.length, latest, repeated_blocker_cycles: repeated, blast_radius_diverging: blastDiverging, stagnating: repeated >= 3 || blastDiverging };
}

export function requestRunControl(db, runId, action, reason = null) {
  if (!new Set(["pause", "cancel"]).has(action)) throw new Error(`RUN_CONTROL_ACTION_INVALID: ${action}`);
  const run = db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId);
  if (!run) throw new Error(`RUN_NOT_FOUND: ${runId}`);
  const timestamp = now(), requestId = id("control");
  db.prepare("UPDATE run_control_requests SET status='superseded',applied_at=? WHERE run_id=? AND action=? AND status='pending'").run(timestamp, runId, action);
  db.prepare("INSERT INTO run_control_requests(id,run_id,action,status,reason,requested_at) VALUES(?,?,?,'pending',?,?)")
    .run(requestId, runId, action, reason || `${action} requested by owner`, timestamp);
  db.prepare(`UPDATE workflow_runs SET ${action === "pause" ? "pause_requested" : "cancel_requested"}=1,updated_at=? WHERE id=?`).run(timestamp, runId);
  appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: `${action}_requested`, payload: { request_id: requestId, reason: reason || null } });
  return { request_id: requestId, run_id: runId, action, status: "pending" };
}

export function resumeRunControl(db, queue, runId) {
  const timestamp = now();
  db.prepare("UPDATE run_control_requests SET status='superseded',applied_at=? WHERE run_id=? AND action='pause' AND status='pending'").run(timestamp, runId);
  db.prepare("UPDATE workflow_runs SET pause_requested=0,updated_at=? WHERE id=?").run(timestamp, runId);
  const state = db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId)?.state;
  if (!state) throw new Error(`RUN_NOT_FOUND: ${runId}`);
  return state === "paused" ? queue.resumeRun(runId) : state;
}

export function applyIdleRunControl(db, queue, runId) {
  const active = db.prepare(`SELECT 1 FROM leases l JOIN workflow_steps ws ON ws.id=l.step_id
    WHERE ws.run_id=? AND l.released_at IS NULL LIMIT 1`).get(runId);
  return active ? null : applyRunControlAtBoundary(db, queue, runId);
}

export function pendingRunControl(db, runId) {
  return db.prepare("SELECT * FROM run_control_requests WHERE run_id=? AND status='pending' ORDER BY CASE action WHEN 'cancel' THEN 0 ELSE 1 END,requested_at LIMIT 1").get(runId) ?? null;
}

export function applyRunControlAtBoundary(db, queue, runId) {
  const request = pendingRunControl(db, runId);
  if (!request) return null;
  const timestamp = now();
  if (request.action === "cancel") queue.cancelRun(runId, { reason: request.reason, at: timestamp });
  else queue.pauseRun(runId, { reason: request.reason, at: timestamp });
  db.prepare("UPDATE run_control_requests SET status='applied',applied_at=? WHERE id=?").run(timestamp, request.id);
  db.prepare("UPDATE workflow_runs SET pause_requested=0,cancel_requested=0,updated_at=? WHERE id=?").run(timestamp, runId);
  return { ...request, status: "applied", applied_at: timestamp };
}

export function runControlStatus(db, runId) {
  const run = db.prepare("SELECT * FROM workflow_runs WHERE id=?").get(runId);
  if (!run) throw new Error(`RUN_NOT_FOUND: ${runId}`);
  const activeSteps = db.prepare("SELECT step_key,ordinal,role_id,state FROM workflow_steps WHERE run_id=? AND state IN ('ready','leased','running','retry_scheduled') ORDER BY ordinal,step_key").all(runId);
  const gate = db.prepare("SELECT details_json FROM gates WHERE run_id=? ORDER BY rowid DESC LIMIT 1").get(runId);
  const review = db.prepare("SELECT structured_json FROM decisions WHERE run_id=? AND kind='review' AND active=1 ORDER BY created_at DESC LIMIT 1").get(runId);
  const usage = budgetUsage(db, runId), progress = progressStatus(db, runId);
  return {
    run_id: runId, state: run.state, improvement_strategy: run.improvement_strategy, cycle: run.cycle,
    active_steps: activeSteps, parallel_members: activeSteps.filter(item => ["leased", "running"].includes(item.state)).length,
    elapsed_ms: Math.max(0, Date.now() - Date.parse(run.created_at)), time_since_progress_ms: progress.latest ? Math.max(0, Date.now() - Date.parse(progress.latest.created_at)) : null,
    calls: usage.calls ?? null, cost_usd: usage.cost_usd ?? null,
    current_gate_failures: parse(gate?.details_json, {}).checks?.filter(check => check.required && check.status !== "passed") ?? [],
    current_primary_gap: parse(review?.structured_json, {}).blockers?.[0] ?? null,
    latest_review: parse(review?.structured_json, null), pause_requested: Boolean(run.pause_requested), cancel_requested: Boolean(run.cancel_requested), progress
  };
}
