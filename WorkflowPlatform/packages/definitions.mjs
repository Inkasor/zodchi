import { ATTEMPT_STATES, RUN_STATES, STEP_STATES, TASK_STATES, ALLOWED_TRANSITIONS } from "../src/state-machine.mjs";
import { structuredHash } from "../src/role-contracts.mjs";

const PACKAGE_VERSION = "2.1.0";

const workTypeCatalog = {
  conversation: ["Conversation", "dialogue"], continuation: ["Continuation", "dialogue"], clarification: ["Clarification", "dialogue"], task: ["Task", "work"], decision: ["Decision", "work"], research: ["Research", "work"], implementation: ["Implementation", "work"], documentation: ["Documentation", "work"], review: ["Review", "verification"], verification: ["Verification", "verification"], testing: ["Testing", "verification"], planning: ["Planning", "work"], fix: ["Fix", "work"], content: ["Content", "material"], marketing: ["Marketing", "material"], release: ["Release", "work"], deployment: ["Deployment", "work"], data_change: ["Data change", "work"], incident: ["Incident", "work"], access_management: ["Access management", "work"], project_bootstrap: ["Project bootstrap", "work"], security_review: ["Security review", "verification"], game_design: ["Game design", "game"], narrative: ["Narrative", "game"], map_design: ["Map design", "game"], technical_art: ["Technical art", "material"], art_direction: ["Art direction", "material"], audio: ["Audio", "material"], asset: ["Asset", "material"], prototype: ["Prototype", "work"], producer: ["Producer", "work"]
};
const artifactCatalog = {
  none: ["None", "none"], document: ["Document", "document"], code: ["Code", "code"], prototype: ["Prototype", "code"], visual_asset: ["Visual asset", "material"], audio_asset: ["Audio asset", "material"], content_asset: ["Content asset", "material"], technical_art_spec: ["Technical art specification", "document"], test_report: ["Test report", "document"], decision: ["Decision", "document"], release_package: ["Release package", "package"], data_migration: ["Data migration", "package"], deployment_evidence: ["Deployment evidence", "document"], incident_report: ["Incident report", "document"], access_change: ["Access change", "document"], security_report: ["Security report", "document"], workflow_package: ["Workflow package", "package"]
};
const qualityCatalog = { prototype: ["Prototype", 0], mvp: ["MVP", 1], production: ["Production", 2], security: ["Security audit", 3] };
const levelCatalog = { L0: ["L0", 0], L1: ["L1", 1], L2: ["L2", 2], L3: ["L3", 3], L4: ["L4", 4] };

const stateMachine = () => ({ task_states: [...TASK_STATES], run_states: [...RUN_STATES], step_states: [...STEP_STATES], attempt_states: [...ATTEMPT_STATES], transitions: Object.fromEntries(Object.entries(ALLOWED_TRANSITIONS).map(([entity, transitions]) => [entity, Object.fromEntries(Object.entries(transitions).map(([from, to]) => [from, [...to]]))])) });
const catalog = (registry, keys, third) => [...new Set(keys)].sort().map(key => ({ key, name: registry[key][0], [third]: registry[key][1] }));
const promptHash = template => `sha256:${structuredHash(template)}`;

function role(key, purpose, workTypes, artifacts, options = {}) {
  const resultSchema = options.schema ?? (key === "planner" ? "planner.v1" : key.includes("reviewer") || key === "reviewer" ? "reviewer.v1" : key.includes("documentator") || key === "documentator" ? "documentator.v1" : "worker.v1");
  return { key, name: options.name ?? key.split("_").map(word => word[0].toUpperCase() + word.slice(1)).join(" "), contract: { version: PACKAGE_VERSION, purpose, boundaries: options.boundaries ?? { owner_decisions: false, publication: false, production_deploy: false }, allowed_work_types: workTypes, allowed_artifact_types: artifacts, allowed_tools: options.tools ?? [], allowed_skills: options.skills ?? [], required_checks: options.checks ?? [], allowed_transitions: options.transitions ?? ["executing", "verifying", "review_required", "documenting"], allowed_profile_keys: [`${key}.mvp`], context_limit_bytes: options.context ?? 24000, max_calls: options.maxCalls ?? 2, max_correction_cycles: options.corrections ?? 1, timeout_seconds: options.timeout ?? 1800, result_schema_key: resultSchema, prompt_template_version: PACKAGE_VERSION, escalation: options.escalation ?? { after_failed_corrections: 1, owner_decisions: true } } };
}
const profilesFor = (packageKey, roles) => roles.map(item => ({ key: `${packageKey}.${item.key}.mvp`, role_key: item.key, provider_family: null, capabilities: item.contract.allowed_skills, operational_levels: ["prototype", "mvp", "production", "security-audit"] }));
const promptsFor = roles => roles.map(item => { const template = `ROLE ${item.key}. Follow the versioned role contract and the separately supplied quality contract. Return only ${item.contract.result_schema_key}. Do not make owner decisions or publish.`; return { key: `${item.key}.default`, version: PACKAGE_VERSION, role_key: item.key, result_schema_key: item.contract.result_schema_key, template, content_hash: promptHash(template) }; });
const checkBinding = (quality, artifact, required = true) => ({ quality_mode_key: quality, artifact_type_key: artifact, required });
const commandCheck = (key, name, command, args, bindings, timeout = 900) => ({ key, name, runner: key, kind: "command", config: { command, args }, timeout_seconds: timeout, bindings });
const projectCommandCheck = (key, name, projectId, command, args, bindings, timeout = 900) => ({ key, name, runner: key, kind: "project_command", config: { project_id: projectId, command, args }, timeout_seconds: timeout, bindings });
const disabledCheck = (key, name, reason, bindings) => ({ key, name, runner: key, kind: "disabled", config: { reason }, timeout_seconds: 30, bindings });
const secretCheck = key => ({ key: `${key}_secret_scan`, name: "Secret scan", runner: `${key}_secret_scan`, kind: "secret_scan", config: {}, timeout_seconds: 300, bindings: [checkBinding("security", "security_report")] });
const securityChecks = key => [
  secretCheck(key),
  commandCheck(`${key}_gitleaks`, "Gitleaks: history and working tree", "gitleaks.exe", ["detect", "--source", ".", "--redact", "--no-banner"], [checkBinding("security", "security_report")], 900),
  commandCheck(`${key}_osv`, "OSV: known dependency vulnerabilities", "osv-scanner.exe", ["scan", "source", "-r", "."], [checkBinding("security", "security_report")], 1800)
];
const addBinding = (check, quality, artifact) => check.bindings.some(item => item.quality_mode_key === quality && item.artifact_type_key === artifact) ? check : ({ ...check, bindings: [...check.bindings, checkBinding(quality, artifact)] });
const completeSoftwareChecks = (checks, staticKey, packageKey) => checks.map(check => {
  let result = check;
  if (check.bindings.some(item => item.quality_mode_key === "mvp" && item.artifact_type_key === "code")) result = addBinding(result, "production", "release_package");
  if (check.key === staticKey) result = addBinding(result, "prototype", null);
  return result;
}).concat(securityChecks(packageKey));

