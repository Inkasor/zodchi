import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "../src/runtime.mjs";
import { ExecutionQueue } from "../src/execution-queue.mjs";
import { BudgetManager } from "../src/budget.mjs";
import { now } from "../src/db.mjs";
import { buildReviewEvidence, captureRunBaselines, claimCenteredReviewEvidence, recordRunEvidence, runChangeEvidence } from "../src/run-evidence.mjs";
import { applyRunControlAtBoundary, blockerFingerprint, requestRunControl } from "../src/progress-supervisor.mjs";
import { consiliumRoles, priorWorkerResultsForStep, targetedSteps } from "../src/work-executor.mjs";
import { callGateway } from "../src/gateway.mjs";
import { transactionAwaitViolations } from "../src/transaction-guard.mjs";
import { DEFAULT_QUALITY_CONTRACTS } from "../src/quality-contracts.mjs";
import { rolePrompt } from "../src/role-contracts.mjs";
import { reviewerPromptContext, reviewerTaskPackage } from "../src/work-executor.mjs";
import { completionBlockers } from "../src/state-machine.mjs";
import { blockerAdmissibility, admissibleOpinionDecision, hasSupportedFactualBlocker } from "../src/review-admissibility.mjs";
import { executeTargetedVerification } from "../src/targeted-verification.mjs";

const CLASSIFICATION = { kind: "task", domain: "workflow", discipline: "general", risk: "low", level: "L2", quality: "mvp", planning_required: true, human_required: false, document_required: false };
const temp = prefix => fs.mkdtempSync(path.join(process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(), prefix));
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });

function fixture(prefix, message = "Точная исходная формулировка владельца — без пересказа.") {
  const root = temp(prefix), projectRoot = path.join(root, "project"), runtime = new Runtime(path.join(root, "workflow.sqlite"));
  fs.mkdirSync(projectRoot, { recursive: true });
  runtime.db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(projectRoot, now());
  runtime.db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status) VALUES('workflow','Workflow','project','mvp','L2','active')").run();
  const runId = runtime.create(message, { project_id: "project", workflow_id: "workflow", event_source: "test" });
  runtime.db.prepare("INSERT INTO conversation_messages(id,project_id,run_id,role,content,created_at,language) VALUES('owner-message','project',?,'user',?,?, 'ru')").run(runId, message, now());
  runtime.classify(runId, CLASSIFICATION);
  runtime.plan(runId, { objective: "planner may paraphrase", steps: [{ key: "worker" }] });
  runtime.setState(runId, "executing");
  return { root, projectRoot, runtime, runId, queue: new ExecutionQueue(runtime.db), budgets: new BudgetManager(runtime.db), close() { runtime.db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function initGit(root) {
  git(root, "init", "-q"); git(root, "config", "user.email", "gauntlet@example.invalid"); git(root, "config", "user.name", "Gauntlet Test");
  fs.writeFileSync(path.join(root, "allowed.js"), "export const allowed = 1;\n");
  fs.writeFileSync(path.join(root, "outside.js"), "export const outside = 1;\n");
  git(root, "add", "."); git(root, "commit", "-qm", "baseline");
}

test("A: reviewer evidence preserves the verbatim owner objective and canonical blockers", () => {
  const fx = fixture("gauntlet-owner-");
  try {
    captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
    const taskId = fx.runtime.get(fx.runId).task_id;
    fx.runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,step_id,kind,outcome,source,structured_json,active,created_at) VALUES('old-review',?,?,NULL,'review','CHANGES_REQUESTED','reviewer','{}',1,?)").run(taskId, fx.runId, now());
    const evidence = buildReviewEvidence(fx.runtime.db, fx.runId, { plan: { completion_criteria: ["planner claim"] }, gate: { status: "passed", checks: [] }, workerResults: [], allowedPaths: [] });
    assert.equal(evidence.owner_objective.verbatim, "Точная исходная формулировка владельца — без пересказа.");
    assert.equal(evidence.owner_objective.source, "conversation_messages");
    assert.ok(Array.isArray(evidence.canonical_completion.blockers));
    assert.ok(completionBlockers(fx.runtime.db, taskId).some(item => item.kind === "rejecting_decisions"));
    assert.ok(!evidence.canonical_completion.blockers.some(item => item.kind === "rejecting_decisions"));
    assert.equal(evidence.planner_advisory.authority, "advisory");
  } finally { fx.close(); }
});

test("claim-centered review packet records primary coverage and an explicit API-to-UI gap", () => {
  const source = (plan_step, path, text, code_intelligence = null) => ({ plan_step, evidence_hash: `hash-${plan_step}`, code_intelligence, files: [{ path, text: `--- lines 1-20 (claim anchor) ---\n${text}`, segments: [{ start_line: 1, end_line: 20, reason: "claim anchor", complete: true }], exact_term_scan: { scope: "complete_file", match: "literal_case_insensitive", occurrences: [{ term: "avgCost", count: 1, matched_lines: 1, locations: [{ line: 2, text }], locations_truncated: false }] } }] });
  const sources = [
    source("producer", "scripts/marketplace-scheme-profit.mjs", "function legacyUpdateRow(avgCost) { return avgCost; }"),
    source("transform", "scripts/dashboard-query-service.mjs", "function buildProductDailyDetails(avgCost) { return { avgCost }; }"),
    source("api", "scripts/dev-api-server.mjs", "res.json(await buildProductDailyDetails());"),
    source("client", "src/main.jsx", "function normalizeServerModelCost(response) { setModel(response); }")
  ];
  const workers = sources.map(item => ({ plan_step: item.plan_step, status: "completed", summary: `${item.plan_step} material claim`, evidence: [`${item.files[0].path}:1-20`] }));
  const packet = claimCenteredReviewEvidence(workers, sources, "Trace producer through API to UI consumer");
  assert.ok(packet.claims.every(claim => claim.primary_evidence_refs.length >= 1 && claim.coverage === "sufficient"));
  assert.ok(packet.claims.every(claim => !Object.hasOwn(claim, "summary") && !Object.hasOwn(claim, "conclusion") && !Object.hasOwn(claim, "evidence")));
  assert.equal(packet.cross_layer_chains[0].coverage, "incomplete");
  assert.equal(packet.cross_layer_chains[0].anchors.ui_consumer, null);
  assert.ok(packet.cross_layer_chains[0].unknown_edges.includes("state_model->ui_consumer"));
  assert.deepEqual(packet.cross_layer_chains[0].missing_edges, []);
  assert.equal(new Set(packet.source_range_catalog.map(range => range.range_id)).size, packet.source_range_catalog.length);
  assert.ok(packet.source_evidence.flatMap(item => item.files).length < sources.flatMap(item => item.files).length + 1);
});

test("matching endpoint fields stay unknown without a concrete assignment or mapping transition", () => {
  const source = (plan_step, path, text) => ({ plan_step, evidence_hash: `hash-${plan_step}`, files: [{ path, text: `--- lines 1-20 (edge anchor) ---\n${text}`, segments: [{ start_line: 1, end_line: 20, reason: "edge anchor", complete: true }] }] });
  const sources = [
    source("producer", "scripts/import-mp-daily.mjs", "producerFields.add('avgCost');"),
    source("api", "scripts/dashboard-query-service.mjs", "responseFields.add('avgCost');"),
    source("client", "src/client.js", "requestedFields.add('avgCost');"),
    source("state", "src/state.js", "const [stateFields] = useState(['avgCost']);"),
    source("ui", "src/View.jsx", "visibleColumns.add('avgCost');")
  ];
  const workers = sources.map(item => ({ plan_step: item.plan_step, status: "completed", summary: item.plan_step, evidence: [`${item.files[0].path}:1-20`] }));
  const packet = claimCenteredReviewEvidence(workers, sources, "Trace avgCost from API to UI");
  const chain = packet.cross_layer_chains[0];
  assert.equal(chain.coverage, "incomplete");
  assert.equal(chain.observed_edges.length, 0);
  assert.ok(chain.edge_coverage.every(edge => edge.status === "unknown"));
  assert.ok(chain.edge_coverage.every(edge => edge.candidate_symbols.includes("avgCost")));
  assert.equal(packet.derived_edge_catalog.length, 0);
});

test("bounded evidence cannot make an absence blocker factually admissible", () => {
  const evidence = {
    base_evidence_hash: "packet-1",
    evidence_compaction: { source_text_reduced: true, metadata_reduced: false },
    claim_coverage: [{ claim_type: "cross_layer_chain", coverage: "incomplete", unknown_edges: ["client->state"] }]
  };
  const opinions = [{ role: "reviewer", result: { decision: "REJECT", evidence_refs: ["packet-1"], blockers: [{ code: "MISSING_CLIENT_STATE_EDGE", message: "No client to state edge exists", path: null }] } }];
  const result = blockerAdmissibility(opinions, evidence);
  assert.equal(result[0].status, "unknown");
  assert.match(result[0].reason, /cannot prove absence/);
});

test("a positive referenced exact scan contradicts an absence blocker", () => {
  const evidence = { exact_scan_catalog: [{ scan_id: "scan-1", occurrences: [{ term: "avgCost", count: 3 }] }] };
  const opinions = [{ role: "reviewer", result: { decision: "REJECT", evidence_refs: ["scan-1"], blockers: [{ code: "AVG_COST_ABSENT", message: "avgCost is absent", path: null }] } }];
  assert.equal(blockerAdmissibility(opinions, evidence)[0].status, "contradicted");
});

test("structured review packet paths support a factual cross-layer inconsistency blocker", () => {
  const evidence = {
    owner_objective: { verbatim: "An observed edge requires transition provenance; otherwise it is unknown." },
    analytical_evidence: { conclusions: [{ summary: "API response to client mapping is observed locally." }] },
    cross_layer_chains: [{ edge_coverage: [{ edge: "api->client_mapping", status: "unknown" }] }]
  };
  const opinion = { role: "adversarial_reviewer", result: {
    decision: "CHANGES_REQUESTED",
    evidence_refs: [
      "owner_objective.verbatim: owner constraint",
      "review_evidence.analytical_evidence.conclusions[0]: claimed observed",
      "task_package.review_evidence.cross_layer_chains[0].edge_coverage[0]: canonical unknown"
    ],
    blockers: [{ code: "UNSUPPORTED_API_TO_CLIENT_EDGE", message: "The conclusion claims an observed edge while canonical evidence says unknown.", path: "docs/analysis.md" }]
  } };
  const result = blockerAdmissibility([opinion], evidence);
  assert.equal(result[0].status, "supported");
  assert.equal(result[0].unresolvable_evidence_refs.length, 0);
  assert.equal(admissibleOpinionDecision(opinion, result), "CHANGES_REQUESTED");
  assert.equal(hasSupportedFactualBlocker(result), true);
});

test("invalid or unsafe structured evidence paths remain unresolved", () => {
  const evidence = { owner_objective: { verbatim: "objective" } };
  const opinion = { role: "reviewer", result: { decision: "REJECT", evidence_refs: ["review_evidence.owner_objective.missing", "review_evidence.__proto__.polluted"], blockers: [{ code: "EVIDENCE_INVALID", message: "Evidence is invalid", path: null }] } };
  const result = blockerAdmissibility([opinion], evidence);
  assert.equal(result[0].status, "unknown");
  assert.equal(result[0].unresolvable_evidence_refs.length, 2);
});

test("typed targeted verification distinguishes observed, missing and unknown", () => {
  const evidence = { exact_scan_catalog: [{ scan_id: "scan-a", path: "src/a.ts", scope: "complete_file", occurrences: [{ term: "avgCost", count: 2 }, { term: "missingField", count: 0 }] }] };
  const request = (subject, path = "src/a.ts") => ({ kind: "exact_term", subject, from: null, to: null, path, evidence_refs: [] });
  assert.equal(executeTargetedVerification(request("avgCost"), evidence).status, "observed");
  assert.equal(executeTargetedVerification(request("missingField"), evidence).status, "missing");
  assert.equal(executeTargetedVerification(request("unknownField", "src/b.ts"), evidence).status, "unknown");
});

test("a concrete response-field assignment creates an observed source-derived edge with transition provenance", () => {
  const source = (plan_step, path, text, code_intelligence = null) => ({ plan_step, evidence_hash: `hash-${plan_step}`, code_intelligence, files: [{ path, text: `--- lines 1-20 (edge anchor) ---\n${text}`, segments: [{ start_line: 1, end_line: 20, reason: "edge anchor", complete: true }] }] });
  const ast = { adapters: [{ name: "typescript-compiler", compiler_available: true, transitions: [{ id: "ts-transition-1", kind: "field_assignment", direction: "from_to", symbol_from: "avgCost", symbol_to: "avgCost", path: "src/client.js", line: 2, method: "typescript_ast" }] }], nodes: [], edges: [] };
  const sources = [
    source("producer", "scripts/import-mp-daily.mjs", "writeRow({ avgCost });"),
    source("api", "scripts/dashboard-query-service.mjs", "return { avgCost };"),
    source("client", "src/client.js", "const avgCost = response.avgCost;", ast),
    source("state", "src/state.js", "setModel({ avgCost });"),
    source("ui", "src/View.jsx", "return <div>{row.avgCost}</div>;")
  ];
  const workers = sources.map(item => ({ plan_step: item.plan_step, status: "completed", summary: item.plan_step, evidence: [`${item.files[0].path}:1-20`] }));
  const packet = claimCenteredReviewEvidence(workers, sources, "Trace avgCost from API to UI");
  const edge = packet.cross_layer_chains[0].edge_coverage.find(item => item.edge === "api->client_mapping");
  assert.equal(edge.status, "observed");
  assert.equal(edge.source_anchor_refs.length, 2);
  assert.ok(edge.transition_anchor_refs.length >= 1);
  assert.equal(edge.derived_edge_refs.length, 1);
  assert.equal(packet.derived_edge_catalog[0].kind, "field_assignment");
  assert.equal(packet.derived_edge_catalog[0].provenance.method, "typescript_ast");
});

test("a sufficient cross-layer claim has provenance for every observed edge", () => {
  const nodes = [
    ["producer", "scripts/marketplace-scheme-profit.mjs"], ["api", "scripts/dashboard-query-service.mjs"],
    ["client", "src/client.js"], ["state", "src/state.js"], ["ui", "src/View.jsx"]
  ].map(([id, path]) => ({ id, path, kind: "function", name: id, start_line: 1, end_line: 20 }));
  const edges = [["e1", "producer", "api"], ["e2", "api", "client"], ["e3", "client", "state"], ["e4", "state", "ui"]].map(([id, from, to]) => ({ id, from, to, type: "calls" }));
  const graph = { strategy: "lexical_to_language_graph", nodes, edges, adapters: [], completeness: { parsed_files: 5, eligible_files: 5 }, statistics: {} };
  const rows = [
    ["producer", nodes[0].path, "function legacyUpdateRow(avgCost) { return avgCost; }"],
    ["api", nodes[1].path, "res.json(await buildProductDailyDetails());"],
    ["client", nodes[2].path, "const data = await response.json();"],
    ["state", nodes[3].path, "setModel(normalizeServerModelCost(data));"],
    ["ui", nodes[4].path, "const View = () => <div>{profit}</div>;"]
  ];
  const sources = rows.map(([plan_step, path, text], index) => ({ plan_step, evidence_hash: `hash-${plan_step}`, code_intelligence: index === 0 ? graph : null, files: [{ path, text: `--- lines 1-20 (edge anchor) ---\n${text}`, segments: [{ start_line: 1, end_line: 20, reason: "edge anchor", complete: true }] }] }));
  const workers = sources.map(item => ({ plan_step: item.plan_step, status: "completed", summary: item.plan_step, evidence: [`${item.files[0].path}:1-20`] }));
  const chain = claimCenteredReviewEvidence(workers, sources, "Trace producer through API to UI").cross_layer_chains[0];
  assert.equal(chain.coverage, "sufficient");
  assert.equal(chain.observed_edges.length, chain.required_edges.length);
  assert.ok(chain.observed_edges.every(edge => edge.provenance_refs.length >= 3));
  assert.deepEqual(chain.unknown_edges, []);
});

test("targeted correction keeps only the latest result for its primary gap", () => {
  const results = [
    { plan_step: "api_ui", summary: "old packet" },
    { plan_step: "profit", summary: "unrelated packet" },
    { plan_step: "api_ui", summary: "latest packet" }
  ];
  assert.deepEqual(priorWorkerResultsForStep(results, "api_ui", { blockers: [] }).map(item => item.summary), ["latest packet"]);
  assert.equal(priorWorkerResultsForStep(results, "api_ui", null).length, 3);
  const reviewPackage = reviewerTaskPackage({}, "project_policy", 1, 4);
  assert.equal(reviewPackage.remaining_correction_cycles, 3);
});

test("B: analytical review retains conclusion and primary source evidence with an empty diff", () => {
  const fx = fixture("gauntlet-analytical-");
  try {
    captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
    fx.runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,step_id,kind,outcome,source,structured_json,active,created_at) VALUES('finding',?,? ,NULL,'artifact:finding','COMPLETED','worker',?,1,?)")
      .run(fx.runtime.get(fx.runId).task_id, fx.runId, JSON.stringify({ artifact_key: "finding", path: null, conclusion: "Importer misses the bootstrap edge" }), now());
    recordRunEvidence(fx.runtime.db, fx.runId, null, "worker_source", { code_intelligence: { anchors: ["importBootstrap"] }, files: [{ path: "src/importer.ts", text: "function importBootstrap() {}" }] });
    const evidence = buildReviewEvidence(fx.runtime.db, fx.runId, { plan: { completion_criteria: [] }, gate: { status: "passed", checks: [] }, workerResults: [{ plan_step: "research", summary: "Importer misses the bootstrap edge", evidence: ["src/importer.ts"] }], allowedPaths: [] });
    assert.equal(evidence.type, "analytical");
    assert.equal(evidence.change_evidence, null);
    assert.equal(evidence.analytical_evidence.decision_artifacts[0].conclusion, "Importer misses the bootstrap edge");
    assert.equal(evidence.source_evidence[0].files[0].path, "src/importer.ts");
  } finally { fx.close(); }
});

