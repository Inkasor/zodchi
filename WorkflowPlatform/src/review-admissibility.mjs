const FACTUAL_CODE = /(?:MISSING|ABSENT|NO_|UNKNOWN|FALSE|INCOMPLETE|UNPROVEN|EVIDENCE|EDGE|CHAIN|PATH|GATE|SCAN|SOURCE|PROVENANCE)/i;
const ABSENCE_CLAIM = /(?:MISSING|ABSENT|NO_|NOT_FOUND|DOES_NOT_EXIST|НЕ\s+(?:НАЙДЕН|СУЩЕСТВУЕТ)|ОТСУТСТВ)/i;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function collectReferences(value, references = new Set()) {
  if (Array.isArray(value)) for (const item of value) collectReferences(item, references);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (/(?:^id$|_id$|_ref$|_refs$|hash$)/i.test(key)) {
      for (const candidate of Array.isArray(item) ? item : [item]) if (typeof candidate === "string" && candidate) references.add(candidate);
    }
    collectReferences(item, references);
  }
  return references;
}

function incompleteEvidence(reviewEvidence) {
  if (reviewEvidence?.evidence_compaction?.source_text_reduced || reviewEvidence?.evidence_compaction?.metadata_reduced) return true;
  const chains = reviewEvidence?.claim_coverage?.filter?.(claim => claim.claim_type === "cross_layer_chain") ?? [];
  return chains.some(claim => claim.coverage === "incomplete" || (claim.unknown_edges ?? []).length);
}

function structuredEvidencePath(reference) {
  if (typeof reference !== "string") return null;
  const match = reference.match(/^((?:task_package\.)?(?:review_evidence\.)?[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[(?:\d+|[A-Za-z_][A-Za-z0-9_]*)\]))*)(?:=([A-Za-z_][A-Za-z0-9_-]*|\d+|true|false|null))?(?=:|$)/);
  if (!match) return null;
  let value = match[1];
  if (value.startsWith("task_package.review_evidence.")) value = value.slice("task_package.review_evidence.".length);
  else if (value.startsWith("review_evidence.")) value = value.slice("review_evidence.".length);
  return { segments: value.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g), expected: match[2] ?? null };
}

function resolvesStructuredEvidence(reference, reviewEvidence) {
  const parsed = structuredEvidencePath(reference), segments = parsed?.segments;
  if (!segments?.length || segments.some(segment => FORBIDDEN_PATH_SEGMENTS.has(segment))) return false;
  let cursor = reviewEvidence;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return false;
    if (Array.isArray(cursor) && !/^\d+$/.test(segment)) {
      cursor = cursor.find(item => item && typeof item === "object" && ["id", "claim_id", "plan_step", "key", "edge", "scan_id", "range_id"].some(field => item[field] === segment));
      if (cursor === undefined) return false;
    } else {
      if (!Object.prototype.hasOwnProperty.call(Object(cursor), segment)) return false;
      cursor = cursor[segment];
    }
  }
  if (parsed.expected === null) return true;
  return String(cursor) === parsed.expected;
}

function referenceResolves(reference, known, reviewEvidence) {
  return known.has(reference) || resolvesStructuredEvidence(reference, reviewEvidence);
}

export function blockerAdmissibility(opinions, reviewEvidence) {
  const known = collectReferences(reviewEvidence);
  if (reviewEvidence?.base_evidence_hash) known.add(reviewEvidence.base_evidence_hash);
  const scans = new Map((reviewEvidence?.exact_scan_catalog ?? reviewEvidence?.source_evidence?.flatMap(item => item.files ?? []).map(file => file.exact_term_scan).filter(Boolean) ?? [])
    .filter(scan => scan?.scan_id).map(scan => [scan.scan_id, scan]));
  const boundedOrIncomplete = incompleteEvidence(reviewEvidence);
  return (opinions ?? []).flatMap(opinion => (opinion.result?.blockers ?? []).map((blocker, blockerIndex) => {
    const refs = [...new Set((opinion.result?.evidence_refs ?? []).filter(Boolean))];
    const resolvable = refs.filter(ref => referenceResolves(ref, known, reviewEvidence));
    const unresolvable = refs.filter(ref => !referenceResolves(ref, known, reviewEvidence));
    const factual = FACTUAL_CODE.test(`${blocker.code} ${blocker.message}`);
    let status = "supported", reason = factual ? "factual blocker has resolvable primary evidence" : "evaluative opinion is preserved for typed arbitration";
    if (!blocker?.code || !blocker?.message) { status = "invalid"; reason = "blocker lacks code or message"; }
    else if (factual && resolvable.some(ref => (scans.get(ref)?.occurrences ?? []).some(item => Number(item.count) > 0)) && /(?:MISSING|ABSENT|NO_|NOT_FOUND)/i.test(`${blocker.code} ${blocker.message}`)) {
      status = "contradicted"; reason = "a referenced complete exact scan contains the allegedly absent subject";
    }
    else if (factual && (!resolvable.length || unresolvable.length)) { status = "unknown"; reason = "factual blocker does not resolve entirely to supplied evidence"; }
    else if (factual && boundedOrIncomplete && ABSENCE_CLAIM.test(`${blocker.code} ${blocker.message}`)) {
      status = "unknown"; reason = "bounded, truncated or incomplete evidence cannot prove absence";
    }
    return {
      opinion_role: opinion.role,
      blocker_index: blockerIndex,
      blocker,
      blocker_kind: factual ? "factual" : "evaluative",
      status,
      resolvable_evidence_refs: resolvable,
      unresolvable_evidence_refs: unresolvable,
      deterministic_facts: {
        evidence_compacted: Boolean(reviewEvidence?.evidence_compaction?.source_text_reduced || reviewEvidence?.evidence_compaction?.metadata_reduced),
        evidence_incomplete: boundedOrIncomplete
      },
      reason
    };
  }));
}

export function admissibleOpinionDecision(opinion, admissibility) {
  if (opinion.result?.decision === "PASS") return "PASS";
  const supported = admissibility.filter(item => item.opinion_role === opinion.role && item.status === "supported");
  return supported.length ? opinion.result.decision : "PASS";
}

export function hasSupportedFactualBlocker(admissibility) {
  return (admissibility ?? []).some(item => item.blocker_kind === "factual" && item.status === "supported");
}
