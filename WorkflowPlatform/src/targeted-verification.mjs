function normalized(value) { return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase(); }
function samePath(left, right) { return normalized(left) === normalized(right); }

export function validateVerificationRequest(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("VERIFICATION_REQUEST_INVALID: object required");
  const fields = ["kind", "subject", "from", "to", "path", "evidence_refs"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields.sort())) throw new Error("VERIFICATION_REQUEST_INVALID: fields mismatch");
  if (!["symbol_reference", "exact_term", "directed_relation", "field_flow", "path_change", "gate_fact"].includes(value.kind) || typeof value.subject !== "string" || !value.subject.trim()) throw new Error("VERIFICATION_REQUEST_INVALID: scalar field");
  if (!Array.isArray(value.evidence_refs) || value.evidence_refs.some(item => typeof item !== "string" || !item.trim())) throw new Error("VERIFICATION_REQUEST_INVALID: evidence_refs");
  return value;
}

function scanVerification(request, evidence) {
  const scans = evidence?.exact_scan_catalog ?? [];
  const candidates = scans.filter(scan => !request.path || samePath(scan.path, request.path));
  const occurrences = candidates.flatMap(scan => (scan.occurrences ?? []).filter(item => String(item.term).toLowerCase() === request.subject.toLowerCase()).map(item => ({ scan, occurrence: item })));
  const observed = occurrences.filter(item => Number(item.occurrence.count) > 0);
  if (observed.length) return { status: "observed", evidence_refs: observed.map(item => item.scan.scan_id).filter(Boolean), facts: observed.map(item => ({ path: item.scan.path ?? null, scope: item.scan.scope, count: item.occurrence.count, matched_lines: item.occurrence.matched_lines, matched_files: item.occurrence.matched_files ?? null })) };
  const completeCorpus = occurrences.filter(item => !request.path
    && item.scan.scope === "complete_corpus"
    && item.scan.completeness === "complete"
    && item.scan.boundary?.authority === "registered_project_source_scope"
    && item.scan.boundary?.enumeration_complete === true
    && Number(item.occurrence.count) === 0);
  if (completeCorpus.length) return { status: "missing", evidence_refs: completeCorpus.map(item => item.scan.scan_id).filter(Boolean), facts: completeCorpus.map(item => ({ path: null, count: 0, scope: item.scan.scope, boundary: item.scan.boundary })) };
  const complete = occurrences.filter(item => item.scan.scope === "complete_file" && Number(item.occurrence.count) === 0);
  if (complete.length && (!request.path || candidates.length === complete.length)) return { status: "missing", evidence_refs: complete.map(item => item.scan.scan_id).filter(Boolean), facts: complete.map(item => ({ path: item.scan.path, count: 0, scope: item.scan.scope })) };
  return { status: "unknown", evidence_refs: [], facts: [{ searched_scans: candidates.length, reason: "no complete conclusive scan for the requested subject and boundary" }] };
}

function relationVerification(request, evidence) {
  const expected = request.from && request.to ? `${request.from}->${request.to}` : request.subject;
  const edges = (evidence?.cross_layer_chains ?? []).flatMap(chain => chain.edge_coverage ?? []).filter(edge => edge.edge === expected);
  const observed = edges.find(edge => edge.status === "observed" && (edge.provenance_refs ?? []).length);
  if (observed) return { status: "observed", evidence_refs: observed.provenance_refs, facts: [observed] };
  const missing = edges.find(edge => edge.status === "missing" && (edge.provenance_refs ?? []).length);
  if (missing) return { status: "missing", evidence_refs: missing.provenance_refs, facts: [missing] };
  return { status: "unknown", evidence_refs: edges.flatMap(edge => edge.provenance_refs ?? []), facts: edges.length ? edges : [{ edge: expected, reason: "bounded graph or source packet is not conclusive" }] };
}

function pathVerification(request, evidence) {
  if (!request.path) return { status: "unknown", evidence_refs: [], facts: [{ reason: "path is required" }] };
  const change = evidence?.change_evidence;
  const found = (change?.roots ?? []).some(root => (root.run_changed_paths ?? []).some(item => samePath(item, request.path)));
  if (found) return { status: "observed", evidence_refs: [], facts: [{ path: request.path, changed: true }] };
  const complete = (change?.roots ?? []).length > 0 && (change.roots ?? []).every(root => root.change_detection?.complete === true);
  return complete ? { status: "missing", evidence_refs: [], facts: [{ path: request.path, changed: false, detection_complete: true }] } : { status: "unknown", evidence_refs: [], facts: [{ path: request.path, reason: "change detection incomplete" }] };
}

function gateVerification(request, evidence) {
  const checks = evidence?.verification?.gate?.checks ?? [];
  const check = checks.find(item => item.id === request.subject || item.name === request.subject);
  if (!check) return { status: "unknown", evidence_refs: [], facts: [{ reason: "gate fact is not registered in the supplied gate" }] };
  return { status: "observed", evidence_refs: [], facts: [{ id: check.id, required: check.required, status: check.status, exit_code: check.exit_code }] };
}

export function executeTargetedVerification(requestValue, evidence) {
  const request = validateVerificationRequest(structuredClone(requestValue));
  const result = request.kind === "symbol_reference" || request.kind === "exact_term"
    ? scanVerification(request, evidence)
    : request.kind === "directed_relation" || request.kind === "field_flow"
    ? relationVerification(request, evidence)
    : request.kind === "path_change"
    ? pathVerification(request, evidence)
    : gateVerification(request, evidence);
  return { schema_version: 1, request, status: result.status, evidence_refs: [...new Set(result.evidence_refs)], facts: result.facts, bounded: true };
}
