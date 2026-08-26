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

function boundedSourceEvidence(value, remaining) {
  const copy = structuredClone(value), files = Array.isArray(copy.files) ? copy.files : [];
  copy.files = files.map(file => {
    const text = String(file.text ?? ""), allowance = Math.max(0, Math.min(4_096, remaining.value));
    const supplied = Buffer.from(text).subarray(0, allowance).toString("utf8");
    remaining.value -= Buffer.byteLength(supplied);
    return { ...file, text: supplied, source_text_truncated: Buffer.byteLength(text) > Buffer.byteLength(supplied) };
  });
  return copy;
}

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
    text: String(file.text ?? ""), source_text_truncated: Boolean(file.source_text_truncated)
  };
}

function reduceLargestString(entries, key, minimum = 0) {
  const candidate = entries.filter(item => Buffer.byteLength(String(item?.[key] ?? "")) > minimum)
    .sort((a, b) => Buffer.byteLength(String(b[key])) - Buffer.byteLength(String(a[key])))[0];
  if (!candidate) return false;
  candidate[key] = utf8Prefix(candidate[key], Math.max(minimum, Math.floor(Buffer.byteLength(String(candidate[key])) / 2)));
  return true;
}

function compactReviewEvidence(evidence, limit = 40_000) {
  const copy = structuredClone(evidence);
  // buildReviewEvidence adds a SHA-256 field after compaction; reserve its JSON envelope here so
  // the object actually delivered to reviewers, not only its pre-hash form, stays under the limit.
  const contentLimit = Math.max(0, limit - 160);
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
  copy.source_evidence = copy.source_evidence.map((item, index) => ({
    step_id: item.step_id ?? null, evidence_hash: item.evidence_hash ?? null, plan_step: item.plan_step ?? null,
    // Adapter totals are repeated for every worker-source snapshot. One sample set proves the
    // category examples; subsequent snapshots retain the complete counts without duplicating it.
    code_intelligence: compactCodeIntelligence(item.code_intelligence, index === 0), files: (item.files ?? []).map(compactSourceFile)
  }));
  // Primary source snippets give way gradually, but each retained file remains named and its
  // exact-scan/code-intelligence metadata remains available after its text reaches zero.
  while (Buffer.byteLength(JSON.stringify(copy)) > contentLimit) {
    const file = copy.source_evidence.flatMap(item => item.files ?? []).sort((a, b) => Buffer.byteLength(String(b.text ?? "")) - Buffer.byteLength(String(a.text ?? "")))[0];
    if (!file || !file.text) break;
    file.text = utf8Prefix(file.text, Math.floor(Buffer.byteLength(file.text) / 2)); file.source_text_truncated = true; copy.evidence_compaction.source_text_reduced = true;
  }
  // Real analytical workflows may carry several independent exact scans. Keep every term, count,
  // path and line while reducing duplicated line bodies and prose summaries only as needed.
  const locations = () => copy.source_evidence.flatMap(item => item.files ?? []).flatMap(file => file.exact_term_scan?.occurrences ?? []).flatMap(item => item.locations ?? []);
  const summaries = () => [...(copy.analytical_evidence?.conclusions ?? []), ...(copy.analytical_evidence?.decision_artifacts ?? [])];
  while (Buffer.byteLength(JSON.stringify(copy)) > contentLimit && reduceLargestString(locations(), "text")) copy.evidence_compaction.metadata_reduced = true;
  while (Buffer.byteLength(JSON.stringify(copy)) > contentLimit) {
    const occurrence = copy.source_evidence.flatMap(item => item.files ?? []).flatMap(file => file.exact_term_scan?.occurrences ?? [])
      .filter(item => (item.locations ?? []).length > 1).sort((a, b) => b.locations.length - a.locations.length)[0];
    if (!occurrence) break;
    occurrence.locations.pop(); occurrence.locations_truncated = true; copy.evidence_compaction.metadata_reduced = true;
  }
  // If many workers scanned the same lexical vocabulary, one located occurrence per file keeps a
  // concrete line anchor while the remaining entries still preserve every term and its full count.
  for (const file of copy.source_evidence.flatMap(item => item.files ?? [])) {
    for (const occurrence of (file.exact_term_scan?.occurrences ?? []).slice(1)) {
      if (Buffer.byteLength(JSON.stringify(copy)) <= contentLimit) break;
      occurrence.locations = []; occurrence.locations_truncated = true; copy.evidence_compaction.metadata_reduced = true;
    }
  }
  const sampleMaps = copy.source_evidence.flatMap(item => item.code_intelligence?.adapters ?? []).map(adapter => adapter.unresolved_call_samples ?? {});
  for (const samples of sampleMaps) {
    for (const category of Object.keys(samples).sort()) {
      if (Buffer.byteLength(JSON.stringify(copy)) <= contentLimit) break;
      samples[category] = []; copy.evidence_compaction.metadata_reduced = true;
    }
  }
  for (const segment of copy.source_evidence.flatMap(item => item.files ?? []).flatMap(file => file.segments ?? [])) {
    if (Buffer.byteLength(JSON.stringify(copy)) <= contentLimit) break;
    segment.reason = ""; copy.evidence_compaction.metadata_reduced = true;
  }
  for (const file of copy.source_evidence.flatMap(item => item.files ?? [])) {
    if (Buffer.byteLength(JSON.stringify(copy)) <= contentLimit) break;
    delete file.supplied_bytes;
    if (!file.text) delete file.source_text_truncated;
    copy.evidence_compaction.metadata_reduced = true;
  }
  while (Buffer.byteLength(JSON.stringify(copy)) > contentLimit && (reduceLargestString(summaries(), "summary", 256) || reduceLargestString(summaries(), "conclusion", 256))) copy.evidence_compaction.metadata_reduced = true;
  const references = () => summaries().flatMap(item => ["evidence_refs", "evidence"].flatMap(key => (item[key] ?? []).map((value, index) => ({ owner: item, key, index, value }))));
  while (Buffer.byteLength(JSON.stringify(copy)) > contentLimit) {
    const candidate = references().filter(item => Buffer.byteLength(String(item.value)) > 120).sort((a, b) => Buffer.byteLength(String(b.value)) - Buffer.byteLength(String(a.value)))[0];
    if (!candidate) break;
    candidate.owner[candidate.key][candidate.index] = utf8Prefix(candidate.value, Math.max(120, Math.floor(Buffer.byteLength(String(candidate.value)) / 2)));
    copy.evidence_compaction.metadata_reduced = true;
  }
  while (Buffer.byteLength(JSON.stringify(copy)) > contentLimit) {
    const candidate = summaries().flatMap(item => ["evidence_refs", "evidence"].map(key => ({ item, key, values: item[key] ?? [] })))
      .filter(entry => entry.values.length > 3).sort((a, b) => b.values.length - a.values.length)[0];
    if (!candidate) break;
    candidate.values.pop(); copy.evidence_compaction.metadata_reduced = true;
  }
  copy.evidence_compaction.supplied_bytes = Buffer.byteLength(JSON.stringify(copy));
  if (Buffer.byteLength(JSON.stringify(copy)) > contentLimit) throw new Error(`REVIEW_EVIDENCE_BUDGET_EXCEEDED: ${Buffer.byteLength(JSON.stringify(copy))}/${limit}`);
  return copy;
}