const QUALITY_LIMITS = Object.freeze({
  prototype: { calls: 4, duration_ms: 600000, correction_cycles: 0 },
  mvp: { calls: 12, duration_ms: 3600000, correction_cycles: 1 },
  production: { calls: 18, duration_ms: 7200000, correction_cycles: 1 },
  "security-audit": { calls: 8, duration_ms: 3600000, correction_cycles: 0 }
});
function normalizeOperationalLevels(levels = [], checks = []) {
  const byLevel = new Map(levels.map(item => [item.level, item]));
  const order = ["prototype", "mvp", "production", "security"];
  return Object.entries(QUALITY_LIMITS).map(([level, budgets]) => {
    const existing = byLevel.get(level) ?? {};
    const quality = level === "security-audit" ? "security" : level;
    const inherited = new Set(order.slice(0, order.indexOf(quality) + 1));
    const applicable = new Set(checks.filter(item => item.bindings.some(binding => inherited.has(binding.quality_mode_key) && binding.required)).map(item => item.key));
    const requested = existing.required_check_keys?.filter(key => applicable.has(key)) ?? [];
    return { level, budgets: { ...budgets }, required_check_keys: requested.length ? requested : [...applicable], correction_limit: budgets.correction_cycles, escalation: existing.escalation ?? {} };
  });
}
function step(key, ordinal, roleKey, artifacts = [], checks = [], options = {}) { return { key, ordinal, role_key: roleKey, required: options.required !== false, irreversible: Boolean(options.irreversible), input_schema_key: options.input ?? "package.v1", output_schema_key: options.output ?? (roleKey?.includes("reviewer") || roleKey === "reviewer" ? "reviewer.v1" : roleKey?.includes("documentator") || roleKey === "documentator" ? "documentator.v1" : roleKey === "planner" ? "planner.v1" : roleKey ? "worker.v1" : "approval.v1"), artifact_type_keys: artifacts, check_keys: checks, correction: options.correction ?? { max_cycles: roleKey && !roleKey.includes("reviewer") ? 1 : 0 }, escalation: options.escalation ?? { human_required_for_owner_decision: true } }; }
const transitions = steps => steps.slice(1).map((item, index) => ({ from: steps[index].key, to: item.key, condition: { previous_required_step: "completed" } }));
function workflow(key, name, steps, questions = [], options = {}) { return { key, name, default_quality: options.quality ?? "mvp", default_level: options.level ?? "L2", status: "active", discovery: { git: true }, history_budget_bytes: options.history ?? 24000, steps, transitions: transitions(steps), questions }; }
const question = (key, prompt, phase = "planning", required = true) => ({ key, phase, prompt, answer_schema: { type: "string", min_length: 1 }, required });
const route = (workType, workflowKey, priority = 10) => ({ work_type_key: workType, workflow_key: workflowKey, enabled: true, priority });
const binding = (roleKey, write = false, purpose = "registered context", priority = 0) => ({ role_key: roleKey, read: true, write, purpose, priority });
const document = (key, filePath, type, authority, bindings) => ({ key, path: filePath, type, authority, status: "active", bindings });
const scenario = (key, input, expected) => ({ key, input, expected, anonymized: true });

function finalize({ key, purpose, roles, workflows, routes, checks, operationalLevels, documents, scenarios, version = PACKAGE_VERSION }) {
  roles = roles.map(item => ({ ...item, contract: { ...item.contract, allowed_profile_keys: [`${key}.${item.key}.mvp`] } }));
  const workTypes = [...new Set([...roles.flatMap(item => item.contract.allowed_work_types), ...routes.map(item => item.work_type_key)])];
  const artifacts = [...new Set([...roles.flatMap(item => item.contract.allowed_artifact_types), ...workflows.flatMap(item => item.steps.flatMap(value => value.artifact_type_keys)), ...checks.flatMap(item => item.bindings.map(value => value.artifact_type_key).filter(Boolean))])];
  const qualities = Object.keys(qualityCatalog);
  const levels = [...new Set(workflows.map(item => item.default_level))];
  return { schema_version: 1, key, version, purpose, prompt_builder_version: PACKAGE_VERSION, catalogs: { work_types: catalog(workTypeCatalog, workTypes, "category"), artifact_types: catalog(artifactCatalog, artifacts, "category"), quality_modes: catalog(qualityCatalog, qualities, "ordinal"), planning_levels: catalog(levelCatalog, levels, "ordinal") }, roles, profiles: profilesFor(key, roles), workflows, state_machine: stateMachine(), routes, checks, operational_levels: normalizeOperationalLevels(operationalLevels, checks), documents, prompt_templates: promptsFor(roles), test_scenarios: scenarios };
}

