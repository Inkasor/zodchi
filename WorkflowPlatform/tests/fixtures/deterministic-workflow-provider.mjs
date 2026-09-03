let input = "";
for await (const chunk of process.stdin) input += chunk;
const role = input.match(/^ROLE: ([^\r\n]+)/m)?.[1] ?? "unknown";

// The role prompt is the XML envelope the platform builds, and the fixture reads the same task package
// the model is given. Parsing a plain-text marker instead left the fixture silently contract-blind: it
// planned against an empty package and every plan was rejected for a role the route does not carry.
function unescapeXml(value) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function contractEnvelope() {
  const element = input.match(/<task_package format="application\/json">([\s\S]*?)<\/task_package>/);
  if (element) return { package: JSON.parse(unescapeXml(element[1])) };
  const legacy = input.match(/WORKFLOW ROLE CONTRACT\r?\n(\{.*\})\r?\nReturn exactly/s);
  return legacy ? JSON.parse(legacy[1]) : null;
}

// The role name says who is asked; the declared result schema says what shape the answer must have.
// Dispatching on the name alone made every id containing "reviewer" answer in reviewer.v1, so the
// strategy reviewer returned a well-formed object of the wrong contract and the run dead-lettered.
const resultSchema = input.match(/<result_contract schema="([^"]+)"/)?.[1] ?? null;

