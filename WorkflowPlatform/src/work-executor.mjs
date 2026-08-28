import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { id, now } from "./db.mjs";
import { ExecutionQueue } from "./execution-queue.mjs";
import { BudgetManager, invokeWithinBudget } from "./budget.mjs";
import { applyRegisteredPatch, documentVersion } from "./documentator.mjs";
import { registeredProjectCheckKeys, runProjectGate } from "./gates.mjs";
import { selectProjectContext } from "./document-context.mjs";
import { collectGitHistory, collectSourceFiles, expandTerms, inventorySummary, scanSourceCorpus, searchSources, sourceScope } from "./source-context.mjs";
import { buildCodeIntelligence, mergeGraphMatches } from "./code-intelligence.mjs";
import { projectRoots, writableRoots } from "./project-roots.mjs";
import { normalizeResourceDeclaration } from "./resource-locks.mjs";
import { loadRoleContract, parseRoleReceipt, rolePrompt, structuredHash } from "./role-contracts.mjs";
import { WORKTREE_ALIAS, aliasDeclarations, registeredResources as registeredProjectResources } from "./project-resources.mjs";
import { consumeCorrectionCycle, documentationOutcome, loadOperationalPolicy, loadQualityContract, operationalLevel, reviewerRequirement } from "./quality-contracts.mjs";
import { buildReviewEvidence, captureRunBaselines, recordRunEvidence, runChangeEvidence } from "./run-evidence.mjs";
import { applyRunControlAtBoundary, pendingRunControl, recordProgressSnapshot, semanticGapFingerprint } from "./progress-supervisor.mjs";
import { blockerAdmissibility, admissibleOpinionDecision, hasSupportedFactualBlocker } from "./review-admissibility.mjs";
import { executeTargetedVerification } from "./targeted-verification.mjs";
import { documentTermScore, rankTerms } from "./term-ranking.mjs";
import { utf8Prefix } from "./utf8.mjs";
import { openClarification, openExternalEvidenceRequest, quiesceRun } from "./interactions.mjs";
import { currentApprovalBinding } from "./approval-binding.mjs";

function hashFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }

function selectedWorkflowContract(db, projectId, workflowId) {
  const rows = db.prepare("SELECT * FROM workflow_step_templates WHERE project_id=? AND workflow_id=? ORDER BY ordinal").all(projectId, workflowId);
  if (!rows.length) return null;
  const workerSteps = rows.filter(row => row.role_id && row.output_schema_key === "worker.v1");
  // A step named for testing is the verification phase's own work and must not become a worker step
  // as well. That is a refinement, not a way to empty a route: a workflow whose whole purpose is to
  // run the registered checks names every step that way, and filtering left it with nothing to run.
  const named = workerSteps.filter(row => !/(?:^|_)(?:test|tests|checks|verify|verification|preflight|review)(?:$|_)/.test(row.step_key));
  const productive = named.length ? named : workerSteps;
  const approvalIndex = rows.findIndex(row => row.irreversible && !row.role_id);
  const productiveAfterApproval = approvalIndex < 0 ? [] : productive.filter(row => row.ordinal > rows[approvalIndex].ordinal);
  const productiveBeforeApproval = productive.filter(row => approvalIndex < 0 || row.ordinal < rows[approvalIndex].ordinal);
  const workerRoles = [...new Set(productiveBeforeApproval.map(row => row.role_id))];
  const checks = [...new Set(rows.flatMap(row => parseJson(row.check_keys_json, [])))];
  return {
    workflow_id: workflowId,
    rows,
    worker_steps: productiveBeforeApproval,
    worker_roles: workerRoles,
    // The roles a route may execute depend on which side of the owner's decision the run is on. Only the
    // steps before it were ever named, so a granted approval used to leave the route with nothing to run.
    worker_steps_after_approval: productiveAfterApproval,
    worker_roles_after_approval: [...new Set(productiveAfterApproval.map(row => row.role_id))],
    check_keys: checks,
    // A workflow that declares no planning step has nothing to drive execution from: the plan is what
    // names the steps, their roles, paths and checks. Falling back to a literal role name hid that as a
    // missing-role error in whichever package happened to use different names.
    planner_role: rows.find(row => row.output_schema_key === "planner.v1")?.role_id ?? null,
    reviewer_role: rows.find(row => row.output_schema_key === "reviewer.v1")?.role_id ?? "reviewer",
    documentator_role: rows.find(row => row.output_schema_key === "documentator.v1")?.role_id ?? "documentator",
    approval: approvalIndex < 0 ? null : { step_key: rows[approvalIndex].step_key, before_productive_work: productiveAfterApproval.length > 0 }
  };
}

// A workflow that declares its steps has already been planned: its author named the roles, the order,
// the artifact types and the checks. Asking a model to invent that again is what let a plan name steps
// the route does not have. A declared planning step still runs, because a change needs paths and
// objectives that only the message can supply; a route without one is executed as it was declared.
// Nothing here can produce an allowed path, so a route whose workers may write must declare planning.
function derivePlanFromTemplates(runtime, projectId, contract, message, registeredChecks, level, documentRequired, documentatorRole, afterApproval) {
  const artifacts = [];
  const steps = (afterApproval && contract.worker_steps_after_approval.length ? contract.worker_steps_after_approval : contract.worker_steps).map(row => {
    const tools = loadRoleContract(runtime.db, projectId, row.role_id, level).allowed_tools;
    if (tools.length) throw new Error(`WORKFLOW_WRITING_STEP_REQUIRES_PLANNING: ${contract.workflow_id}:${row.step_key}`);
    const keys = parseJson(row.artifact_types_json, []).map(type => {
      const key = `${row.step_key}.${type}`;
      artifacts.push({ key, type, path: null, required: false });
      return key;
    });
    return { key: row.step_key, role: row.role_id, objective: message, allowed_paths: [], artifact_keys: keys, check_ids: parseJson(row.check_keys_json, []).filter(check => registeredChecks.includes(check)), resources: parseJson(row.resources_json, []), required: row.required === 1, irreversible: row.irreversible === 1, max_attempts: (parseJson(row.correction_json, {}).max_cycles ?? 0) + 1 };
  });
  if (documentRequired) {
    // The documentation phase resolves its target from the plan, so a declared route still has to say
    // which registered document the run must change. One writable document is an answer; several are
    // the same ambiguity a planner would have had to settle, and it is reported as such.
    const writable = runtime.db.prepare(`SELECT pd.path FROM project_documents pd JOIN role_documents rd ON rd.document_id=pd.id AND rd.project_id=pd.project_id
      WHERE pd.project_id=? AND rd.role_id=? AND rd.write_access=1 AND pd.active=1 ORDER BY pd.path`).all(projectId, documentatorRole);
    if (writable.length !== 1) throw new Error(`WORKFLOW_REQUIRED_DOCUMENT_NEEDS_PLANNING: ${contract.workflow_id} must declare a planning step to choose among the ${writable.length} documents ${documentatorRole} may write`);
    artifacts.push({ key: "required_document", type: "document", path: writable[0].path, required: true });
  }
  return { schema_version: 1, outcome: "ready", scope: { included: [message], excluded: [] }, allowed_paths: [], inputs: [], checks: registeredChecks, risks: [], artifacts, completion_criteria: [], questions: [], steps };
}

function approvalQuestion(contract, responseLanguage) {
  return responseLanguage === "ru"
    ? `Этот маршрут содержит отдельное действие владельца «${contract.approval.step_key}». Подтверждение нужно получить до продолжения.`
    : `This workflow contains a separate owner action, "${contract.approval.step_key}". Confirmation is required before continuing.`;
}

function requireWorkflowApproval(runtime, runId, contract, responseLanguage) {
  const taskId = runtime.get(runId).task_id;
  const question = approvalQuestion(contract, responseLanguage);
  const binding = currentApprovalBinding(runtime.db, runId, contract.approval.step_key);
  runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at,detail_json,binding_hash,binding_json) VALUES(?,?,?,'workflow_approval',?,'pending',?,?,?,?)")
    .run(id("approval"), taskId, runId, question, now(), JSON.stringify({ action_step_key: contract.approval.step_key, binding_hash: binding.hash }), binding.hash, JSON.stringify(binding.value));
  runtime.setState(runId, "approval_required", { reason: `workflow approval required: ${contract.approval.step_key}` });
  return { status: "approval_required", questions: [question], workflow_approval: contract.approval.step_key, approval_binding_hash: binding.hash };
}

function promptBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }

function compactCodeIntelligenceEvidence(sourceMatches) {
  const intelligence = sourceMatches?.code_intelligence;
  if (!intelligence) return null;
  return {
    schema_version: intelligence.schema_version,
    strategy: intelligence.strategy,
    adapters: intelligence.adapters,
    completeness: intelligence.completeness,
    statistics: intelligence.statistics
  };
}

function reviewCodeIntelligenceEvidence(sourceMatches) {
  const intelligence = sourceMatches?.code_intelligence;
  if (!intelligence) return null;
  return {
    ...compactCodeIntelligenceEvidence(sourceMatches),
    nodes: (intelligence.nodes ?? []).slice(0, 40).map(node => ({ id: node.id, kind: node.kind, name: node.name, path: node.path, start_line: node.start_line, end_line: node.end_line, reasons: node.reasons ?? [] })),
    edges: (intelligence.edges ?? []).slice(0, 80).map(edge => ({ id: edge.id ?? null, from: edge.from, to: edge.to, type: edge.type }))
  };
}

export function compactCorpusExactScan(scan, { intent = null } = {}) {
  if (!scan) return null;
  const normalizedIntent = intent === null ? null : String(intent).toLowerCase();
  const occurrences = normalizedIntent === null
    ? (scan.occurrences ?? [])
    : (scan.occurrences ?? []).filter(item => normalizedIntent.includes(String(item.term ?? "").toLowerCase()));
  // A corpus scan is run-wide evidence. A worker receives only the claims its package asks it to
  // inspect; otherwise one broad owner request makes every unrelated/pathless step carry every
  // occurrence and every per-partition fact as mandatory context.
  if (normalizedIntent !== null && occurrences.length === 0) return null;
  return {
    scan_id: scan.scan_id, scope: scan.scope, match: scan.match, terms: occurrences.map(item => item.term),
    completeness: scan.completeness, boundary: scan.boundary,
    occurrences: occurrences.map(item => ({ ...item, locations: (item.locations ?? []).slice(0, 4), locations_truncated: item.locations_truncated || (item.locations ?? []).length > 4 })),
    covered_files_ref: scan.provenance?.inventory_hash ?? null,
    provenance: scan.provenance
  };
}

function recordCorpusExactScan(runtime, runId, stepId, scan) {
  const { covered_files: coveredFiles = [], ...header } = scan;
  const chunkSize = 500, chunkCount = Math.ceil(coveredFiles.length / chunkSize);
  for (let index = 0; index < chunkCount; index += 1) recordRunEvidence(runtime.db, runId, stepId, "corpus_exact_scan_inventory_chunk", {
    scan_id: scan.scan_id, inventory_hash: scan.provenance?.inventory_hash ?? null,
    chunk_index: index, chunk_count: chunkCount, files: coveredFiles.slice(index * chunkSize, (index + 1) * chunkSize)
  });
  const stored = { ...header, inventory: { hash: scan.provenance?.inventory_hash ?? null, file_count: coveredFiles.length, chunk_count: chunkCount, evidence_kind: "corpus_exact_scan_inventory_chunk" } };
  recordRunEvidence(runtime.db, runId, stepId, "corpus_exact_scan", stored);
  return stored;
}

function reusableCorpusExactScan(runtime, runId, discovery, subject) {
  const expectedScope = JSON.stringify([...(discovery.source_scope ?? [])]), expectedRoots = JSON.stringify((discovery.roots ?? []).map(root => ({ key: root.key, access: root.access })));
  const projectId = runtime.get(runId).project_id;
  for (const row of runtime.db.prepare("SELECT evidence_json,created_at FROM run_evidence WHERE run_id=? AND kind='corpus_exact_scan' ORDER BY created_at DESC,id DESC").all(runId)) {
    const scan = parseJson(row.evidence_json, null);
    if (!scan?.scan_id || scan.completeness !== "complete" || scan.boundary?.authority !== "registered_project_source_scope" || scan.boundary?.enumeration_complete !== true) continue;
    if (!scan.terms?.some(term => term.toLowerCase() === subject.toLowerCase())) continue;
    if (JSON.stringify(scan.boundary.source_scope_patterns ?? []) !== expectedScope) continue;
    if (JSON.stringify((scan.provenance?.roots ?? []).map(root => ({ key: root.key, access: root.access }))) !== expectedRoots) continue;
    // A completed worker after the snapshot may have changed source. Read-only work is conservatively
    // treated the same way because proving that it did not mutate would cost more than one fresh scan.
    const laterWorker = runtime.db.prepare(`SELECT 1 FROM attempts a
      JOIN workflow_steps ws ON ws.id=a.step_id
      JOIN role_contracts rc ON rc.project_id=? AND rc.role_id=ws.role_id AND rc.result_schema_key='worker.v1' AND rc.status='active'
      WHERE ws.run_id=? AND a.state='succeeded' AND a.finished_at>? LIMIT 1`).get(projectId, runId, row.created_at);
    if (!laterWorker) return scan;
  }
  return null;
}

export function executeVerificationWithCorpusFallback({ request, evidence, discovery, runtime, runId, stepId }) {
  let verification = executeTargetedVerification(request, evidence ?? {});
  if (verification.status !== "unknown" || request.path || !["symbol_reference", "exact_term"].includes(request.kind)) return verification;
  if (request.subject.length < 4) return { ...verification, facts: [{ reason: "corpus scan requires an exact subject of at least four characters", subject_length: request.subject.length }], scan_skipped: "subject_too_short" };
  const reusable = reusableCorpusExactScan(runtime, runId, discovery, request.subject);
  if (reusable) {
    const reused = executeTargetedVerification(request, { ...(evidence ?? {}), exact_scan_catalog: [...(evidence?.exact_scan_catalog ?? []), compactCorpusExactScan(reusable)] });
    if (reused.status !== "unknown") return { ...reused, reused_evidence_ref: reusable.scan_id };
  }
  const scan = scanSourceCorpus(discovery.roots ?? [], sourceScope(discovery.source_scope), [request.subject]);
  const stored = recordCorpusExactScan(runtime, runId, stepId, scan);
  const augmented = { ...(evidence ?? {}), exact_scan_catalog: [...(evidence?.exact_scan_catalog ?? []), compactCorpusExactScan(stored)] };
  verification = executeTargetedVerification(request, augmented);
  return { ...verification, generated_evidence_refs: [scan.scan_id] };
}

