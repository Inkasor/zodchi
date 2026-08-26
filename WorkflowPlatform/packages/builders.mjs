import { ATTEMPT_STATES, RUN_STATES, STEP_STATES, TASK_STATES, ALLOWED_TRANSITIONS } from "../src/state-machine.mjs";
import { structuredHash } from "../src/role-contracts.mjs";

const PACKAGE_VERSION = "3.0.0";

const workTypeCatalog = {
  conversation: ["Conversation", "dialogue"], continuation: ["Continuation", "dialogue"], clarification: ["Clarification", "dialogue"], task: ["Task", "work"], decision: ["Decision", "work"], research: ["Research", "work"], implementation: ["Implementation", "work"], documentation: ["Documentation", "work"], review: ["Review", "verification"], verification: ["Verification", "verification"], testing: ["Testing", "verification"], planning: ["Planning", "work"], fix: ["Fix", "work"], content: ["Content", "material"], marketing: ["Marketing", "material"], release: ["Release", "work"], deployment: ["Deployment", "work"], data_change: ["Data change", "work"], data_collection: ["Data collection", "work"], incident: ["Incident", "work"], access_management: ["Access management", "work"], project_bootstrap: ["Project bootstrap", "work"], security_review: ["Security review", "verification"], game_design: ["Game design", "game"], narrative: ["Narrative", "game"], map_design: ["Map design", "game"], technical_art: ["Technical art", "material"], art_direction: ["Art direction", "material"], audio: ["Audio", "material"], asset: ["Asset", "material"], prototype: ["Prototype", "work"], producer: ["Producer", "work"]
};
const artifactCatalog = {
  none: ["None", "none"], document: ["Document", "document"], code: ["Code", "code"], prototype: ["Prototype", "code"], visual_asset: ["Visual asset", "material"], audio_asset: ["Audio asset", "material"], content_asset: ["Content asset", "material"], technical_art_spec: ["Technical art specification", "document"], test_report: ["Test report", "document"], decision: ["Decision", "document"], release_package: ["Release package", "package"], data_migration: ["Data migration", "package"], deployment_evidence: ["Deployment evidence", "document"], incident_report: ["Incident report", "document"], access_change: ["Access change", "document"], collection_evidence: ["Collection evidence", "document"], security_report: ["Security report", "document"], workflow_package: ["Workflow package", "package"]
};
const qualityCatalog = { prototype: ["Prototype", 0], mvp: ["MVP", 1], production: ["Production", 2], security: ["Security audit", 3] };
const levelCatalog = { L0: ["L0", 0], L1: ["L1", 1], L2: ["L2", 2], L3: ["L3", 3], L4: ["L4", 4] };

const stateMachine = () => ({ task_states: [...TASK_STATES], run_states: [...RUN_STATES], step_states: [...STEP_STATES], attempt_states: [...ATTEMPT_STATES], transitions: Object.fromEntries(Object.entries(ALLOWED_TRANSITIONS).map(([entity, transitions]) => [entity, Object.fromEntries(Object.entries(transitions).map(([from, to]) => [from, [...to]]))])) });
const catalog = (registry, keys, third) => [...new Set(keys)].sort().map(key => ({ key, name: registry[key][0], [third]: registry[key][1] }));
const promptHash = template => `sha256:${structuredHash(template)}`;