function indiePackage(projectKey) {
  const isM = projectKey === "project-m";
  const prefix = isM ? "project_m" : "project_r";
  const technicalChecks = completeSoftwareChecks(isM ? [
    commandCheck("project_m_eslint", "Project M ESLint", "corepack.cmd", ["pnpm", "exec", "eslint", "."], [checkBinding("prototype", null)], 1200),
    commandCheck("project_m_typecheck", "Project M typecheck", "corepack.cmd", ["pnpm", "-r", "typecheck"], [checkBinding("mvp", "code")], 1800),
    commandCheck("project_m_build", "Project M build", "corepack.cmd", ["pnpm", "-r", "build"], [checkBinding("production", "release_package")], 2400),
    commandCheck("project_m_map_render", "Project M map render", "corepack.cmd", ["pnpm", "--filter", "@empolicy/map-render", "test"], [checkBinding("mvp", "code")], 1200),
    disabledCheck("project_m_unity_tests", "Project M Unity EditMode tests", "unity_editor_not_installed", [checkBinding("mvp", "code")]),
    disabledCheck("project_m_deployment_verification", "Project M deployment verification", "requires_project_specific_deployment_binding", [checkBinding("production", "release_package")])
  ] : [
    commandCheck("project_r_eslint", "Project R ESLint", "npm.cmd", ["exec", "--", "eslint", "."], [checkBinding("prototype", null)], 1200),
    commandCheck("project_r_typecheck", "Project R typecheck", "npm.cmd", ["exec", "--", "tsc", "--noEmit"], [checkBinding("mvp", "code")], 1200),
    commandCheck("project_r_tests", "Project R tests", "npm.cmd", ["test"], [checkBinding("mvp", "code")], 1800),
    commandCheck("project_r_build", "Project R build", "npm.cmd", ["run", "build"], [checkBinding("production", "release_package")], 1800),
    commandCheck("project_r_map_engine", "Project R map engine compatibility", "npm.cmd", ["run", "test:map-engine"], [checkBinding("mvp", "code")], 900),
    disabledCheck("project_r_e2e", "Project R browser scenario", "playwright_scenario_not_registered", [checkBinding("production", "release_package")]),
    disabledCheck("project_r_deployment_verification", "Project R deployment verification", "requires_project_specific_deployment_binding", [checkBinding("production", "release_package")])
  ], `${prefix}_eslint`, prefix);
  const codeChecks = technicalChecks.map(item => item.key);
  const roles = [
    role("classifier", "Select only a registered Indie Studio route.", ["conversation", "research", "game_design", "narrative", "implementation", "art_direction", "audio", "prototype", "testing", "release"], ["none"], { schema: "classification.v1", corrections: 0 }),
    role("researcher", "Read registered sources without editing.", ["research"], ["document"], { boundaries: { edits: false } }),
    role("planner", "Create a bounded normalized package without editing.", ["planning", "implementation", "prototype", "release"], ["document", "code", "prototype", "release_package"], { boundaries: { edits: false }, checks: codeChecks }),
    role("producer_assistant", "Collect goals, priorities and open owner decisions without deciding them.", ["producer", "decision"], ["decision", "document"]),
    role("game_designer", "Design mechanics, loops, balance and gameplay criteria without accepting them for the owner.", ["game_design"], ["document", "prototype"], { skills: ["game-production:game-design"] }),
    role("narrative_designer", "Propose story, quests and consequences within accepted canon.", ["narrative"], ["document", "content_asset"], { skills: ["game-production:game-narrative-design"] }),
    role("game_programmer", "Implement only the allowed game-code package.", ["implementation", "fix", "prototype"], ["code", "prototype"], { tools: ["apply_patch"], skills: ["game-production:project-context"], checks: codeChecks }),
    role("visual_artist", "Create visual candidates without visual acceptance.", ["art_direction", "asset"], ["visual_asset"], { skills: ["game-production:game-art-direction"] }),
    role("technical_artist", "Validate, optimize and bind registered assets.", ["technical_art", "asset"], ["technical_art_spec", "visual_asset"], { skills: ["game-production:game-technical-art"] }),
    role("sound_designer", "Create and integrate audio candidates without owner acceptance.", ["audio", "asset"], ["audio_asset"], { skills: ["game-production:game-audio-production"] }),
    role("game_tester", "Run registered technical checks and reproduce defects.", ["testing", "verification"], ["test_report"], { skills: ["game-production:browser-game-qa"], checks: codeChecks }),
    role("playtester", "Report gameplay observations separately from owner acceptance.", ["testing"], ["test_report"], { skills: ["game-production:browser-game-qa"], boundaries: { product_acceptance: false, gameplay_acceptance: false, visual_acceptance: false } }),
    role("reviewer", "Return PASS, CHANGES_REQUESTED or REJECT after program gates.", ["review"], ["test_report", "code", "document"], { checks: codeChecks }),
    role("documentator", "Update only registered working documents after accepted decisions.", ["documentation", "decision"], ["document", "decision"], { tools: ["apply_patch"] }),
    role("release_operator", "Build and verify a release candidate without publishing.", ["release"], ["release_package", "test_report"], { skills: ["game-production:browser-game-release"], checks: codeChecks, boundaries: { publish: false, deploy: false, owner_release_decision: false } })
  ];
  const flow = (key, name, items, questions = []) => workflow(`${prefix}.${key}`, name, items, questions);
  const workflows = [
    flow("indie_strategy", "Indie strategy", [step("producer_intake", 1, "producer_assistant", ["decision"]), step("research", 2, "researcher", ["document"], [], { required: false }), step("owner_decision", 3, null, ["decision"], [], { irreversible: true }), step("document", 4, "documentator", ["document"])], [question("target_outcome", "What is the next outcome the owner should evaluate?")]),
    flow("game_design", "Game design", [step("design", 1, "game_designer", ["document"]), step("document", 2, "documentator", ["document"]), step("owner_acceptance", 3, null, ["decision"], [], { irreversible: true })], [question("player_value", "What value should the player receive?")]),
    flow("narrative_design", "Narrative design", [step("narrative", 1, "narrative_designer", ["content_asset"]), step("owner_decision", 2, null, ["decision"], [], { irreversible: true }), step("document", 3, "documentator", ["document"])], [question("canon_choice", "Which narrative decision requires owner approval?")]),
    flow("game_implementation", "Game implementation", [step("plan", 1, "planner", ["document"]), step("implement", 2, "game_programmer", ["code"], codeChecks), step("test", 3, "game_tester", ["test_report"], codeChecks), step("review", 4, "reviewer", ["test_report"], codeChecks), step("document", 5, "documentator", ["document"])], [question("allowed_paths", "Which paths belong to the bounded package?")]),
    flow("visual_asset", "Visual asset", [step("direction", 1, "visual_artist", ["visual_asset"]), step("visual_acceptance", 2, null, ["decision"], [], { irreversible: true }), step("technical", 3, "technical_artist", ["technical_art_spec"]), step("provenance", 4, "documentator", ["document"]), step("owner_acceptance", 5, null, ["decision"], [], { irreversible: true })], [question("visual_brief", "Which visual brief has the owner accepted?")]),
    flow("audio_asset", "Audio asset", [step("brief", 1, "sound_designer", ["audio_asset"]), step("technical", 2, "game_tester", ["test_report"]), step("integration", 3, "sound_designer", ["audio_asset"]), step("owner_acceptance", 4, null, ["decision"], [], { irreversible: true })], [question("audio_brief", "Which audio brief has the owner accepted?")]),
    flow("prototype", "Prototype", [step("plan", 1, "planner", ["document"]), step("prototype", 2, "game_programmer", ["prototype"]), step("test", 3, "game_tester", ["test_report"])], [question("assumption", "Which single assumption does the prototype test?")]),
    flow("playtest", "Playtest", [step("build", 1, "release_operator", ["release_package"], codeChecks), step("playtest", 2, "playtester", ["test_report"]), step("owner_gates", 3, null, ["decision"], [], { irreversible: true })]),
    flow("release", "Release", [step("freeze", 1, "producer_assistant", ["decision"]), step("build", 2, "release_operator", ["release_package"], codeChecks), step("review", 3, "reviewer", ["test_report"], codeChecks), step("publication_approval", 4, null, ["decision"], [], { irreversible: true })], [question("release_authority", "Has the owner granted separate publication authority?")])
  ];
  const documents = isM ? [
    document("repo_rules", "AGENTS.md", "authority", "project-m", roles.map(item => binding(item.key))),
    document("current_strategy", "docs/CurrentStrategy.md", "strategy", "petr", roles.map(item => binding(item.key, item.key === "documentator", "current product strategy", 10))),
    document("current_stage", "docs/plans/CurrentStagePlan.md", "plan", "petr", roles.map(item => binding(item.key, item.key === "documentator", "single active package", 20))),
    document("lore_baseline", "docs/LoreBaseline.md", "authority", "project-lore", roles.map(item => binding(item.key)))
  ] : [
    document("current_strategy", "docs/CurrentStrategy.md", "strategy", "petr", roles.map(item => binding(item.key, item.key === "documentator", "current product strategy", 10))),
    document("current_stage", "docs/plans/CurrentStagePlan.md", "plan", "petr", roles.map(item => binding(item.key, item.key === "documentator", "single active package", 20))),
    document("values", "docs/Values.md", "authority", "petr", roles.map(item => binding(item.key))), document("gdd", "docs/GDD.md", "authority", "petr", roles.map(item => binding(item.key))), document("visual_style", "docs/VisualStyle.md", "authority", "petr", roles.map(item => binding(item.key))), document("tech", "docs/Tech.md", "authority", "project-r", roles.map(item => binding(item.key))), document("lore_baseline", "docs/LoreBaseline.md", "authority", "project-lore", roles.map(item => binding(item.key)))
  ];
  return finalize({ key: `indie-studio.${projectKey}`, version: "2.1.1", purpose: `Indie Studio workflow family for ${projectKey}; technical gates never replace Petr's gameplay, visual or product acceptance.`, roles, workflows, routes: [route("conversation", `${prefix}.indie_strategy`, 100), route("research", `${prefix}.indie_strategy`, 90), route("producer", `${prefix}.indie_strategy`), route("game_design", `${prefix}.game_design`), route("narrative", `${prefix}.narrative_design`), route("implementation", `${prefix}.game_implementation`), route("art_direction", `${prefix}.visual_asset`), route("audio", `${prefix}.audio_asset`), route("prototype", `${prefix}.prototype`), route("testing", `${prefix}.playtest`), route("release", `${prefix}.release`)], checks: technicalChecks, operationalLevels: [{ level: "prototype", budgets: { calls: 4, duration_ms: 600000 }, required_check_keys: [], correction_limit: 0, escalation: { owner_decisions: true } }, { level: "mvp", budgets: { calls: 12, duration_ms: 3600000 }, required_check_keys: codeChecks, correction_limit: 1, escalation: { reviewer_after_failure: true, owner_acceptance_separate: true } }, { level: "production", budgets: { calls: 20, duration_ms: 7200000 }, required_check_keys: codeChecks, correction_limit: 1, escalation: { reviewer_required: true, publication_requires_owner: true } }], documents, scenarios: [scenario("conversation", { work_type: "conversation" }, { productive_roles: [] }), scenario("research", { work_type: "research" }, { roles: ["researcher"], excludes: ["game_programmer", "reviewer"] }), scenario("narrative_decision", { work_type: "narrative", owner_decision: "pending" }, { route: `${prefix}.narrative_design`, documentator_after_approval: true }), scenario("game_code", { work_type: "implementation", artifact_type: "code" }, { route: `${prefix}.game_implementation`, gates_required: true }), scenario("visual_asset", { work_type: "art_direction" }, { route: `${prefix}.visual_asset`, human_acceptance: "pending" }), scenario("audio_asset", { work_type: "audio" }, { route: `${prefix}.audio_asset`, human_acceptance: "pending" })] });
}