test("review evidence compacts large source and gate payloads under its measured envelope", () => {
  const fx = fixture("gauntlet-review-budget-");
  try {
    captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
    recordRunEvidence(fx.runtime.db, fx.runId, null, "worker_source", { code_intelligence: { anchors: ["criticalSymbol"] }, files: Array.from({ length: 12 }, (_, index) => ({ path: `src/${index}.ts`, text: `criticalSymbol${index}\n${"x".repeat(12_000)}` })) });
    const evidence = buildReviewEvidence(fx.runtime.db, fx.runId, { plan: { completion_criteria: [] }, gate: { status: "failed", checks: Array.from({ length: 20 }, (_, index) => ({ id: `gate-${index}`, required: true, status: "failed", failure: "failure ".repeat(2_000), execution_project_id: "project", execution_root: fx.projectRoot })) }, workerResults: [], allowedPaths: [] });
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= evidence.evidence_compaction.limit_bytes);
    assert.equal(evidence.code_intelligence_catalog[0].anchors[0], "criticalSymbol");
    assert.equal(evidence.source_evidence[0].files[0].path, "src/0.ts");
    assert.ok(evidence.source_evidence[0].files.every(file => file.source_ranges[0].text.length >= 512));
    assert.equal(evidence.verification.gate.checks[0].execution_project_id, "project");
  } finally { fx.close(); }
});