// Search results are already ranked best-first. When their independent collection caps add up to more
// than a role can receive, discard the least relevant evidence first and keep the highest-ranked path.
// The inventory is structural context, so counts per area replace hundreds of path/size records; paths
// proven relevant by the two-pass search remain in source_matches.
export function fitSourceEvidence(context, limit, measure = promptBytes) {
  if (Array.isArray(context.source_inventory)) context.source_inventory = inventorySummary(context.source_inventory);
  const refresh = () => measure(context);
  while (refresh() > limit && Array.isArray(context.decisions) && context.decisions.length) context.decisions.shift();
  const result = context.source_matches;
  if (!result || !Array.isArray(result.files)) return context;
  const originalFiles = result.files.length;
  const intelligence = result.code_intelligence;
  // Global graph rows duplicate the path-local summaries already attached to ranked files. Compact that
  // supporting detail before dropping the actual matching paths and lines the planner needs to assign
  // work. 0.4.0 did this in the opposite order and could reduce forty results to one noisy file.
  while (refresh() > limit && Array.isArray(intelligence?.edges) && intelligence.edges.length) intelligence.edges.pop();
  while (refresh() > limit && Array.isArray(intelligence?.nodes) && intelligence.nodes.length > 8) intelligence.nodes.pop();
  while (refresh() > limit && Array.isArray(intelligence?.ranked_files) && intelligence.ranked_files.length > 8) intelligence.ranked_files.pop();
  // Adapter transition catalogs are valuable to claim review after source collection, but they are
  // duplicate global detail in a planner locator packet. Remove them before shortening the compact
  // exact-term path index: those proven paths are what let the planner assign the next collection.
  for (const adapter of intelligence?.adapters ?? []) {
    while (refresh() > limit && Array.isArray(adapter.transitions) && adapter.transitions.length) {
      adapter.transitions.pop(); adapter.transitions_truncated = true;
    }
    while (refresh() > limit && Array.isArray(adapter.diagnostics) && adapter.diagnostics.length) {
      adapter.diagnostics.pop(); adapter.diagnostics_truncated = true;
    }
  }
  for (let index = result.files.length - 1; refresh() > limit && index >= 0; index -= 1) {
    const nodes = result.files[index].graph?.nodes;
    while (refresh() > limit && Array.isArray(nodes) && nodes.length > 2) nodes.pop();
  }
  for (let index = result.files.length - 1; refresh() > limit && index >= 0; index -= 1) {
    const matches = result.files[index].matches;
    while (refresh() > limit && Array.isArray(matches) && matches.length > 2) matches.pop();
  }
  while (refresh() > limit && Array.isArray(result.exact_term_index)) {
    const candidate = result.exact_term_index.filter(item => Array.isArray(item.paths) && item.paths.length > 8)
      .sort((left, right) => right.paths.length - left.paths.length || left.term.localeCompare(right.term, "en"))[0];
    if (!candidate) break;
    candidate.paths.pop();
    candidate.paths_truncated = true;
    candidate.retained_paths = candidate.paths.length;
  }
  while (refresh() > limit && result.files.length > 6) {
    result.files.pop();
    result.truncated = true;
    result.budget_truncation = { retained_files: result.files.length, omitted_files: originalFiles - result.files.length };
  }
  for (let index = result.files.length - 1; refresh() > limit && index >= 0; index -= 1) {
    const matches = result.files[index].matches, nodes = result.files[index].graph?.nodes;
    while (refresh() > limit && Array.isArray(matches) && matches.length > 1) matches.pop();
    while (refresh() > limit && Array.isArray(nodes) && nodes.length > 1) nodes.pop();
  }
  while (refresh() > limit && result.files.length > 1) {
    result.files.pop();
    result.truncated = true;
    result.budget_truncation = { retained_files: result.files.length, omitted_files: originalFiles - result.files.length };
  }
  if (intelligence && refresh() > limit) intelligence.prompt_truncated = true;
  // Keep the best path even under an unusually small envelope; matching lines are supporting detail and
  // can be reduced without losing where the proven hit lives.
  const best = result.files[0];
  while (refresh() > limit && Array.isArray(best?.matches) && best.matches.length > 1) best.matches.pop();
  // The locator packet can still overflow after all result files except the best one have gone away.
  // exact_term_index and code-intelligence summaries are global catalogs, so their independent caps
  // can dominate a small planner contract even though the one proven path is already sufficient to
  // assign a source-bearing step. Keep that path and progressively reduce only duplicate catalogs.
  while (refresh() > limit && Array.isArray(result.exact_term_index) && result.exact_term_index.length > 1) {
    result.exact_term_index.pop();
    result.exact_term_index_truncated = true;
  }
  const exact = result.exact_term_index?.[0];
  while (refresh() > limit && Array.isArray(exact?.paths) && exact.paths.length > 1) {
    exact.paths.pop(); exact.paths_truncated = true; exact.retained_paths = exact.paths.length;
  }
  while (refresh() > limit && Array.isArray(intelligence?.edges) && intelligence.edges.length) intelligence.edges.pop();
  while (refresh() > limit && Array.isArray(intelligence?.nodes) && intelligence.nodes.length) intelligence.nodes.pop();
  while (refresh() > limit && Array.isArray(intelligence?.ranked_files) && intelligence.ranked_files.length) intelligence.ranked_files.pop();
  while (refresh() > limit && Array.isArray(result.terms) && result.terms.length > 1) result.terms.pop();
  for (const key of ["request_words", "identifiers"]) {
    const values = result.derived_from?.[key];
    while (refresh() > limit && Array.isArray(values) && values.length > 1) values.pop();
  }
  return context;
}

export function compactPriorWorkerResults(results, maxBytes = 16_000) {
  const items = [];
  for (const result of results ?? []) {
    const item = {
      plan_step: result.plan_step ?? null,
      status: result.status,
      summary: utf8Prefix(result.summary, 2000),
      evidence: [],
      artifacts: result.artifacts ?? []
    };
    for (const evidence of result.evidence ?? []) {
      const candidate = { ...item, evidence: [...item.evidence, utf8Prefix(evidence, 2000)] };
      if (Buffer.byteLength(JSON.stringify({ items: [...items, candidate] })) > maxBytes) break;
      item.evidence = candidate.evidence;
    }
    if (Buffer.byteLength(JSON.stringify({ items: [...items, item] })) > maxBytes) break;
    items.push(item);
  }
  return { items, retained_results: items.length, total_results: results?.length ?? 0, truncated: items.length < (results?.length ?? 0) };
}

export function priorWorkerResultsForStep(results, stepKey, correctionReview = null) {
  if (!correctionReview) return results ?? [];
  // A correction already carries the review gap. Repeating every earlier worker narrative starves the
  // exact source ranges the reviewer asked to inspect. Keep only the latest result of this targeted step;
  // the immutable review package remains the cross-step synthesis authority.
  return (results ?? []).filter(result => result.plan_step === stepKey).slice(-1);
}

export function preDocumentationTelemetry(db, runId) {
  const calls = db.prepare("SELECT role_id,receipt_id,input_tokens,cached_tokens,output_tokens,reasoning_tokens,duration_ms FROM gateway_calls WHERE run_id=? ORDER BY started_at,id").all(runId);
  const tokens = calls.reduce((total, call) => {
    total.input += Number(call.input_tokens) || 0;
    total.cached += Number(call.cached_tokens) || 0;
    total.output += Number(call.output_tokens) || 0;
    total.reasoning += Number(call.reasoning_tokens) || 0;
    return total;
  }, { input: 0, cached: 0, output: 0, reasoning: 0 });
  const run = db.prepare("SELECT created_at FROM workflow_runs WHERE id=?").get(runId);
  const promptMeasurements = db.prepare("SELECT evidence_json,evidence_hash FROM run_evidence WHERE run_id=? AND kind='role_prompt_metrics' ORDER BY created_at").all(runId)
    .map(row => ({ ...parseJson(row.evidence_json, {}), provenance_hash: row.evidence_hash }));
  const gates = db.prepare("SELECT kind,status,details_json FROM gates WHERE run_id=? ORDER BY rowid").all(runId).map(row => {
    const details = parseJson(row.details_json, {});
    return { kind: row.kind, status: row.status, checks: (details.checks ?? []).map(check => ({ id: check.id, status: check.status, required: check.required, duration_ms: check.duration_ms ?? null })) };
  });
  return {
    scope: "pre_documentation_snapshot",
    lifecycle_note: "Final state, total duration and the documentator receipt are appended by platform run statistics after this document proposal is applied.",
    calls: calls.length,
    receipts: calls.map(call => ({ role: call.role_id, receipt_id: call.receipt_id, duration_ms: call.duration_ms })),
    tokens,
    elapsed_ms: run?.created_at ? Math.max(0, Date.now() - Date.parse(run.created_at)) : null,
    prompt_measurements: promptMeasurements,
    gates
  };
}

function fitWorkerSources(context, limit, measure) {
  const files = context.sources?.files;
  if (!Array.isArray(files)) return context;
  for (let index = files.length - 1; measure(context) > limit && index >= 0; index -= 1) {
    const file = files[index], text = String(file.text ?? "");
    if (!text) continue;
    const overflow = measure(context) - limit;
    file.text = utf8Prefix(text, Math.max(0, Buffer.byteLength(text) - overflow - 256));
    file.supplied_bytes = Buffer.byteLength(file.text);
    file.truncated = true;
    file.prompt_truncated = true;
  }
  context.sources.bytes = files.reduce((total, file) => total + Buffer.byteLength(String(file.text ?? "")), 0);
  return context;
}

function boundedContext(discovery, roleId, classification, limit, responseLanguage, supplied = {}) {
  const selected = selectProjectContext(discovery, classification, [], null, discovery.project.id, roleId);
  const context = {
    project: { id: discovery.project.id, name: discovery.project.name },
    // Where the roots are and what each one grants is the first thing a role needs and the cheapest
    // thing to send: without it the role knows a second directory exists only when a document happens
    // to name it, and cannot tell a directory it may change from one it may only read.
    roots: (discovery.roots ?? []).map(root => ({ key: root.key, path: root.path, access: root.access, primary: root.primary })),
    role_id: roleId, response_language: responseLanguage, documents: [], decisions: discovery.decisions, pending_interactions: discovery.pending_interactions,
    // Collection is what a role reads the project with. A planner is given the inventory so it can name
    // the paths the work needs; a worker is given the contents of the paths the plan allowed. Neither
    // opens a file itself, so the same plan against the same tree produces the same invocation.
    ...supplied
  };
  fitSourceEvidence(context, limit);
  let used = promptBytes(context);
  for (const document of selected.documents) {
    const remaining = limit - used;
    if (remaining <= 256) break;
    const item = { id: document.id, path: document.path, authority: document.authority, version: document.content_hash ?? null, text: utf8Prefix(document.text, Math.max(0, remaining - 256)) };
    context.documents.push(item);
    used = Buffer.byteLength(JSON.stringify(context));
  }
  return context;
}

function storeStepPayload(db, stepId, contract, resultSchemaKey, result = null) {
  db.prepare("UPDATE workflow_steps SET contract_json=?,result_schema_key=?,result_json=?,updated_at=? WHERE id=?")
    .run(JSON.stringify(contract), resultSchemaKey, result ? JSON.stringify(result) : null, now(), stepId);
}

function promptWithinContract(contract, qualityContract, packageContract, context, schemaKey) {
  const fitted = structuredClone(context ?? {});
  const fixedPromptFloorBytes = Buffer.byteLength(rolePrompt({ contract, qualityContract, packageContract: {}, context: {}, resultSchema: schemaKey }));
  const mandatoryContext = Object.fromEntries(Object.entries(fitted).filter(([key]) => !new Set(["documents", "decisions", "pending_interactions", "source_inventory", "source_matches", "sources"]).has(key)));
  const mandatoryContextFloorBytes = Buffer.byteLength(rolePrompt({ contract, qualityContract, packageContract, context: mandatoryContext, resultSchema: schemaKey }));
  const floorError = (code, measured) => {
    const error = new Error(`${code}: role envelope is ${measured}/${contract.context_limit_bytes} bytes`);
    error.prompt_metrics = {
      prompt_bytes: measured,
      context_limit_bytes: contract.context_limit_bytes,
      fixed_prompt_floor_bytes: fixedPromptFloorBytes,
      mandatory_context_floor_bytes: mandatoryContextFloorBytes,
      dynamic_context_bytes: 0
    };
    return error;
  };
  if (fixedPromptFloorBytes > contract.context_limit_bytes) throw floorError("ROLE_CONTEXT_FLOOR_EXCEEDED", fixedPromptFloorBytes);
  if (mandatoryContextFloorBytes > contract.context_limit_bytes) throw floorError("ROLE_CONTEXT_MINIMUM_UNSATISFIABLE", mandatoryContextFloorBytes);
  let prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  // History gives way before authority. Registered documents are what a role reasons from, while
  // decisions accumulate with every run, so trimming documents first would drop the authority to keep
  // an ever-growing log and the role would fail on a project purely because it had been used a lot.
  while (Buffer.byteLength(prompt) > contract.context_limit_bytes && Array.isArray(fitted.decisions) && fitted.decisions.length) {
    fitted.decisions.shift();
    prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  }
  fitSourceEvidence(fitted, contract.context_limit_bytes, value => Buffer.byteLength(rolePrompt({ contract, qualityContract, packageContract, context: value, resultSchema: schemaKey })));
  prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  while (Buffer.byteLength(prompt) > contract.context_limit_bytes && Array.isArray(fitted.documents) && fitted.documents.length) {
    const overflow = Buffer.byteLength(prompt) - contract.context_limit_bytes;
    const document = fitted.documents.at(-1), text = String(document.text ?? "");
    if (Buffer.byteLength(text) > overflow + 512) document.text = utf8Prefix(text, Math.max(0, Buffer.byteLength(text) - overflow - 256));
    else fitted.documents.pop();
    prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  }
  fitWorkerSources(fitted, contract.context_limit_bytes, value => Buffer.byteLength(rolePrompt({ contract, qualityContract, packageContract, context: value, resultSchema: schemaKey })));
  prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  if (Buffer.byteLength(prompt) > contract.context_limit_bytes) {
    const error = new Error(`ROLE_CONTEXT_DYNAMIC_OVERFLOW: compacted role envelope is ${Buffer.byteLength(prompt)}/${contract.context_limit_bytes} bytes`);
    error.prompt_metrics = {
      prompt_bytes: Buffer.byteLength(prompt),
      context_limit_bytes: contract.context_limit_bytes,
      fixed_prompt_floor_bytes: fixedPromptFloorBytes,
      mandatory_context_floor_bytes: mandatoryContextFloorBytes,
      dynamic_context_bytes: Math.max(0, Buffer.byteLength(prompt) - mandatoryContextFloorBytes),
      project_context_bytes: Buffer.byteLength(JSON.stringify(fitted)),
      task_package_bytes: Buffer.byteLength(JSON.stringify(packageContract ?? {})),
      document_bytes: Buffer.byteLength(JSON.stringify(fitted.documents ?? [])),
      source_inventory_bytes: Buffer.byteLength(JSON.stringify(fitted.source_inventory ?? [])),
      source_matches_bytes: Buffer.byteLength(JSON.stringify(fitted.source_matches ?? null))
    };
    throw error;
  }
  return prompt;
}

function roleBudgetRequest(runtime, runId, stepId, roleId, attemptId, contract, callKey) {
  const task = runtime.getTask(runId);
  const manager = new BudgetManager(runtime.db);
  // max_calls bounds one role assignment, not every independent plan step that happens to use the same
  // role. The workflow and task scopes still cap the whole run; the step-qualified role scope prevents
  // retries inside one assignment from becoming unbounded without starving later analyst packages.
  const roleScope = `${runId}:${stepId}:${roleId}`;
  manager.define({ scopeType: "role", scopeId: roleScope, metric: "calls", limit: contract.max_calls });
  manager.define({ scopeType: "attempt", scopeId: attemptId, metric: "calls", limit: 1 });
  return {
    manager,
    request: {
      scopes: [
        { type: "project", id: task.project_id }, { type: "task", id: task.id }, { type: "workflow", id: runId },
        { type: "role", id: roleScope }, { type: "attempt", id: attemptId }
      ],
      metric: "calls", amount: 1, idempotencyKey: callKey, taskId: task.id, runId, reason: `role:${roleId}`
    }
  };
}