function sharedMapPackage() {
  const internalTest = (key, name, file) => commandCheck(key, name, "node", ["--experimental-strip-types", file], [checkBinding("mvp", "code")], 900);
  const checks = completeSoftwareChecks([
    commandCheck("shared_map_typecheck", "SharedMapEngine typecheck", "corepack.cmd", ["pnpm", "typecheck"], [checkBinding("mvp", "code")]),
    internalTest("shared_map_network", "SharedMapEngine network tests", "src/network/placeNetwork.test.mjs"),
    internalTest("shared_map_package", "SharedMapEngine package tests", "src/publish/mapCorePackage.test.mjs"),
    internalTest("shared_map_core", "SharedMapEngine core tests", "src/core/mapCore.test.mjs"),
    internalTest("shared_map_blueprint", "SharedMapEngine blueprint tests", "src/core/blueprintFromMapCore.test.mjs"),
    internalTest("shared_map_compose", "SharedMapEngine compose tests", "src/compose/composeFromMapCore.test.mjs"),
    disabledCheck("shared_map_production", "SharedMapEngine Project M renderer integration", "requires_registered_project_m_renderer_root", [checkBinding("mvp", "code")]),
    commandCheck("shared_map_build", "SharedMapEngine build", "corepack.cmd", ["pnpm", "build"], [checkBinding("production", "release_package")]),
    projectCommandCheck("project_m_compatibility", "Project M compatibility", "project-m", "corepack.cmd", ["pnpm", "--filter", "@empolicy/map-render", "test"], [checkBinding("mvp", "code")], 1200),
    projectCommandCheck("project_r_compatibility", "Project R compatibility", "project-r", "npm.cmd", ["run", "test:map-engine"], [checkBinding("mvp", "code")], 900),
    disabledCheck("shared_map_deployment_verification", "SharedMapEngine publication verification", "requires_project_specific_publication_binding", [checkBinding("production", "release_package")])
  ], "shared_map_typecheck", "shared_map");
  const checkKeys = checks.map(item => item.key), roles = [role("shared_engine_architect", "Protect the presentation-neutral consumer contract.", ["planning", "map_design"], ["document"], { skills: ["game-production:shared-map-engine"] }), role("shared_engine_programmer", "Implement an isolated presentation-neutral engine package.", ["implementation", "fix"], ["code"], { tools: ["apply_patch"], skills: ["game-production:shared-map-engine"], checks: checkKeys }), role("shared_engine_tester", "Run deterministic engine and consumer compatibility checks.", ["testing", "verification"], ["test_report"], { checks: checkKeys }), role("shared_engine_reviewer", "Review engine boundaries read-only.", ["review"], ["test_report", "code"], { checks: checkKeys }), role("documentator", "Record the accepted contract version without product decisions.", ["documentation"], ["document"], { tools: ["apply_patch"] })];
  const steps = [step("contract", 1, "shared_engine_architect", ["document"]), step("implement", 2, "shared_engine_programmer", ["code"], checkKeys), step("test", 3, "shared_engine_tester", ["test_report"], checkKeys), step("review", 4, "shared_engine_reviewer", ["test_report"], checkKeys), step("document", 5, "documentator", ["document"])], workflows = [workflow("shared-map-engine.change", "Shared map engine change", steps, [question("consumer_contract", "Which exact Project M and Project R consumer contracts are in scope?")])];
  return finalize({ key: "shared-map-engine.core", version: "2.1.2", purpose: "Presentation-neutral shared map engine workflow with separate M/R compatibility and owner acceptance gates.", roles, workflows, routes: [route("map_design", "shared-map-engine.change"), route("implementation", "shared-map-engine.change")], checks, operationalLevels: [{ level: "mvp", budgets: { calls: 10, duration_ms: 3600000 }, required_check_keys: checkKeys, correction_limit: 1, escalation: { consumer_compatibility_required: true } }], documents: [document("repo_rules", "AGENTS.md", "authority", "shared-map-engine", roles.map(item => binding(item.key))), document("package_contract", "package.json", "reference", "shared-map-engine", roles.map(item => binding(item.key)))], scenarios: [scenario("engine_change", { work_type: "implementation", artifact_type: "code" }, { isolated_workspace: true, consumers: ["project-m", "project-r"], human_acceptance_separate: true })] });
}