function role(key, purpose, workTypes, artifacts, options = {}) {
  const resultSchema = options.schema ?? (key.includes("planner") || key === "planner" ? "planner.v1" : key.includes("reviewer") || key === "reviewer" ? "reviewer.v1" : key.includes("documentator") || key === "documentator" ? "documentator.v1" : "worker.v1");
  return { key, name: options.name ?? key.split("_").map(word => word[0].toUpperCase() + word.slice(1)).join(" "), contract: { version: PACKAGE_VERSION, purpose, boundaries: options.boundaries ?? { owner_decisions: false, publication: false, production_deploy: false }, allowed_work_types: workTypes, allowed_artifact_types: artifacts, allowed_tools: options.tools ?? [], allowed_skills: options.skills ?? [], required_checks: options.checks ?? [], allowed_transitions: options.transitions ?? ["executing", "verifying", "review_required", "documenting"], allowed_profile_keys: [`${key}.mvp`], context_limit_bytes: options.context ?? 65536, max_calls: options.maxCalls ?? 2, max_correction_cycles: options.corrections ?? 1, timeout_seconds: options.timeout ?? 1800, result_schema_key: resultSchema, prompt_template_version: PACKAGE_VERSION, escalation: options.escalation ?? { after_failed_corrections: 1, owner_decisions: true } } };
}
const profilesFor = (packageKey, roles) => roles.map(item => ({ key: `${packageKey}.${item.key}.mvp`, role_key: item.key, provider_family: null, capabilities: item.contract.allowed_skills, operational_levels: ["prototype", "mvp", "production", "security-audit"] }));
const promptsFor = roles => roles.map(item => { const template = `ROLE ${item.key}. Follow the versioned role contract and the separately supplied quality contract. Return only ${item.contract.result_schema_key}. Do not make owner decisions or publish.`; return { key: `${item.key}.default`, version: PACKAGE_VERSION, role_key: item.key, result_schema_key: item.contract.result_schema_key, template, content_hash: promptHash(template) }; });
const checkBinding = (quality, artifact, required = true) => ({ quality_mode_key: quality, artifact_type_key: artifact, required });
const commandCheck = (key, name, command, args, bindings, timeout = 900) => ({ key, name, runner: key, kind: "command", config: { command, args }, timeout_seconds: timeout, bindings });
const projectCommandCheck = (key, name, projectId, command, args, bindings, timeout = 900) => ({ key, name, runner: key, kind: "project_command", config: { project_id: projectId, command, args }, timeout_seconds: timeout, bindings });
// A disabled check is declared so its absence stays visible, but it never blocks: it cannot pass, and
// gate coverage is measured by the executable required checks instead.
const disabledCheck = (key, name, reason, bindings) => ({ key, name, runner: key, kind: "disabled", config: { reason }, timeout_seconds: 30, bindings: bindings.map(item => ({ ...item, required: false })) });
const secretCheck = key => ({ key: `${key}_secret_scan`, name: "Secret scan", runner: `${key}_secret_scan`, kind: "secret_scan", config: {}, timeout_seconds: 300, bindings: [checkBinding("security", "security_report")] });
// A gate resolves the checks of its own level and every level below it, and a security audit sits
// above production. Bound to the audit alone these three would never run on a release, so the one
// moment a project publishes code would be the one moment nothing looks for a leaked secret.
const securityChecks = key => [
  addBinding(secretCheck(key), "production", "release_package"),
  commandCheck(`${key}_gitleaks`, "Gitleaks: history and working tree", "gitleaks.exe", ["detect", "--source", ".", "--redact", "--no-banner"], [checkBinding("security", "security_report"), checkBinding("production", "release_package")], 900),
  commandCheck(`${key}_osv`, "OSV: known dependency vulnerabilities", "osv-scanner.exe", ["scan", "source", "-r", "."], [checkBinding("security", "security_report"), checkBinding("production", "release_package")], 1800)
];
// Packages whose own tooling is not bound locally still need one executable gate, and a secret scan
// over the changed files is one every project can run.
const withBroadSecretScan = (checks, packageKey) => checks.map(check => check.key === `${packageKey}_secret_scan`
  ? addBinding(addBinding(check, "prototype", null), "mvp", "code")
  : check);
const addBinding = (check, quality, artifact) => check.bindings.some(item => item.quality_mode_key === quality && item.artifact_type_key === artifact) ? check : ({ ...check, bindings: [...check.bindings, checkBinding(quality, artifact, check.kind !== "disabled")] });
const completeSoftwareChecks = (checks, staticKey, packageKey) => checks.map(check => {
  let result = check;
  if (check.bindings.some(item => item.quality_mode_key === "mvp" && item.artifact_type_key === "code")) result = addBinding(result, "production", "release_package");
  if (check.key === staticKey) result = addBinding(result, "prototype", null);
  return result;
}).concat(securityChecks(packageKey));