export function buildReviewEvidence(db, runId, { plan, gate, workerResults, allowedPaths = [] } = {}) {
  const run = db.prepare("SELECT task_id FROM workflow_runs WHERE id=?").get(runId);
  if (!run) throw new Error(`RUN_NOT_FOUND: ${runId}`);
  const changes = runChangeEvidence(db, runId, allowedPaths);
  const decisionArtifacts = db.prepare("SELECT kind,structured_json FROM decisions WHERE run_id=? AND active=1 AND kind LIKE 'artifact:%' ORDER BY created_at").all(runId)
    .map(row => ({ kind: row.kind, ...parse(row.structured_json, {}) }));
  const hasChanges = changes.run_changed_paths.length > 0, hasAnalysis = decisionArtifacts.length > 0;
  const type = hasChanges && hasAnalysis ? "mixed" : hasChanges ? "change" : "analytical";
  const remainingSourceBytes = { value: 24_000 };
  const sourceEvidence = db.prepare("SELECT step_id,evidence_hash,evidence_json FROM run_evidence WHERE run_id=? AND kind='worker_source' ORDER BY created_at").all(runId)
    .map(row => ({ step_id: row.step_id, evidence_hash: row.evidence_hash, ...boundedSourceEvidence(parse(row.evidence_json, {}), remainingSourceBytes) }));
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
  const compact = compactReviewEvidence(evidence);
  compact.base_evidence_hash = digest(JSON.stringify(compact));
  recordRunEvidence(db, runId, null, "review_base", compact);
  return compact;
}