let result;
if (resultSchema === "strategy_review.v1") {
  const patch = contractEnvelope()?.package?.state_patch_contract ?? {};
  // Required checks that could not run are not a strategy problem: no bounded step this role may
  // select would make an unavailable tool available, and inventing one would report progress.
  result = {
    schema_version: 1, decision: "NO_VIABLE_STRATEGY",
    rationale: "The required project gate did not pass and no registered step within this role's authority can change that outcome.",
    selected_step_keys: [], verification_request: null, replan_intent: null,
    evidence_refs: ["project-gate:not-green"],
    state_patch: { schema_version: 1, patch_id: patch.patch_id, base_projection_hash: patch.base_projection_hash, changes: [{ operation: "replace_active", path: "decisions.strategy_recovery" }] }
  };
} else if (resultSchema === "judge.v1") {
  const patch = contractEnvelope()?.package?.state_patch_contract ?? {};
  result = {
    schema_version: 1, decision: "PASS",
    rationale: "The bounded contract was fulfilled and no source path was changed.",
    evidence_refs: ["worker:zero-change"], primary_gap: null, verification_request: null,
    state_patch: { schema_version: 1, patch_id: patch.patch_id, base_projection_hash: patch.base_projection_hash, changes: [{ operation: "replace_active", path: "decisions.judge_resolution" }] }
  };
} else if (resultSchema === "documentator.v1") {
  const packageValue = contractEnvelope()?.package ?? {};
  const existing = typeof packageValue.expected_version === "string";
  result = {
    schema_version: 1, status: "proposed", document_id: packageValue.document_id ?? null, expected_version: packageValue.expected_version ?? null,
    operation: existing ? "update_section" : "create_document", authority: packageValue.authority ?? "registered project documents", content: existing ? "new accepted content" : '<document id="generated" status="working"><section id="summary" status="working">new accepted content</section></document>',
    section_id: existing ? "summary" : null, decision_id: null, evidence_id: null, status_value: null,
    target_tag: null, target_id: null, replacement_id: null
  };
} else if (role === "classifier") {
  const conversation = input.includes("SCENARIO:conversation"), research = input.includes("SCENARIO:research");
  const scenario = Object.fromEntries([...input.matchAll(/SCENARIO_([A-Z_]+)=([a-z0-9._-]+)/g)].map(match => [match[1].toLowerCase(), match[2]]));
  result = {
    schema_version: 1, work_type: "implementation", artifact_type: "code", domain: "game-development", discipline: "software",
    risk: "low", planning_level: "L2", quality_mode: "mvp", planning_required: true, human_required: false,
    needs_questions: false, document_required: false, reply_mode: "work", pending_interaction_id: null, pending_interaction_response: null,
    resolved_objective: "Run the registered read-only verification route.", reason: "A registered read-only verification route was requested.", questions: [], human_response: null
  };
  if (conversation) Object.assign(result, { work_type: "conversation", artifact_type: "none", domain: "general", discipline: "general", planning_level: "L0", planning_required: false, reply_mode: "conversation", reason: "Ordinary conversation requires no productive role.", human_response: "Привет! Workflow Platform отвечает в тот же чат без запуска рабочих ролей." });
  if (research) Object.assign(result, { work_type: "research", artifact_type: "document", domain: "research", discipline: "software", planning_level: "L1", planning_required: false, reply_mode: "research", reason: "Bounded research uses the registered project corpus under read-only constraints.", human_response: null });
  if (scenario.work_type) Object.assign(result, {
    work_type: scenario.work_type,
    artifact_type: scenario.artifact ?? "test_report",
    domain: scenario.domain ?? "software",
    discipline: scenario.discipline ?? "software",
    reason: "The acceptance scenario explicitly names a route from the package imported into its isolated registry."
  });
} else if (role === "researcher") {
  const decoded = unescapeXml(input);
  const sourceText = decoded.match(/REGISTERED_SOURCE_EVIDENCE:(\{.*\})\r?\nREGISTERED_PROJECT_CORPUS:/)?.[1] ?? null;
  let sources = null;
  try { sources = sourceText ? JSON.parse(sourceText) : null; } catch { /* malformed supplied evidence remains insufficient */ }
  // Acceptance must cite content the platform actually supplied, not merely the first inventory path.
  // The latter can be a README or another name-only record and now correctly fails source validation.
  const inspectedPath = sources?.files?.find(item => item?.status === "read" && typeof item?.path === "string")?.path ?? null;
  result = inspectedPath
    ? { schema_version: 1, status: "answered", answer: "Зарегистрированный корпус проверен в read-only режиме; один реальный путь подтверждает доступ исследователя, worker и reviewer не запускались.", inspected_paths: [inspectedPath], limitations: [] }
    : { schema_version: 1, status: "insufficient", answer: "Зарегистрированный корпус проверен в read-only режиме; файлов для содержательного ответа недостаточно, worker и reviewer не запускались.", inspected_paths: [], limitations: ["В acceptance-фикстуре нет исходников, необходимых для содержательного ответа."] };
} else if (resultSchema === "planner.v1" || (!resultSchema && role === "planner")) {
  const contract = contractEnvelope(), checks = contract?.package?.registered_checks ?? [];
  // The step's role has to come from the package being planned. Naming a fixed role here made the
  // fixture usable only with the package it was written against, and every other package produced a
  // plan rejected for a role the route does not carry.
  const registered = contract?.package?.registered_roles ?? [];
  const workType = contract?.package?.classification?.work_type ?? null;
  const decides = /^(?:classifier|planner|judge)$|reviewer$/;
  const candidates = registered.filter(item => !decides.test(item.id ?? ""));
  const permitted = candidates.filter(item => {
    const allowed = item.allowed_work_types ?? [];
    return !workType || !allowed.length || allowed.includes("*") || allowed.includes(workType);
  });
  const workerRole = (permitted[0] ?? candidates[0] ?? registered[0])?.id ?? "worker";
  result = {
    schema_version: 1, outcome: "ready", scope: { included: ["read-only technical verification"], excluded: ["source edits", "owner acceptance", "publication"] },
    allowed_paths: [], inputs: ["registered project documents", "current working tree"], checks, risks: ["existing dirty worktree is preserved"], artifacts: [],
    completion_criteria: ["all registered required checks pass", "reviewer returns PASS"], questions: [],
    steps: [{ key: "verify_project", role: workerRole, objective: "Perform no edits; provide structured evidence so registered checks can verify the current project.", allowed_paths: [], artifact_keys: [], check_ids: checks, resources: [], required: true, irreversible: false, max_attempts: 1 }]
  };
} else if (resultSchema === "reviewer.v1" || (!resultSchema && role.includes("reviewer"))) {
  result = { schema_version: 1, decision: "PASS", summary: "Registered checks are green and no source path was changed by the bounded worker.", blockers: [], required_actions: [], evidence_refs: ["project-gate:passed", "worker:zero-change"] };
} else {
  result = { schema_version: 1, status: "completed", summary: `The bounded ${role} contract completed without source edits or owner decisions.`, changed_paths: [], artifacts: [], evidence: ["zero-path allowlist"], questions: [], external_evidence_request: null };
}

console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 64, cached_input_tokens: 16, output_tokens: 32, reasoning_output_tokens: 4, service_tier: "deterministic-contract" } }));
console.log(JSON.stringify({ result: JSON.stringify(result) }));
