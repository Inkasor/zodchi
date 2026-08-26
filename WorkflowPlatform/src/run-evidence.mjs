import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { id, now } from "./db.mjs";
import { completionBlockers } from "./state-machine.mjs";

const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv", "__pycache__", "tmp", "temp"]);

function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fileHash(file) { try { return fs.statSync(file).isFile() ? digest(fs.readFileSync(file)) : null; } catch { return null; } }
function git(root, args, fallback = null) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return fallback; }
}
function normalized(value) { return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, ""); }

function porcelain(root) {
  const output = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], "");
  const rows = [];
  for (const item of output.split("\0").filter(Boolean)) {
    const code = item.slice(0, 2), value = item.slice(3);
    const renamed = value.includes(" -> ") ? value.slice(value.lastIndexOf(" -> ") + 4) : value;
    rows.push({ code, path: normalized(renamed) });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path, "en") || a.code.localeCompare(b.code, "en"));
}

function inventory(root) {
  const files = [];
  const walk = (directory, prefix = "") => {
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (IGNORED.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        files.push({ path: relative, size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs), hash: fileHash(absolute) });
      }
    }
  };
  walk(root);
  return files;
}

export function ownerObjective(db, runId) {
  const row = db.prepare("SELECT content FROM conversation_messages WHERE run_id=? AND role='user' ORDER BY created_at,id LIMIT 1").get(runId);
  if (!row) throw new Error(`RUN_OWNER_OBJECTIVE_MISSING: ${runId}`);
  return Object.freeze({ source: "conversation_messages", verbatim: row.content });
}

