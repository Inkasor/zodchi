import crypto from "node:crypto";
import { id, now } from "./db.mjs";
import { appendEvent } from "./state-machine.mjs";
import { recordRunEvidence, runChangeEvidence } from "./run-evidence.mjs";

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

function canonicalClaims(reviewEvidence) {
  const claims = [...(reviewEvidence?.claim_coverage ?? []), ...(reviewEvidence?.cross_layer_chains ?? [])];
  const byId = new Map();
  for (const claim of claims) {
    const key = String(claim.claim_id ?? `anonymous:${claim.claim_type ?? "material"}:${byId.size}`);
    byId.set(key, { ...(byId.get(key) ?? {}), ...claim, claim_id: key });
  }
  return [...byId.values()].sort((a, b) => a.claim_id.localeCompare(b.claim_id));
}

function refs(value) {
  return [...new Set((value ?? []).filter(Boolean).map(String))].sort();
}

export function semanticGapFingerprint(reviewEvidence) {
  const claims = canonicalClaims(reviewEvidence).map(claim => ({
    claim_id: claim.claim_id,
    claim_type: claim.claim_type ?? "material",
    coverage: claim.coverage ?? "unknown",
    required_edges: refs((claim.required_edges ?? []).map(edge => typeof edge === "string" ? edge : edge.edge)),
    required_facts: refs(claim.required_facts ?? claim.required_predicates),
    primary_evidence_present: Boolean((claim.primary_evidence_refs ?? []).length),
    contradictions_present: Boolean((claim.contradicting_evidence_refs ?? []).length),
    edge_statuses: (claim.edge_coverage ?? []).map(edge => ({ edge: edge.edge, status: edge.status ?? "unknown" })).sort((a, b) => String(a.edge).localeCompare(String(b.edge)))
  })).filter(claim => claim.coverage !== "sufficient" || claim.edge_statuses.some(edge => edge.status !== "observed"));
  const verification = (reviewEvidence?.verification?.verification_results ?? []).map(item => ({
    request: item.request ?? null, status: item.status ?? "unknown", facts: item.facts ?? null
  }));
  const normalized = { claims, verification };
  return claims.length || verification.length ? { normalized, fingerprint: `semantic:${hash(normalized)}` } : null;
}

export function evidenceFrontierFingerprint(reviewEvidence) {
  const normalized = canonicalClaims(reviewEvidence).map(claim => ({
    claim_id: claim.claim_id,
    primary_evidence_refs: refs(claim.primary_evidence_refs),
    contradicting_evidence_refs: refs(claim.contradicting_evidence_refs),
    exact_scan_refs: refs(claim.exact_scan_refs),
    graph_edges: refs(claim.graph_edges),
    edges: (claim.edge_coverage ?? []).map(edge => ({
      edge: edge.edge,
      source_anchor_refs: refs(edge.source_anchor_refs),
      transition_anchor_refs: refs(edge.transition_anchor_refs),
      graph_edge_refs: refs(edge.graph_edge_refs),
      derived_edge_refs: refs(edge.derived_edge_refs),
      provenance_refs: refs(edge.provenance_refs)
    })).sort((a, b) => String(a.edge).localeCompare(String(b.edge)))
  }));
  const scans = (reviewEvidence?.exact_scan_catalog ?? []).map(scan => ({
    scan_id: scan.scan_id ?? null, scope: scan.scope ?? null,
    complete: scan.complete ?? scan.completeness ?? scan.locations_truncated === false
  })).sort((a, b) => String(a.scan_id).localeCompare(String(b.scan_id)));
  const verification = (reviewEvidence?.verification?.verification_results ?? []).map(item => ({
    evidence_hash: item.evidence_hash ?? null, evidence_refs: refs(item.evidence_refs), bounded: item.bounded ?? null
  }));
  return { normalized: { claims: normalized, scans, verification }, fingerprint: `frontier:${hash({ claims: normalized, scans, verification })}` };
}

function budgetUsage(db, runId) {
  const rows = db.prepare(`SELECT b.metric,COALESCE(SUM(be.amount),0) AS used,MAX(b.limit_value) AS limit_value
    FROM budgets b LEFT JOIN budget_entries be ON be.budget_id=b.id AND be.run_id=?
    WHERE b.scope_type='workflow' AND b.scope_id=? GROUP BY b.metric`).all(runId, runId);
  return Object.fromEntries(rows.map(row => [row.metric, { used: Number(row.used), limit: Number(row.limit_value) }]));
}