test("review evidence compacts repeated TS graph and exact-scan metadata without losing paths or counts", () => {
  const fx = fixture("gauntlet-review-real-metadata-");
  try {
    captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
    const code_intelligence = { strategy: "lexical_to_language_graph", adapters: [{ name: "typescript-compiler", files: 102, compiler_available: true, definitions: 12_143, resolved_references: 9_200, unresolved_calls: 15_770, unresolved_call_categories: { standard_library: 8663, external_dependency: 24, dynamic_or_untyped: 5779, project_internal_unmapped: 1304 }, unresolved_call_samples: { dynamic_or_untyped: Array.from({ length: 20 }, (_, index) => ({ path: `scripts/${index}.mjs`, line: index + 1, expression: "dynamicCall".repeat(100) })) }, semantic_diagnostics: 0 }] };
    for (let step = 0; step < 7; step += 1) recordRunEvidence(fx.runtime.db, fx.runId, null, "worker_source", { plan_step: `trace-${step}`, code_intelligence, files: Array.from({ length: 4 }, (_, file) => ({ path: `src/${step}-${file}.ts`, segments: [{ start_line: 1, end_line: 20, reason: "objective_match", complete: true }], exact_term_scan: { scope: "complete_file", match: "literal_case_insensitive", occurrences: Array.from({ length: 40 }, (_, term) => ({ term: `anchor-${term}`, count: term + 1, matched_lines: term + 1, locations: Array.from({ length: 8 }, (_, line) => ({ line: line + 1, text: "relevant source line ".repeat(50) })), locations_truncated: false })) }, text: "source body ".repeat(1_000), supplied_bytes: 12_000 })) });
    const workerResults = Array.from({ length: 7 }, (_, index) => ({ plan_step: `trace-${index}`, summary: "evidence-backed conclusion ".repeat(300), evidence: Array.from({ length: 20 }, (_, ref) => `src/${index}-${ref % 4}.ts:${ref + 1} ${"proof ".repeat(100)}`) }));
    const configuredContextLimit = 256 * 1024, reviewEvidenceLimit = Math.floor(configuredContextLimit * 7 / 10);
    const evidence = buildReviewEvidence(fx.runtime.db, fx.runId, { plan: { completion_criteria: [] }, gate: { status: "passed", checks: [] }, workerResults, allowedPaths: [], reviewEvidenceLimit });
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= evidence.evidence_compaction.limit_bytes);
    assert.equal(evidence.source_evidence.length, 7);
    assert.equal(evidence.source_evidence[6].files[3].path, "src/6-3.ts");
    assert.equal(evidence.code_intelligence_catalog.length, 1);
    assert.equal(evidence.source_evidence[6].code_intelligence_ref, evidence.code_intelligence_catalog[0].id);
    assert.ok(evidence.source_range_catalog.every(range => range.text.length >= 512));
    assert.ok(evidence.source_evidence.flatMap(item => item.files).every(file => file.source_range_refs.every(ref => evidence.source_range_catalog.some(range => range.range_id === ref))));
    const firstScan = evidence.exact_scan_catalog[0];
    const anchorEleven = firstScan.count_index?.["anchor-11"] ?? firstScan.occurrences.find(item => item.term === "anchor-11");
    assert.equal(anchorEleven.count, 12);
    assert.equal(evidence.code_intelligence_catalog[0].adapters[0].unresolved_call_categories.project_internal_unmapped, 1304);
    const contract = { role_id: "reviewer", version: "1.0.0", purpose: "Independently review immutable evidence.", boundaries: {}, allowed_tools: [], allowed_skills: [], prompt_template_version: "1.0.0", result_schema_key: "reviewer.v1", context_limit_bytes: configuredContextLimit };
    const prompt = rolePrompt({ contract, qualityContract: DEFAULT_QUALITY_CONTRACTS.find(item => item.level === "mvp"), packageContract: reviewerTaskPackage(evidence, "project_policy", 0), context: reviewerPromptContext({ work_type: "documentation", artifact_type: "document", risk: "medium", quality_mode: "mvp" }, "ru"), resultSchema: "reviewer.v1" });
    const promptBytes = Buffer.byteLength(prompt);
    assert.ok(promptBytes <= contract.context_limit_bytes, `reviewer prompt ${promptBytes}/${contract.context_limit_bytes}`);
  } finally { fx.close(); }
});