async function controlledGatewayReceipt(runtime, queue, runId, invocation) {
  if (!invocation || typeof invocation.then !== "function") return invocation;
  let settled = false;
  const result = Promise.resolve(invocation).finally(() => { settled = true; });
  while (!settled) {
    const winner = await Promise.race([result.then(value => ({ type: "receipt", value }), error => ({ type: "error", error })), new Promise(resolve => setTimeout(() => resolve({ type: "poll" }), 250))]);
    if (winner.type === "receipt") return winner.value;
    if (winner.type === "error") throw winner.error;
    const control = pendingRunControl(runtime.db, runId);
    if (control?.action !== "cancel") continue;
    if (typeof invocation.cancel === "function") await invocation.cancel();
    queue.cancelRun(runId, { reason: control.reason });
    runtime.db.prepare("UPDATE run_control_requests SET status='applied',applied_at=? WHERE id=?").run(now(), control.id);
    runtime.db.prepare("UPDATE workflow_runs SET cancel_requested=0,updated_at=? WHERE id=?").run(now(), runId);
    const error = new Error("RUN_CANCELLED"); error.code = "RUN_CANCELLED"; throw error;
  }
  return result;
}

async function invokeRole({ runtime, queue, runId, roleId, level, taskRoot, packageContract, context, schemaKey, parseOptions, gatewayCall, activeInvocations = null }) {
  const contract = loadRoleContract(runtime.db, runtime.get(runId).project_id, roleId, level);
  const qualityContract = loadQualityContract(runtime.db, level);
  if (contract.result_schema_key !== schemaKey) throw new Error(`ROLE_SCHEMA_NOT_ALLOWED: ${roleId}:${schemaKey}`);
  const lease = queue.checkout({ ownerId: `workflow:${roleId}`, runId, roleId, leaseMs: contract.timeout_seconds * 1000 });
  if (!lease) throw new Error(`ROLE_STEP_NOT_READY: ${roleId}`);
  const step = runtime.db.prepare("SELECT * FROM workflow_steps WHERE id=?").get(lease.stepId);
  if (step.role_id !== roleId) throw new Error(`ROLE_STEP_MISMATCH: expected ${step.role_id}, got ${roleId}`);
  queue.start(lease.token);
  const promptContext = context ?? {};
  let prompt;
  try { prompt = promptWithinContract(contract, qualityContract, packageContract, promptContext, schemaKey); }
  catch (error) {
    recordRunEvidence(runtime.db, runId, step.id, "role_prompt_overflow", {
      step_key: step.step_key,
      role_id: roleId,
      ...(error.prompt_metrics ?? { context_limit_bytes: contract.context_limit_bytes }),
      error: error.message
    });
    const failure = queue.fail(lease.token, { category: "context_budget_exceeded", retryable: false });
    throw new Error(`${error.message}: ${JSON.stringify(failure)}`);
  }
  recordRunEvidence(runtime.db, runId, step.id, "role_prompt_metrics", {
    step_key: step.step_key,
    role_id: roleId,
    prompt_bytes: Buffer.byteLength(prompt),
    context_limit_bytes: contract.context_limit_bytes,
    review_evidence_bytes: packageContract?.review_evidence ? Buffer.byteLength(JSON.stringify(packageContract.review_evidence)) : null
  });
  fs.mkdirSync(taskRoot, { recursive: true });
  const taskFile = path.join(taskRoot, `${step.ordinal}-${roleId}.md`);
  fs.writeFileSync(taskFile, prompt, "utf8");
  storeStepPayload(runtime.db, step.id, packageContract, schemaKey);
  const { manager, request } = roleBudgetRequest(runtime, runId, step.id, roleId, lease.attemptId, contract, `${step.id}:${lease.attemptNo}:call`);
  let receipt = null;
  try {
    receipt = await invokeWithinBudget(manager, request, () => {
      const gatewayInvocation = gatewayCall({
        provider: contract.provider, profile: contract.profile, level, role: roleId, taskFile,
        project: runtime.db.prepare("SELECT root_path FROM projects WHERE id=?").get(runtime.get(runId).project_id).root_path,
        // Only the writable roots go to the provider, and the primary one is already there as --project.
        // A read-only root was collected into the prompt and is deliberately never handed to the sandbox.
        writeDirs: writableRoots(projectRoots(runtime.db, runtime.get(runId).project_id)).filter(root => !root.primary).map(root => root.path),
        taskId: `${runId}:${step.step_key}:${lease.attemptNo}`, workflowRunId: runId, attemptNo: lease.attemptNo
      });
      activeInvocations?.add(gatewayInvocation);
      return controlledGatewayReceipt(runtime, queue, runId, gatewayInvocation).finally(() => activeInvocations?.delete(gatewayInvocation));
    });
    let result;
    try {
      result = parseRoleReceipt(receipt, schemaKey, { contract, ...parseOptions });
    } catch (error) {
      error.code = "ROLE_RESULT_SCHEMA_INVALID";
      error.invalidRoleOutput = utf8Prefix(String(receipt.output ?? ""), 16_384);
      throw error;
    }
    const usage = receipt.usage ?? {};
    const measured = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
      duration_ms: receipt.duration_ms ?? (receipt.startedAt && receipt.finishedAt ? Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt) : null),
      correction_cycles: receipt.correctionCycles ?? receipt.correction_cycles,
      cost_usd: usage.cost_usd
    };
    let costSettlement = null;
    for (const [metric, amount] of Object.entries(measured)) if (Number.isFinite(Number(amount)) && Number(amount) > 0) {
      const charge = { ...request, metric, amount: Number(amount), idempotencyKey: `${request.idempotencyKey}:${metric}`, reason: `${request.reason}:${metric}` };
      if (metric === "cost_usd") costSettlement = manager.settleActual(charge);
      else manager.consume(charge);
    }
    const contractHash = structuredHash({ role_contract_id: contract.id, role_contract_version: contract.version, package: packageContract });
    const resultHash = structuredHash(result);
    runtime.linkGateway(runId, { ...receipt, step_id: step.id, attempt_id: lease.attemptId, contract_hash: contractHash, result_hash: resultHash });
    storeStepPayload(runtime.db, step.id, packageContract, schemaKey, result);
    return {
      contract, qualityContract, lease, step, receipt, result, costSettlement,
      complete: details => queue.complete(lease.token, { receiptId: receipt.receiptId ?? receipt.receipt_id, details }),
      fail: (category, retryable = true) => queue.fail(lease.token, { category, retryable })
    };
  } catch (error) {
    if (receipt) {
      try { runtime.linkGateway(runId, { ...receipt, step_id: step.id, attempt_id: lease.attemptId, contract_hash: structuredHash({ role_contract_id: contract.id, package: packageContract }) }); } catch {}
    }
    if (receipt && error.code === "ROLE_RESULT_SCHEMA_INVALID") {
      recordRunEvidence(runtime.db, runId, step.id, "role_result_validation_error", {
        step_key: step.step_key,
        role_id: roleId,
        schema_key: schemaKey,
        error: String(error.message),
        raw_result_hash: crypto.createHash("sha256").update(String(receipt.output ?? "")).digest("hex")
      });
    }
    try { error.queueFailure = queue.fail(lease.token, { category: error.code ?? String(error.message).split(":")[0].slice(0, 120), retryable: true }); } catch {}
    throw error;
  }
}

function applyPlannerToDatabase(runtime, runId, plannerResult) {
  const plan = runtime.db.prepare("SELECT id FROM plans WHERE run_id=?").get(runId);
  runtime.db.prepare(`UPDATE plans SET schema_version=1,outcome=?,scope_json=?,allowed_paths_json=?,inputs_json=?,checks_json=?,risks_json=?,artifacts_json=?,completion_criteria_json=?,questions_json=?,steps_json=?,status=? WHERE id=?`)
    .run(plannerResult.outcome, JSON.stringify(plannerResult.scope), JSON.stringify(plannerResult.allowed_paths), JSON.stringify(plannerResult.inputs), JSON.stringify(plannerResult.checks), JSON.stringify(plannerResult.risks), JSON.stringify(plannerResult.artifacts), JSON.stringify(plannerResult.completion_criteria), JSON.stringify(plannerResult.questions), JSON.stringify(plannerResult.steps), plannerResult.outcome === "ready" ? "authorized" : "clarification_required", plan.id);
}

function storedAuthorizedPlan(db, runId) {
  const row = db.prepare("SELECT * FROM plans WHERE run_id=? AND status='authorized'").get(runId);
  if (!row) return null;
  const steps = parseJson(row.steps_json, []);
  if (!steps.length) return null;
  return {
    schema_version: row.schema_version ?? 1,
    outcome: row.outcome,
    scope: parseJson(row.scope_json, { included: [], excluded: [] }),
    allowed_paths: parseJson(row.allowed_paths_json, []),
    inputs: parseJson(row.inputs_json, []),
    checks: parseJson(row.checks_json, []),
    risks: parseJson(row.risks_json, []),
    artifacts: parseJson(row.artifacts_json, []),
    completion_criteria: parseJson(row.completion_criteria_json, []),
    questions: parseJson(row.questions_json, []),
    steps
  };
}

function registerNewPlannedDocument(runtime, projectId, projectRoot, plannerResult, documentatorRole) {
  const required = plannerResult.artifacts.filter(item => item.required && item.type === "document" && item.path);
  if (required.length !== 1) return;
  const target = required[0];
  const existing = runtime.db.prepare("SELECT id FROM project_documents WHERE project_id=? AND path=? AND active=1").get(projectId, target.path);
  if (existing) return;
  if (!/^docs\/[A-Za-z0-9Ѐ-ӿ_. -]+\.md$/i.test(target.path)) throw new Error(`DOCUMENT_NEW_TARGET_NOT_ALLOWED: ${target.path}`);
  const file = path.resolve(projectRoot, target.path);
  if (!file.startsWith(`${path.resolve(projectRoot)}${path.sep}`) || fs.existsSync(file)) throw new Error(`DOCUMENT_UNREGISTERED_EXISTING_TARGET: ${target.path}`);
  const documentId = id("document");
  runtime.db.prepare("INSERT INTO project_documents(id,project_id,path,root_key,document_type,authority,status,active,version,updated_at) VALUES(?,?,?,'primary','report','workflow','active',1,0,?)")
    .run(documentId, projectId, target.path, now());
  runtime.db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES(?,?,?,1,1,'task-planned document output',100)")
    .run(projectId, documentatorRole, documentId);
}

function appendSteps(runtime, runId, steps, { sameOrdinal = false } = {}) {
  const timestamp = now();
  const existing = runtime.db.prepare("SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM workflow_steps WHERE run_id=?").get(runId).ordinal;
  const keys = new Set(runtime.db.prepare("SELECT step_key FROM workflow_steps WHERE run_id=?").all(runId).map(row => row.step_key));
  const inserted = [];
  for (const [index, step] of steps.entries()) {
    if (keys.has(step.key)) throw new Error(`PLAN_STEP_DUPLICATE: ${step.key}`);
    keys.add(step.key);
    const ordinal = sameOrdinal ? existing + 1 : existing + index + 1;
    const stepId = id("step");
    runtime.db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,role_id,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts,contract_json,result_schema_key,resources_json) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?)")
      .run(stepId, runId, step.key, ordinal, step.role, step.required ? 1 : 0, step.irreversible ? 1 : 0, `${runId}:${step.key}:${ordinal}`, timestamp, timestamp, step.max_attempts, JSON.stringify(step.contract), step.schema, JSON.stringify((step.resources ?? []).map(normalizeResourceDeclaration)));
    inserted.push(stepId);
  }
  return inserted;
}

// A run holds one step per key, and a replan writes a second set of steps into the same run. They are
// prefixed the way a correction cycle is, so the superseded attempt stays readable as history instead of
// colliding with the plan that replaced it.
// Which roles are allowed to change files. The working tree of a project is a resource like any other,
// and a step that writes holds it exclusively whether or not any plan mentioned it: two workers editing
// one checkout at the same time is the commonest conflict there is, and leaving it to a planner to
// remember would make the lock optional in exactly the case it matters.
function writingRoles(db, projectId) {
  return new Set(db.prepare("SELECT role_id,boundaries_json FROM role_contracts WHERE project_id=? AND status='active'").all(projectId)
    .filter(row => parseJson(row.boundaries_json, {})?.writes === true).map(row => row.role_id));
}

// A plan names resources by alias; the authority behind each alias is the installation's, and it is
// resolved here, once, on the way into the step. A correction or a replan reuses the same planned step,
// so it carries the same resources: rebuilding the step without them was how a corrected worker came to
// write with no lock at all while the plan still said which resource it needed.
function plannedStepResources(db, projectId, writers, step) {
  const declared = aliasDeclarations(db, projectId, step.resources ?? []);
  if (!writers.has(step.role) || declared.some(item => item.kind === "project.worktree")) return declared;
  return [...aliasDeclarations(db, projectId, [{ alias: WORKTREE_ALIAS, mode: "exclusive" }]), ...declared];
}

function appendExecutionSteps(runtime, runId, projectId, plannerResult, keyPrefix = "") {
  const writers = writingRoles(runtime.db, projectId);
  appendSteps(runtime, runId, [
    ...plannerResult.steps.map(step => ({ ...step, key: `${keyPrefix}${step.key}`, schema: "worker.v1", resources: plannedStepResources(runtime.db, projectId, writers, step), contract: { objective: step.objective, allowed_paths: step.allowed_paths, artifact_keys: step.artifact_keys, check_ids: step.check_ids } })),
    { key: `${keyPrefix}verification`, role: null, required: true, irreversible: false, max_attempts: 1, schema: "gate.v1", contract: { allowed_paths: plannerResult.allowed_paths, check_ids: plannerResult.checks } }
  ]);
}

function appendCorrectionSteps(runtime, runId, projectId, plannerResult, cycle, selectedSteps = plannerResult.steps, keyPrefix = "") {
  const writers = writingRoles(runtime.db, projectId);
  appendSteps(runtime, runId, [
    ...selectedSteps.map(step => ({ key: `${keyPrefix}correction_${cycle}_${step.key}`, role: step.role, required: true, irreversible: false, max_attempts: 1, schema: "worker.v1", resources: plannedStepResources(runtime.db, projectId, writers, step), contract: { objective: step.objective, allowed_paths: step.allowed_paths, artifact_keys: step.artifact_keys, check_ids: step.check_ids, correction_cycle: cycle } })),
    { key: `${keyPrefix}verification_${cycle}`, role: null, required: true, irreversible: false, max_attempts: 1, schema: "gate.v1", contract: { allowed_paths: plannerResult.allowed_paths, check_ids: plannerResult.checks, correction_cycle: cycle } }
  ]);
}

function appendReviewerSteps(runtime, runId, roles, reason, cycle = 0) {
  return appendSteps(runtime, runId, roles.map((role, index) => ({ key: cycle || index ? `review_${cycle}_${index + 1}` : "review", role, required: true, irreversible: false, max_attempts: 2, schema: "reviewer.v1", contract: { reason, independent_member: index + 1 } })), { sameOrdinal: true });
}

function appendDocumentatorStep(runtime, runId, projectId, roleId, outcome) {
  const resources = aliasDeclarations(runtime.db, projectId, [{ alias: WORKTREE_ALIAS, mode: "exclusive" }]);
  appendSteps(runtime, runId, [{ key: "documentation", role: roleId, required: true, irreversible: false, max_attempts: 1, schema: "documentator.v1", resources, contract: { quality_outcome: outcome } }]);
}