export function recordProgressSnapshot(db, runId, { cycle = 0, gate = null, reviewer = null, reviewEvidence = null, allowedPaths = [] } = {}) {
  const changes = runChangeEvidence(db, runId, allowedPaths);
  const failures = gateFailureFingerprints(gate);
  const semantic = semanticGapFingerprint(reviewEvidence);
  const frontier = reviewEvidence ? evidenceFrontierFingerprint(reviewEvidence) : null;
  const primary = semantic ?? (reviewer?.blockers?.[0] ? blockerFingerprint(reviewer.blockers[0]) : null);
  const progressKind = reviewEvidence || reviewer ? "semantic_review" : "gate";
  const packetHash = reviewEvidence?.base_evidence_hash ?? null;
  const previous = db.prepare("SELECT * FROM progress_snapshots WHERE run_id=? AND progress_kind=? ORDER BY created_at DESC,id DESC LIMIT 1").get(runId, progressKind);
  const deterministicProgress = Boolean(previous && (
    (semantic?.fingerprint ?? null) !== (previous.semantic_fingerprint ?? null)
    || (semantic?.fingerprint ?? null) === (previous.semantic_fingerprint ?? null) && frontier?.fingerprint && frontier.fingerprint !== previous.frontier_fingerprint
    || progressKind === "gate" && JSON.stringify((gate?.checks ?? []).map(check => `${check.id}:${check.status}`).sort()) !== previous.gate_vector_json
  ));
  const usage = budgetUsage(db, runId);
  const gateVector = (gate?.checks ?? []).map(check => `${check.id}:${check.status}`).sort();
  const created = now();
  db.prepare(`INSERT INTO progress_snapshots(id,run_id,cycle,gate_vector_json,failure_fingerprints_json,primary_gap_fingerprint,changed_scope_json,unauthorized_changes_json,calls_used,cost_usd,blast_radius,verified_progress,created_at,progress_kind,packet_hash,semantic_fingerprint,frontier_fingerprint)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id("progress"), runId, cycle, JSON.stringify(gateVector), JSON.stringify(failures.map(item => item.fingerprint)), primary?.fingerprint ?? null,
      JSON.stringify(changes.run_changed_paths), JSON.stringify(changes.unauthorized_changes), usage.calls?.used ?? 0, usage.cost_usd?.used ?? 0, changes.run_changed_paths.length, deterministicProgress ? 1 : 0, created,
      progressKind, packetHash, semantic?.fingerprint ?? null, frontier?.fingerprint ?? null);
  appendEvent(db, { entityType: "workflow_run", entityId: runId, kind: "progress_snapshot", payload: { cycle, progress_kind: progressKind, packet_hash: packetHash, semantic_fingerprint: semantic?.fingerprint ?? null, frontier_fingerprint: frontier?.fingerprint ?? null, gate_vector: gateVector, primary_gap_fingerprint: primary?.fingerprint ?? null, blast_radius: changes.run_changed_paths.length, verified_progress: deterministicProgress } });
  const routeRow = db.prepare("SELECT evidence_hash,evidence_json FROM run_evidence WHERE run_id=? AND kind='correction_routing' ORDER BY created_at DESC,id DESC LIMIT 1").get(runId);
  const route = parse(routeRow?.evidence_json, null);
  if (route?.progress_kind === progressKind && !db.prepare("SELECT 1 FROM run_evidence WHERE run_id=? AND kind='correction_route_outcome' AND evidence_json LIKE ? LIMIT 1").get(runId, `%${routeRow.evidence_hash}%`)) {
    const semanticAfter = semantic?.fingerprint ?? null, frontierAfter = frontier?.fingerprint ?? null;
    recordRunEvidence(db, runId, null, "correction_route_outcome", {
      route_evidence_hash: routeRow.evidence_hash,
      progress_kind: progressKind,
      semantic_gap_fingerprint: route.semantic_gap_fingerprint ?? null,
      attempted_route_keys: route.route_keys ?? [],
      packet_hash_before: route.packet_hash_before ?? null,
      packet_hash_after: packetHash,
      semantic_fingerprint_before: route.semantic_fingerprint_before ?? null,
      semantic_fingerprint_after: semanticAfter,
      frontier_fingerprint_before: route.frontier_fingerprint_before ?? null,
      frontier_fingerprint_after: frontierAfter,
      exhausted: route.semantic_fingerprint_before === semanticAfter && route.frontier_fingerprint_before === frontierAfter
    });
  }
  return progressStatus(db, runId);
}

export function progressStatus(db, runId) {
  const snapshots = db.prepare("SELECT * FROM progress_snapshots WHERE run_id=? ORDER BY created_at,id").all(runId).map(row => ({
    ...row, gate_vector: parse(row.gate_vector_json, []), failure_fingerprints: parse(row.failure_fingerprints_json, []),
    changed_scope: parse(row.changed_scope_json, []), unauthorized_changes: parse(row.unauthorized_changes_json, [])
  }));
  const latest = snapshots.at(-1) ?? null;
  const channel = latest ? snapshots.filter(item => item.progress_kind === latest.progress_kind) : [];
  let repeated = 0;
  if (latest) {
    const signature = latest.primary_gap_fingerprint || latest.failure_fingerprints.join("|") || latest.gate_vector.join("|");
    for (let index = channel.length - 1; index >= 0; index -= 1) {
      const item = channel[index], candidate = item.primary_gap_fingerprint || item.failure_fingerprints.join("|") || item.gate_vector.join("|");
      if (!signature || candidate !== signature || item.verified_progress) break;
      repeated += 1;
    }
  }
  const previous = channel.at(-2);
  const blastDiverging = Boolean(latest && previous && latest.blast_radius > previous.blast_radius && repeated >= 2);
  const semanticGap = Boolean(latest?.primary_gap_fingerprint?.startsWith("semantic:"));
  const duplicatePacket = Boolean(latest?.packet_hash && previous?.packet_hash && latest.packet_hash === previous.packet_hash);
  const sameSemantic = Boolean(latest?.semantic_fingerprint && latest.semantic_fingerprint === previous?.semantic_fingerprint);
  const frontierAdvanced = Boolean(sameSemantic && latest?.frontier_fingerprint && latest.frontier_fingerprint !== previous?.frontier_fingerprint);
  return { snapshots: snapshots.length, latest, repeated_blocker_cycles: repeated, blast_radius_diverging: blastDiverging, semantic_gap: semanticGap,
    duplicate_packet: duplicatePacket, semantic_progress: Boolean(previous && !sameSemantic), evidence_frontier_progress: frontierAdvanced,
    stagnating: duplicatePacket || (sameSemantic && !frontierAdvanced && repeated >= 2) || (!semanticGap && repeated >= 3) || blastDiverging };
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