test("C-D: committed and initially dirty files remain visible in the run-relative Git delta", () => {
  for (const initiallyDirty of [false, true]) {
    const fx = fixture(`gauntlet-git-${initiallyDirty}-`);
    try {
      initGit(fx.projectRoot);
      if (initiallyDirty) fs.writeFileSync(path.join(fx.projectRoot, "outside.js"), "export const outside = 2;\n");
      captureRunBaselines(fx.runtime.db, fx.runId, [{ key: "primary", path: fx.projectRoot, access: "write" }]);
      fs.writeFileSync(path.join(fx.projectRoot, "outside.js"), `export const outside = ${initiallyDirty ? 3 : 2};\n`);
      git(fx.projectRoot, "add", "outside.js"); git(fx.projectRoot, "commit", "-qm", "worker commit");
      assert.equal(git(fx.projectRoot, "status", "--porcelain"), "");
      const delta = runChangeEvidence(fx.runtime.db, fx.runId, ["allowed.js"]);
      assert.ok(delta.run_changed_paths.includes("outside.js"));
      assert.ok(delta.unauthorized_changes.includes("outside.js"));
    } finally { fx.close(); }
  }
});

test("E: a local blocker selects exactly the affected plan step", () => {
  const plan = { steps: Array.from({ length: 5 }, (_, index) => ({ key: `step-${index}`, allowed_paths: [`src/${index}.ts`], check_ids: [`check-${index}`] })) };
  const selected = targetedSteps(plan, { gate: { checks: [{ id: "check-3", required: true, status: "failed", execution_project_id: "consumer", execution_root: "registered-consumer-root" }] } });
  assert.deepEqual(selected.steps.map(item => item.key), ["step-3"]);
  assert.equal(selected.confidence, "high");
});

