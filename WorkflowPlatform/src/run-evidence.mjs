import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { utf8Prefix } from "./utf8.mjs";
import { execFileSync } from "node:child_process";
import { id, now } from "./db.mjs";
import { completionBlockers } from "./state-machine.mjs";
import { adapterMaterialSymbols, adapterTransitions, selectFlowEvidenceAdapter } from "./evidence-flow-adapters.mjs";

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
    transitions: (adapter.transitions ?? []).slice(0, 200),
    unresolved_call_categories: adapter.unresolved_call_categories ?? {},
    unresolved_call_samples: includeSamples ? Object.fromEntries(Object.entries(adapter.unresolved_call_samples ?? {}).map(([category, samples]) => [category,
      (samples ?? []).slice(0, 2).map(sample => ({ path: sample.path, line: sample.line, expression: utf8Prefix(sample.expression, 240) }))
    ])) : {},
    semantic_diagnostics: adapter.semantic_diagnostics
  }));
  return copy;
}

function compactSourceFile(file) {
  if (Array.isArray(file.source_range_refs)) return { path: file.path, source_range_refs: [...file.source_range_refs], exact_scan_ref: file.exact_scan_ref ?? null };
  if (Array.isArray(file.source_ranges)) return {
    ...file,
    source_ranges: file.source_ranges.map(range => ({ ...range, reason: utf8Prefix(range.reason, 160), text: String(range.text ?? "") }))
  };
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

function claimTokens(value) {
  return [...new Set(String(value ?? "").toLowerCase().match(/[a-zа-яё_$][a-zа-яё0-9_$.-]{3,}/giu) ?? [])]
    .filter(token => !new Set(["this", "that", "with", "from", "через", "котор", "подтверж", "evidence", "source"]).has(token)).slice(0, 40);
}

function rangeRef(file, range) {
  return `${file.path}:${range.start_line ?? "?"}-${range.end_line ?? "?"}`;
}

function selectClaimRanges(file, claimText, evidenceRefs) {
  const explicitLines = evidenceRefs.flatMap(value => {
    const expression = new RegExp(`${String(file.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)(?:-(\\d+))?`, "ig");
    return [...String(value).matchAll(expression)].map(match => ({ start: Number(match[1]), end: Number(match[2] ?? match[1]) }));
  });
  const tokens = claimTokens(claimText);
  const scored = (file.source_ranges ?? []).map((range, index) => {
    const text = `${range.reason ?? ""}\n${range.text ?? ""}`.toLowerCase();
    const explicit = explicitLines.some(lines => Number(range.start_line) <= lines.end && Number(range.end_line) >= lines.start);
    return { range, index, explicit, score: tokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0) };
  }).filter(item => item.explicit || item.score > 0).sort((left, right) => Number(right.explicit) - Number(left.explicit) || right.score - left.score || left.index - right.index);
  const selected = scored.length ? scored.slice(0, 3) : (file.source_ranges ?? []).slice(0, 1).map((range, index) => ({ range, index }));
  return selected.map(item => item.range);
}

function chainAnchor(sources, spec) {
  const stepKeys = new Set(spec.step_keys ?? []), pathHints = (spec.path_hints ?? []).map(normalized), terms = (spec.anchor_terms ?? []).map(term => term.toLowerCase());
  const candidates = [];
  for (const source of sources.values()) for (const file of source.files ?? []) for (const range of file.source_ranges ?? []) {
    const stepMatch = stepKeys.has(source.plan_step), pathMatch = pathHints.some(hint => normalized(file.path).includes(hint));
    const text = `${range.reason ?? ""}\n${range.text ?? ""}`.toLowerCase();
    const termMatches = terms.filter(term => text.includes(term)).length;
    const score = Number(stepMatch) * 8 + Number(pathMatch) * 6 + termMatches * 3;
    if ((stepMatch || pathMatch) && score > 0 && (!terms.length || termMatches > 0)) candidates.push({ file, range, score });
  }
  return candidates.sort((left, right) => right.score - left.score || normalized(left.file.path).localeCompare(normalized(right.file.path)) || Number(left.range.start_line) - Number(right.range.start_line))[0] ?? null;
}