function lorePackage() {
  const checks = [
    commandCheck("lore_index_schema", "Lore index schema", "node", ["scripts/lore-validate.mjs", "index"], [checkBinding("prototype", null)], 300),
    commandCheck("lore_continuity", "Lore continuity", "node", ["scripts/lore-validate.mjs", "continuity"], [checkBinding("mvp", "document")], 300),
    commandCheck("lore_source_hashes", "Lore source provenance", "node", ["scripts/lore-validate.mjs", "sources"], [checkBinding("mvp", "document")], 300)
  ], checkKeys = checks.map(item => item.key);
  const roles = [role("lore_researcher", "Inventory exact existing facts and sources without changing canon.", ["research"], ["document"], { skills: ["game-production:shared-world-lore"], boundaries: { edits: false, invent_facts: false } }), role("lore_editor", "Propose a LORE-CHANGE without accepting it.", ["narrative", "decision"], ["decision", "document"], { skills: ["game-production:shared-world-lore"] }), role("continuity_reviewer", "Find terminology, chronology and M/R impact conflicts.", ["review", "verification"], ["test_report", "document"], { skills: ["game-production:shared-world-lore"], checks: checkKeys }), role("lore_documentator", "Apply an owner-accepted LORE-CHANGE and update the index.", ["documentation", "decision"], ["document"], { tools: ["apply_patch"], skills: ["game-production:shared-world-lore"], checks: checkKeys })];
  const steps = [step("research", 1, "lore_researcher", ["document"]), step("proposal", 2, "lore_editor", ["decision"]), step("continuity", 3, "continuity_reviewer", ["test_report"], checkKeys), step("owner_decision", 4, null, ["decision"], [], { irreversible: true }), step("canon", 5, "lore_documentator", ["document"], checkKeys), step("consumer_proposals", 6, "lore_editor", ["decision"])], workflows = [workflow("shared-lore.change", "Shared lore change", steps, [question("shared_fact", "Which exact fact is proposed as shared canon?"), question("source_sha", "Which exact source SHA and section support the proposal?")])];
  return finalize({ key: "shared-lore.canon", purpose: "Shared Project Lore change protocol; Petr alone accepts canon and M/R synchronize separately.", roles, workflows, routes: [route("narrative", "shared-lore.change"), route("decision", "shared-lore.change")], checks, operationalLevels: [{ level: "mvp", budgets: { calls: 8, duration_ms: 2400000 }, required_check_keys: checkKeys, correction_limit: 1, escalation: { owner_canon_decision_required: true } }], documents: [document("repo_rules", "AGENTS.md", "authority", "project-lore", roles.map(item => binding(item.key))), document("change_protocol", "docs/ChangeProtocol.md", "authority", "project-lore", roles.map(item => binding(item.key))), document("canon", "docs/Canon.md", "authority", "petr", roles.map(item => binding(item.key, item.key === "lore_documentator", "owner-accepted shared canon", 20))), document("lore_index", "data/lore-index.json", "authority", "project-lore", roles.map(item => binding(item.key, item.key === "lore_documentator", "accepted canon index", 10)))], scenarios: [scenario("lore_change", { work_type: "narrative", candidate: "anonymized_fact" }, { continuity_review: true, owner_decision: "pending", consumer_updates: "separate" })] });
}

function oneCPackage() {
  const checks = completeSoftwareChecks([disabledCheck("bsl_language_server", "BSL Language Server diagnostics", "requires_local_bsl_binding", [checkBinding("mvp", "code")]), disabledCheck("one_c_local_build", "Stejmins 1C build", "requires_stejmins_build_binding", [checkBinding("production", "release_package")]), disabledCheck("one_c_runtime_1c", "Target 1C runtime", "requires_separate_runtime_authority", [checkBinding("production", "test_report")])], "bsl_language_server", "one_c"), sourceChecks = ["bsl_language_server"];
  const contextSkill = "advertising-project-context", workflowSkill = "advertising-workflow", developerSkills = [contextSkill, workflowSkill, "epf-build", "epf-validate", "form-info", "form-edit", "form-validate", "cfe-diff", "cfe-patch-method", "cfe-validate"];
  const roles = [role("one_c_analyst", "Define business outcome, current behavior, data, constraints and acceptance criteria.", ["research", "planning", "clarification"], ["document", "decision"], { skills: [contextSkill], boundaries: { edits: false, business_acceptance: false } }), role("one_c_developer", "Implement only allowed BSL, form or metadata files while preserving encoding and invariants.", ["implementation", "fix"], ["code"], { tools: ["apply_patch"], skills: developerSkills, checks: sourceChecks }), role("one_c_tester", "Keep source, local build and server runtime evidence separate.", ["testing", "verification"], ["test_report"], { skills: [contextSkill, "epf-validate", "form-validate", "cfe-validate"], checks: sourceChecks }), role("one_c_reviewer", "Review production/security/high-risk or failed correction packages without business acceptance.", ["review"], ["test_report", "code"], { skills: [contextSkill, workflowSkill], checks: sourceChecks }), role("one_c_documentator", "Update only registered plans and documentation after accepted decisions.", ["documentation", "decision"], ["document"], { tools: ["apply_patch"], skills: [contextSkill] })];
  const steps = [step("discovery", 1, "one_c_analyst", ["document"]), step("analysis", 2, "one_c_analyst", ["decision"]), step("owner_contract", 3, null, ["decision"], [], { irreversible: true }), step("implementation", 4, "one_c_developer", ["code"], sourceChecks), step("checks", 5, "one_c_tester", ["test_report"], sourceChecks), step("review", 6, "one_c_reviewer", ["test_report"], sourceChecks, { required: false }), step("document", 7, "one_c_documentator", ["document"]), step("user_acceptance", 8, null, ["decision"], [], { irreversible: true })], workflows = [workflow("one-c.change", "1C bounded change", steps, [question("business_outcome", "Which business outcome should change?"), question("current_behavior", "What behavior is observed now?"), question("data_contract", "Which data and invariants are affected?"), question("acceptance", "Which independent business, source, build, runtime, and user criteria apply?")])];
  return finalize({ key: "one-c.development", version: "2.2.0", purpose: "Portable 1C development workflow. BSL Language Server blocks only new critical correctness findings while maintainability findings remain visible; Stejmins build, target runtime, and user acceptance stay independent.", roles, workflows, routes: [route("implementation", "one-c.change"), route("fix", "one-c.change"), route("testing", "one-c.change")], checks, operationalLevels: [{ level: "mvp", budgets: { calls: 8, duration_ms: 3600000 }, required_check_keys: sourceChecks, correction_limit: 1, escalation: { reviewer_on_high_risk_or_failed_cycle: true, business_acceptance_separate: true, runtime_acceptance_separate: true } }], documents: [document("repo_rules", "AGENTS.md", "authority", "advertising-project", roles.map(item => binding(item.key))), document("change_plan", "docs/PLAN.md", "plan", "project-lead", roles.map(item => binding(item.key, item.key === "one_c_documentator", "single active change package", 20))), document("production_plan", "docs/CURRENT_PRODUCTION.md", "plan", "project-lead", roles.map(item => binding(item.key))), document("ai_workflow", "docs/AI_WORKFLOW.md", "authority", "advertising-project", roles.map(item => binding(item.key))), document("testing_1c", "docs/TESTING_1C.md", "reference", "advertising-project", roles.map(item => binding(item.key)))], scenarios: [scenario("green", { classification: "implementation", project_check: "passed" }, { route: "one-c.change", state: "approval_required", response: "Technical checks passed; runtime and user acceptance remain separate." }), scenario("red", { classification: "implementation", project_check: "failed" }, { route: "one-c.change", state: "changes_requested", response: "The check failed; correction is limited to one cycle." }), scenario("timeout", { classification: "implementation", project_check: "timed_out" }, { route: "one-c.change", state: "blocked", response: "The check timed out; the result is not green." }), scenario("unavailable", { classification: "implementation", project_check: "unavailable" }, { route: "one-c.change", state: "blocked", response: "The BSL check is unavailable: requires_local_bsl_binding." })] });
}