test("a pathless review gap targets the source step named by top-level evidence refs", () => {
  const plan = { steps: [
    { key: "trace-profit", allowed_paths: ["scripts/dashboard-query-service.mjs"], check_ids: [] },
    { key: "synthesize", allowed_paths: [], check_ids: [] }
  ] };
  const reviewer = {
    blockers: [{ code: "PRIMARY_SOURCE_RANGES_MISSING", message: "Primary ranges are missing", path: null }],
    evidence_refs: ["scripts/dashboard-query-service.mjs:3336-3410"],
    required_actions: ["Collect the complete range from scripts/dashboard-query-service.mjs"]
  };
  assert.deepEqual(targetedSteps(plan, { reviewer }).steps.map(item => item.key), ["trace-profit"]);
});

test("a semantic API-to-UI gap targets the client source step instead of pathless synthesis", () => {
  const plan = { steps: [
    { key: "trace_api_contract", objective: "Trace storage to API response", allowed_paths: ["scripts/api.mjs"], check_ids: [] },
    { key: "trace_client_ui", objective: "Trace API response to client mapping, state model and UI consumer", allowed_paths: ["src/main.jsx"], check_ids: [] },
    { key: "synthesize", objective: "Combine the findings", allowed_paths: [], check_ids: [] }
  ] };
  const reviewer = {
    blockers: [{ code: "INCOMPLETE_CROSS_LAYER_CHAIN", message: "API to client mapping to state model to UI consumer is unknown", path: null }],
    evidence_refs: [],
    required_actions: ["Collect source anchors for API, client mapping, state model and UI consumer"]
  };
  assert.deepEqual(targetedSteps(plan, { reviewer }).steps.map(item => item.key), ["trace_client_ui"]);
});

test("semantic routing is language independent when the structured project symbol is the same", () => {
  const plan = { steps: [
    { key: "trace_api", objective: "Trace server response contract", allowed_paths: ["server/api.ts"], check_ids: [] },
    { key: "trace_avgCost_state", objective: "Trace avgCost client mapping and state model", allowed_paths: ["src/state.ts"], check_ids: [] }
  ] };
  const route = message => targetedSteps(plan, { reviewer: { blockers: [{ code: "EDGE_UNKNOWN", message, path: null }], evidence_refs: [], required_actions: [message] } });
  assert.deepEqual(route("Докажи переход avgCost из client mapping в state model").steps.map(item => item.key), ["trace_avgCost_state"]);
  assert.deepEqual(route("Prove the avgCost transition from client mapping into the state model").steps.map(item => item.key), ["trace_avgCost_state"]);
  assert.deepEqual(route("Please provide all generally required source evidence and prove avgCost").steps.map(item => item.key), ["trace_avgCost_state"]);
});

test("targeted path routing respects canonical segment boundaries", () => {
  const plan = { steps: [{ key: "a", allowed_paths: ["src/a"], check_ids: [] }, { key: "ab", allowed_paths: ["src/ab/file.ts"], check_ids: [] }] };
  const reviewer = { blockers: [{ code: "LOCAL", message: "fix source", path: "src/ab/file.ts" }], evidence_refs: [], required_actions: [] };
  assert.deepEqual(targetedSteps(plan, { reviewer }).steps.map(item => item.key), ["ab"]);
});