const QUALITY_LIMITS = Object.freeze({
  prototype: { calls: 4, duration_ms: 600000, correction_cycles: 0, cost_usd: 0.5 },
  mvp: { calls: 12, duration_ms: 3600000, correction_cycles: 1, cost_usd: 2 },
  production: { calls: 18, duration_ms: 7200000, correction_cycles: 1, cost_usd: 8 },
  "security-audit": { calls: 8, duration_ms: 3600000, correction_cycles: 0, cost_usd: 4 }
});
function normalizeOperationalLevels(levels = [], checks = []) {
  const byLevel = new Map(levels.map(item => [item.level, item]));
  const order = ["prototype", "mvp", "production", "security"];
  return Object.entries(QUALITY_LIMITS).map(([level, budgets]) => {
    const existing = byLevel.get(level) ?? {};
    const improvementStrategy = existing.improvement_strategy ?? "standard";
    const quality = level === "security-audit" ? "security" : level;
    const inherited = new Set(order.slice(0, order.indexOf(quality) + 1));
    const applicable = new Set(checks.filter(item => item.bindings.some(binding => inherited.has(binding.quality_mode_key) && binding.required)).map(item => item.key));
    const requested = existing.required_check_keys?.filter(key => applicable.has(key)) ?? [];
    const effectiveBudgets = improvementStrategy === "gauntlet" ? { ...budgets, ...(existing.budgets ?? {}) } : { ...budgets };
    return { level, improvement_strategy: improvementStrategy, budgets: effectiveBudgets, required_check_keys: requested.length ? requested : [...applicable], correction_limit: effectiveBudgets.correction_cycles, escalation: existing.escalation ?? {} };
  });
}
function step(key, ordinal, roleKey, artifacts = [], checks = [], options = {}) { return { key, ordinal, role_key: roleKey, required: options.required !== false, irreversible: Boolean(options.irreversible), input_schema_key: options.input ?? "package.v1", output_schema_key: options.output ?? (roleKey?.includes("reviewer") || roleKey === "reviewer" ? "reviewer.v1" : roleKey?.includes("documentator") || roleKey === "documentator" ? "documentator.v1" : roleKey?.includes("planner") || roleKey === "planner" ? "planner.v1" : roleKey ? "worker.v1" : "approval.v1"), artifact_type_keys: artifacts, check_keys: checks, correction: options.correction ?? { max_cycles: roleKey && !roleKey.includes("reviewer") ? 1 : 0 }, escalation: options.escalation ?? { human_required_for_owner_decision: true } }; }
const transitions = steps => steps.slice(1).map((item, index) => ({ from: steps[index].key, to: item.key, condition: { previous_required_step: "completed" } }));
function workflow(key, name, steps, questions = [], options = {}) { return { key, name, default_quality: options.quality ?? "mvp", default_level: options.level ?? "L2", status: "active", discovery: { git: true }, history_budget_bytes: options.history ?? 24000, steps, transitions: transitions(steps), questions }; }
const question = (key, prompt, phase = "planning", required = true) => ({ key, phase, prompt, answer_schema: { type: "string", min_length: 1 }, required });
const route = (workType, workflowKey, priority = 10) => ({ work_type_key: workType, workflow_key: workflowKey, enabled: true, priority });
const binding = (roleKey, write = false, purpose = "registered context", priority = 0) => ({ role_key: roleKey, read: true, write, purpose, priority });
const document = (key, filePath, type, authority, bindings, root = "primary") => ({ key, path: filePath, root, type, authority, status: "active", bindings });
const scenario = (key, input, expected) => ({ key, input, expected, anonymized: true });

function finalize({ key, purpose, roles, workflows, routes, checks, operationalLevels, documents, scenarios, version = PACKAGE_VERSION }) {
  roles = roles.map(item => ({ ...item, contract: { ...item.contract, allowed_profile_keys: [`${key}.${item.key}.mvp`] } }));
  const workTypes = [...new Set([...roles.flatMap(item => item.contract.allowed_work_types), ...routes.map(item => item.work_type_key)])];
  const artifacts = [...new Set([...roles.flatMap(item => item.contract.allowed_artifact_types), ...workflows.flatMap(item => item.steps.flatMap(value => value.artifact_type_keys)), ...checks.flatMap(item => item.bindings.map(value => value.artifact_type_key).filter(Boolean))])];
  const qualities = Object.keys(qualityCatalog);
  const levels = [...new Set(workflows.map(item => item.default_level))];
  return { schema_version: 1, key, version, purpose, prompt_builder_version: PACKAGE_VERSION, catalogs: { work_types: catalog(workTypeCatalog, workTypes, "category"), artifact_types: catalog(artifactCatalog, artifacts, "category"), quality_modes: catalog(qualityCatalog, qualities, "ordinal"), planning_levels: catalog(levelCatalog, levels, "ordinal") }, roles, profiles: profilesFor(key, roles), workflows, state_machine: stateMachine(), routes, checks, operational_levels: normalizeOperationalLevels(operationalLevels, checks), documents, prompt_templates: promptsFor(roles), test_scenarios: scenarios };
}