function transitionAnchors(flowAdapter, symbols, files, targetPath, sources) {
  return adapterTransitions(flowAdapter, symbols, targetPath, sources).map(transition => {
    const file = files.find(item => item.path === transition.path);
    const range = (file?.source_ranges ?? []).find(item => Number(item.start_line) <= transition.line && Number(item.end_line) >= transition.line);
    return file && range ? { file, range, transition } : null;
  }).filter(Boolean);
}

export function claimCenteredReviewEvidence(workerResults, sourceEvidence, flowAdapter = null) {
  const compacted = sourceEvidence.map(item => ({ ...item, files: (item.files ?? []).map(compactSourceFile) }));
  const latestResults = new Map(), latestSources = new Map();
  for (const result of workerResults ?? []) latestResults.set(result.plan_step ?? `claim_${latestResults.size + 1}`, result);
  for (const source of compacted) latestSources.set(source.plan_step ?? `source_${latestSources.size + 1}`, source);
  const allFiles = [...latestSources.values()].flatMap(item => item.files ?? []), rangeCatalog = new Map(), scanCatalog = new Map();
  const sourceHashes = file => [...new Set(compacted.filter(item => (item.files ?? []).some(candidate => candidate.path === file.path)).map(item => item.evidence_hash).filter(Boolean))];
  const registerRange = (file, range) => {
    const rangeId = `range_${digest(`${file.path}\n${range.start_line}\n${range.end_line}\n${range.text ?? ""}`).slice(0, 20)}`;
    if (!rangeCatalog.has(rangeId)) rangeCatalog.set(rangeId, { range_id: rangeId, path: file.path, start_line: range.start_line, end_line: range.end_line, reason: range.reason, text: range.text, provenance: { source_snapshot_hashes: sourceHashes(file), content_hash: digest(range.text ?? "") } });
    return rangeId;
  };
  const registerScan = file => {
    if (!file.exact_term_scan) return null;
    const scanId = `scan_${digest(`${file.path}\n${JSON.stringify(file.exact_term_scan)}`).slice(0, 20)}`;
    if (!scanCatalog.has(scanId)) scanCatalog.set(scanId, { scan_id: scanId, path: file.path, ...file.exact_term_scan, provenance: { source_snapshot_hashes: sourceHashes(file) } });
    return scanId;
  };
  const chainRequested = Boolean(flowAdapter);
  const requiredChainEdges = flowAdapter?.required_edges ?? [];
  const claims = [], conclusions = [];
  for (const [planStep, result] of latestResults) {
    const rawEvidenceRefs = (result.evidence ?? []).map(String), claimText = `${result.summary ?? ""}\n${rawEvidenceRefs.join("\n")}`;
    const mentioned = allFiles.filter(file => rawEvidenceRefs.some(value => normalized(value).includes(normalized(file.path))));
    const stepFiles = latestSources.get(planStep)?.files ?? [];
    const candidates = mentioned.length ? mentioned : stepFiles;
    const primaryEvidenceRefs = [];
    for (const file of candidates) {
      const ranges = selectClaimRanges(file, claimText, rawEvidenceRefs);
      primaryEvidenceRefs.push(...ranges.map(range => registerRange(file, range)));
    }
    const paths = new Set(candidates.map(file => file.path));
    const graphEdges = [...latestSources.values()].flatMap(item => item.code_intelligence?.edges ?? []).filter(edge => {
      const nodes = itemNodes(latestSources, edge); return nodes.some(node => paths.has(node.path));
    }).slice(0, 16).map(edge => edge.id ?? `${edge.from}->${edge.to}:${edge.type}`);
    const exactScanRefs = candidates.map(registerScan).filter(Boolean);
    // The plan step is the stable material-claim identity across correction cycles. Worker prose is an
    // analytical artifact, not identity: changing a summary must never manufacture semantic progress.
    const claimId = `claim_${digest(planStep).slice(0, 16)}`;
    const crossLayerNarrative = chainRequested && /synth|coverage_package|cross.?layer|end.?to.?end/i.test(planStep);
    // A synthesis result is an analytical conclusion, not a second evidence narrative. Cross-layer
    // coverage has its own deterministic chain record below and must never be duplicated as a generic
    // claim->primary_evidence assertion that can contradict the real edge coverage.
    if (primaryEvidenceRefs.length && !crossLayerNarrative) claims.push({
      claim_id: claimId,
      claim_type: /test|check|verify/i.test(planStep) ? "verification" : "analytical",
      subject: planStep,
      target: [...paths].sort(),
      required_edges: ["claim->primary_evidence"],
      observed_edges: [{ edge: "claim->primary_evidence", status: "observed", provenance_refs: [...new Set(primaryEvidenceRefs)] }],
      primary_evidence_refs: [...new Set(primaryEvidenceRefs)],
      contradicting_evidence_refs: [],
      graph_edge_refs: [...new Set(graphEdges)],
      exact_scan_refs: [...new Set(exactScanRefs)],
      provenance: { worker_result_hash: digest(JSON.stringify(result)), source_snapshot_hashes: [...new Set(compacted.filter(item => (item.files ?? []).some(file => candidates.includes(file))).map(item => item.evidence_hash).filter(Boolean))] },
      edge_coverage: [{ edge: "claim->primary_evidence", status: "observed", provenance_refs: [...new Set(primaryEvidenceRefs)] }],
      coverage: "sufficient",
      missing_edges: [],
      unknown_edges: []
    });
    conclusions.push({ claim_id: primaryEvidenceRefs.length && !crossLayerNarrative ? claimId : null, plan_step: planStep, summary: result.summary ?? "", evidence_refs: rawEvidenceRefs.slice(0, 12).map(value => utf8Prefix(value, 320)) });
  }
  const anchorSpecs = flowAdapter?.nodes ?? [];
  const anchorDetails = Object.fromEntries(anchorSpecs.map(spec => {
    const anchor = chainAnchor(latestSources, spec);
    return [spec.key, anchor ? { ...anchor, range_id: registerRange(anchor.file, anchor.range) } : null];
  }));
  const anchors = Object.fromEntries(Object.entries(anchorDetails).map(([name, value]) => [name, value?.range_id ?? null]));
  const derivedEdgeCatalog = [];
  const chainEdgeCoverage = requiredChainEdges.map(edge => {
    const [from, to] = edge.split("->");
    const endpointRefs = [anchors[from], anchors[to]].filter(Boolean);
    const sourceAnchorRefs = [...new Set(endpointRefs)];
    const graphRefs = graphPath(latestSources, rangeCatalog.get(anchors[from])?.path, rangeCatalog.get(anchors[to])?.path);
    if (anchors[from] && anchors[to] && graphRefs.length) return { edge, status: "observed", graph_edge_refs: graphRefs, source_anchor_refs: sourceAnchorRefs, derived_edge_refs: [], provenance_refs: [...new Set([...sourceAnchorRefs, ...graphRefs])] };
    const symbols = anchors[from] && anchors[to]
      ? adapterMaterialSymbols(anchorDetails[from].range.text, anchorDetails[to].range.text, flowAdapter)
      : [];
    const transitions = transitionAnchors(flowAdapter, symbols, allFiles, rangeCatalog.get(anchors[to])?.path, latestSources);
    const transitionAnchorRefs = transitions.map(({ file, range }) => registerRange(file, range));
    if (symbols.length && transitionAnchorRefs.length) {
      const edgeId = `derived_edge_${digest(`${edge}\n${sourceAnchorRefs.join("\n")}\n${transitionAnchorRefs.join("\n")}\n${symbols.join("\n")}`).slice(0, 20)}`;
      derivedEdgeCatalog.push({
        edge_id: edgeId, from, to, kind: transitions[0].transition.kind, symbols,
        source_anchor_refs: sourceAnchorRefs, transition_anchor_refs: transitionAnchorRefs,
        ast_refs: transitions.map(item => item.transition.id), direction: "from_to", symbol_from: transitions[0].transition.symbol_from, symbol_to: transitions[0].transition.symbol_to,
        provenance: { method: flowAdapter.transition?.method, adapter: flowAdapter.key, source_range_refs: [...new Set([...sourceAnchorRefs, ...transitionAnchorRefs])], ast_refs: transitions.map(item => item.transition.id) }
      });
      return { edge, status: "observed", graph_edge_refs: [], source_anchor_refs: sourceAnchorRefs, transition_anchor_refs: transitionAnchorRefs, derived_edge_refs: [edgeId], candidate_symbols: symbols, provenance_refs: [...new Set([...sourceAnchorRefs, ...transitionAnchorRefs, edgeId])] };
    }
    // The selected graph is bounded supporting evidence. Failure to find a path in it is not proof that
    // the project has no path; a deterministic complete negative scan would be required for `missing`.
    return { edge, status: "unknown", graph_edge_refs: [], source_anchor_refs: sourceAnchorRefs, transition_anchor_refs: [], derived_edge_refs: [], candidate_symbols: symbols, provenance_refs: sourceAnchorRefs };
  });
  const usedRanges = new Set([...claims.flatMap(claim => claim.primary_evidence_refs), ...Object.values(anchors).filter(Boolean), ...chainEdgeCoverage.flatMap(edge => edge.transition_anchor_refs ?? [])]);
  const selectedSources = [...latestSources.values()].map(item => ({
    step_id: item.step_id ?? null,
    evidence_hash: item.evidence_hash ?? null,
    plan_step: item.plan_step ?? null,
    code_intelligence: item.code_intelligence,
    files: (item.files ?? []).map(file => {
      const refs = (file.source_ranges ?? []).map(range => registerRange(file, range)).filter(ref => usedRanges.has(ref));
      const exactScanRef = [...scanCatalog.values()].find(scan => scan.path === file.path)?.scan_id ?? null;
      return refs.length || exactScanRef ? { path: file.path, source_range_refs: refs, exact_scan_ref: exactScanRef } : null;
    }).filter(Boolean)
  })).filter(item => item.files.length).filter((item, index, values) => values.findLastIndex(candidate => candidate.plan_step === item.plan_step) === index);
  return {
    claims,
    conclusions,
    source_range_catalog: [...rangeCatalog.values()].filter(range => usedRanges.has(range.range_id)),
    exact_scan_catalog: [...scanCatalog.values()],
    derived_edge_catalog: derivedEdgeCatalog,
    source_evidence: claims.length ? selectedSources : [...latestSources.values()],
    cross_layer_chains: chainRequested ? [{
      claim_id: `claim_flow_${digest(flowAdapter.key).slice(0, 16)}`,
      claim_type: flowAdapter.claim_type,
      adapter: flowAdapter.key,
      subject: flowAdapter.subject,
      target: flowAdapter.target,
      required_edges: requiredChainEdges,
      observed_edges: chainEdgeCoverage.filter(edge => edge.status === "observed"),
      primary_evidence_refs: [...new Set(Object.values(anchors).filter(Boolean))],
      contradicting_evidence_refs: [],
      exact_scan_refs: [],
      graph_edge_refs: [...new Set(chainEdgeCoverage.flatMap(item => item.graph_edge_refs ?? []))],
      derived_edge_refs: [...new Set(chainEdgeCoverage.flatMap(item => item.derived_edge_refs ?? []))],
      anchors,
      edge_coverage: chainEdgeCoverage,
      coverage: chainEdgeCoverage.every(edge => edge.status === "observed" && edge.provenance_refs.length) ? "sufficient" : "incomplete",
      missing_edges: chainEdgeCoverage.filter(edge => edge.status === "missing").map(edge => edge.edge),
      unknown_edges: chainEdgeCoverage.filter(edge => edge.status === "unknown").map(edge => edge.edge)
    }] : []
  };
}