test("targeted routing reports none instead of guessing a synthesis or first step", () => {
  const result = targetedSteps({ steps: [{ key: "first", objective: "unrelated", allowed_paths: ["src/a.ts"], check_ids: [] }, { key: "synthesis", objective: "combine", allowed_paths: [], check_ids: [] }] }, { reviewer: { blockers: [], evidence_refs: [], required_actions: [] } });
  assert.deepEqual(result.steps, []);
  assert.equal(result.confidence, "none");
});

test("F: post-factum cost records the overshooting receipt and denies the next call", () => {
  const fx = fixture("gauntlet-cost-");
  try {
    const scopes = [{ type: "workflow", id: fx.runId }], request = { scopes, taskId: fx.runtime.get(fx.runId).task_id, runId: fx.runId };
    fx.budgets.define({ scopeType: "workflow", scopeId: fx.runId, metric: "cost_usd", limit: 1 });
    fx.budgets.assertModelAdmission(request);
    const settled = fx.budgets.settleActual({ ...request, amount: 1.25, idempotencyKey: "receipt-1" });
    assert.equal(settled.overshoot, 0.25);
    assert.equal(fx.runtime.db.prepare("SELECT used_value FROM budgets WHERE scope_id=? AND metric='cost_usd'").get(fx.runId).used_value, 1.25);
    assert.throws(() => fx.budgets.assertModelAdmission(request), /BUDGET_EXHAUSTED/);
  } finally { fx.close(); }
});

test("G: two admitted parallel costs settle before one lifecycle stop and a third admission is denied", async () => {
  const fx = fixture("gauntlet-parallel-cost-");
  try {
    const taskId = fx.runtime.get(fx.runId).task_id, scopes = [{ type: "workflow", id: fx.runId }], request = { scopes, taskId, runId: fx.runId };
    fx.budgets.define({ scopeType: "workflow", scopeId: fx.runId, metric: "cost_usd", limit: 1 });
    let release; const barrier = new Promise(resolve => { release = resolve; });
    const admitted = (key, amount) => { fx.budgets.assertModelAdmission(request); return barrier.then(() => fx.budgets.settleActual({ ...request, amount, idempotencyKey: key })); };
    const first = admitted("review-a", 0.7), second = admitted("review-b", 0.7); release();
    const receipts = await Promise.all([first, second]);
    assert.equal(receipts.length, 2); assert.equal(fx.runtime.get(fx.runId).state, "executing");
    assert.throws(() => fx.budgets.assertModelAdmission(request), /BUDGET_EXHAUSTED/);
    assert.equal(fx.runtime.get(fx.runId).state, "blocked");
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM events WHERE entity_type='workflow_run' AND entity_id=? AND kind='state_transition' AND to_state='blocked'").get(fx.runId).count, 1);
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM budget_entries WHERE run_id=?").get(fx.runId).count, 2);
  } finally { fx.close(); }
});

test("H: cancelling an active Gateway invocation kills descendants and closes queue lifecycle", async () => {
  const fx = fixture("gauntlet-cancel-tree-");
  try {
    const childFile = path.join(fx.root, "child.mjs"), gatewayFile = path.join(fx.root, "gateway.mjs"), marker = path.join(fx.root, "writes.log");
    fs.writeFileSync(childFile, `import fs from "node:fs"; const file=process.argv[2]; setInterval(()=>fs.appendFileSync(file,"x"),25);\n`);
    fs.writeFileSync(gatewayFile, `import {spawn} from "node:child_process"; import path from "node:path"; spawn(process.execPath,[path.join(import.meta.dirname,"child.mjs"),${JSON.stringify(marker)}],{stdio:"ignore"}); setInterval(()=>{},1000);\n`);
    fx.queue.enqueueRun(fx.runId); const lease = fx.queue.checkout({ ownerId: "worker", runId: fx.runId }); fx.queue.start(lease.token);
    const invocation = callGateway({ gateway: gatewayFile, gatewayDatabase: path.join(fx.root, "gateway.sqlite"), gatewayPolicy: path.join(fx.root, "policy.json"), profile: "fixture", taskFile: childFile, project: fx.projectRoot, taskId: "fixture", workflowRunId: fx.runId });
    const rejected = assert.rejects(invocation, /GATEWAY_INVOCATION_CANCELLED/);
    for (let attempt = 0; attempt < 40 && !fs.existsSync(marker); attempt += 1) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(fs.existsSync(marker), true);
    await invocation.cancel(); fx.queue.cancelRun(fx.runId, { reason: "owner cancel" }); await rejected;
    const size = fs.statSync(marker).size; await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(fs.statSync(marker).size, size);
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM leases WHERE released_at IS NULL").get().count, 0);
    assert.equal(fx.runtime.db.prepare("SELECT state FROM attempts WHERE id=?").get(lease.attemptId).state, "cancelled");
    assert.equal(fx.runtime.get(fx.runId).state, "cancelled");
    assert.equal(fx.queue.complete(lease.token, { receiptId: "late" }).ignored, true);
  } finally { fx.close(); }
});