function companyWebPackage(spec) {
  const prefix = spec.key.replaceAll(/[^a-z0-9]+/g, "_");
  const codeChecks = spec.codeChecks ?? [];
  const dataChecks = spec.dataChecks ?? codeChecks;
  const releaseChecks = spec.releaseChecks ?? codeChecks;
  const contentChecks = spec.contentChecks ?? codeChecks;
  const roles = [
    role("classifier", "Classify natural-language intent using only registered work types and routes; never route by trigger phrase or keyword.", ["conversation", "continuation", "clarification", "research", "implementation", "fix", "documentation", "data_change", "incident", "access_management", "project_bootstrap", "security_review", "release", "deployment", ...(spec.content ? ["content", "asset"] : [])], ["none"], { schema: "classification.v1", corrections: 0, boundaries: { keyword_routing: false, productive_edits: false } }),
    role("researcher", "Read only registered project sources and return a bounded factual answer without editing.", ["research", "conversation", "continuation", "documentation", "incident", "access_management", "project_bootstrap", "security_review"], ["document", "incident_report", "security_report"], { boundaries: { edits: false, production_actions: false } }),
    role("planner", "Turn an accepted outcome into a bounded package with exact paths, checks, risks and approval boundaries.", ["planning", "implementation", "fix", "documentation", "data_change", "incident", "release", "deployment", "access_management", "project_bootstrap", "security_review", ...(spec.content ? ["content", "asset"] : [])], ["document", "decision", "code", "data_migration", "release_package", "workflow_package", "content_asset", "visual_asset", "security_report", "access_change"], { boundaries: { edits: false, production_actions: false }, checks: [...new Set([...codeChecks, ...dataChecks, ...releaseChecks, ...contentChecks])] }),
    role("web_developer", "Implement only the allowed source package and leave production unchanged.", ["implementation", "fix"], ["code"], { tools: ["apply_patch"], checks: codeChecks }),
    role("data_engineer", "Implement a reversible data contract or migration against fixtures or an isolated copy, never live data.", ["data_change", "implementation", "fix"], ["code", "data_migration"], { tools: ["apply_patch"], checks: dataChecks, boundaries: { live_data_writes: false, backup_required_before_apply: true } }),
    role("tester", "Run registered deterministic checks and keep source, CI, runtime and user evidence separate.", ["testing", "verification"], ["test_report", "deployment_evidence"], { checks: [...new Set([...codeChecks, ...dataChecks, ...releaseChecks, ...contentChecks])] }),
    role("reviewer", "Return PASS, CHANGES_REQUESTED or REJECT after required deterministic checks; never replace owner approval.", ["review", "verification", "security_review"], ["test_report", "code", "document", "security_report"], { checks: [...new Set([...codeChecks, ...dataChecks, ...releaseChecks, ...contentChecks])], boundaries: { owner_decisions: false, production_deploy: false } }),
    role("documentator", "Update only registered working documents from accepted structured decisions and pass semantic lint.", ["documentation", "decision"], ["document", "decision"], { tools: ["apply_patch"] }),
    role("release_operator", "Prepare or execute only an explicitly approved exact release and verify the deployed revision without changing shared data by hand.", ["release", "deployment"], ["release_package", "deployment_evidence"], { tools: ["exec_command"], checks: releaseChecks, boundaries: { explicit_approval_required: true, direct_release_edit: false, live_data_edit: false } }),
    role("incident_responder", "Diagnose production read-only, preserve evidence and separate a local repair from any later deployment.", ["incident", "research", "fix"], ["incident_report", "document"], { boundaries: { production_writes: false, deploy: false } }),
    role("access_administrator", "Prepare and apply the smallest approved access change without exposing credentials or broadening unrelated permissions.", ["access_management"], ["access_change", "test_report"], { tools: ["exec_command"], boundaries: { explicit_approval_required: true, secrets_in_output: false, least_privilege: true } }),
    role("security_reviewer", "Perform a read-only security review and return findings without silently changing policy or secrets.", ["security_review", "review"], ["security_report"], { boundaries: { edits: false, secret_access: false, acceptance: false } }),
    role("project_bootstrapper", "Create a bounded new-project proposal and local scaffolding without publishing or deploying.", ["project_bootstrap", "implementation"], ["workflow_package", "code", "document"], { tools: ["apply_patch"], boundaries: { publish: false, deploy: false } })
  ];
  if (spec.content) roles.push(role("content_specialist", "Prepare a traceable content or media candidate without final product acceptance.", ["content", "asset"], ["content_asset", "visual_asset", "document"], { tools: ["apply_patch"], checks: contentChecks, boundaries: { product_acceptance: false, publication: false } }));

  const flow = (key, name, items, questions = [], options = {}) => workflow(`${prefix}.${key}`, name, items, questions, options);
  const workflows = [
    flow("research", "Human conversation and bounded research", [step("research", 1, "researcher", ["document"])], [], { level: "L1", history: 20000 }),
    flow("change", "Bounded product change", [step("plan", 1, "planner", ["document"]), step("implement", 2, "web_developer", ["code"], codeChecks), step("checks", 3, "tester", ["test_report"], codeChecks), step("review", 4, "reviewer", ["test_report"], codeChecks), step("document", 5, "documentator", ["document"])], [question("expected_result", "Which observable result should change?"), question("protected_work", "Which existing changes and data must remain untouched?")]),
    flow("data", "Reversible data change", [step("plan", 1, "planner", ["data_migration"]), step("implement", 2, "data_engineer", ["code", "data_migration"], dataChecks), step("checks", 3, "tester", ["test_report"], dataChecks), step("review", 4, "reviewer", ["test_report"], dataChecks), step("apply_approval", 5, null, ["decision"], [], { irreversible: true }), step("document", 6, "documentator", ["document"])], [question("data_boundary", "Which data, time range, and invariants are affected?"), question("rollback", "How can rollback be tested without changing production data?")]),
    flow("release", "Verified release and deployment", [step("plan", 1, "planner", ["release_package"]), step("preflight", 2, "tester", ["test_report"], releaseChecks), step("review", 3, "reviewer", ["test_report"], releaseChecks), step("deployment_approval", 4, null, ["decision"], [], { irreversible: true }), step("deploy", 5, "release_operator", ["release_package", "deployment_evidence"], releaseChecks), step("verify", 6, "tester", ["deployment_evidence"], releaseChecks), step("document", 7, "documentator", ["document"])], [question("release_scope", "Which exact result and revision should be deployed?")], { quality: "production", level: "L3" }),
    flow("incident", "Production incident diagnosis and local repair", [step("diagnose", 1, "incident_responder", ["incident_report"]), step("plan", 2, "planner", ["document"]), step("repair", 3, "web_developer", ["code"], codeChecks), step("checks", 4, "tester", ["test_report"], codeChecks), step("review", 5, "reviewer", ["test_report"], codeChecks), step("document", 6, "documentator", ["document"])], [question("observed_failure", "What is observed, where, and since when?"), question("production_boundary", "Which production actions has the owner already authorized?")], { level: "L3" }),
    flow("access", "Least-privilege access change", [step("inspect", 1, "researcher", ["document"]), step("proposal", 2, "access_administrator", ["access_change"]), step("access_approval", 3, null, ["decision"], [], { irreversible: true }), step("apply", 4, "access_administrator", ["access_change"]), step("verify", 5, "tester", ["test_report"]), step("document", 6, "documentator", ["document"])], [question("identity", "Who needs access to what, and for which work?"), question("expiry", "Is the access permanent or time-limited?")], { quality: "production", level: "L3" }),
    flow("bootstrap", "New project bootstrap", [step("discover", 1, "researcher", ["document"]), step("plan", 2, "planner", ["workflow_package"]), step("scaffold", 3, "project_bootstrapper", ["code", "workflow_package"]), step("checks", 4, "tester", ["test_report"]), step("owner_approval", 5, null, ["decision"], [], { irreversible: true }), step("document", 6, "documentator", ["document"])], [question("project_owner", "Who owns the product and authorizes publication?"), question("runtime", "Where must the project run, and which data does it use?")], { level: "L3" }),
    flow("documentation", "Registered documentation update", [step("source", 1, "researcher", ["document"]), step("document", 2, "documentator", ["document"]), step("review", 3, "reviewer", ["document"])], [question("document_outcome", "Which accepted decision or verified fact should be recorded?")]),
    flow("security", "Read-only security review", [step("inventory", 1, "researcher", ["document"]), step("review", 2, "security_reviewer", ["security_report"]), step("owner_decision", 3, null, ["decision"], [], { irreversible: true }), step("document", 4, "documentator", ["document"])], [question("security_scope", "Which system boundary, data, and threat model are in scope?")], { quality: "security", level: "L4" })
  ];
  if (spec.content) workflows.push(flow("content", "Traceable content production", [step("brief", 1, "planner", ["document"]), step("produce", 2, "content_specialist", ["content_asset", "visual_asset"], contentChecks), step("checks", 3, "tester", ["test_report"], contentChecks), step("owner_acceptance", 4, null, ["decision"], [], { irreversible: true }), step("document", 5, "documentator", ["document"])], [question("content_outcome", "Which material is needed, for whom, and by which acceptance criteria?")], { level: "L2" }));

  const routes = [
    route("conversation", `${prefix}.research`, 100), route("continuation", `${prefix}.research`, 100), route("research", `${prefix}.research`, 90),
    route("implementation", `${prefix}.change`), route("fix", `${prefix}.change`), route("data_change", `${prefix}.data`),
    route("release", `${prefix}.release`), route("deployment", `${prefix}.release`), route("incident", `${prefix}.incident`),
    route("access_management", `${prefix}.access`), route("project_bootstrap", `${prefix}.bootstrap`), route("documentation", `${prefix}.documentation`), route("security_review", `${prefix}.security`)
  ];
  if (spec.content) { routes.push(route("content", `${prefix}.content`), route("asset", `${prefix}.content`)); }
  const documents = spec.documents.map(item => document(item.key, item.path, item.type, item.authority, roles.map(value => binding(value.key, value.key === "documentator", value.key === "documentator" ? "accepted project record" : "registered project context", value.key === "documentator" ? 20 : 0))));
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
      ...(spec.content ? [scenario("content_candidate", { message: "Prepare the material and show it for approval", classifier: "model" }, { work_type: "content", route: `${prefix}.content`, owner_acceptance: "pending" })] : [])
    ]
  });
}