export function captureRunBaselines(db, runId, roots, { sourceScopeNarrowed = false } = {}) {
  const captured = [];
  for (const root of roots.filter(item => item.access === "write")) {
    const head = git(root.path, ["rev-parse", "HEAD"], null)?.trim() || null;
    const mode = head ? "git" : "inventory";
    const payload = mode === "git"
      ? { status: porcelain(root.path).map(item => ({ ...item, hash: fileHash(path.join(root.path, item.path)) })) }
      : { files: inventory(root.path) };
    const complete = mode === "git" || !sourceScopeNarrowed;
    db.prepare(`INSERT OR REPLACE INTO run_root_baselines(run_id,root_key,root_path,mode,complete,baseline_head,baseline_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(runId, root.key, root.path, mode, complete ? 1 : 0, head, JSON.stringify(payload), now());
    captured.push({ root_key: root.key, root_path: root.path, mode, complete, baseline_head: head, ...payload });
  }
  return captured;
}

function commitDelta(root, baselineHead) {
  const currentHead = git(root, ["rev-parse", "HEAD"], null)?.trim() || null;
  if (!baselineHead || !currentHead || currentHead === baselineHead) return { current_head: currentHead, paths: [], commits: [] };
  const paths = git(root, ["diff", "--name-only", "-z", `${baselineHead}..${currentHead}`], "").split("\0").filter(Boolean).map(normalized);
  const commits = git(root, ["log", "--format=%H%x09%s", `${baselineHead}..${currentHead}`], "").split(/\r?\n/).filter(Boolean);
  return { current_head: currentHead, paths, commits };
}

function gitDelta(row) {
  const baseline = JSON.parse(row.baseline_json), initial = new Map((baseline.status ?? []).map(item => [item.path, item]));
  const current = porcelain(row.root_path), currentMap = new Map(current.map(item => [item.path, item]));
  const committed = commitDelta(row.root_path, row.baseline_head);
  const candidates = new Set([...committed.paths, ...currentMap.keys(), ...initial.keys()]);
  const changed = [];
  for (const relative of candidates) {
    const before = initial.get(relative), after = currentMap.get(relative);
    const finalHash = fileHash(path.join(row.root_path, relative));
    if (before) {
      if (before.hash === finalHash && (!after || after.code === before.code)) continue;
      changed.push(relative); continue;
    }
    if (committed.paths.includes(relative) || after) changed.push(relative);
  }
  return {
    root_key: row.root_key, root_path: row.root_path, change_detection: { mode: "git", complete: true },
    baseline_head: row.baseline_head, current_head: committed.current_head, head_changed: Boolean(row.baseline_head && committed.current_head && row.baseline_head !== committed.current_head),
    commits_created_during_run: committed.commits, committed_delta: committed.paths, working_tree_status: current,
    run_changed_paths: [...new Set(changed)].sort()
  };
}

function inventoryDelta(row) {
  const baseline = new Map(JSON.parse(row.baseline_json).files.map(item => [item.path, item]));
  const current = inventory(row.root_path), currentMap = new Map(current.map(item => [item.path, item]));
  const changed = [];
  for (const relative of new Set([...baseline.keys(), ...currentMap.keys()])) {
    const before = baseline.get(relative), after = currentMap.get(relative);
    if (!before || !after || before.hash !== after.hash) changed.push(relative);
  }
  return { root_key: row.root_key, root_path: row.root_path, change_detection: { mode: "inventory", complete: row.complete === 1 }, run_changed_paths: changed.sort() };
}

function wildcardExpression(pattern) {
  const escaped = normalized(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function authorizedPath(pathValue, allowedPaths) {
  const candidate = normalized(pathValue);
  return (allowedPaths ?? []).some(value => {
    const allowed = normalized(value);
    return candidate === allowed || (!/[?*]/.test(allowed) && candidate.startsWith(`${allowed.replace(/\/$/, "")}/`)) || wildcardExpression(allowed).test(candidate);
  });
}

function changedSymbols(root, paths) {
  const symbols = [];
  const pattern = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)|^\s*(?:Функция|Процедура)\s+([A-Za-z_Ѐ-ӿ][A-Za-z0-9_Ѐ-ӿ]*)/i;
  for (const relative of paths.slice(0, 50)) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 2 * 1024 * 1024) continue;
    let text; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const match = line.match(pattern);
      if (match) symbols.push({ path: relative, symbol: match[1] ?? match[2], line: index + 1 });
      if (symbols.length >= 100) return symbols;
    }
  }
  return symbols;
}

export function runChangeEvidence(db, runId, allowedPaths = []) {
  const roots = db.prepare("SELECT * FROM run_root_baselines WHERE run_id=? ORDER BY root_key").all(runId).map(row => row.mode === "git" ? gitDelta(row) : inventoryDelta(row));
  for (const root of roots) {
    root.authorized_changes = root.run_changed_paths.filter(item => authorizedPath(item, allowedPaths));
    root.unauthorized_changes = root.run_changed_paths.filter(item => !authorizedPath(item, allowedPaths));
    root.changed_symbols = changedSymbols(root.root_path, root.run_changed_paths);
  }
  return {
    roots,
    run_changed_paths: roots.flatMap(root => root.run_changed_paths.map(item => root.root_key === "primary" ? item : `${root.root_key}/${item}`)),
    unauthorized_changes: roots.flatMap(root => root.unauthorized_changes.map(item => root.root_key === "primary" ? item : `${root.root_key}/${item}`))
  };
}

export function recordRunEvidence(db, runId, stepId, kind, value) {
  const evidenceJson = JSON.stringify(value), evidenceHash = digest(evidenceJson);
  db.prepare("INSERT INTO run_evidence(id,run_id,step_id,kind,evidence_hash,evidence_json,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id("evidence"), runId, stepId ?? null, kind, evidenceHash, evidenceJson, now());
  return evidenceHash;
}

function parse(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function utf8Prefix(value, bytes) { return Buffer.from(String(value ?? "")).subarray(0, Math.max(0, bytes)).toString("utf8"); }

function compactCodeIntelligence(value, includeSamples = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "adapters") continue;
    copy[key] = Array.isArray(item) ? item.slice(0, 100).map(entry => typeof entry === "string" ? utf8Prefix(entry, 240) : entry) : item;
  }
  copy.adapters = (value.adapters ?? []).slice(0, 8).map(adapter => ({
    name: adapter.name, files: adapter.files, compiler_available: adapter.compiler_available,
    definitions: adapter.definitions, resolved_references: adapter.resolved_references, unresolved_calls: adapter.unresolved_calls,
    unresolved_call_categories: adapter.unresolved_call_categories ?? {},
    unresolved_call_samples: includeSamples ? Object.fromEntries(Object.entries(adapter.unresolved_call_samples ?? {}).map(([category, samples]) => [category,
      (samples ?? []).slice(0, 2).map(sample => ({ path: sample.path, line: sample.line, expression: utf8Prefix(sample.expression, 240) }))
    ])) : {},
    semantic_diagnostics: adapter.semantic_diagnostics
  }));
  return copy;
}

function compactSourceFile(file) {
  const scan = file.exact_term_scan;
  const source = String(file.text ?? ""), headers = [...source.matchAll(/^--- lines (\d+)-(\d+) \(([^)]*)\) ---\r?\n/gm)];
  const sourceRanges = headers.length ? headers.map((header, index) => ({
    start_line: Number(header[1]), end_line: Number(header[2]), reason: utf8Prefix(header[3], 160),
    text: source.slice(header.index + header[0].length, headers[index + 1]?.index ?? source.length).trim()
  })) : source ? [{
    start_line: file.segments?.[0]?.start_line ?? null, end_line: file.segments?.[0]?.end_line ?? null,
    reason: utf8Prefix(file.segments?.[0]?.reason ?? "supplied_source", 160), text: source
  }] : [];
  return {
    path: file.path,
    segments: (file.segments ?? []).slice(0, 12).map(segment => ({
      start_line: segment.start_line, end_line: segment.end_line, reason: utf8Prefix(segment.reason, 160), complete: segment.complete
    })),
    ...(scan ? { exact_term_scan: {
      scope: scan.scope, match: scan.match,
      occurrences: (scan.occurrences ?? []).slice(0, 40).map(occurrence => ({
        term: utf8Prefix(occurrence.term, 160), count: occurrence.count, matched_lines: occurrence.matched_lines,
        locations: (occurrence.locations ?? []).slice(0, 3).map(location => ({ line: location.line, text: utf8Prefix(location.text, 320) })),
        locations_truncated: Boolean(occurrence.locations_truncated) || (occurrence.locations ?? []).length > 3
      }))
    } } : {}),
    supplied_bytes: file.supplied_bytes,
    source_ranges: sourceRanges
  };
}

function trimStringValues(entries, read, write, bytesToRemove, minimum = 0) {
  let remaining = Math.max(0, bytesToRemove), candidates = entries.map(entry => ({ entry, bytes: Buffer.byteLength(String(read(entry) ?? "")) })).filter(item => item.bytes > minimum);
  while (remaining > 0 && candidates.length) {
    const share = Math.max(1, Math.ceil(remaining / candidates.length));
    let removedThisRound = 0;
    for (const candidate of candidates) {
      const remove = Math.min(candidate.bytes - minimum, share);
      if (remove <= 0) continue;
      const target = candidate.bytes - remove;
      write(candidate.entry, utf8Prefix(read(candidate.entry), target));
      const actual = candidate.bytes - Buffer.byteLength(String(read(candidate.entry) ?? ""));
      candidate.bytes -= actual; remaining -= actual; removedThisRound += actual;
      if (remaining <= 0) break;
    }
    if (!removedThisRound) break;
    candidates = candidates.filter(item => item.bytes > minimum);
  }
  return bytesToRemove - remaining;
}

function compactReviewEvidence(evidence, limit = 72_000) {
  const copy = structuredClone(evidence);
  // buildReviewEvidence adds a SHA-256 field after compaction; reserve its JSON envelope here so
  // the object actually delivered to reviewers, not only its pre-hash form, stays under the limit.
  const contentLimit = Math.max(0, limit - 320);
  copy.evidence_compaction = { limit_bytes: limit, supplied_bytes: 0, source_text_reduced: false, metadata_reduced: false };
  if (copy.change_evidence) {
    copy.change_evidence.run_changed_paths = copy.change_evidence.run_changed_paths.slice(0, 200);
    copy.change_evidence.unauthorized_changes = copy.change_evidence.unauthorized_changes.slice(0, 200);
    copy.change_evidence.roots = copy.change_evidence.roots.map(root => ({
      ...root,
      commits_created_during_run: (root.commits_created_during_run ?? []).slice(0, 50).map(value => utf8Prefix(value, 500)),
      committed_delta: (root.committed_delta ?? []).slice(0, 200), working_tree_status: (root.working_tree_status ?? []).slice(0, 100),
      run_changed_paths: (root.run_changed_paths ?? []).slice(0, 200), authorized_changes: (root.authorized_changes ?? []).slice(0, 200),
      unauthorized_changes: (root.unauthorized_changes ?? []).slice(0, 200), changed_symbols: (root.changed_symbols ?? []).slice(0, 100)
    }));
  }
  if (copy.analytical_evidence) {
    copy.analytical_evidence.decision_artifacts = copy.analytical_evidence.decision_artifacts.slice(0, 50).map(item => ({
      kind: item.kind, artifact_key: item.artifact_key ?? null, artifact_type: item.artifact_type ?? null, path: item.path ?? null,
      conclusion: utf8Prefix(item.conclusion ?? item.summary ?? "", 2_048), evidence: (item.evidence ?? item.evidence_refs ?? []).slice(0, 12).map(value => utf8Prefix(value, 320))
    }));
    copy.analytical_evidence.conclusions = copy.analytical_evidence.conclusions.slice(0, 50).map(item => ({ ...item, summary: utf8Prefix(item.summary, 2_048), evidence_refs: (item.evidence_refs ?? []).slice(0, 12).map(value => utf8Prefix(value, 320)) }));
  }
  if (copy.verification?.gate?.checks) copy.verification.gate.checks = copy.verification.gate.checks.slice(0, 50).map(check => ({
    id: check.id, name: check.name, required: check.required, status: check.status, exit_code: check.exit_code, duration_ms: check.duration_ms,
    failure: utf8Prefix(check.failure, 512), failure_path: check.failure_path ?? null,
    execution_project_id: check.execution_project_id ?? null, execution_root: check.execution_root ?? null
  }));
  copy.artifacts = copy.artifacts.slice(0, 100).map(item => ({ ...item, provenance_json: utf8Prefix(item.provenance_json, 2_048) }));
  const intelligenceCatalog = [], intelligenceRefs = new Map();
  copy.source_evidence = copy.source_evidence.map(item => {
    const intelligence = compactCodeIntelligence(item.code_intelligence, true), signature = JSON.stringify(intelligence);
    let intelligenceRef = intelligenceRefs.get(signature);
    if (!intelligenceRef) {
      intelligenceRef = `code_intelligence_${intelligenceCatalog.length + 1}`;
      intelligenceRefs.set(signature, intelligenceRef); intelligenceCatalog.push({ id: intelligenceRef, ...intelligence });
    }
    return { step_id: item.step_id ?? null, evidence_hash: item.evidence_hash ?? null, plan_step: item.plan_step ?? null, code_intelligence_ref: intelligenceRef, files: (item.files ?? []).map(compactSourceFile) };
  });
  // Worker steps commonly share the planner's same global graph statistics. Store each distinct
  // graph once and keep per-snapshot references; no evidence is lost when a correction adds another
  // source snapshot.
  copy.code_intelligence_catalog = intelligenceCatalog;
  const size = () => Buffer.byteLength(JSON.stringify(copy));
  const excessBytes = () => size() > contentLimit ? size() - contentLimit + 64 : 0;
  const files = copy.source_evidence.flatMap(item => item.files ?? []);
  const sourceRanges = files.flatMap(file => file.source_ranges ?? []);
  // Preserve a concrete excerpt from every supplied primary range. Large concatenated file strings
  // used to be reduced to empty values before lower-value scan metadata was compacted, leaving a
  // reviewer with paths and counts but no code it could independently inspect.
  let excess = excessBytes();
  if (excess && trimStringValues(sourceRanges, range => range.text, (range, value) => { range.text = value; range.text_truncated = true; }, excess, 768)) copy.evidence_compaction.source_text_reduced = true;
  // Real analytical workflows may carry several independent exact scans. Keep every term, count,
  // path and line while reducing duplicated line bodies and prose summaries only as needed.
  const occurrences = files.flatMap(file => file.exact_term_scan?.occurrences ?? []);
  const locations = occurrences.flatMap(item => item.locations ?? []);
  const summaries = [...(copy.analytical_evidence?.conclusions ?? []), ...(copy.analytical_evidence?.decision_artifacts ?? [])];
  excess = excessBytes();
  if (excess && trimStringValues(locations, item => item.text, (item, value) => { item.text = value; }, excess)) copy.evidence_compaction.metadata_reduced = true;
  if (size() > contentLimit) for (const occurrence of occurrences) {
    if ((occurrence.locations ?? []).length > 1) { occurrence.locations = occurrence.locations.slice(0, 1); occurrence.locations_truncated = true; copy.evidence_compaction.metadata_reduced = true; }
  }
  // If many workers scanned the same lexical vocabulary, one located occurrence per file keeps a
  // concrete line anchor while the remaining entries still preserve every term and its full count.
  if (size() > contentLimit) for (const file of files) for (const occurrence of (file.exact_term_scan?.occurrences ?? []).slice(1)) {
    occurrence.locations = []; occurrence.locations_truncated = true; copy.evidence_compaction.metadata_reduced = true;
  }
  const sampleMaps = copy.code_intelligence_catalog.flatMap(item => item.adapters ?? []).map(adapter => adapter.unresolved_call_samples ?? {});
  if (size() > contentLimit) for (const samples of sampleMaps) for (const category of Object.keys(samples).sort()) { samples[category] = []; copy.evidence_compaction.metadata_reduced = true; }
  if (size() > contentLimit) for (const segment of files.flatMap(file => file.segments ?? [])) { segment.reason = ""; copy.evidence_compaction.metadata_reduced = true; }
  if (size() > contentLimit) for (const file of files) { delete file.supplied_bytes; copy.evidence_compaction.metadata_reduced = true; }
  if (size() > contentLimit) for (const file of files) {
    const scan = file.exact_term_scan, occurrences = scan?.occurrences ?? [];
    if (!occurrences.length) continue;
    scan.count_index = Object.fromEntries(occurrences.map(item => [item.term, { count: item.count, matched_lines: item.matched_lines }]));
    scan.occurrences = occurrences.filter(item => (item.locations ?? []).length).slice(0, 1);
    copy.evidence_compaction.metadata_reduced = true;
  }
  excess = excessBytes();
  if (excess && trimStringValues(summaries, item => item.summary ?? item.conclusion, (item, value) => { if (Object.hasOwn(item, "summary")) item.summary = value; else item.conclusion = value; }, excess, 256)) copy.evidence_compaction.metadata_reduced = true;
  const references = summaries.flatMap(item => ["evidence_refs", "evidence"].flatMap(key => (item[key] ?? []).map((value, index) => ({ owner: item, key, index }))));
  excess = excessBytes();
  if (excess && trimStringValues(references, item => item.owner[item.key][item.index], (item, value) => { item.owner[item.key][item.index] = value; }, excess, 120)) copy.evidence_compaction.metadata_reduced = true;
  if (size() > contentLimit) for (const item of summaries) for (const key of ["evidence_refs", "evidence"]) if ((item[key] ?? []).length > 3) { item[key] = item[key].slice(0, 3); copy.evidence_compaction.metadata_reduced = true; }
  // JSON escaping and the final compaction counters add a small measured envelope overhead. Pay that
  // from every range fairly while retaining a non-empty inspectable excerpt from each one.
  excess = excessBytes();
  if (excess && trimStringValues(sourceRanges, range => range.text, (range, value) => { range.text = value; range.text_truncated = true; }, excess, 512)) copy.evidence_compaction.source_text_reduced = true;
  copy.evidence_compaction.supplied_bytes = size();
  if (size() > contentLimit) throw new Error(`REVIEW_EVIDENCE_BUDGET_EXCEEDED: ${size()}/${limit}`);
  return copy;
}

export function buildReviewEvidence(db, runId, { plan, gate, workerResults, allowedPaths = [], reviewEvidenceLimit = 72_000 } = {}) {
  const run = db.prepare("SELECT task_id FROM workflow_runs WHERE id=?").get(runId);
  if (!run) throw new Error(`RUN_NOT_FOUND: ${runId}`);
  const changes = runChangeEvidence(db, runId, allowedPaths);
  const decisionArtifacts = db.prepare("SELECT kind,structured_json FROM decisions WHERE run_id=? AND active=1 AND kind LIKE 'artifact:%' ORDER BY created_at").all(runId)
    .map(row => ({ kind: row.kind, ...parse(row.structured_json, {}) }));
  const hasChanges = changes.run_changed_paths.length > 0, hasAnalysis = decisionArtifacts.length > 0;
  const type = hasChanges && hasAnalysis ? "mixed" : hasChanges ? "change" : "analytical";
  const sourceEvidence = db.prepare("SELECT step_id,evidence_hash,evidence_json FROM run_evidence WHERE run_id=? AND kind='worker_source' ORDER BY created_at").all(runId)
    .map(row => ({ step_id: row.step_id, evidence_hash: row.evidence_hash, ...parse(row.evidence_json, {}) }));
  const evidence = {
    schema_version: 1, type, owner_objective: ownerObjective(db, runId),
    canonical_completion: { blockers: completionBlockers(db, run.task_id) },
    planner_advisory: { completion_criteria: plan?.completion_criteria ?? [], authority: "advisory" },
    verification: { gate: gate ?? null },
    change_evidence: type === "analytical" ? null : changes,
    analytical_evidence: type === "change" ? null : { decision_artifacts: decisionArtifacts, conclusions: (workerResults ?? []).map(item => ({ plan_step: item.plan_step, summary: item.summary, evidence_refs: item.evidence })) },
    source_evidence: sourceEvidence,
    artifacts: db.prepare("SELECT kind,uri,content_hash,status,provenance_json FROM artifacts WHERE run_id=? ORDER BY created_at").all(runId)
  };
  const compact = compactReviewEvidence(evidence, reviewEvidenceLimit);
  compact.base_evidence_hash = digest(JSON.stringify(compact));
  recordRunEvidence(db, runId, null, "review_base", compact);
  return compact;
}