test("I: pause requested during work applies only after the current safe unit", () => {
  const fx = fixture("gauntlet-pause-");
  try {
    fx.runtime.db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts) VALUES('next',?,'next',2,'pending',1,0,'next',?,?,1)").run(fx.runId, now(), now());
    fx.queue.enqueueRun(fx.runId); const lease = fx.queue.checkout({ ownerId: "worker", runId: fx.runId }); fx.queue.start(lease.token);
    requestRunControl(fx.runtime.db, fx.runId, "pause", "owner pause");
    assert.equal(fx.runtime.get(fx.runId).state, "executing");
    fx.queue.complete(lease.token); applyRunControlAtBoundary(fx.runtime.db, fx.queue, fx.runId);
    assert.equal(fx.runtime.get(fx.runId).state, "paused");
    assert.equal(fx.queue.checkout({ ownerId: "must-not-start", runId: fx.runId }), null);
  } finally { fx.close(); }
});

test("J: textual separator variants produce a stable blocker fingerprint", () => {
  const first = blockerFingerprint({ code: "SCHEMA_COMPATIBILITY", path: "Src\\Importer.ts", check_id: "Schema" });
  const second = blockerFingerprint({ code: "schema-compatibility", path: "src/importer.ts", check_id: "schema" });
  assert.equal(first.fingerprint, second.fingerprint);
});

test("K: same-ordinal reviewers do not emit queue_drained until both finish", () => {
  const fx = fixture("gauntlet-queue-");
  try {
    fx.runtime.db.prepare("UPDATE workflow_steps SET step_key='review-a',ordinal=1 WHERE run_id=?").run(fx.runId);
    fx.runtime.db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts) VALUES('review-b',?,'review-b',1,'pending',1,0,'review-b',?,?,1)").run(fx.runId, now(), now());
    fx.queue.enqueueRun(fx.runId);
    const a = fx.queue.checkout({ ownerId: "review-a", runId: fx.runId }), b = fx.queue.checkout({ ownerId: "review-b", runId: fx.runId });
    fx.queue.start(a.token); fx.queue.start(b.token); fx.queue.complete(a.token);
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM events WHERE entity_id=? AND kind='queue_drained'").get(fx.runId).count, 0);
    fx.queue.complete(b.token);
    assert.equal(fx.runtime.db.prepare("SELECT COUNT(*) count FROM events WHERE entity_id=? AND kind='queue_drained'").get(fx.runId).count, 1);
  } finally { fx.close(); }
});

test("consilium member cap 1, 2 and 3 changes the actual selected review calls", () => {
  const available = new Set(["reviewer", "adversarial_reviewer", "evidence_reviewer"]);
  assert.deepEqual(consiliumRoles(available, "reviewer", 1), ["reviewer"]);
  assert.deepEqual(consiliumRoles(available, "reviewer", 2), ["reviewer", "adversarial_reviewer"]);
  assert.deepEqual(consiliumRoles(available, "reviewer", 3), ["reviewer", "adversarial_reviewer", "evidence_reviewer"]);
  assert.equal(consiliumRoles(available, "reviewer", 99).length, 3);
});

test("L: model work may overlap outside DatabaseSync transactions and the static guard rejects await in one", async () => {
  let release; const barrier = new Promise(resolve => { release = resolve; }); let active = 0, maximum = 0;
  const invoke = async () => { active += 1; maximum = Math.max(maximum, active); await barrier; active -= 1; };
  const first = invoke(), second = invoke(); release(); await Promise.all([first, second]);
  assert.equal(maximum, 2);
  assert.deepEqual(transactionAwaitViolations('db.exec("BEGIN IMMEDIATE");\nconst row = db.prepare("SELECT 1").get();\ndb.exec("COMMIT");'), []);
  assert.equal(transactionAwaitViolations('db.exec("BEGIN IMMEDIATE");\nawait invokeRole();\ndb.exec("COMMIT");').length, 1);
  for (const directory of [path.resolve(import.meta.dirname, "../src"), path.resolve(import.meta.dirname, "../../AgentGateway/src")]) {
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith(".mjs"))) assert.deepEqual(transactionAwaitViolations(fs.readFileSync(path.join(directory, file), "utf8"), file), []);
  }
});

test("M: cross-project check provenance is retained while routing by its registered check", () => {
  const gate = { checks: [{ id: "consumer-schema", required: true, status: "failed", execution_project_id: "consumer", execution_root: "registered-consumer-root" }] };
  const selected = targetedSteps({ steps: [{ key: "consumer-fix", allowed_paths: ["src/consumer.ts"], check_ids: ["consumer-schema"] }, { key: "producer", allowed_paths: ["src/producer.ts"], check_ids: [] }] }, { gate });
  assert.equal(gate.checks[0].execution_project_id, "consumer");
  assert.equal(gate.checks[0].execution_root, "registered-consumer-root");
  assert.deepEqual(selected.steps.map(item => item.key), ["consumer-fix"]);
});