function companyWebPackages() {
  const code = artifact => [checkBinding("mvp", artifact), checkBinding("production", artifact === "code" ? "release_package" : artifact)];
  const marketChecks = completeSoftwareChecks([
    commandCheck("marketplaces_lint", "MarketplacesData ESLint", "npm.cmd", ["run", "lint"], [checkBinding("prototype", null)], 1200),
    commandCheck("marketplaces_tests", "MarketplacesData tests", "npm.cmd", ["test"], [checkBinding("mvp", "code")], 3600),
    commandCheck("marketplaces_build", "MarketplacesData production build", "npm.cmd", ["run", "build"], [checkBinding("production", "release_package")], 1800),
    commandCheck("marketplaces_plan_status", "MarketplacesData plan status", "npm.cmd", ["run", "plan:status"], [checkBinding("mvp", "document")], 300),
    disabledCheck("marketplaces_ci", "MarketplacesData GitHub Actions", "requires_local_github_binding", [checkBinding("production", "release_package")]),
    disabledCheck("marketplaces_deployed_revision", "MarketplacesData deployed revision", "requires_local_server_binding", [checkBinding("production", "deployment_evidence")]),
    disabledCheck("marketplaces_public_health", "MarketplacesData public health", "requires_local_health_binding", [checkBinding("production", "deployment_evidence")])
  ], "marketplaces_lint", "marketplaces");
  const dashboardChecks = completeSoftwareChecks([
    commandCheck("dashboard_lint", "Dashboard ESLint", "npm.cmd", ["run", "lint"], [checkBinding("prototype", null)], 1200),
    commandCheck("dashboard_tests", "Dashboard tests", "npm.cmd", ["test"], [checkBinding("mvp", "code")], 1800),
    commandCheck("dashboard_build", "Dashboard production build", "npm.cmd", ["run", "build"], [checkBinding("production", "release_package")], 1800),
    disabledCheck("dashboard_deployed_revision", "Dashboard deployed revision", "requires_local_server_binding", [checkBinding("production", "deployment_evidence")]),
    disabledCheck("dashboard_public_health", "Dashboard public health", "requires_local_health_binding", [checkBinding("production", "deployment_evidence")])
  ], "dashboard_lint", "dashboard");
  const photoChecks = completeSoftwareChecks([
    commandCheck("photo_hub_tests", "Photo Hub tests", "npm.cmd", ["test"], [checkBinding("mvp", "code")], 1800),
    commandCheck("photo_hub_content_tests", "Photo Hub content tests", "npm.cmd", ["test"], [checkBinding("mvp", "content_asset")], 1800),
    commandCheck("photo_hub_build", "Photo Hub build", "npm.cmd", ["run", "build"], code("code"), 1800),
    commandCheck("photo_hub_sites", "Photo Hub Sites contract", "npm.cmd", ["run", "test:sites"], [checkBinding("mvp", "code")], 900),
    commandCheck("photo_hub_content_sites", "Photo Hub content Sites contract", "npm.cmd", ["run", "test:sites"], [checkBinding("mvp", "content_asset")], 900),
    commandCheck("photo_hub_release", "Photo Hub release contract", "npm.cmd", ["run", "release:check"], [checkBinding("production", "release_package")], 900),
    commandCheck("photo_hub_auth", "Photo Hub production auth", "npm.cmd", ["run", "test:production-auth"], [checkBinding("production", "release_package")], 900),
    disabledCheck("photo_hub_deployed_revision", "Photo Hub deployed revision", "requires_local_server_binding", [checkBinding("production", "deployment_evidence")])
  ], "photo_hub_build", "photo_hub");
  const mappingChecks = completeSoftwareChecks([
    commandCheck("mapping_hub_tests", "Mapping Hub tests", "python", ["-m", "unittest", "discover", "-s", "tests", "-v"], [checkBinding("mvp", "code")], 1800),
    commandCheck("mapping_hub_content_tests", "Mapping Hub content tests", "python", ["-m", "unittest", "discover", "-s", "tests", "-v"], [checkBinding("mvp", "content_asset")], 1800),
    commandCheck("mapping_hub_release", "Mapping Hub release contract", "python", ["scripts/release_check.py"], [checkBinding("mvp", "code"), checkBinding("production", "release_package")], 900),
    disabledCheck("mapping_hub_deployed_revision", "Mapping Hub deployed revision", "requires_local_server_binding", [checkBinding("production", "deployment_evidence")])
  ], "mapping_hub_release", "mapping_hub");
  const interiorChecks = completeSoftwareChecks([
    commandCheck("interior_hub_release", "Interior Hub release contract", "npm.cmd", ["run", "release:check"], [checkBinding("mvp", "code"), checkBinding("production", "release_package")], 1800),
    commandCheck("interior_hub_content_release", "Interior Hub content release contract", "npm.cmd", ["run", "release:check"], [checkBinding("mvp", "content_asset")], 1800),
    commandCheck("interior_hub_auth", "Interior Hub production auth", "npm.cmd", ["run", "test:production-auth"], [checkBinding("production", "release_package")], 900),
    disabledCheck("interior_hub_deployed_revision", "Interior Hub deployed revision", "requires_local_server_binding", [checkBinding("production", "deployment_evidence")])
  ], "interior_hub_release", "interior_hub");
  const operationsChecks = [
    disabledCheck("company_ops_source_validation", "Company operations source validation", "requires_project_specific_static_validator", [checkBinding("prototype", null)]),
    disabledCheck("company_ops_ssh_preflight", "Company SSH preflight", "requires_local_ssh_binding", [checkBinding("mvp", "access_change")]),
    disabledCheck("company_ops_auth_smoke", "Company identity smoke", "requires_local_identity_binding", [checkBinding("mvp", "access_change")]),
    disabledCheck("company_ops_deploy_health", "Company deployment health", "requires_project_specific_binding", [checkBinding("production", "deployment_evidence")]),
    ...securityChecks("company_ops")
  ];
  const zodchiChecks = completeSoftwareChecks([
    commandCheck("zodchi_static", "Zodchi source and semantic validation", "node", ["scripts/validate-source.mjs"], [checkBinding("prototype", null)], 600),
    commandCheck("zodchi_tests", "Zodchi complete test suite", "npm.cmd", ["test"], [checkBinding("mvp", "code")], 3600),
    commandCheck("zodchi_release_build", "Zodchi verified release build", "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/build-release.ps1", "-Output", "dist/Zodchi-gate", "-Replace"], [checkBinding("production", "release_package")], 3600)
  ], "zodchi_static", "zodchi");
  return [
    companyWebPackage({ key: "zodchi.product-development", version: "2.1.0", purpose: "Zodchi product development workflow with separate source, installed release and local data boundaries.", checks: zodchiChecks, codeChecks: ["zodchi_tests"], dataChecks: ["zodchi_tests"], releaseChecks: ["zodchi_tests", "zodchi_release_build"], documents: [
      { key: "product_readme", path: "README.md", type: "authority", authority: "zodchi" },
      { key: "architecture", path: "docs/ARCHITECTURE.md", type: "authority", authority: "zodchi" },
      { key: "product_identity", path: "product.json", type: "reference", authority: "zodchi" },
      { key: "changelog", path: "CHANGELOG.md", type: "plan", authority: "zodchi" }
    ] }),
    companyWebPackage({ key: "company-web.marketplaces-data", version: "2.1.1", purpose: "Company workflow for MarketplacesData development, data collection, production incidents and controlled deployment.", checks: marketChecks, codeChecks: ["marketplaces_tests", "marketplaces_build"], dataChecks: ["marketplaces_tests", "marketplaces_build"], releaseChecks: marketChecks.map(item => item.key), documents: [
      { key: "repo_rules", path: "AGENTS.md", type: "authority", authority: "marketplaces-data" },
      { key: "current_change", path: "docs/CURRENT_CHANGE.md", type: "plan", authority: "petr" },
      { key: "current_production", path: "docs/CURRENT_PRODUCTION.md", type: "plan", authority: "petr" },
      { key: "deployment", path: "docs/DEPLOYMENT.md", type: "authority", authority: "marketplaces-data" },
      { key: "package", path: "package.json", type: "reference", authority: "marketplaces-data" }
    ] }),
    companyWebPackage({ key: "company-web.dashboard", version: "2.1.1", purpose: "Company workflow for the analytics dashboard while preserving Petr and Artem peer work and production data boundaries.", checks: dashboardChecks, codeChecks: ["dashboard_tests", "dashboard_build"], dataChecks: ["dashboard_tests", "dashboard_build"], releaseChecks: dashboardChecks.map(item => item.key), documents: [
      { key: "repo_rules", path: "AGENTS.md", type: "authority", authority: "dashboard" },
      { key: "readme", path: "README.md", type: "authority", authority: "dashboard" },
      { key: "deployment", path: "docs/deployment.md", type: "authority", authority: "dashboard" },
      { key: "package", path: "package.json", type: "reference", authority: "dashboard" }
    ] }),
    companyWebPackage({ key: "company-web.photo-hub", purpose: "Human-first Photo Hub workflow for a non-programmer product owner, content operations and controlled deployment.", checks: photoChecks, codeChecks: ["photo_hub_tests", "photo_hub_build", "photo_hub_sites"], dataChecks: ["photo_hub_tests"], releaseChecks: photoChecks.map(item => item.key), contentChecks: ["photo_hub_content_tests", "photo_hub_content_sites"], content: true, documents: [
      { key: "repo_rules", path: "AGENTS.md", type: "authority", authority: "photo-hub" },
      { key: "readme", path: "README.md", type: "authority", authority: "photo-hub" },
      { key: "security", path: "SECURITY.md", type: "authority", authority: "photo-hub" },
      { key: "production", path: "docs/PRODUCTION_HANDOFF.md", type: "plan", authority: "product-owner" }
    ] }),
    companyWebPackage({ key: "company-web.mapping-hub", purpose: "Human-first Mapping Hub workflow for Python development, catalog decisions and controlled deployment.", checks: mappingChecks, codeChecks: ["mapping_hub_tests", "mapping_hub_release"], dataChecks: ["mapping_hub_tests", "mapping_hub_release"], releaseChecks: mappingChecks.map(item => item.key), contentChecks: ["mapping_hub_content_tests"], content: true, documents: [
      { key: "repo_rules", path: "AGENTS.md", type: "authority", authority: "mapping-hub" },
      { key: "readme", path: "README.md", type: "authority", authority: "mapping-hub" },
      { key: "security", path: "SECURITY.md", type: "authority", authority: "mapping-hub" },
      { key: "deployment", path: "docs/SERVER_DEPLOYMENT.md", type: "authority", authority: "mapping-hub" }
    ] }),
    companyWebPackage({ key: "company-web.interior-hub", purpose: "Human-first Interior Hub workflow for content, visual processing, code and controlled deployment.", checks: interiorChecks, codeChecks: ["interior_hub_release"], dataChecks: ["interior_hub_release"], releaseChecks: interiorChecks.map(item => item.key), contentChecks: ["interior_hub_content_release"], content: true, documents: [
      { key: "repo_rules", path: "AGENTS.md", type: "authority", authority: "interior-hub" },
      { key: "readme", path: "README.md", type: "authority", authority: "interior-hub" },
      { key: "security", path: "SECURITY.md", type: "authority", authority: "interior-hub" },
      { key: "deployment", path: "docs/SERVER_DEPLOYMENT.md", type: "authority", authority: "interior-hub" }
    ] }),
    companyWebPackage({ key: "company-operations.core", purpose: "Petr-owned administration, DevOps, access, project bootstrap, incident and security workflow for company infrastructure.", checks: operationsChecks, codeChecks: [], dataChecks: [], releaseChecks: operationsChecks.map(item => item.key), documents: [
      { key: "deploy_standard", path: "server-setup/GITHUB-ACTIONS-PRODUCTION-DEPLOY-STANDARD.md", type: "authority", authority: "petr" },
      { key: "team_accounts", path: "server-setup/TEAM-ACCOUNTS-DEPLOYMENT.md", type: "authority", authority: "petr" },
      { key: "remote_codex", path: "server-setup/remote-codex-onboarding/README.md", type: "authority", authority: "petr" },
      { key: "current_operations", path: "docs/CurrentOperations.md", type: "plan", authority: "petr" }
    ] })
  ];
}

export const PACKAGE_DEFINITIONS = Object.freeze([indiePackage("project-m"), indiePackage("project-r"), sharedMapPackage(), lorePackage(), oneCPackage(), ...companyWebPackages()]);