function companyWebPackage(spec) {
  const prefix = spec.key.replaceAll(/[^a-z0-9]+/g, "_");
  const codeChecks = spec.codeChecks ?? [];
  const dataChecks = spec.dataChecks ?? codeChecks;
  const releaseChecks = spec.releaseChecks ?? codeChecks;
  const contentChecks = spec.contentChecks ?? codeChecks;
  const roles = [
    role("classifier", "Classify natural-language intent using only registered work types and routes; never route by trigger phrase or keyword.", ["conversation", "continuation", "clarification", "research", "implementation", "fix", "documentation", "data_change", "incident", "access_management", "project_bootstrap", "security_review", "release", "deployment", ...(spec.collection ? ["data_collection"] : []), ...(spec.content ? ["content", "asset"] : [])], ["none"], { schema: "classification.v1", corrections: 0, boundaries: { keyword_routing: false, productive_edits: false } }),
    role("researcher", "Read only registered project sources and return a bounded factual answer without editing.", ["research", "conversation", "continuation", "documentation", "incident", "access_management", "project_bootstrap", "security_review"], ["document", "incident_report", "security_report"], { boundaries: { edits: false, production_actions: false } }),
    role("planner", "Turn an accepted outcome into a bounded package with exact paths, checks, risks and approval boundaries.", ["planning", "implementation", "fix", "documentation", "data_change", "incident", "release", "deployment", "access_management", "project_bootstrap", "security_review", ...(spec.collection ? ["data_collection"] : []), ...(spec.content ? ["content", "asset"] : [])], ["document", "decision", "code", "data_migration", "release_package", "workflow_package", "content_asset", "visual_asset", "security_report", "access_change", ...(spec.collection ? ["collection_evidence"] : [])], { boundaries: { edits: false, production_actions: false }, checks: [...new Set([...codeChecks, ...dataChecks, ...releaseChecks, ...contentChecks])] }),
    role("web_developer", "Implement only the allowed source package and leave production unchanged.", ["implementation", "fix"], ["code"], { tools: ["apply_patch"], checks: codeChecks }),
    role("data_engineer", "Implement a reversible data contract or migration against fixtures or an isolated copy, never live data.", ["data_change", "implementation", "fix"], ["code", "data_migration"], { tools: ["apply_patch"], checks: dataChecks, boundaries: { live_data_writes: false, backup_required_before_apply: true } }),
    role("tester", "Run registered deterministic checks and keep source, CI, runtime and user evidence separate.", ["testing", "verification", ...(spec.collection ? ["data_collection"] : [])], ["test_report", "deployment_evidence", ...(spec.collection ? ["collection_evidence"] : [])], { checks: [...new Set([...codeChecks, ...dataChecks, ...releaseChecks, ...contentChecks])] }),
    role("reviewer", "Return PASS, CHANGES_REQUESTED or REJECT after required deterministic checks; never replace owner approval.", ["review", "verification", "security_review"], ["test_report", "code", "document", "security_report"], { checks: [...new Set([...codeChecks, ...dataChecks, ...releaseChecks, ...contentChecks])], boundaries: { owner_decisions: false, production_deploy: false } }),
    role("adversarial_reviewer", "Independently challenge the same immutable evidence and identify the strongest unsupported claim without seeing another review opinion.", ["review", "verification", "security_review"], ["test_report", "code", "document", "security_report"], { checks: [...new Set([...codeChecks, ...dataChecks, ...releaseChecks, ...contentChecks])], boundaries: { edits: false, opinions_from_other_reviewers: false, owner_decisions: false } }),
    role("strategy_reviewer", "Independently assess whether the current evidence-backed strategy targets the primary remaining gap without replaying completed work.", ["review", "verification", "planning"], ["test_report", "code", "document", "decision"], { boundaries: { edits: false, opinions_from_other_reviewers: false, owner_decisions: false } }),
    role("judge", "Resolve only judgment conflicts between independent opinions after factual disagreements have been sent to deterministic verification.", ["review", "verification"], ["decision", "test_report", "document"], { schema: "worker.v1", boundaries: { edits: false, majority_vote: false, owner_decisions: false } }),
    role("documentator", "Update only registered working documents from accepted structured decisions and pass semantic lint.", ["documentation", "decision"], ["document", "decision"], { tools: ["apply_patch"] }),
    role("release_operator", "Prepare or execute only an explicitly approved exact release and verify the deployed revision without changing shared data by hand.", ["release", "deployment"], ["release_package", "deployment_evidence"], { tools: ["exec_command"], checks: releaseChecks, boundaries: { explicit_approval_required: true, direct_release_edit: false, live_data_edit: false } }),
    role("incident_responder", "Diagnose production read-only, preserve evidence and separate a local repair from any later deployment.", ["incident", "research", "fix"], ["incident_report", "document"], { boundaries: { production_writes: false, deploy: false } }),
    role("access_administrator", "Prepare and apply the smallest approved access change without exposing credentials or broadening unrelated permissions.", ["access_management"], ["access_change", "test_report"], { tools: ["exec_command"], boundaries: { explicit_approval_required: true, secrets_in_output: false, least_privilege: true } }),
    role("security_reviewer", "Perform a read-only security review and return findings without silently changing policy or secrets.", ["security_review", "review"], ["security_report"], { boundaries: { edits: false, secret_access: false, acceptance: false } }),
    role("project_bootstrapper", "Create a bounded new-project proposal and local scaffolding without publishing or deploying.", ["project_bootstrap", "implementation"], ["workflow_package", "code", "document"], { tools: ["apply_patch"], boundaries: { publish: false, deploy: false } })
  ];
  // Collection reads live marketplace APIs. Nothing it does is undone by a rollback: the requests are
  // spent, the rate limits are consumed and the account has been seen using them. So the operator may
  // only run identifiers the owner listed, and only after the approval step recorded that list.
  if (spec.collection) roles.push(role("collection_operator", "Run only the owner-approved collection identifiers against live marketplace APIs, never send a write request and never widen the approved endpoint list.", ["data_collection"], ["collection_evidence", "test_report"], { tools: ["exec_command"], checks: dataChecks, boundaries: { write_requests: false, explicit_approval_required: true, unlisted_endpoints: false, credential_output: false } }));
  if (spec.content) roles.push(role("content_specialist", "Prepare a traceable content or media candidate without final product acceptance.", ["content", "asset"], ["content_asset", "visual_asset", "document"], { tools: ["apply_patch"], checks: contentChecks, boundaries: { product_acceptance: false, publication: false } }));

  const flow = (key, name, items, questions = [], options = {}) => workflow(`${prefix}.${key}`, name, items, questions, options);
  const workflows = [
    flow("research", "Human conversation and bounded research", [step("research", 1, "researcher", ["document"])], [], { level: "L1", history: 20000 }),
    flow("change", "Bounded product change", [step("plan", 1, "planner", ["document"]), step("implement", 2, "web_developer", ["code"], codeChecks), step("checks", 3, "tester", ["test_report"], codeChecks), step("review", 4, "reviewer", ["test_report"], codeChecks), step("document", 5, "documentator", ["document"])], [question("expected_result", "Which observable result should change?"), question("protected_work", "Which existing changes and data must remain untouched?")]),
    flow("data", "Reversible data change", [step("plan", 1, "planner", ["data_migration"]), step("implement", 2, "data_engineer", ["code", "data_migration"], dataChecks), step("checks", 3, "tester", ["test_report"], dataChecks), step("review", 4, "reviewer", ["test_report"], dataChecks), step("apply_approval", 5, null, ["decision"], [], { irreversible: true }), step("document", 6, "documentator", ["document"])], [question("data_boundary", "Which data, time range, and invariants are affected?"), question("rollback", "How can rollback be tested without changing production data?")]),
    flow("release", "Verified release and deployment", [step("plan", 1, "planner", ["release_package"]), step("preflight", 2, "tester", ["test_report"], releaseChecks), step("review", 3, "reviewer", ["test_report"], releaseChecks), step("deployment_approval", 4, null, ["decision"], [], { irreversible: true }), step("deploy", 5, "release_operator", ["release_package", "deployment_evidence"], releaseChecks), step("verify", 6, "tester", ["deployment_evidence"], releaseChecks), step("document", 7, "documentator", ["document"])], [question("release_scope", "Which exact result and revision should be deployed?")], { quality: "production", level: "L3" }),
    flow("incident", "Production incident diagnosis and local repair", [step("diagnose", 1, "incident_responder", ["incident_report"]), step("plan", 2, "planner", ["document"]), step("repair", 3, "web_developer", ["code"], codeChecks), step("checks", 4, "tester", ["test_report"], codeChecks), step("review", 5, "reviewer", ["test_report"], codeChecks), step("document", 6, "documentator", ["document"])], [question("observed_failure", "What is observed, where, and since when?"), question("production_boundary", "Which production actions has the owner already authorized?")], { quality: "production", level: "L3" }),
    flow("access", "Least-privilege access change", [step("inspect", 1, "researcher", ["document"]), step("plan", 2, "planner", ["access_change"]), step("proposal", 3, "access_administrator", ["access_change"]), step("access_approval", 4, null, ["decision"], [], { irreversible: true }), step("apply", 5, "access_administrator", ["access_change"]), step("verify", 6, "tester", ["test_report"]), step("document", 7, "documentator", ["document"])], [question("identity", "Who needs access to what, and for which work?"), question("expiry", "Is the access permanent or time-limited?")], { quality: "production", level: "L3" }),
    flow("bootstrap", "New project bootstrap", [step("discover", 1, "researcher", ["document"]), step("plan", 2, "planner", ["workflow_package"]), step("scaffold", 3, "project_bootstrapper", ["code", "workflow_package"]), step("checks", 4, "tester", ["test_report"], codeChecks), step("owner_approval", 5, null, ["decision"], [], { irreversible: true }), step("document", 6, "documentator", ["document"])], [question("project_owner", "Who owns the product and authorizes publication?"), question("runtime", "Where must the project run, and which data does it use?")], { level: "L3" }),
    flow("documentation", "Registered documentation update", [step("source", 1, "researcher", ["document"]), step("plan", 2, "planner", ["document"]), step("document", 3, "documentator", ["document"]), step("review", 4, "reviewer", ["document"])], [question("document_outcome", "Which accepted decision or verified fact should be recorded?")]),
    flow("security", "Read-only security review", [step("inventory", 1, "researcher", ["document"]), step("review", 2, "security_reviewer", ["security_report"]), step("owner_decision", 3, null, ["decision"], [], { irreversible: true }), step("document", 4, "documentator", ["document"])], [question("security_scope", "Which system boundary, data, and threat model are in scope?")], { quality: "security", level: "L4" }),
    flow("verification", "Registered verification run", [step("checks", 1, "tester", ["test_report"], codeChecks), step("review", 2, "reviewer", ["test_report"], codeChecks)], [question("verification_scope", "Which registered checks should run, and over which paths?")], { level: "L1" })
  ];
  // The dry run happens before the approval so the owner decides against a measured request count
  // rather than an estimate, and the approval names the exact identifiers the live run may use.
  if (spec.collection) workflows.push(flow("collection", "Authorized live data collection", [step("plan", 1, "planner", ["document"]), step("dry_run", 2, "collection_operator", ["test_report"], dataChecks), step("review", 3, "reviewer", ["test_report"], dataChecks), step("collection_approval", 4, null, ["decision"], [], { irreversible: true }), step("collect", 5, "collection_operator", ["collection_evidence"]), step("verify", 6, "tester", ["collection_evidence"], dataChecks), step("document", 7, "documentator", ["document"])], [question("collection_scope", "Which marketplace, account, endpoint identifiers and time range are in scope?"), question("collection_authorization", "Which live calls has the owner authorized, and what must stay audit-only?")], { quality: "production", level: "L3" }));
  if (spec.content) workflows.push(flow("content", "Traceable content production", [step("brief", 1, "planner", ["document"]), step("produce", 2, "content_specialist", ["content_asset", "visual_asset"], contentChecks), step("checks", 3, "tester", ["test_report"], contentChecks), step("owner_acceptance", 4, null, ["decision"], [], { irreversible: true }), step("document", 5, "documentator", ["document"])], [question("content_outcome", "Which material is needed, for whom, and by which acceptance criteria?")], { level: "L2" }));

  const routes = [
    route("conversation", `${prefix}.research`, 100), route("continuation", `${prefix}.research`, 100), route("research", `${prefix}.research`, 90),
    route("implementation", `${prefix}.change`), route("fix", `${prefix}.change`), route("data_change", `${prefix}.data`),
    route("release", `${prefix}.release`), route("deployment", `${prefix}.release`), route("incident", `${prefix}.incident`),
    route("access_management", `${prefix}.access`), route("project_bootstrap", `${prefix}.bootstrap`), route("documentation", `${prefix}.documentation`), route("security_review", `${prefix}.security`),
    route("testing", `${prefix}.verification`), route("verification", `${prefix}.verification`)
  ];
  if (spec.collection) routes.push(route("data_collection", `${prefix}.collection`));
  if (spec.content) { routes.push(route("content", `${prefix}.content`), route("asset", `${prefix}.content`)); }
  // A reference document is registered context the roles read, not a record the documentator maintains:
  // package manifests and generated indexes belong to the tools that own them. Granting write access
  // anyway would oblige the documentator to keep them in the semantic document format, which would stop
  // them being what they are.
  // A document on a read-only root belongs to the project that owns that directory: it is registered
  // here so the roles can see the other end of an integration, and the documentator maintaining it from
  // this side would edit another project's files outside that project's own checks and review.
  const documents = spec.documents.map(item => {
    const readOnlyRoot = (spec.roots ?? []).some(root => root.key === item.root && root.access !== "write");
    const writes = value => value.key === "documentator" && item.type !== "reference" && !readOnlyRoot;
    return document(item.key, item.path, item.type, item.authority, roles.map(value => binding(value.key, writes(value), writes(value) ? "accepted project record" : "registered project context", writes(value) ? 20 : 0)), item.root ?? "primary");
  });
  const requiredMvpChecks = [...new Set([...codeChecks, ...dataChecks, ...contentChecks])];
  return finalize({
    key: spec.key,
    version: spec.version ?? PACKAGE_VERSION,
    purpose: spec.purpose,
    roles,
    workflows,
    routes,
    checks: spec.checks,
    operationalLevels: [
      { level: "prototype", budgets: { calls: 4, duration_ms: 600000 }, required_check_keys: [], correction_limit: 0, escalation: { owner_decisions: true } },
      { level: "mvp", budgets: { calls: 12, duration_ms: 3600000 }, required_check_keys: requiredMvpChecks, correction_limit: 1, escalation: { reviewer_after_failure: true, owner_acceptance_separate: true } },
      { level: "production", budgets: { calls: 18, duration_ms: 7200000 }, required_check_keys: releaseChecks, correction_limit: 1, escalation: { reviewer_required: true, deployment_requires_recorded_approval: true } },
      { level: "security-audit", budgets: { calls: 8, duration_ms: 3600000 }, required_check_keys: [], correction_limit: 0, escalation: { owner_decision_required: true } }
    ],
    documents,
    scenarios: [
      scenario("natural_conversation", { message: "Talk with me about the current state", classifier: "model" }, { work_type: "conversation", productive_roles: [] }),
      scenario("bounded_research", { message: "Find out why the current process is inconvenient", classifier: "model" }, { work_type: "research", roles: ["researcher"], excludes: ["planner", "web_developer", "reviewer"] }),
      scenario("implementation", { message: "Fix this bounded problem", classifier: "model" }, { work_type: "implementation", route: `${prefix}.change`, required_gates: codeChecks }),
      scenario("deployment_approval", { message: "Check readiness and ask about publication if needed", classifier: "model" }, { work_type: "deployment", route: `${prefix}.release`, keyword_trigger: false, explicit_approval_step: "deployment_approval" }),
      scenario("incident_separation", { message: "There is an error in production; investigate it", classifier: "model" }, { work_type: "incident", route: `${prefix}.incident`, deployment: "separate" }),
      ...(spec.collection ? [scenario("live_collection_approval", { message: "Collect the fresh marketplace data", classifier: "model" }, { work_type: "data_collection", route: `${prefix}.collection`, keyword_trigger: false, explicit_approval_step: "collection_approval" })] : []),
      ...(spec.content ? [scenario("content_candidate", { message: "Prepare the material and show it for approval", classifier: "model" }, { work_type: "content", route: `${prefix}.content`, owner_acceptance: "pending" })] : [])
    ]
  });
}


export { PACKAGE_VERSION, role, checkBinding, commandCheck, projectCommandCheck, disabledCheck, secretCheck, securityChecks, withBroadSecretScan, addBinding, completeSoftwareChecks, step, workflow, question, route, binding, document, scenario, finalize, companyWebPackage };