function verifyWorkerArtifacts(runtime, runId, stepId, projectRoot, plannerResult, artifactKeys, workerResult) {
  const taskId = runtime.get(runId).task_id;
  const assigned = plannerResult.artifacts.filter(item => artifactKeys.includes(item.key));
  for (const required of assigned.filter(item => item.required && item.path !== null)) if (!workerResult.artifacts.some(item => item.key === required.key)) throw new Error(`WORKER_REQUIRED_ARTIFACT_MISSING: ${required.key}`);
  for (const artifact of workerResult.artifacts) {
    const file = path.resolve(projectRoot, artifact.path);
    if (!file.startsWith(`${path.resolve(projectRoot)}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`WORKER_ARTIFACT_FILE_MISSING: ${artifact.path}`);
    const actualHash = hashFile(file);
    if (artifact.content_hash && artifact.content_hash !== actualHash) throw new Error(`WORKER_ARTIFACT_HASH_MISMATCH: ${artifact.path}`);
    runtime.db.prepare("INSERT INTO artifacts(id,task_id,run_id,step_id,kind,uri,content_hash,status,provenance_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id("artifact"), taskId, runId, stepId, artifact.type, artifact.path, actualHash, "created", JSON.stringify({ source: "worker.v1", key: artifact.key }), now(), now());
  }
  // A planner may ask an analytical worker for a decision rather than a file. worker.v1 already
  // carries that result as a validated summary plus evidence, so requiring it to invent a file-shaped
  // artifact makes the contract impossible to satisfy. Materialize the receipt in the native decisions
  // table and keep its planner key for auditability and later context selection.
  for (const artifact of assigned.filter(item => item.path === null)) {
    const decisionId = id("decision");
    runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,step_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,?,?,'COMPLETED','worker',?,1,?)")
      .run(decisionId, taskId, runId, stepId, `artifact:${artifact.key}`, JSON.stringify({ artifact_key: artifact.key, artifact_type: artifact.type, summary: workerResult.summary, evidence: workerResult.evidence }), now());
    runtime.db.prepare("UPDATE gateway_calls SET decision_ref=? WHERE run_id=? AND step_id=?").run(decisionId, runId, stepId);
  }
}

function reviewerDecision(runtime, runId, stepId, result) {
  const taskId = runtime.get(runId).task_id;
  const decisionId = id("decision");
  runtime.db.prepare("UPDATE decisions SET active=0 WHERE task_id=? AND kind='review'").run(taskId);
  runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,step_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,?, 'review',?,'reviewer',?,1,?)")
    .run(decisionId, taskId, runId, stepId, result.decision, JSON.stringify(result), now());
  return decisionId;
}

function decisionRank(value) { return value === "REJECT" ? 3 : value === "CHANGES_REQUESTED" ? 2 : 1; }

export function consiliumRoles(availableRoles, reviewerRole, maximum) {
  const available = availableRoles instanceof Set ? availableRoles : new Set(availableRoles);
  return [reviewerRole, "adversarial_reviewer", "evidence_reviewer"].filter((role, index, values) => available.has(role) && values.indexOf(role) === index).slice(0, Math.max(1, Math.min(3, Number(maximum) || 2)));
}

export function reviewerTaskPackage(reviewEvidence, reviewReason, correctionCycles, correctionLimit = correctionCycles) {
  return {
    review_reason: reviewReason,
    review_evidence: reviewEvidence,
    correction_cycles: correctionCycles,
    correction_limit: correctionLimit,
    remaining_correction_cycles: Math.max(0, correctionLimit - correctionCycles)
  };
}

export function reviewerPromptContext(classification, responseLanguage) {
  return {
    response_language: responseLanguage,
    evidence_authority: "immutable_review_package",
    classification: { work_type: classification.work_type, artifact_type: classification.artifact_type, risk: classification.risk, quality_mode: classification.quality_mode }
  };
}

export function recoveryRoute(recovery) {
  const steps = Array.isArray(recovery?.steps) ? recovery.steps : [];
  return { steps, confidence: steps.length ? "high" : "none", basis: `strategy_review:${recovery?.decision ?? "NO_VIABLE_STRATEGY"}`, unresolved_signals: [] };
}

export function validRecoverySelection(selectedStepKeys, exhaustedStepKeys = []) {
  const exhausted = new Set(exhaustedStepKeys);
  return (selectedStepKeys ?? []).length > 0 && !(selectedStepKeys ?? []).some(key => exhausted.has(key));
}

export async function settleAdmittedReviewInvocations(invocations) {
  const settled = await Promise.allSettled(invocations);
  const rejected = settled.find(item => item.status === "rejected");
  return { settled, rejected, values: rejected ? [] : settled.map(item => item.value) };
}

export function remainingWorkflowCalls(db, runId) {
  const budget = db.prepare("SELECT used_value,limit_value FROM budgets WHERE scope_type='workflow' AND scope_id=? AND metric='calls'").get(runId);
  return budget ? Math.max(0, Number(budget.limit_value) - Number(budget.used_value)) : Number.POSITIVE_INFINITY;
}

export function reviewPhaseCallFloor(db, projectId, reviewerRole, policy, classification) {
  const available = new Set(db.prepare("SELECT role_id FROM role_contracts WHERE project_id=? AND status='active'").all(projectId).map(row => row.role_id));
  const roles = policy.improvement_strategy === "gauntlet"
    ? consiliumRoles(available, reviewerRole, policy.max_parallel_consilium_members)
    : [reviewerRole];
  const selected = roles.length ? roles : [reviewerRole];
  return selected.length + (available.has("judge") ? 1 : 0) + (classification.document_required ? 1 : 0);
}

export function correctionCallFloor(db, projectId, reviewerRole, policy, classification, correctionCycle, selectedStepCount) {
  const review = reviewerRequirement(policy.contract, classification, correctionCycle, policy.project_escalations);
  return selectedStepCount + (review.required ? reviewPhaseCallFloor(db, projectId, reviewerRole, policy, classification) : 0);
}

export function registeredReplanCatalog(db, projectId, level, artifactType, availableRoles = []) {
  return {
    registeredRoles: [...availableRoles],
    registeredChecks: registeredProjectCheckKeys(db, projectId, level, artifactType),
    registeredArtifactTypes: db.prepare("SELECT id FROM artifact_types").all().map(row => row.id)
  };
}

export async function invokeReviewerWithSchemaRepair({ invoke, packageContract, onRetry = () => {} }) {
  let currentPackage = packageContract;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try { return await invoke(currentPackage); }
    catch (error) {
      const retryScheduled = error.code === "ROLE_RESULT_SCHEMA_INVALID" && error.queueFailure?.action === "retry_scheduled";
      if (!retryScheduled || attempt === 2) throw error;
      currentPackage = {
        ...packageContract,
        schema_repair: {
          attempt: attempt + 1,
          validation_error: String(error.message),
          invalid_result: error.invalidRoleOutput ?? null,
          instruction: "Return one corrected reviewer.v1 object. Preserve the evidence-grounded judgment and make decision, blockers and required_actions mutually consistent."
        }
      };
      await onRetry({ attempt: attempt + 1, error, packageContract: currentPackage });
    }
  }
  throw new Error("REVIEWER_SCHEMA_REPAIR_EXHAUSTED");
}

async function executeIndependentReview({ runtime, queue, runId, projectId, reviewerRole, policy, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, reviewReason, plan, gate, workerResults, correctionCycles }) {
  const available = new Set(runtime.db.prepare("SELECT role_id FROM role_contracts WHERE project_id=? AND status='active'").all(projectId).map(row => row.role_id));
  const roles = policy.improvement_strategy === "gauntlet"
    ? consiliumRoles(available, reviewerRole, policy.max_parallel_consilium_members)
    : [reviewerRole];
  const selectedRoles = roles.length ? roles : [reviewerRole];
  const reviewerContracts = selectedRoles.map(roleId => loadRoleContract(runtime.db, projectId, roleId, level));
  // Evidence is bounded by the actual selected role contracts, not by a historical global constant.
  // Thirty percent remains for the XML contract, task package framing, schema and escaping overhead; the
  // final invokeRole measurement remains authoritative for every individual reviewer.
  const reviewEvidenceLimit = Math.floor(Math.min(...reviewerContracts.map(contract => contract.context_limit_bytes)) * 7 / 10);
  const previousBase = runtime.db.prepare("SELECT evidence_json FROM run_evidence WHERE run_id=? AND kind='review_base' ORDER BY created_at DESC,id DESC LIMIT 1").get(runId);
  const previousEvidence = parseJson(previousBase?.evidence_json, null);
  const reviewEvidence = buildReviewEvidence(runtime.db, runId, { plan, gate, workerResults, allowedPaths: plan.allowed_paths, reviewEvidenceLimit });
  if (correctionCycles > 0 && previousEvidence?.base_evidence_hash === reviewEvidence.base_evidence_hash) {
    const previousRoutes = runtime.db.prepare("SELECT evidence_json FROM run_evidence WHERE run_id=? AND kind='correction_routing' ORDER BY created_at DESC,id DESC LIMIT 1").all(runId)
      .flatMap(row => parseJson(row.evidence_json, {}).route_keys ?? parseJson(row.evidence_json, {}).steps?.map(step => step.key) ?? []);
    recordRunEvidence(runtime.db, runId, null, "duplicate_review_evidence", {
      previous_hash: previousEvidence.base_evidence_hash,
      current_hash: reviewEvidence.base_evidence_hash,
      semantic_gap_fingerprint: semanticGapFingerprint(reviewEvidence)?.fingerprint ?? null,
      previous_route_keys: previousRoutes
    });
    const latest = runtime.db.prepare("SELECT structured_json FROM decisions WHERE run_id=? AND kind='review' AND active=1 ORDER BY created_at DESC,id DESC LIMIT 1").get(runId);
    const result = parseJson(latest?.structured_json, null) ?? { decision: "CHANGES_REQUESTED", summary: "Canonical review evidence is identical to the prior cycle.", blockers: [{ code: "DUPLICATE_REVIEW_EVIDENCE", message: "Correction added no canonical review evidence.", path: null }], evidence_refs: [reviewEvidence.base_evidence_hash], required_actions: [], schema_version: 1 };
    return { duplicate: true, result, opinions: [], base_evidence_hash: reviewEvidence.base_evidence_hash, review_evidence: reviewEvidence, budget_exhausted: false, cost_budget: null };
  }
  const phaseCallFloor = selectedRoles.length + (available.has("judge") ? 1 : 0) + (classification.document_required ? 1 : 0);
  if (remainingWorkflowCalls(runtime.db, runId) < phaseCallFloor) {
    recordRunEvidence(runtime.db, runId, null, "review_admission_rejected", { reason: "workflow_call_budget_minimum_unsatisfiable", remaining_calls: remainingWorkflowCalls(runtime.db, runId), required_calls: phaseCallFloor, selected_roles: selectedRoles, correction_cycle: correctionCycles });
    const latest = runtime.db.prepare("SELECT structured_json FROM decisions WHERE run_id=? AND kind='review' AND active=1 ORDER BY created_at DESC,id DESC LIMIT 1").get(runId);
    const result = parseJson(latest?.structured_json, null) ?? { decision: "CHANGES_REQUESTED", summary: "The bounded review phase cannot be admitted within the remaining workflow call budget.", blockers: [{ code: "REVIEW_CALL_BUDGET_MINIMUM_UNSATISFIABLE", message: "Insufficient calls remain for the complete admitted review phase.", path: null }], evidence_refs: [reviewEvidence.base_evidence_hash], required_actions: [], schema_version: 1 };
    return { budget_unavailable: true, result, opinions: [], base_evidence_hash: reviewEvidence.base_evidence_hash, review_evidence: reviewEvidence, budget_exhausted: false, cost_budget: null };
  }
  const reviewerStepIds = appendReviewerSteps(runtime, runId, selectedRoles, reviewReason, correctionCycles);
  queue.enqueueRun(runId);
  runtime.setState(runId, "review_required", { reason: reviewReason });
  const activeInvocations = new Set();
  const invocations = selectedRoles.map(async roleId => {
    try {
      const reviewerPackage = reviewerTaskPackage(reviewEvidence, reviewReason, correctionCycles, Number(policy.limits.correction_cycles) || 0);
      const reviewer = await invokeReviewerWithSchemaRepair({
        packageContract: reviewerPackage,
        invoke: packageContract => invokeRole({ runtime, queue, runId, roleId, level, taskRoot, packageContract, context: reviewerPromptContext(classification, responseLanguage), schemaKey: "reviewer.v1", parseOptions: {}, gatewayCall, activeInvocations }),
        onRetry: ({ attempt, error }) => recordRunEvidence(runtime.db, runId, null, "reviewer_schema_repair", {
          role_id: roleId,
          attempt,
          validation_error: String(error.message),
          prior_result_hash: crypto.createHash("sha256").update(String(error.invalidRoleOutput ?? "")).digest("hex")
        })
      });
      reviewer.complete({ decision: reviewer.result.decision, base_evidence_hash: reviewEvidence.base_evidence_hash });
      return { role: roleId, invocation: reviewer, result: reviewer.result };
    } catch (error) {
      await Promise.allSettled([...activeInvocations].map(invocation => typeof invocation.cancel === "function" ? invocation.cancel() : Promise.resolve()));
      throw error;
    }
  });
  // Every consilium member above has already been admitted and started. A fail-fast Promise.all would
  // let the parent transition the run while another Gateway call still owns a live lease and budget.
  // Drain every admitted participant first; invokeRole closes its own queue lifecycle on both paths.
  const { settled: settledOpinions, rejected: rejectedOpinion, values: opinions } = await settleAdmittedReviewInvocations(invocations);
  if (rejectedOpinion) {
    queue.abandonSteps(runId, reviewerStepIds, { reason: "review phase failed after all admitted participants settled" });
    recordRunEvidence(runtime.db, runId, null, "review_consilium_settled", {
      base_evidence_hash: reviewEvidence.base_evidence_hash,
      participants: selectedRoles.map((role, index) => ({ role, status: settledOpinions[index].status }))
    });
    throw rejectedOpinion.reason;
  }
  recordRunEvidence(runtime.db, runId, null, "review_opinions", { base_evidence_hash: reviewEvidence.base_evidence_hash, opinions: opinions.map(item => ({ role: item.role, result: item.result })) });
  const costBudget = runtime.db.prepare("SELECT used_value,limit_value,status FROM budgets WHERE scope_type='workflow' AND scope_id=? AND metric='cost_usd'").get(runId);
  const budgetExhausted = Boolean(costBudget && (costBudget.status === "exhausted" || costBudget.used_value >= costBudget.limit_value));
  const admissibility = blockerAdmissibility(opinions, reviewEvidence);
  recordRunEvidence(runtime.db, runId, null, "blocker_admissibility", { base_evidence_hash: reviewEvidence.base_evidence_hash, blockers: admissibility });
  const effectiveOpinions = opinions.map(item => ({ ...item, effective_decision: admissibleOpinionDecision(item, admissibility) }));
  let final = effectiveOpinions.sort((a, b) => decisionRank(b.effective_decision) - decisionRank(a.effective_decision))[0].result;
  if (effectiveOpinions.every(item => item.effective_decision === "PASS")) final = { decision: "PASS", summary: "No admissible blocker remains after deterministic factual admissibility.", blockers: [], evidence_refs: [reviewEvidence.base_evidence_hash], required_actions: [], schema_version: 1 };
  const supportedFactualBlocker = hasSupportedFactualBlocker(admissibility);
  if (supportedFactualBlocker) recordRunEvidence(runtime.db, runId, null, "deterministic_factual_blocker", { base_evidence_hash: reviewEvidence.base_evidence_hash, blockers: admissibility.filter(item => item.blocker_kind === "factual" && item.status === "supported") });
  if (new Set(effectiveOpinions.map(item => item.effective_decision)).size > 1 && !supportedFactualBlocker) {
    // Factual disagreement is first exposed as deterministic targeted-verification evidence. The current
    // registered gate is immutable evidence; a judge is used only when the project has registered one.
    recordRunEvidence(runtime.db, runId, null, "targeted_verification", { reason: "independent_review_disagreement", gate, base_evidence_hash: reviewEvidence.base_evidence_hash });
    if (available.has("judge")) {
      appendSteps(runtime, runId, [{ key: `judge_${correctionCycles}`, role: "judge", required: true, irreversible: false, max_attempts: 1, schema: "judge.v1", contract: { base_evidence_hash: reviewEvidence.base_evidence_hash } }]);
      queue.enqueueRun(runId);
      const judgePackage = { objective: "Resolve the evaluative conflict after deterministic blocker admissibility.", base_evidence: reviewEvidence, opinions: opinions.map(item => ({ role: item.role, result: item.result })), blocker_admissibility: admissibility, conflicts: effectiveOpinions.map(item => ({ role: item.role, effective_decision: item.effective_decision })) };
      const judge = await invokeRole({ runtime, queue, runId, roleId: "judge", level, taskRoot, packageContract: judgePackage, context: reviewerPromptContext(classification, responseLanguage), schemaKey: "judge.v1", parseOptions: {}, gatewayCall });
      judge.complete({ outcome: judge.result.decision });
      if (judge.result.decision === "PASS") final = { decision: "PASS", summary: judge.result.rationale, blockers: [], evidence_refs: judge.result.evidence_refs, required_actions: [], schema_version: 1 };
      else if (judge.result.decision === "PRIMARY_GAP") final = { decision: "CHANGES_REQUESTED", summary: judge.result.rationale, blockers: [{ code: judge.result.primary_gap.kind, message: judge.result.primary_gap.message, path: judge.result.primary_gap.path }], evidence_refs: judge.result.primary_gap.evidence_refs, required_actions: [judge.result.primary_gap.search_intent], schema_version: 1 };
      else if (judge.result.decision === "TARGETED_VERIFICATION") {
        const verification = executeVerificationWithCorpusFallback({ request: judge.result.verification_request, evidence: reviewEvidence, discovery, runtime, runId, stepId: judge.step.id });
        recordRunEvidence(runtime.db, runId, judge.step.id, "targeted_verification_result", verification);
        final = { decision: "CHANGES_REQUESTED", summary: `${judge.result.rationale} Deterministic verification status: ${verification.status}.`, blockers: [{ code: `TARGETED_VERIFICATION_${verification.status.toUpperCase()}`, message: judge.result.verification_request.subject, path: judge.result.verification_request.path }], evidence_refs: [...new Set([...judge.result.verification_request.evidence_refs, ...verification.evidence_refs])], required_actions: verification.status === "unknown" ? [JSON.stringify(judge.result.verification_request)] : [`Use deterministic verification result ${verification.status}: ${JSON.stringify(verification.facts)}`], schema_version: 1 };
      }
      else final = { decision: "CHANGES_REQUESTED", summary: judge.result.rationale, blockers: [{ code: "OWNER_DECISION", message: judge.result.rationale, path: null }], evidence_refs: judge.result.evidence_refs, required_actions: [judge.result.rationale], schema_version: 1 };
    } else {
      recordRunEvidence(runtime.db, runId, null, "consilium_conflict_without_judge", { base_evidence_hash: reviewEvidence.base_evidence_hash, opinions: effectiveOpinions.map(item => ({ role: item.role, decision: item.effective_decision })) });
      throw new Error("CONSILIUM_CONFLICT_WITHOUT_JUDGE");
    }
  }
  const finalStep = opinions.find(item => item.result === final)?.invocation.step.id ?? opinions[0].invocation.step.id;
  const decisionId = reviewerDecision(runtime, runId, finalStep, final);
  runtime.db.prepare("UPDATE gateway_calls SET decision_ref=? WHERE run_id=? AND step_id=?").run(decisionId, runId, finalStep);
  return { result: final, opinions: opinions.map(item => ({ role: item.role, result: item.result })), base_evidence_hash: reviewEvidence.base_evidence_hash, review_evidence: reviewEvidence, budget_exhausted: budgetExhausted, cost_budget: costBudget ?? null };
}

function exhaustedRouteKeys(db, runId, semanticGap) {
  if (!semanticGap) return [];
  return [...new Set(db.prepare("SELECT evidence_json FROM run_evidence WHERE run_id=? AND kind='correction_route_outcome' ORDER BY created_at,id").all(runId)
    .map(row => parseJson(row.evidence_json, {}))
    .filter(outcome => outcome.semantic_gap_fingerprint === semanticGap && outcome.exhausted)
    .flatMap(outcome => outcome.attempted_route_keys ?? []))];
}

async function executeStrategyRecovery({ runtime, queue, runId, projectId, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, plan, gate, reviewer, reviewEvidence, progress, cycle }) {
  const available = new Set(runtime.db.prepare("SELECT role_id FROM role_contracts WHERE project_id=? AND status='active'").all(projectId).map(row => row.role_id));
  if (!available.has("strategy_reviewer")) return { decision: "NO_VIABLE_STRATEGY", rationale: "strategy_reviewer is not registered", steps: [], executed: false };
  const semanticGap = progress?.latest?.semantic_fingerprint ?? progress?.latest?.primary_gap_fingerprint ?? semanticGapFingerprint(reviewEvidence)?.fingerprint ?? null;
  const exhausted = exhaustedRouteKeys(runtime.db, runId, semanticGap);
  if (remainingWorkflowCalls(runtime.db, runId) < 1) {
    recordRunEvidence(runtime.db, runId, null, "strategy_recovery_unavailable", { reason: "workflow_call_budget_exhausted", requested_phase: "strategy_review", remaining_calls: 0, semantic_gap_fingerprint: semanticGap });
    return { decision: "NO_VIABLE_STRATEGY", rationale: "workflow call budget is exhausted before strategy review", steps: [], executed: false };
  }
  appendSteps(runtime, runId, [{ key: `strategy_review_${cycle}`, role: "strategy_reviewer", required: true, irreversible: false, max_attempts: 1, schema: "strategy_review.v1", contract: { cycle } }]);
  queue.enqueueRun(runId);
  const strategyPackage = {
    objective: "Select the next bounded recovery strategy without executing it.",
    available_steps: plan.steps.map(step => ({ key: step.key, objective: step.objective, allowed_paths: step.allowed_paths, check_ids: step.check_ids })),
    primary_gap: reviewer?.blockers?.[0] ?? null,
    gate_failures: (gate?.checks ?? []).filter(check => check.required && check.status !== "passed").map(check => ({ id: check.id, failure_path: check.failure_path ?? null })),
    prior_progress: progress ?? null,
    claim_coverage: reviewEvidence?.claim_coverage ?? [],
    verification_results: reviewEvidence?.verification?.verification_results ?? [],
    exhausted_step_keys: exhausted,
    correction_cycle: cycle
  };
  const strategy = await invokeRole({ runtime, queue, runId, roleId: "strategy_reviewer", level, taskRoot, packageContract: strategyPackage, context: reviewerPromptContext(classification, responseLanguage), schemaKey: "strategy_review.v1", parseOptions: { availableStepKeys: plan.steps.map(step => step.key) }, gatewayCall });
  strategy.complete({ decision: strategy.result.decision });
  recordRunEvidence(runtime.db, runId, strategy.step.id, "strategy_review", strategy.result);
  if (strategy.result.decision === "SELECT_EXISTING_STEP") {
    const selected = strategy.result.selected_step_keys ?? [];
    if (!validRecoverySelection(selected, exhausted)) {
      recordRunEvidence(runtime.db, runId, strategy.step.id, "strategy_selection_rejected", { semantic_gap_fingerprint: semanticGap, selected_step_keys: selected, exhausted_step_keys: exhausted });
      return { decision: "NO_VIABLE_STRATEGY", rationale: "strategy selected a route exhausted for the unchanged semantic gap", steps: [], executed: true };
    }
    if (remainingWorkflowCalls(runtime.db, runId) < 1) {
      recordRunEvidence(runtime.db, runId, strategy.step.id, "strategy_recovery_unavailable", { reason: "workflow_call_budget_exhausted", requested_phase: "selected_step", remaining_calls: 0, semantic_gap_fingerprint: semanticGap, selected_step_keys: selected });
      return { decision: "NO_VIABLE_STRATEGY", rationale: "strategy selected a source step but the workflow call budget is exhausted", steps: [], executed: true };
    }
    return { ...strategy.result, steps: plan.steps.filter(step => selected.includes(step.key)), executed: true };
  }
  if (strategy.result.decision === "TARGETED_VERIFICATION") {
    const verification = executeVerificationWithCorpusFallback({ request: strategy.result.verification_request, evidence: reviewEvidence ?? {}, discovery, runtime, runId, stepId: strategy.step.id });
    recordRunEvidence(runtime.db, runId, strategy.step.id, "targeted_verification_result", verification);
    if (verification.status !== "unknown") {
      if (remainingWorkflowCalls(runtime.db, runId) < 1) return { decision: "NO_VIABLE_STRATEGY", rationale: "deterministic verification completed but no workflow call remains for arbitration", verification, steps: [], executed: true };
      return { ...strategy.result, verification, review_again: true, steps: [], executed: true };
    }
    const verificationReviewer = { blockers: [{ code: "TARGETED_VERIFICATION_UNKNOWN", message: strategy.result.verification_request.subject, path: strategy.result.verification_request.path }], evidence_refs: verification.evidence_refs, required_actions: [JSON.stringify(strategy.result.verification_request)] };
    const candidate = targetedSteps(plan, { reviewer: verificationReviewer }).steps.filter(step => !exhausted.includes(step.key));
    if (!candidate.length) return { decision: "NO_VIABLE_STRATEGY", rationale: "targeted verification remained unknown and no new source-bearing route can collect the missing proof", verification, steps: [], executed: true };
    if (remainingWorkflowCalls(runtime.db, runId) < 1) return { decision: "NO_VIABLE_STRATEGY", rationale: "targeted verification remained unknown but the workflow call budget is exhausted", verification, steps: [], executed: true };
    return { ...strategy.result, verification, steps: candidate, executed: true };
  }
  if (strategy.result.decision !== "REPLAN") return { ...strategy.result, steps: [], executed: true };
  const plannerRole = runtime.db.prepare("SELECT role_id FROM role_contracts WHERE project_id=? AND status='active' AND result_schema_key='planner.v1' ORDER BY role_id LIMIT 1").get(projectId)?.role_id;
  if (!plannerRole) return { decision: "NO_VIABLE_STRATEGY", rationale: "bounded replan requested but no planner is registered", steps: [], executed: true };
  if (remainingWorkflowCalls(runtime.db, runId) < 1) {
    recordRunEvidence(runtime.db, runId, strategy.step.id, "strategy_recovery_unavailable", { reason: "workflow_call_budget_exhausted", requested_phase: "replan", remaining_calls: 0, semantic_gap_fingerprint: semanticGap });
    return { decision: "NO_VIABLE_STRATEGY", rationale: "bounded replan requested but the workflow call budget is exhausted", steps: [], executed: true };
  }
  appendSteps(runtime, runId, [{ key: `strategy_replan_${cycle}`, role: plannerRole, required: true, irreversible: false, max_attempts: 1, schema: "planner.v1", contract: { cycle } }]);
  queue.enqueueRun(runId);
  const { registeredRoles, registeredChecks, registeredArtifactTypes } = registeredReplanCatalog(runtime.db, projectId, level, classification.artifact_type, available);
  const resources = registeredProjectResources(runtime.db, projectId);
  const replanPackage = { objective: strategy.result.replan_intent, previous_plan: plan, primary_gap: reviewer?.blockers?.[0] ?? null, registered_roles: registeredRoles, registered_checks: registeredChecks, registered_artifact_types: registeredArtifactTypes, registered_resources: resources, rule: "Return a bounded replacement plan. Do not execute any step." };
  const planner = await invokeRole({ runtime, queue, runId, roleId: plannerRole, level, taskRoot, packageContract: replanPackage, context: reviewerPromptContext(classification, responseLanguage), schemaKey: "planner.v1", parseOptions: { registeredRoles, registeredChecks, registeredArtifactTypes, registeredResources: resources, maxStepAttempts: 1 }, gatewayCall });
  planner.complete({ outcome: planner.result.outcome });
  recordRunEvidence(runtime.db, runId, planner.step.id, "strategy_replan", { prior_plan_hash: structuredHash(plan), replacement_plan_hash: structuredHash(planner.result), intent: strategy.result.replan_intent });
  const replacementRoute = targetedSteps(planner.result, reviewer ? { reviewer } : { gate });
  return { ...strategy.result, plan: planner.result, steps: replacementRoute.steps, executed: true };
}

function writableDocument(runtime, projectId, plannerResult, documentatorRole = "documentator") {
  const paths = plannerResult.artifacts.filter(item => item.type === "document" && item.path).map(item => item.path);
  const rows = runtime.db.prepare(`SELECT pd.* FROM project_documents pd JOIN role_documents rd ON rd.document_id=pd.id AND rd.project_id=pd.project_id
    WHERE pd.project_id=? AND rd.role_id=? AND rd.write_access=1 AND pd.active=1 ORDER BY pd.path`).all(projectId, documentatorRole).filter(row => paths.includes(row.path));
  if (rows.length !== 1) throw new Error(`DOCUMENT_TARGET_AMBIGUOUS: expected one registered writable document, found ${rows.length}`);
  return rows[0];
}

function ownerAccepted(runtime, runId) {
  const taskId = runtime.get(runId).task_id;
  return Boolean(runtime.db.prepare(`SELECT 1 FROM decisions d LEFT JOIN approvals a ON a.decision_id=d.id
    WHERE d.task_id=? AND d.active=1 AND upper(d.outcome) IN ('APPROVE','ACCEPTED')
      AND (lower(d.source) IN ('owner','petr','user') OR a.status='approved') LIMIT 1`).get(taskId));
}

async function executeGateStep({ runtime, queue, runId, stepKey, projectRoot, level, plannerResult, classification, gateRunner, cycle }) {
  const gateLease = queue.checkout({ ownerId: "workflow:project-gate", runId, stepKey, leaseMs: 900_000 });
  if (!gateLease || gateLease.stepKey !== stepKey) throw new Error(`GATE_STEP_NOT_READY: expected ${stepKey}`);
  queue.start(gateLease.token);
  let gate;
  try {
    gate = await gateRunner(projectRoot, level, runtime.dbFile ?? undefined, `${runId}:gate:${cycle}`, {
      runId, allowedPaths: plannerResult.allowed_paths, artifactType: classification.artifact_type
    });
  } catch (error) {
    queue.fail(gateLease.token, { category: "gate_runner_error", retryable: false });
    runtime.setState(runId, "failed", { reason: "project gate runner failed" });
    throw error;
  }
  const changeEvidence = runChangeEvidence(runtime.db, runId, plannerResult.allowed_paths);
  if (changeEvidence.unauthorized_changes.length) {
    gate.checks.push({ id: "authorized_write_scope", name: "Run-relative authorized write scope", required: true, status: "failed", exit_code: 1, duration_ms: 0, failure: `Unauthorized run changes: ${changeEvidence.unauthorized_changes.join(", ")}`, failure_path: changeEvidence.unauthorized_changes[0], execution_project_id: runtime.get(runId).project_id, execution_root: projectRoot });
    gate.status = "failed";
    gate.summary = `${gate.checks.filter(check => check.status === "passed").length} passed, ${gate.checks.filter(check => check.required && check.status !== "passed").length} blocking`;
  }
  runtime.recordGate(runId, { ...gate, step_id: gateLease.stepId }, `project_cycle_${cycle}`, true);
  storeStepPayload(runtime.db, gateLease.stepId, { allowed_paths: plannerResult.allowed_paths, checks: plannerResult.checks, correction_cycle: cycle }, "gate.v1", gate);
  queue.complete(gateLease.token, { details: { status: gate.status, correction_cycle: cycle } });
  runtime.setState(runId, "verifying", { reason: cycle ? `program checks completed after correction ${cycle}` : "program checks completed" });
  return gate;
}

export function targetedSteps(plan, { gate = null, reviewer = null } = {}) {
  const failedChecks = new Set((gate?.checks ?? []).filter(check => check.required && check.status !== "passed").map(check => check.id));
  const primary = reviewer?.blockers?.[0] ?? null;
  const reviewSignals = [
    primary?.path,
    ...(reviewer?.evidence_refs ?? []),
    reviewer?.required_actions?.[0],
    primary?.message,
    ...(gate?.checks ?? []).map(check => check.failure_path)
  ];
  const paths = reviewSignals.filter(Boolean).map(value => String(value).replaceAll("\\", "/").replace(/:\d+(?:-\d+)?$/, ""));
  const checkSelected = plan.steps.filter(step => (step.check_ids ?? []).some(check => failedChecks.has(check)));
  if (checkSelected.length) return { steps: checkSelected, confidence: "high", basis: "registered_check_binding", unresolved_signals: [] };
  const pathSelected = plan.steps.filter(step => {
    return (step.allowed_paths ?? []).some(allowed => paths.some(value => {
      const candidate = value.toLowerCase(), boundary = allowed.toLowerCase().replace(/\/$/, "");
      return candidate === boundary || candidate.startsWith(`${boundary}/`) || candidate.includes(`/${boundary}/`) || candidate.endsWith(`/${boundary}`);
    }));
  });
  if (pathSelected.length) return { steps: pathSelected, confidence: "high", basis: "canonical_path_boundary", unresolved_signals: [] };
  // A semantic review gap often has no single file path (for example API -> client mapping -> UI).
  // Route it to the source-bearing plan step whose key/objective best matches that primary intent;
  // never spend the correction on a pathless synthesis step while a searchable source step exists.
  const sourceSteps = plan.steps.filter(step => (step.allowed_paths ?? []).length);
  const stepDocuments = sourceSteps.map(step => `${step.key} ${step.objective ?? ""} ${(step.allowed_paths ?? []).join(" ")}`);
  const rankedTerms = rankTerms(reviewSignals.filter(Boolean).join(" "), stepDocuments);
  const scored = sourceSteps.map((step, index) => {
    return { step, score: documentTermScore(stepDocuments[index], rankedTerms) };
  }).filter(item => item.score > 0).sort((left, right) => right.score - left.score);
  if (scored.length && (scored.length === 1 || scored[0].score > scored[1].score)) return { steps: [scored[0].step], confidence: "medium", basis: "unique_semantic_intent_score", unresolved_signals: [] };
  return { steps: [], confidence: scored.length ? "low" : "none", basis: scored.length ? "ambiguous_semantic_intent" : "no_supported_route", unresolved_signals: reviewSignals.filter(Boolean).map(String).slice(0, 12) };
}

// A run stopped for the owner's decision holds everything needed to continue: the classification it was
// given and the message it was started from. The confirming message classifies as a conversation, so
// resuming means re-entering the paused run with its own objective, not the objective of the "yes".
// Two different waits, opened from the one place that knows which one this is. The typed evidence
// contract names the resource, the provenance and the completeness a delivered packet has to satisfy, so
// the wait can be closed by evidence rather than by a message that merely says the fact is true.
function openWorkerWait(runtime, runId, plannedStep, worker) {
  const taskId = runtime.get(runId).task_id;
  const stepId = worker.step?.id ?? null;
  const contract = worker.result.external_evidence_request ?? null;
  quiesceRun(runtime.db, runId, contract ? "external evidence requested" : "worker clarification opened");
  if (contract) {
    openExternalEvidenceRequest(runtime.db, {
      taskId, runId, stepId, question: worker.result.summary, contract,
      affectedSteps: [plannedStep.key]
    });
    return "external_evidence_required";
  }
  if (!worker.result.questions.length) return null;
  for (const question of worker.result.questions) openClarification(runtime.db, { taskId, runId, stepId, kind: "planner_clarification", question, reason: worker.result.summary, affectedSteps: [plannedStep.key] });
  return "clarification_required";
}

// Resuming has to carry the answer, or the run replans against the same missing information and asks the
// same question again. The objective is the one the run was opened with; the answers settled against it
// are appended as recorded fact, in the order they were given.
const LINE = "\n";
export function resumeObjective(db, runId) {
  const paused = pausedRunObjective(db, runId);
  const answered = db.prepare(`SELECT kind,question,answer_json,answered_run_id FROM approvals
    WHERE run_id=? AND status='approved' AND kind IN ('clarification','planner_clarification','external_evidence') ORDER BY resolved_at,id`).all(runId);
  if (!answered.length) return paused;
  const lines = answered.map(item => {
    const answer = parseJson(item.answer_json, null);
    const reply = item.kind === "external_evidence"
      ? `evidence packet ${answer?.evidence?.content_hash ?? "delivered"} from ${answer?.evidence?.resource?.identity ?? "the named resource"}`
      : db.prepare("SELECT content FROM conversation_messages WHERE run_id=? AND role='user' ORDER BY created_at,id LIMIT 1").get(item.answered_run_id)?.content ?? "answered";
    return `- ${item.question}${LINE}  ${reply}`;
  });
  return { ...paused, message: `${paused.message}${LINE}${LINE}ANSWERED_BEFORE_RESUMING:${LINE}${lines.join(LINE)}` };
}

export function pausedRunObjective(db, runId) {
  const row = db.prepare("SELECT * FROM classifications WHERE run_id=?").get(runId);
  if (!row) throw new Error(`RUN_HAS_NO_CLASSIFICATION: ${runId}`);
  const message = db.prepare("SELECT content FROM conversation_messages WHERE run_id=? AND role='user' ORDER BY created_at,id LIMIT 1").get(runId);
  if (!message) throw new Error(`RUN_HAS_NO_MESSAGE: ${runId}`);
  const classification = Object.freeze({
    schema_version: 1, work_type: row.kind, kind: row.kind, artifact_type: row.artifact_type_id, artifact: row.artifact_type_id,
    domain: row.domain_id, discipline: row.discipline_id, risk: row.risk, planning_level: row.planning_level_id, level: row.planning_level_id,
    quality_mode: row.quality_mode_id, quality: row.quality_mode_id, planning_required: row.planning_required === 1, human_required: row.human_required === 1,
    needs_questions: false, document_required: row.document_required === 1, reply_mode: row.reply_mode, pending_interaction_id: null,
    pending_interaction_response: null, reason: row.reason ?? "", questions: [], human_response: null
  });
  return { classification, message: message.content };
}

export async function executeStructuredWork({ runtime, runId, classification, definition, discovery, message, responseLanguage = "en", taskRoot, gatewayCall, gateRunner = runProjectGate, approvalGranted = false }) {
  const level = operationalLevel(classification.quality_mode);
  const projectId = runtime.get(runId).project_id;
  const projectRoot = discovery.project.root_path;
  const queue = new ExecutionQueue(runtime.db);
  const routeContract = selectedWorkflowContract(runtime.db, projectId, runtime.get(runId).workflow_id);
  const policy = loadOperationalPolicy(runtime.db, projectId, runtime.get(runId).workflow_id, level);
  const approvalBeforeWork = Boolean(routeContract?.approval?.before_productive_work);
  const preparedPlan = approvalGranted && approvalBeforeWork ? storedAuthorizedPlan(runtime.db, runId) : null;
  // A workflow with no declared shape at all falls back to the platform roles. One that declares its
  // shape and omits planning is a different thing: the plan is what names the steps to execute, so
  // there is nothing to run, and the literal fallback used to report that as a missing role instead.
  const plannerRole = routeContract ? routeContract.planner_role : "planner";
  const reviewerRole = routeContract?.reviewer_role ?? "reviewer";
  const documentatorRole = routeContract?.documentator_role ?? "documentator";
  const plannerContract = plannerRole ? loadRoleContract(runtime.db, projectId, plannerRole, level) : null;
  if (plannerContract?.allowed_work_types.length && !plannerContract.allowed_work_types.includes(classification.work_type) && !plannerContract.allowed_work_types.includes("*")) throw new Error(`ROLE_WORK_TYPE_NOT_ALLOWED: planner:${classification.work_type}`);
  // Planning a second time in the same run is a new step, not the old one reopened: the first planning
  // call happened, produced its questions and is history. A run holds one step per key, so the replan
  // gets its own, the way a correction cycle does.
  const planningAttempts = preparedPlan ? 0 : runtime.db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND (step_key='planning' OR step_key LIKE 'replan!_%' ESCAPE '!')").get(runId).count;
  const planningKey = planningAttempts ? `replan_${planningAttempts}` : "planning";
  const stepKeyOf = key => (planningAttempts ? `replan_${planningAttempts}_${key}` : key);
  if (!preparedPlan) {
    runtime.plan(runId, { objective: message, authority: definition.authority ?? "registered project documents", steps: plannerContract ? [{ key: planningKey, role: plannerRole, max_attempts: plannerContract.max_correction_cycles + 1 }] : [] });
    queue.enqueueRun(runId);
  }
  const allRegisteredRoles = runtime.db.prepare("SELECT id FROM roles ORDER BY id").all().map(row => row.id);
  const routeRoles = (approvalGranted || approvalBeforeWork) && routeContract?.worker_roles_after_approval.length ? routeContract.worker_roles_after_approval : routeContract?.worker_roles;
  const registeredRoles = routeContract ? routeRoles.filter(role => allRegisteredRoles.includes(role)) : allRegisteredRoles;
  if (!registeredRoles.length) throw new Error(`WORKFLOW_ROUTE_HAS_NO_EXECUTABLE_ROLE: ${runtime.get(runId).workflow_id}`);
  const allRegisteredChecks = registeredProjectCheckKeys(runtime.db, projectId, level, classification.artifact_type);
  const registeredChecks = routeContract?.check_keys.length ? allRegisteredChecks.filter(check => routeContract.check_keys.includes(check)) : allRegisteredChecks;
  const registeredArtifactTypes = runtime.db.prepare("SELECT id FROM artifact_types ORDER BY id").all().map(row => row.id);
  // Naming the roles is not enough: a role that may not edit will refuse an editing step, and the plan
  // is then unsatisfiable from the moment it is written. The planner needs each role's purpose and its
  // boundaries so it can put the work where the work is permitted.
  // A role the planner may name but whose contract this project does not carry still has to appear, or
  // the planner would be validated against a role it was never shown.
  const roleCapabilities = registeredRoles.map(role => {
    let contract; try { contract = loadRoleContract(runtime.db, projectId, role, level); } catch { return { id: role }; }
    return { id: role, purpose: contract.purpose, boundaries: contract.boundaries, allowed_work_types: contract.allowed_work_types, allowed_artifact_types: contract.allowed_artifact_types, allowed_tools: contract.allowed_tools };
  });
  // Review and documentation run as their own phases after the worker steps, so a plan that assigns
  // a document write to a worker step asks a role to do work the route never gave it. The planner has
  // to know what happens after its steps in order to stop at the right place.
  const followingPhases = [
    { phase: "verification", runs: "runs every registered check listed below and records the gate", role: null, checks: registeredChecks },
    { phase: "review", runs: "independent review when the quality contract requires it", role: reviewerRole },
    { phase: "documentation", runs: classification.document_required ? "applies the required registered document change" : "applies a registered document change when one is required", role: documentatorRole }
  ];
  // Naming the later phases was not enough on its own: a plan still spent a worker step on defining the
  // verification gates, which is the verification phase's own work given to a role that may not do it.
  // The boundary has to be stated, not left to be inferred from the list.
  const planBoundary = {
    covers: "only the steps the worker roles below execute before verification",
    excludes: followingPhases.map(item => `${item.phase}: ${item.runs}`),
    rule: "Do not plan a step for work a following phase already performs, and assign every step to a role whose allowed_work_types and boundaries permit that step."
  };
  // A plan step is rejected when its role is not one the route may execute, so the planner has to be
  // told which roles those are. Checks and artifact types were already named here; the roles were
  // validated against a list the planner never saw, and it filled the gap by naming itself.
  // The aliases a plan may choose from, without the authorities behind them: which host or path an alias
  // resolves to is the installation's material and is neither the model's business nor safe in a prompt.
  const registeredStepResources = registeredProjectResources(runtime.db, projectId);
  const plannerPackage = { objective: message, classification: { work_type: classification.work_type, artifact_type: classification.artifact_type, risk: classification.risk, quality_mode: classification.quality_mode }, registered_roles: roleCapabilities, plan_boundary: planBoundary, following_phases: followingPhases, registered_checks: registeredChecks, registered_artifact_types: registeredArtifactTypes, registered_resources: registeredStepResources };
  plannerPackage.collection_contract = {
    source_matches: "Ranked locator evidence. It is deliberately excerpted and may cap returned result files; use exact_term_index and completeness to distinguish a result cap from an incomplete corpus scan.",
    worker_sources: "After planning, the platform supplies each worker with contents, relevant ranges and complete-file exact-term scan results for its allowed_paths. Workers consume those supplied results and do not rerun shell or file searches. The planner must select paths and assign investigation steps; it must not request full source bodies for itself.",
    decomposition_rule: "A broad static trace that needs more than four source paths or separately covers producers, consumers and tests must be split into sequential read-only investigation steps of at most four paths each. Reuse the registered read-only role when appropriate. Every later step receives compact structured findings from earlier steps, so a final synthesis step can combine the chain without putting the whole repository into one invocation. These intermediate findings are worker result evidence, not file artifacts: do not add intermediate entries to plan.artifacts and set artifact_keys=[] on every read-only investigation step. For a documentation request, plan.artifacts contains only the one final path requested by the owner; the documentator creates it after review.",
    trace_rule: "For an end-to-end behavior trace, prioritize production definitions, their production call sites, persistence boundaries and focused tests. Put discovered production symbol names and exact line anchors into the relevant worker objective so collection can retain their complete enclosing functions. A reference catalog or similarly named future subsystem is supporting evidence only when a resolved graph edge or an exact production call site connects it to the requested runtime behavior. Keep separate mechanisms separate instead of substituting one FBO/FBS/rFBS occurrence for another.",
    clarification_rule: "Ask the owner only for a missing product decision or external fact. A need for more registered source content is a worker investigation step, not an owner clarification."
  };
  let plannerSourceMatches = null, corpusExactScan = null;
  if (plannerContract) {
    const scope = sourceScope(discovery.source_scope);
    const expanded = expandTerms(discovery.roots ?? [], scope, message);
    const lexical = searchSources(discovery.roots ?? [], scope, expanded.terms, { indexedTerms: expanded.code });
    const intelligence = buildCodeIntelligence(discovery.roots ?? [], scope, expanded.terms, lexical, { primaryTerms: expanded.code, contextTerms: expanded.subject });
    plannerSourceMatches = { ...mergeGraphMatches(lexical, intelligence), derived_from: { request_words: expanded.subject, identifiers: expanded.harvested } };
    // Corpus-wide claims are expensive primary evidence, so scan only identifiers explicitly supplied
    // by the owner. Harvested bridge terms remain locator hints; promoting all of them to complete-scan
    // obligations would bloat every worker and reviewer packet with facts nobody requested.
    if (expanded.code.length) {
      corpusExactScan = scanSourceCorpus(discovery.roots ?? [], scope, expanded.code);
      corpusExactScan = recordCorpusExactScan(runtime, runId, null, corpusExactScan);
    }
  }
  const planner = !preparedPlan && plannerContract && await invokeRole({ runtime, queue, runId, roleId: plannerRole, level, taskRoot, packageContract: plannerPackage, context: boundedContext(discovery, plannerRole, classification, Math.floor(plannerContract.context_limit_bytes / 2), responseLanguage, {
    source_inventory: inventorySummary(discovery.sources ?? []),
      // An inventory says what exists; it does not say where the thing the owner asked about lives, and
      // in a project of a thousand files choosing paths by name is guessing. The identifiers are already
      // in the message, so the platform searches the declared scope for them before the planner is called
      // and hands over the files that actually mention them.
      source_matches: plannerSourceMatches
    }), schemaKey: "planner.v1", parseOptions: { registeredRoles, registeredChecks, registeredArtifactTypes, registeredResources: registeredStepResources, maxStepAttempts: policy.limits.correction_cycles + 1 }, gatewayCall });
  let plan = preparedPlan ?? (planner ? planner.result : derivePlanFromTemplates(runtime, projectId, routeContract, message, registeredChecks, level, classification.document_required, documentatorRole, approvalGranted || approvalBeforeWork));
  if (!preparedPlan) {
    if (classification.document_required) registerNewPlannedDocument(runtime, projectId, projectRoot, plan, documentatorRole);
    applyPlannerToDatabase(runtime, runId, plan);
  }
  if (planner) {
    planner.complete({ outcome: plan.outcome });
    if (plan.outcome === "questions") {
      const taskId = runtime.get(runId).task_id;
      // Nothing may still be holding a lease or half-running while the owner is asked: the question is
      // being asked precisely because nothing else can move, and the answer may change what those steps
      // were going to do.
      quiesceRun(runtime.db, runId, "planner clarification opened");
      const opened = plan.questions.map(question => openClarification(runtime.db, { taskId, runId, kind: "planner_clarification", question, reason: "the plan cannot be completed without this decision" }));
      runtime.setState(runId, "clarification_required", { reason: "planner needs clarification" });
      return { status: "clarification_required", questions: plan.questions, interaction_ids: opened };
    }
  }
  if (classification.document_required && !plan.artifacts.some(item => item.type === "document" && item.required)) throw new Error("PLAN_REQUIRED_DOCUMENT_ARTIFACT_MISSING");
  if (!preparedPlan) appendExecutionSteps(runtime, runId, projectId, plan, stepKeyOf(""));
  // Consent is requested only after the exact plan has been persisted. The pending worker and gate steps
  // are part of the bound checkpoint but are not enqueued, leased or executed until the owner approves
  // that hash. Resuming reads this plan instead of asking a model to produce a different one after consent.
  if (approvalBeforeWork && !approvalGranted) return requireWorkflowApproval(runtime, runId, routeContract, responseLanguage);
  queue.enqueueRun(runId);
  runtime.setState(runId, "executing", { reason: "structured plan authorized" });
  captureRunBaselines(runtime.db, runId, projectRoots(runtime.db, projectId), { sourceScopeNarrowed: sourceScope(discovery.source_scope).narrowed });
  const workerResults = [];
  const executeWorkers = async (cycle = 0, priorGate = null, selectedSteps = plan.steps, correctionReview = null) => {
    const cycleResults = [];
    for (const plannedStep of selectedSteps) {
    const contract = loadRoleContract(runtime.db, projectId, plannedStep.role, level);
    const reviewGap = correctionReview ? { blockers: correctionReview.blockers ?? [], required_actions: correctionReview.required_actions ?? [], evidence_refs: correctionReview.evidence_refs ?? [] } : null;
    const packageContract = { objective: plannedStep.objective, allowed_paths: plannedStep.allowed_paths, artifact_keys: plannedStep.artifact_keys, check_ids: plannedStep.check_ids, plan_hash: structuredHash(plan), correction_cycle: cycle, gate_failures: priorGate?.checks?.filter(check => check.required && check.status !== "passed") ?? [], review_gap: reviewGap };
    // A planner commonly shortens the worker objective and leaves exact paths, identifiers or line
    // ranges in the original request and its evidence inputs. Source selection needs that complete
    // search intent even though the worker's authority remains the narrower package contract.
    const supplementalSourceQuery = [message, ...(plan.inputs ?? []), ...(reviewGap?.blockers ?? []).flatMap(blocker => [blocker.code, blocker.message, blocker.path]), ...(reviewGap?.required_actions ?? []), ...(reviewGap?.evidence_refs ?? [])].filter(Boolean).join("\n");
    // Sequential analysis steps build one evidence chain. A later synthesis/handoff step must receive
    // completed worker findings even when its own allowed_paths contains only a not-yet-created output
    // document; rereading files is neither necessary nor a substitute for the earlier conclusions.
    const taskEvidence = {
      plan_inputs: plan.inputs ?? [],
      prior_worker_results: compactPriorWorkerResults(priorWorkerResultsForStep([...workerResults, ...cycleResults], plannedStep.key, correctionReview)),
      code_intelligence: compactCodeIntelligenceEvidence(plannerSourceMatches),
      corpus_exact_scan: compactCorpusExactScan(corpusExactScan, { intent: plannedStep.objective }),
      git_history: collectGitHistory(discovery.roots ?? [], plannedStep.allowed_paths, sourceScope(discovery.source_scope), { enabled: discovery.git?.enabled === true })
    };
    const qualityContract = loadQualityContract(runtime.db, level);
    const makeContext = (sourceBudget, contextBudget) => boundedContext(discovery, plannedStep.role, classification, contextBudget, responseLanguage, {
      task_evidence: taskEvidence,
      sources: collectSourceFiles(discovery.roots ?? [], plannedStep.allowed_paths, sourceScope(discovery.source_scope), sourceBudget, { query: plannedStep.objective, supplementalQuery: supplementalSourceQuery })
    });
    // Source collection used to spend 80% of the role limit before the role contract, package contract,
    // path-bound history and JSON envelope were measured. Final prompt fitting then removed the overflow
    // with a raw prefix cut, which could discard a complete requested range that the collector had already
    // selected. Measure the real fixed envelope and recollect against the actual remainder instead. The
    // small reserve covers per-file and per-segment metadata, and the loop makes that estimate exact.
    let sourceBudget = Math.floor(contract.context_limit_bytes * 0.8);
    let probeContext;
    for (let pass = 0; pass < 4; pass += 1) {
      probeContext = makeContext(sourceBudget, 0);
      const measured = Buffer.byteLength(rolePrompt({ contract, qualityContract, packageContract, context: probeContext, resultSchema: "worker.v1" }));
      if (measured <= contract.context_limit_bytes) break;
      sourceBudget = Math.max(0, sourceBudget - (measured - contract.context_limit_bytes) - 512);
    }
    const workerContext = makeContext(sourceBudget, contract.context_limit_bytes);
    recordRunEvidence(runtime.db, runId, null, "worker_source", {
      plan_step: plannedStep.key,
      code_intelligence: reviewCodeIntelligenceEvidence(plannerSourceMatches),
      files: (workerContext.sources?.files ?? []).map(file => ({ path: file.path, segments: file.segments, exact_term_scan: file.exact_term_scan, supplied_bytes: file.supplied_bytes, text: file.text }))
    });
    let worker;
    try { worker = await invokeRole({ runtime, queue, runId, roleId: plannedStep.role, level, taskRoot, packageContract, context: workerContext, schemaKey: "worker.v1", parseOptions: { packageContract }, gatewayCall }); }
    catch (error) {
      if (error.code === "RUN_CANCELLED" || error.message === "RUN_CANCELLED") return { stopped: { status: "cancelled", planner: plan, workers: [...workerResults, ...cycleResults], gate: priorGate, reviewer: null } };
      throw error;
    }
    if (worker.result.status !== "completed") {
      worker.fail(`worker_${worker.result.status}`, worker.result.status === "failed");
      // A blocked worker used to end the run with nobody asked for what was missing. It now says which
      // of the two waits it is in, and the run parks in the state that names it: a fact that lives only
      // outside the project is asked for as evidence, a missing decision as a question, and a block that
      // is neither remains a block.
      const waiting = worker.result.status === "blocked"
        ? openWorkerWait(runtime, runId, plannedStep, worker)
        : null;
      const targetState = waiting ?? (worker.result.status === "blocked" ? "blocked" : "retry_scheduled");
      if (runtime.get(runId).state !== targetState) runtime.setState(runId, targetState, { reason: waiting ? `worker requires ${waiting}` : `worker returned ${worker.result.status}` });
      return { stopped: { status: targetState, planner: plan, workers: [...workerResults, ...cycleResults, worker.result], gate: priorGate, reviewer: null } };
    }
    try { verifyWorkerArtifacts(runtime, runId, worker.step.id, projectRoot, plan, plannedStep.artifact_keys, worker.result); }
    catch (error) {
      worker.fail(String(error.message).split(":")[0].slice(0, 120), false);
      throw error;
    }
    worker.complete({ status: worker.result.status });
    cycleResults.push({ ...worker.result, correction_cycle: cycle, plan_step: plannedStep.key });
    const control = applyRunControlAtBoundary(runtime.db, queue, runId);
    if (control) return { stopped: { status: control.action === "pause" ? "paused" : "cancelled", planner: plan, workers: [...workerResults, ...cycleResults], gate: priorGate, reviewer: null } };
    }
    workerResults.push(...cycleResults);
    return { stopped: null };
  };
  const firstWorkers = await executeWorkers();
  if (firstWorkers.stopped) return firstWorkers.stopped;

  let correctionCycles = 0;
  const strategyRecoveries = new Set();
  const recoveryKey = (kind, progress) => `${kind}:${progress?.latest?.semantic_fingerprint ?? progress?.latest?.primary_gap_fingerprint ?? "none"}`;
  const emergencyFuse = Math.min(12, Math.max(0, Number(policy.limits.correction_cycles) || 0));
  let gate = await executeGateStep({ runtime, queue, runId, stepKey: stepKeyOf("verification"), projectRoot, level, plannerResult: plan, classification, gateRunner, cycle: 0 });
  let reviewerResult = null;
  let reviewRequirement = reviewerRequirement(policy.contract, classification, correctionCycles, policy.project_escalations);
  while (true) {
    const boundaryControl = applyRunControlAtBoundary(runtime.db, queue, runId);
    if (boundaryControl) return { status: boundaryControl.action === "pause" ? "paused" : "cancelled", planner: plan, workers: workerResults, gate, reviewer: reviewerResult };
    if (gate.status !== "passed") {
      const progress = recordProgressSnapshot(runtime.db, runId, { cycle: correctionCycles, gate, allowedPaths: plan.allowed_paths });
      let recoveryRouting = null;
      const gateRecoveryKey = recoveryKey("gate", progress);
      if (progress.stagnating && !strategyRecoveries.has(gateRecoveryKey)) {
        const recovery = await executeStrategyRecovery({ runtime, queue, runId, projectId, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, plan, gate, reviewer: null, reviewEvidence: { verification: { gate } }, progress, cycle: correctionCycles });
        if (recovery.executed) strategyRecoveries.add(gateRecoveryKey);
        if (recovery.plan) { plan = recovery.plan; applyPlannerToDatabase(runtime, runId, plan); }
        const strictRouting = recoveryRoute(recovery), candidate = strictRouting.steps;
        if (candidate.length) recoveryRouting = strictRouting;
        else if (recovery.decision === "NO_VIABLE_STRATEGY") {
          runtime.setState(runId, "blocked", { reason: "strategy review found no viable bounded recovery" });
          return { status: "blocked", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, progress, strategy: recovery };
        }
      }
      if (correctionCycles >= emergencyFuse || (progress.stagnating && !recoveryRouting)) {
        runtime.setState(runId, progress.stagnating ? "blocked" : "changes_requested", { reason: progress.stagnating ? "gauntlet stagnation detected" : "required project gate not green" });
        return { status: progress.stagnating ? "blocked" : "changes_requested", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, progress };
      }
      runtime.db.prepare("UPDATE gates SET required=0 WHERE run_id=? AND kind=?").run(runId, `project_cycle_${correctionCycles}`);
      runtime.setState(runId, "changes_requested", { reason: "required project gate not green; targeted correction authorized" });
      correctionCycles += 1;
      let routing = recoveryRouting ?? targetedSteps(plan, { gate });
      if (!routing.steps.length) {
        recordRunEvidence(runtime.db, runId, null, "correction_routing_unresolved", routing);
        if (!strategyRecoveries.has(gateRecoveryKey)) {
          const recovery = await executeStrategyRecovery({ runtime, queue, runId, projectId, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, plan, gate, reviewer: null, reviewEvidence: { verification: { gate } }, progress, cycle: correctionCycles });
          if (recovery.executed) strategyRecoveries.add(gateRecoveryKey);
          if (recovery.plan) { plan = recovery.plan; applyPlannerToDatabase(runtime, runId, plan); }
          routing = recoveryRoute(recovery);
          if (recovery.decision === "NO_VIABLE_STRATEGY") {
            runtime.setState(runId, "blocked", { reason: "strategy review found no viable bounded gate recovery" });
            return { status: "blocked", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, progress, strategy: recovery };
          }
        }
        if (!routing.steps.length) {
          runtime.setState(runId, "changes_requested", { reason: "no supported correction route after bounded strategy review" });
          return { status: "changes_requested", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, routing };
        }
      }
      const selected = routing.steps;
      const requiredCalls = correctionCallFloor(runtime.db, projectId, reviewerRole, policy, classification, correctionCycles, selected.length);
      const remainingCalls = remainingWorkflowCalls(runtime.db, runId);
      if (remainingCalls < requiredCalls) {
        recordRunEvidence(runtime.db, runId, null, "correction_admission_rejected", { reason: "workflow_call_budget_minimum_unsatisfiable", progress_kind: "gate", remaining_calls: remainingCalls, required_calls: requiredCalls, selected_step_keys: selected.map(step => step.key), correction_cycle: correctionCycles });
        runtime.setState(runId, "blocked", { reason: "insufficient workflow calls for correction and its required review phase" });
        return { status: "blocked", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, progress, routing };
      }
      consumeCorrectionCycle(runtime, runId, correctionCycles);
      recordRunEvidence(runtime.db, runId, null, "correction_routing", { ...routing, progress_kind: "gate", semantic_gap_fingerprint: progress.latest?.semantic_fingerprint ?? progress.latest?.primary_gap_fingerprint ?? null, route_keys: selected.map(step => step.key), packet_hash_before: progress.latest?.packet_hash ?? null, semantic_fingerprint_before: progress.latest?.semantic_fingerprint ?? null, frontier_fingerprint_before: progress.latest?.frontier_fingerprint ?? null });
      appendCorrectionSteps(runtime, runId, projectId, plan, correctionCycles, selected, stepKeyOf(""));
      queue.enqueueRun(runId);
      runtime.db.prepare("UPDATE workflow_runs SET cycle=?,updated_at=? WHERE id=?").run(correctionCycles, now(), runId);
      runtime.setState(runId, "executing", { reason: `targeted correction ${correctionCycles}: ${selected.map(step => step.key).join(",")}` });
      const corrected = await executeWorkers(correctionCycles, gate, selected);
      if (corrected.stopped) return corrected.stopped;
      gate = await executeGateStep({ runtime, queue, runId, stepKey: stepKeyOf(`verification_${correctionCycles}`), projectRoot, level, plannerResult: plan, classification, gateRunner, cycle: correctionCycles });
      continue;
    }
    // A correction can make review mandatory even when the initial low-risk plan did
    // not require it, so this decision must be refreshed at the green boundary.
    reviewRequirement = reviewerRequirement(policy.contract, classification, correctionCycles, policy.project_escalations);
    if (!reviewRequirement.required) break;
    const reviewed = await executeIndependentReview({ runtime, queue, runId, projectId, reviewerRole, policy, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, reviewReason: reviewRequirement.reason, plan, gate, workerResults, correctionCycles });
    reviewerResult = reviewed.result;
    if (reviewed.budget_unavailable) {
      runtime.setState(runId, "blocked", { reason: "insufficient workflow calls for a complete admitted review phase" });
      return { status: "blocked", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, review_opinions: reviewed.opinions, review_evidence: reviewed.review_evidence };
    }
    if (reviewed.budget_exhausted) {
      runtime.setState(runId, "blocked", { reason: "post-factum cost budget exhausted after all admitted review members settled" });
      return { status: "blocked", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, review_opinions: reviewed.opinions, cost_budget: reviewed.cost_budget };
    }
    if (reviewerResult.decision === "PASS") {
      recordProgressSnapshot(runtime.db, runId, { cycle: correctionCycles, gate, reviewer: reviewerResult, reviewEvidence: reviewed.review_evidence, allowedPaths: plan.allowed_paths });
      break;
    }
    if (reviewerResult.decision === "REJECT") {
      runtime.setState(runId, "rejected", { reason: "independent review rejected result" });
      return { status: "rejected", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, review_opinions: reviewed.opinions };
    }
    const progress = recordProgressSnapshot(runtime.db, runId, { cycle: correctionCycles, gate, reviewer: reviewerResult, reviewEvidence: reviewed.review_evidence, allowedPaths: plan.allowed_paths });
    let recoveryRouting = null;
    const semanticRecoveryKey = recoveryKey("semantic_review", progress);
    if (progress.stagnating && !strategyRecoveries.has(semanticRecoveryKey)) {
      const recovery = await executeStrategyRecovery({ runtime, queue, runId, projectId, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, plan, gate, reviewer: reviewerResult, reviewEvidence: reviewed.review_evidence, progress, cycle: correctionCycles });
      if (recovery.executed) strategyRecoveries.add(semanticRecoveryKey);
      if (recovery.plan) { plan = recovery.plan; applyPlannerToDatabase(runtime, runId, plan); }
      if (recovery.review_again) continue;
      const strictRouting = recoveryRoute(recovery), candidate = strictRouting.steps;
      if (candidate.length) recoveryRouting = strictRouting;
      else if (recovery.decision === "NO_VIABLE_STRATEGY") {
        runtime.setState(runId, "blocked", { reason: "strategy review found no viable bounded recovery" });
        return { status: "blocked", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, review_opinions: reviewed.opinions, progress, strategy: recovery };
      }
    }
    if (correctionCycles >= emergencyFuse || (progress.stagnating && !recoveryRouting)) {
      runtime.setState(runId, progress.stagnating ? "blocked" : "changes_requested", { reason: progress.stagnating ? "repeated primary review gap" : "reviewer requested changes" });
      return { status: progress.stagnating ? "blocked" : "changes_requested", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, review_opinions: reviewed.opinions, progress };
    }
    runtime.setState(runId, "changes_requested", { reason: "primary review gap routed to targeted correction" });
    correctionCycles += 1;
    let routing = recoveryRouting ?? targetedSteps(plan, { reviewer: reviewerResult });
    if (!routing.steps.length) {
      recordRunEvidence(runtime.db, runId, null, "correction_routing_unresolved", routing);
      if (!strategyRecoveries.has(semanticRecoveryKey)) {
        const recovery = await executeStrategyRecovery({ runtime, queue, runId, projectId, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, plan, gate, reviewer: reviewerResult, reviewEvidence: reviewed.review_evidence, progress, cycle: correctionCycles });
        if (recovery.executed) strategyRecoveries.add(semanticRecoveryKey);
        if (recovery.plan) { plan = recovery.plan; applyPlannerToDatabase(runtime, runId, plan); }
        if (recovery.review_again) continue;
        routing = recoveryRoute(recovery);
        if (recovery.decision === "NO_VIABLE_STRATEGY") {
          runtime.setState(runId, "blocked", { reason: "strategy review found no viable bounded semantic recovery" });
          return { status: "blocked", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, review_opinions: reviewed.opinions, progress, strategy: recovery };
        }
      }
      if (!routing.steps.length) {
        runtime.setState(runId, "changes_requested", { reason: "no supported review-gap route after bounded strategy review" });
        return { status: "changes_requested", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, review_opinions: reviewed.opinions, routing };
      }
    }
    const selected = routing.steps;
    const requiredCalls = correctionCallFloor(runtime.db, projectId, reviewerRole, policy, classification, correctionCycles, selected.length);
    const remainingCalls = remainingWorkflowCalls(runtime.db, runId);
    if (remainingCalls < requiredCalls) {
      recordRunEvidence(runtime.db, runId, null, "correction_admission_rejected", { reason: "workflow_call_budget_minimum_unsatisfiable", progress_kind: "semantic_review", semantic_gap_fingerprint: progress.latest?.semantic_fingerprint ?? progress.latest?.primary_gap_fingerprint ?? null, remaining_calls: remainingCalls, required_calls: requiredCalls, selected_step_keys: selected.map(step => step.key), correction_cycle: correctionCycles });
      runtime.setState(runId, "blocked", { reason: "insufficient workflow calls for correction and its required review phase" });
      return { status: "blocked", planner: plan, workers: workerResults, gate, reviewer: reviewerResult, review_opinions: reviewed.opinions, progress, routing };
    }
    consumeCorrectionCycle(runtime, runId, correctionCycles);
    recordRunEvidence(runtime.db, runId, null, "correction_routing", { ...routing, progress_kind: "semantic_review", semantic_gap_fingerprint: progress.latest?.semantic_fingerprint ?? progress.latest?.primary_gap_fingerprint ?? null, route_keys: selected.map(step => step.key), packet_hash_before: progress.latest?.packet_hash ?? null, semantic_fingerprint_before: progress.latest?.semantic_fingerprint ?? null, frontier_fingerprint_before: progress.latest?.frontier_fingerprint ?? null });
    appendCorrectionSteps(runtime, runId, projectId, plan, correctionCycles, selected, stepKeyOf(""));
    queue.enqueueRun(runId);
    runtime.db.prepare("UPDATE workflow_runs SET cycle=?,updated_at=? WHERE id=?").run(correctionCycles, now(), runId);
    runtime.setState(runId, "executing", { reason: `review-gap correction ${correctionCycles}: ${selected.map(step => step.key).join(",")}` });
    const corrected = await executeWorkers(correctionCycles, gate, selected, reviewerResult);
    if (corrected.stopped) return corrected.stopped;
    gate = await executeGateStep({ runtime, queue, runId, stepKey: stepKeyOf(`verification_${correctionCycles}`), projectRoot, level, plannerResult: plan, classification, gateRunner, cycle: correctionCycles });
  }
  if (routeContract?.approval && !approvalGranted) return { ...requireWorkflowApproval(runtime, runId, routeContract, responseLanguage), planner: plan, workers: workerResults, gate, reviewer: reviewerResult };
  return documentAndComplete({ runtime, queue, runId, projectId, projectRoot, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, policy, plan, gate, reviewerResult, documentatorRole, correctionCycles, workerResults, reviewRequirement });
}

// Documentation and completion are the phases that follow the owner's decision. A run that stopped for a
// decision after its work re-enters here with its recorded plan, gate and review, so continuing costs
// only the phases that never ran.
async function documentAndComplete({ runtime, queue, runId, projectId, projectRoot, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, policy, plan, gate, reviewerResult, documentatorRole, correctionCycles, workerResults, reviewRequirement }) {
  let documentation = null;
  if (classification.document_required) {
    const qualityOutcome = documentationOutcome(policy.contract, { gateStatus: gate.status, ownerAccepted: ownerAccepted(runtime, runId) });
    appendDocumentatorStep(runtime, runId, projectId, documentatorRole, qualityOutcome);
    queue.enqueueRun(runId);
    runtime.setState(runId, "documenting", { reason: reviewerResult ? "required documentation after reviewer PASS" : "required documentation after green deterministic gate" });
    const target = writableDocument(runtime, projectId, plan, documentatorRole);
    const documentatorContract = loadRoleContract(runtime.db, projectId, documentatorRole, level);
    const expectedVersion = documentVersion(path.resolve(projectRoot, target.path));
    const documentPackage = {
      document_id: target.id, path: target.path, authority: target.authority, expected_version: expectedVersion,
      required_operation: expectedVersion === null ? "create_document" : "update_section_or_supported_operation",
      delivery: "Return a documentator.v1 proposal only; the platform writes and lints the document atomically. Do not edit the filesystem.",
      verification_delivery: "The gate below has already run. Record its actual status and checks in the document; never describe a completed check as future work.",
      semantic_format: "markdown+xml_semantic",
      plan_hash: structuredHash(plan), reviewer_decision: reviewerResult?.decision ?? "NOT_REQUIRED", quality_outcome: qualityOutcome,
      completion_criteria: plan.completion_criteria,
      document_evidence: compactPriorWorkerResults(workerResults, 24_000),
      run_telemetry: preDocumentationTelemetry(runtime.db, runId),
      gate: {
        status: gate.status,
        summary: gate.summary ?? null,
        checks: gate.checks.map(check => ({
          id: check.id,
          name: check.name ?? check.id,
          status: check.status,
          required: check.required,
          exit_code: check.exit_code ?? null,
          duration_ms: check.duration_ms ?? null
        }))
      }
    };
    const documentator = await invokeRole({ runtime, queue, runId, roleId: documentatorRole, level, taskRoot, packageContract: documentPackage, context: boundedContext(discovery, documentatorRole, classification, documentatorContract.context_limit_bytes, responseLanguage), schemaKey: "documentator.v1", parseOptions: { allowedDocumentIds: [target.id] }, gatewayCall });
    try { documentation = applyRegisteredPatch({ db: runtime.db, runId, projectId, projectRoot, roleId: documentatorRole, proposal: documentator.result, qualityOutcome }); }
    catch (error) {
      documentator.fail("document_patch_failed", false);
      throw error;
    }
    runtime.db.prepare("INSERT INTO artifacts(id,task_id,run_id,step_id,kind,uri,content_hash,status,provenance_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id("artifact"), runtime.get(runId).task_id, runId, documentator.step.id, "document", target.path, documentation.afterVersion.replace(/^sha256:/, ""), "verified", JSON.stringify({ source: "documentator.v1", document_id: target.id }), now(), now());
    runtime.db.prepare("UPDATE gateway_calls SET artifact_ref=? WHERE run_id=? AND step_id=?").run(target.id, runId, documentator.step.id);
    documentator.complete({ document_id: target.id, after_version: documentation.afterVersion });
    runtime.setState(runId, "documented", { reason: "required document patch applied and linted" });
  }
  runtime.setState(runId, "completed", { reason: "all structured role contracts and required gates completed" });
  return { status: "completed", planner: plan, workers: workerResults, correction_cycles: correctionCycles, gate, reviewer: reviewerResult, review_requirement: reviewRequirement, documentation };
}

// A run stopped for a decision that follows its work already holds every result the remaining phases
// need: the plan in `plans` and `workflow_steps`, the verification in `gates`, the review in `decisions`.
// Reading that history back is what makes continuing possible without repeating, and paying for, the
// work that was already done.
export function recordedRunResults(db, runId) {
  const row = db.prepare("SELECT * FROM plans WHERE run_id=?").get(runId);
  if (!row) throw new Error(`RUN_HAS_NO_PLAN: ${runId}`);
  const steps = db.prepare("SELECT * FROM workflow_steps WHERE run_id=? AND result_schema_key='worker.v1' ORDER BY ordinal").all(runId);
  const planned = steps.filter(step => !step.step_key.startsWith("correction_"));
  if (!planned.length) throw new Error(`RUN_HAS_NO_EXECUTED_STEPS: ${runId}`);
  const storedSteps = parseJson(row.steps_json, []);
  const plan = {
    schema_version: row.schema_version ?? 1,
    outcome: row.outcome,
    scope: parseJson(row.scope_json, { included: [], excluded: [] }),
    allowed_paths: parseJson(row.allowed_paths_json, []),
    inputs: parseJson(row.inputs_json, []),
    checks: parseJson(row.checks_json, []),
    risks: parseJson(row.risks_json, []),
    artifacts: parseJson(row.artifacts_json, []),
    completion_criteria: parseJson(row.completion_criteria_json, []),
    questions: parseJson(row.questions_json, []),
    steps: storedSteps.length ? storedSteps : planned.map(step => {
      const contract = parseJson(step.contract_json, {});
      return { key: step.step_key, role: step.role_id, objective: contract.objective ?? row.objective, allowed_paths: contract.allowed_paths ?? [], artifact_keys: contract.artifact_keys ?? [], check_ids: contract.check_ids ?? [], resources: [], required: step.required === 1, irreversible: step.irreversible === 1, max_attempts: step.max_attempts };
    })
  };
  const gateRow = db.prepare("SELECT * FROM gates WHERE run_id=? AND kind LIKE 'project_cycle_' || '%' ORDER BY rowid DESC LIMIT 1").get(runId);
  if (!gateRow) throw new Error(`RUN_HAS_NO_GATE: ${runId}`);
  const review = db.prepare("SELECT structured_json FROM decisions WHERE run_id=? AND kind='review' AND active=1 ORDER BY created_at DESC LIMIT 1").get(runId);
  return {
    plan,
    gate: parseJson(gateRow.details_json, { status: gateRow.status, checks: [] }),
    reviewer: review ? parseJson(review.structured_json, null) : null,
    workers: steps.map(step => parseJson(step.result_json, null)).filter(Boolean),
    correction_cycles: Number(String(gateRow.kind).replace("project_cycle_", "")) || 0
  };
}

// Continuing a run whose decision followed its work runs only what the decision was blocking. The
// alternative was to re-enter the run from its objective, which would repeat every completed step, so
// this path deliberately never touches the worker, verification or review phases again.
export async function continueApprovedRun({ runtime, runId, discovery, responseLanguage = "en", taskRoot, gatewayCall }) {
  const { classification } = pausedRunObjective(runtime.db, runId);
  const recorded = recordedRunResults(runtime.db, runId);
  const level = operationalLevel(classification.quality_mode);
  const projectId = runtime.get(runId).project_id;
  const routeContract = selectedWorkflowContract(runtime.db, projectId, runtime.get(runId).workflow_id);
  const policy = loadOperationalPolicy(runtime.db, projectId, runtime.get(runId).workflow_id, level);
  return documentAndComplete({
    runtime, queue: new ExecutionQueue(runtime.db), runId, projectId, projectRoot: discovery.project.root_path, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, policy,
    plan: recorded.plan, gate: recorded.gate, reviewerResult: recorded.reviewer, documentatorRole: routeContract?.documentator_role ?? "documentator",
    correctionCycles: recorded.correction_cycles, workerResults: recorded.workers,
    reviewRequirement: { required: Boolean(recorded.reviewer), reason: recorded.reviewer ? "review recorded before the owner decision" : "not required" }
  });
}