function itemNodes(sources, edge) {
  const nodes = [...sources.values()].flatMap(item => item.code_intelligence?.nodes ?? []);
  return nodes.filter(node => node.id === edge.from || node.id === edge.to);
}

function graphPath(sources, fromPath, toPath) {
  if (!fromPath || !toPath) return [];
  const nodes = [...sources.values()].flatMap(item => item.code_intelligence?.nodes ?? []), edges = [...sources.values()].flatMap(item => item.code_intelligence?.edges ?? []);
  const targets = new Set(nodes.filter(node => node.path === toPath).map(node => node.id));
  let frontier = nodes.filter(node => node.path === fromPath).map(node => ({ id: node.id, depth: 0, provenance: [] })), visited = new Set(frontier.map(item => item.id));
  while (frontier.length) {
    const current = frontier.shift();
    if (targets.has(current.id)) return current.provenance;
    if (current.depth >= 4) continue;
    for (const edge of edges.filter(item => item.from === current.id)) {
      const next = edge.to;
      const edgeRef = edge.id ?? `${edge.from}->${edge.to}:${edge.type}`;
      if (!visited.has(next)) { visited.add(next); frontier.push({ id: next, depth: current.depth + 1, provenance: [...current.provenance, edgeRef] }); }
    }
  }
  return [];
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
  const contentLimit = Math.max(0, limit - 192);
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
  const sourceRanges = (copy.source_range_catalog?.length ? copy.source_range_catalog : files.flatMap(file => file.source_ranges ?? []));
  // Preserve a concrete excerpt from every supplied primary range. Large concatenated file strings
  // used to be reduced to empty values before lower-value scan metadata was compacted, leaving a
  // reviewer with paths and counts but no code it could independently inspect.
  let excess = excessBytes();
  if (excess && trimStringValues(sourceRanges, range => range.text, (range, value) => { range.text = value; range.text_truncated = true; }, excess, 768)) copy.evidence_compaction.source_text_reduced = true;
  // Real analytical workflows may carry several independent exact scans. Keep every term, count,
  // path and line while reducing duplicated line bodies and prose summaries only as needed.
  const scans = copy.exact_scan_catalog?.length ? copy.exact_scan_catalog : files.map(file => file.exact_term_scan).filter(Boolean);
  const occurrences = scans.flatMap(scan => scan.occurrences ?? []);
  const locations = occurrences.flatMap(item => item.locations ?? []);
  const summaries = [...(copy.analytical_evidence?.conclusions ?? []), ...(copy.analytical_evidence?.decision_artifacts ?? [])];
  excess = excessBytes();
  if (excess && trimStringValues(locations, item => item.text, (item, value) => { item.text = value; }, excess)) copy.evidence_compaction.metadata_reduced = true;
  if (size() > contentLimit) for (const occurrence of occurrences) {
    if ((occurrence.locations ?? []).length > 1) { occurrence.locations = occurrence.locations.slice(0, 1); occurrence.locations_truncated = true; copy.evidence_compaction.metadata_reduced = true; }
  }
  // If many workers scanned the same lexical vocabulary, one located occurrence per file keeps a
  // concrete line anchor while the remaining entries still preserve every term and its full count.
  if (size() > contentLimit) for (const scan of scans) for (const occurrence of (scan.occurrences ?? []).slice(1)) {
    occurrence.locations = []; occurrence.locations_truncated = true; copy.evidence_compaction.metadata_reduced = true;
  }
  const sampleMaps = copy.code_intelligence_catalog.flatMap(item => item.adapters ?? []).map(adapter => adapter.unresolved_call_samples ?? {});
  if (size() > contentLimit) for (const samples of sampleMaps) for (const category of Object.keys(samples).sort()) { samples[category] = []; copy.evidence_compaction.metadata_reduced = true; }
  if (size() > contentLimit) for (const segment of files.flatMap(file => file.segments ?? [])) { segment.reason = ""; copy.evidence_compaction.metadata_reduced = true; }
  if (size() > contentLimit) for (const file of files) { delete file.supplied_bytes; copy.evidence_compaction.metadata_reduced = true; }
  if (size() > contentLimit) for (const scan of scans) {
    const occurrences = scan?.occurrences ?? [];
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
  const run = db.prepare("SELECT wr.task_id,wr.project_id,wr.workflow_id,w.package_key FROM workflow_runs wr LEFT JOIN workflows w ON w.id=wr.workflow_id WHERE wr.id=?").get(runId);
  if (!run) throw new Error(`RUN_NOT_FOUND: ${runId}`);
  const changes = runChangeEvidence(db, runId, allowedPaths);
  const decisionArtifacts = db.prepare("SELECT kind,structured_json FROM decisions WHERE run_id=? AND active=1 AND kind LIKE 'artifact:%' ORDER BY created_at").all(runId)
    .map(row => ({ kind: row.kind, ...parse(row.structured_json, {}) }));
  const hasChanges = changes.run_changed_paths.length > 0, hasAnalysis = decisionArtifacts.length > 0;
  const type = hasChanges && hasAnalysis ? "mixed" : hasChanges ? "change" : "analytical";
  const sourceRows = db.prepare("SELECT step_id,evidence_hash,evidence_json FROM run_evidence WHERE run_id=? AND kind='worker_source' ORDER BY created_at,id").all(runId)
    .map(row => ({ step_id: row.step_id, evidence_hash: row.evidence_hash, ...parse(row.evidence_json, {}) }));
  // The append-only trace retains every collection attempt. The reviewer envelope stores one physical
  // copy of identical evidence and references it by hash, so retry bookkeeping cannot masquerade as a
  // changed proof packet.
  const sourceEvidence = [...new Map(sourceRows.map(item => [item.evidence_hash, item])).values()];
  const corpusScans = db.prepare("SELECT evidence_hash,evidence_json FROM run_evidence WHERE run_id=? AND kind='corpus_exact_scan' ORDER BY created_at,id").all(runId)
    .map(row => ({ evidence_hash: row.evidence_hash, ...parse(row.evidence_json, {}) }))
    .filter(scan => scan.scan_id)
    .map(scan => ({
      scan_id: scan.scan_id, scope: scan.scope, match: scan.match, terms: scan.terms,
      completeness: scan.completeness, boundary: scan.boundary,
      occurrences: (scan.occurrences ?? []).map(item => ({ ...item, locations: (item.locations ?? []).slice(0, 4), locations_truncated: item.locations_truncated || (item.locations ?? []).length > 4 })),
      covered_files_ref: scan.provenance?.inventory_hash ?? null,
      provenance: { ...scan.provenance, source_evidence_hash: scan.evidence_hash, roots: (scan.provenance?.roots ?? []).map(root => ({ key: root.key, access: root.access })) }
    }));
  const workflowKey = db.prepare(`SELECT m.semantic_key FROM package_import_mappings m
    JOIN workflow_import_proposals p ON p.id=m.proposal_id
    WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type='workflow' AND m.local_id=?
    ORDER BY p.applied_at DESC LIMIT 1`).get(run.project_id, run.workflow_id)?.semantic_key ?? run.workflow_id;
  const registeredFlows = db.prepare("SELECT * FROM evidence_flow_adapters WHERE project_id=? AND package_key=? ORDER BY flow_key").all(run.project_id, run.package_key).map(row => ({
    key: row.flow_key, claim_type: row.claim_type, subject: row.subject, target: row.target,
    workflow_keys: parse(row.workflow_keys_json, []), nodes: parse(row.nodes_json, []), required_edges: parse(row.required_edges_json, []),
    material_symbols: parse(row.material_symbols_json, []), transition: { adapter: row.transition_adapter, method: row.transition_method }, status: row.status
  }));
  const sourceMap = new Map(sourceEvidence.map((source, index) => [source.plan_step ?? `source_${index + 1}`, source]));
  const flowSelection = selectFlowEvidenceAdapter(registeredFlows, workflowKey, sourceMap);
  recordRunEvidence(db, runId, null, "flow_adapter_selection", { status: flowSelection.status, reason: flowSelection.reason, workflow_key: workflowKey, flow_key: flowSelection.flow?.key ?? null });
  const centered = claimCenteredReviewEvidence(workerResults, sourceEvidence, flowSelection.flow);
  const corpusClaims = corpusScans.map(scan => {
    const complete = scan.completeness === "complete" && scan.boundary?.authority === "registered_project_source_scope" && scan.boundary?.enumeration_complete === true;
    const edge = "claim->complete_corpus_scan";
    return {
      claim_id: `claim_${digest(scan.scan_id).slice(0, 16)}`, claim_type: "exact_corpus_scan",
      subject: scan.terms, target: scan.boundary?.source_scope_patterns ?? [], required_edges: [edge],
      observed_edges: complete ? [{ edge, status: "observed", provenance_refs: [scan.scan_id] }] : [],
      primary_evidence_refs: [scan.scan_id], contradicting_evidence_refs: [], graph_edge_refs: [], exact_scan_refs: [scan.scan_id],
      provenance: { scan_id: scan.scan_id, inventory_hash: scan.covered_files_ref, source_evidence_hash: scan.provenance?.source_evidence_hash },
      edge_coverage: [{ edge, status: complete ? "observed" : "unknown", provenance_refs: [scan.scan_id] }],
      coverage: complete ? "sufficient" : "incomplete", missing_edges: [], unknown_edges: complete ? [] : [edge]
    };
  });
  const verificationResults = db.prepare("SELECT evidence_hash,evidence_json FROM run_evidence WHERE run_id=? AND kind='targeted_verification_result' ORDER BY created_at,id").all(runId)
    .map(row => ({ evidence_hash: row.evidence_hash, ...parse(row.evidence_json, {}) }));
  const evidence = {
    schema_version: 1, type, owner_objective: ownerObjective(db, runId),
    flow_adapter_selection: { status: flowSelection.status, reason: flowSelection.reason, workflow_key: workflowKey, flow_key: flowSelection.flow?.key ?? null },
    canonical_completion: {
      blockers: completionBlockers(db, run.task_id, { excludeReviewDecisions: true }),
      review_reconsideration: "The active decision from the previous review cycle is intentionally excluded because this package supersedes it; all other completion blockers remain canonical."
    },
    planner_advisory: { completion_criteria: plan?.completion_criteria ?? [], authority: "advisory" },
    verification: { gate: gate ?? null, verification_results: verificationResults },
    change_evidence: type === "analytical" ? null : changes,
    analytical_evidence: type === "change" ? null : { decision_artifacts: decisionArtifacts, conclusions: centered.conclusions },
    claim_coverage: [...centered.claims, ...corpusClaims],
    cross_layer_chains: centered.cross_layer_chains,
    source_range_catalog: centered.source_range_catalog,
    exact_scan_catalog: [...new Map([...centered.exact_scan_catalog, ...corpusScans].map(scan => [scan.scan_id, scan])).values()],
    source_evidence: centered.source_evidence,
    artifacts: db.prepare("SELECT kind,uri,content_hash,status,provenance_json FROM artifacts WHERE run_id=? ORDER BY created_at").all(runId)
  };
  const compact = compactReviewEvidence(evidence, reviewEvidenceLimit);
  compact.base_evidence_hash = digest(JSON.stringify(compact));
  recordRunEvidence(db, runId, null, "review_base", compact);
  return compact;
}
