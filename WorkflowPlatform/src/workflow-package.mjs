import fs from "node:fs";
import path from "node:path";
import { openDb, now } from "./db.mjs";
import { ATTEMPT_STATES, RUN_STATES, STEP_STATES, TASK_STATES, ALLOWED_TRANSITIONS } from "./state-machine.mjs";
import { stableJson, structuredHash } from "./role-contracts.mjs";
import { escapeXml, exactAttributes, exactChildren, parseLimitedXml } from "./limited-xml.mjs";
import { DEFAULT_QUALITY_CONTRACTS, QUALITY_LEVELS, qualityModesThrough } from "./quality-contracts.mjs";
import { RESOURCE_KINDS, RESOURCE_MODES } from "./resource-locks.mjs";
import { declareProjectResourceRequirement, projectResources } from "./project-resources.mjs";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SEMANTIC_KEY = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const PACKAGE_SCHEMA_VERSION = 2;
const PACKAGE_KEYS = ["schema_version", "key", "version", "purpose", "prompt_builder_version", "catalogs", "resources", "roles", "profiles", "workflows", "state_machine", "routes", "checks", "operational_levels", "evidence_flows", "documents", "prompt_templates", "test_scenarios"];
const FORBIDDEN_KEYS = new Set(["secret", "password", "api_key", "access_token", "refresh_token", "cookie", "credentials", "model_id", "profile_id", "root_path", "account"]);

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: object required`);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) throw new Error(`${label}: exact fields required`);
  return value;
}
function array(value, label) { if (!Array.isArray(value)) throw new Error(`${label}: array required`); return value; }
function semanticKey(value, label) { if (!SEMANTIC_KEY.test(String(value ?? ""))) throw new Error(`${label}: invalid semantic key`); return value; }
function parseJson(value, fallback) { return value === null || value === undefined ? fallback : JSON.parse(value); }
function digest(value) { return `sha256:${structuredHash(value)}`; }
function unique(items, selector, label) { const seen = new Set(); for (const item of items) { const value = selector(item); if (seen.has(value)) throw new Error(`${label}: duplicate ${value}`); seen.add(value); } }
function atomicJson(file, value) { const resolved = path.resolve(file); fs.mkdirSync(path.dirname(resolved), { recursive: true }); const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.renameSync(temporary, resolved); }
function rows(db, sql, ...parameters) { return db.prepare(sql).all(...parameters).map(row => ({ ...row })); }

function scanPortable(value, location = "package") {
  if (Array.isArray(value)) return value.forEach((item, index) => scanPortable(item, `${location}[${index}]`));
  if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) { if (FORBIDDEN_KEYS.has(name.toLowerCase())) throw new Error(`${location}.${name}: local or secret field forbidden`); scanPortable(item, `${location}.${name}`); }
  } else if (typeof value === "string") {
    if (/(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(value)) throw new Error(`${location}: credential-shaped value forbidden`);
    if (/\b[A-Za-z]:[\\/]/.test(value) || /\/(?:home|Users)\/[A-Za-z0-9._-]+\//.test(value)) throw new Error(`${location}: machine-specific absolute path forbidden`);
  }
}

function stateContract() {
  return { task_states: [...TASK_STATES], run_states: [...RUN_STATES], step_states: [...STEP_STATES], attempt_states: [...ATTEMPT_STATES], transitions: Object.fromEntries(Object.entries(ALLOWED_TRANSITIONS).map(([entity, transitions]) => [entity, Object.fromEntries(Object.entries(transitions).map(([from, to]) => [from, [...to]]))])) };
}
function mappedKey(db, projectId, type, localId) {
  return db.prepare(`SELECT m.semantic_key FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type=? AND m.local_id=? ORDER BY p.applied_at DESC LIMIT 1`).get(projectId, type, localId)?.semantic_key ?? localId;
}
function activeRelease(db, projectId, packageKey) { return db.prepare("SELECT * FROM workflow_package_releases WHERE project_id=? AND package_key=? AND status='active'").get(projectId, packageKey); }

function buildPackage(db, projectId, workflowFilter) {
  const project = db.prepare("SELECT id,name FROM projects WHERE id=?").get(projectId);
  if (!project) throw new Error(`PACKAGE_PROJECT_NOT_FOUND: ${projectId}`);
  const workflowRows = workflowFilter ? db.prepare("SELECT * FROM workflows WHERE project_id=? AND (id=? OR package_key=?) ORDER BY id").all(projectId, workflowFilter, workflowFilter) : db.prepare("SELECT * FROM workflows WHERE project_id=? ORDER BY id").all(projectId);
  if (!workflowRows.length) throw new Error("PACKAGE_WORKFLOW_NOT_FOUND");
  const packageKey = workflowRows.find(row => row.package_key)?.package_key ?? workflowFilter ?? projectId;
  const release = activeRelease(db, projectId, packageKey);
  const version = release?.version ?? workflowRows.find(row => row.package_version)?.package_version ?? "1.0.0";
  const workflowIds = new Set(workflowRows.map(row => row.id));
  const workflowKeys = new Map(workflowRows.map(row => [row.id, mappedKey(db, projectId, "workflow", row.id)]));
  const contractRows = db.prepare("SELECT rc.*,r.name role_name FROM role_contracts rc JOIN roles r ON r.id=rc.role_id WHERE rc.project_id=? AND rc.status='active' ORDER BY rc.role_id").all(projectId);
  const roles = contractRows.map(row => ({ key: row.role_id, name: row.role_name, contract: { version: row.version, purpose: row.purpose, boundaries: parseJson(row.boundaries_json, {}), allowed_work_types: parseJson(row.allowed_work_types_json, []), allowed_artifact_types: parseJson(row.allowed_artifact_types_json, []), allowed_tools: parseJson(row.allowed_tools_json, []), allowed_skills: parseJson(row.allowed_skills_json, []), required_checks: parseJson(row.required_checks_json, []), allowed_transitions: parseJson(row.allowed_transitions_json, []), allowed_profile_keys: parseJson(row.allowed_profiles_json, []), context_limit_bytes: row.context_limit_bytes, max_calls: row.max_calls, max_correction_cycles: row.max_correction_cycles, timeout_seconds: row.timeout_seconds, result_schema_key: row.result_schema_key, prompt_template_version: row.prompt_template_version, escalation: parseJson(row.escalation_json, {}) } }));
  let profiles = db.prepare("SELECT * FROM portable_profile_requirements WHERE project_id=? AND package_key=? ORDER BY profile_key").all(projectId, packageKey).map(row => ({ key: row.profile_key, role_key: row.role_id, provider_family: row.provider_family, capabilities: parseJson(row.capabilities_json, []), operational_levels: parseJson(row.operational_levels_json, []) }));
  if (!profiles.length) profiles = db.prepare("SELECT a.role_id,a.operational_level,p.provider FROM role_profile_assignments a JOIN profiles p ON p.id=a.profile_id WHERE a.project_id=? AND a.enabled=1 ORDER BY a.role_id,a.operational_level").all(projectId).map(row => ({ key: `${row.role_id}.${row.operational_level}`, role_key: row.role_id, provider_family: row.provider, capabilities: [], operational_levels: [row.operational_level] }));
  const workflows = workflowRows.map(row => ({
    key: workflowKeys.get(row.id), name: row.name, default_quality: row.default_quality, default_level: row.default_level, status: row.status, discovery: parseJson(row.discovery_json, { git: false }), history_budget_bytes: row.history_budget_bytes,
    steps: db.prepare("SELECT * FROM workflow_step_templates WHERE project_id=? AND workflow_id=? ORDER BY ordinal").all(projectId, row.id).map(step => ({ key: step.step_key, ordinal: step.ordinal, role_key: step.role_id, required: Boolean(step.required), irreversible: Boolean(step.irreversible), input_schema_key: step.input_schema_key, output_schema_key: step.output_schema_key, artifact_type_keys: parseJson(step.artifact_types_json, []), check_keys: parseJson(step.check_keys_json, []), resources: parseJson(step.resources_json, []), correction: parseJson(step.correction_json, {}), escalation: parseJson(step.escalation_json, {}) })),
    transitions: db.prepare("SELECT * FROM workflow_transition_templates WHERE project_id=? AND workflow_id=? ORDER BY from_step_key,to_step_key").all(projectId, row.id).map(item => ({ from: item.from_step_key, to: item.to_step_key, condition: parseJson(item.condition_json, {}) })),
    questions: db.prepare("SELECT * FROM workflow_questions WHERE project_id=? AND workflow_id=? ORDER BY question_key").all(projectId, row.id).map(item => ({ key: item.question_key, phase: item.phase, prompt: item.prompt, answer_schema: parseJson(item.answer_schema_json, {}), required: Boolean(item.required) }))
  }));
  const routeRows = db.prepare("SELECT * FROM workflow_routes WHERE project_id=? ORDER BY work_type_id,priority DESC,workflow_id").all(projectId).filter(row => workflowIds.has(row.workflow_id));
  const checkRows = db.prepare("SELECT d.*,pc.quality_mode_id,pc.required,pc.artifact_type_id FROM project_checks pc JOIN check_definitions d ON d.id=pc.check_id WHERE pc.project_id=? ORDER BY d.id,pc.quality_mode_id,pc.artifact_type_id").all(projectId);
  const checkMap = new Map();
  for (const row of checkRows) { const itemKey = mappedKey(db, projectId, "check", row.id), item = checkMap.get(itemKey) ?? { key: itemKey, name: row.name, runner: row.runner, kind: row.kind, config: parseJson(row.config_json, {}), timeout_seconds: row.timeout_seconds, bindings: [] }; item.bindings.push({ quality_mode_key: row.quality_mode_id, artifact_type_key: row.artifact_type_id, required: Boolean(row.required) }); checkMap.set(itemKey, item); }
  const documents = db.prepare("SELECT * FROM project_documents WHERE project_id=? AND active=1 ORDER BY id").all(projectId).map(row => ({ key: mappedKey(db, projectId, "document", row.id), path: row.path.replaceAll("\\", "/"), root: row.root_key, type: row.document_type, authority: row.authority, status: row.status, bindings: db.prepare("SELECT role_id,read_access,write_access,purpose,priority FROM role_documents WHERE project_id=? AND document_id=? ORDER BY role_id").all(projectId, row.id).map(binding => ({ role_key: binding.role_id, read: Boolean(binding.read_access), write: Boolean(binding.write_access), purpose: binding.purpose, priority: binding.priority })) }));
  const operationalLevels = db.prepare("SELECT * FROM operational_level_policies WHERE project_id=? AND package_key=? ORDER BY level").all(projectId, packageKey).map(row => {
    const normalized = db.prepare("SELECT metric,limit_value FROM operational_level_budget_limits WHERE project_id=? AND package_key=? AND level=? ORDER BY metric").all(projectId, packageKey, row.level);
    const budgets = normalized.length ? Object.fromEntries(normalized.map(item => [item.metric, item.limit_value])) : parseJson(row.budgets_json, {});
    return { level: row.level, improvement_strategy: row.improvement_strategy ?? "standard", budgets, required_check_keys: parseJson(row.required_checks_json, []), correction_limit: row.correction_limit, escalation: parseJson(row.escalation_json, {}) };
  });
  const prompts = db.prepare("SELECT * FROM prompt_templates WHERE project_id=? AND package_key=? AND status='active' ORDER BY template_key").all(projectId, packageKey).map(row => ({ key: row.template_key, version: row.version, role_key: row.role_id, result_schema_key: row.result_schema_key, template: row.template_text, content_hash: row.content_hash }));
  const scenarios = db.prepare("SELECT * FROM package_test_scenarios WHERE project_id=? AND package_key=? AND package_version=? ORDER BY scenario_key").all(projectId, packageKey, version).map(row => ({ key: row.scenario_key, input: parseJson(row.input_json, {}), expected: parseJson(row.expected_json, {}), anonymized: Boolean(row.anonymized) }));
  const evidenceFlows = db.prepare("SELECT * FROM evidence_flow_adapters WHERE project_id=? AND package_key=? ORDER BY flow_key").all(projectId, packageKey).map(row => ({
    key: row.flow_key, claim_type: row.claim_type, subject: row.subject, target: row.target,
    workflow_keys: parseJson(row.workflow_keys_json, []), nodes: parseJson(row.nodes_json, []), required_edges: parseJson(row.required_edges_json, []),
    material_symbols: parseJson(row.material_symbols_json, []), transition: { adapter: row.transition_adapter, method: row.transition_method }, status: row.status
  }));
  const referencedWorkTypes = [...new Set(routeRows.map(row => row.work_type_id))];
  const referencedArtifacts = [...new Set([...roles.flatMap(role => role.contract.allowed_artifact_types), ...workflows.flatMap(workflow => workflow.steps.flatMap(step => step.artifact_type_keys)), ...[...checkMap.values()].flatMap(check => check.bindings.map(binding => binding.artifact_type_key).filter(Boolean))])];
  const referencedQuality = [...new Set([...workflowRows.map(row => row.default_quality), ...checkRows.map(row => row.quality_mode_id)])];
  const referencedLevels = [...new Set(workflowRows.map(row => row.default_level))];
  const referencedDomains = parseJson(release?.domain_keys_json, []);
  const referencedDisciplines = parseJson(release?.discipline_keys_json, []);
  const resourceAliases = [...new Set(workflows.flatMap(workflow => workflow.steps.flatMap(step => step.resources.map(resource => resource.alias))))].sort();
  const installedResources = new Map(projectResources(db, projectId).map(resource => [resource.alias, resource]));
  const resources = resourceAliases.map(alias => {
    const resource = installedResources.get(alias);
    if (!resource) throw new Error(`PACKAGE_DEPENDENCY_MISSING: project_resources:${alias}`);
    return { alias: resource.alias, kind: resource.kind, purpose: resource.purpose };
  });
  const catalog = (table, ids, fields) => ids.sort().map(idValue => { const row = db.prepare(`SELECT ${fields.join(",")} FROM ${table} WHERE id=?`).get(idValue); if (!row) throw new Error(`PACKAGE_DEPENDENCY_MISSING: ${table}:${idValue}`); return { key: idValue, ...Object.fromEntries(fields.filter(field => field !== "id").map(field => [field, row[field]])) }; });
  return { schema_version: PACKAGE_SCHEMA_VERSION, key: packageKey, version, purpose: release?.purpose ?? `Portable workflows for ${project.name}`, prompt_builder_version: release?.prompt_builder_version ?? "1.0.0", catalogs: { domains: catalog("domains", referencedDomains, ["id", "name"]), disciplines: catalog("disciplines", referencedDisciplines, ["id", "name"]), work_types: catalog("work_types", referencedWorkTypes, ["id", "name", "category"]), artifact_types: catalog("artifact_types", referencedArtifacts, ["id", "name", "category"]), quality_modes: catalog("quality_modes", referencedQuality, ["id", "name", "ordinal"]), planning_levels: catalog("planning_levels", referencedLevels, ["id", "name", "ordinal"]) }, resources, roles, profiles, workflows, state_machine: stateContract(), routes: routeRows.map(row => ({ work_type_key: row.work_type_id, workflow_key: workflowKeys.get(row.workflow_id), enabled: Boolean(row.enabled), priority: row.priority })), checks: [...checkMap.values()], operational_levels: operationalLevels, evidence_flows: evidenceFlows, documents, prompt_templates: prompts, test_scenarios: scenarios };
}

export function buildWorkflowPackageValue(db, projectId, workflowFilter = null) { return validateWorkflowPackage(buildPackage(db, projectId, workflowFilter)); }

export function validateWorkflowPackage(value) {
  if (value?.schema_version !== PACKAGE_SCHEMA_VERSION) {
    if (value?.schema_version === 1) throw new Error("WORKFLOW_PACKAGE_SCHEMA_MIGRATION_REQUIRED: schema_version 1 -> 2");
    throw new Error(`workflow_package: unsupported schema_version ${value?.schema_version ?? "missing"}`);
  }
  exactObject(value, PACKAGE_KEYS, "workflow_package");
  semanticKey(value.key, "workflow_package.key"); if (!SEMVER.test(value.version) || !SEMVER.test(value.prompt_builder_version) || !String(value.purpose ?? "").trim()) throw new Error("workflow_package: invalid metadata");
  exactObject(value.catalogs, ["domains", "disciplines", "work_types", "artifact_types", "quality_modes", "planning_levels"], "catalogs");
  const catalogs = {};
  for (const [name, items] of Object.entries(value.catalogs)) { array(items, `catalogs.${name}`); unique(items, item => semanticKey(item.key, `${name}.key`), name); catalogs[name] = new Set(items.map(item => item.key)); }
  for (const name of ["domains", "disciplines"]) for (const item of value.catalogs[name]) { exactObject(item, ["key", "name"], `catalogs.${name}.${item.key}`); if (typeof item.name !== "string" || !item.name.trim()) throw new Error(`catalogs.${name}.${item.key}: name required`); }
  for (const name of ["work_types", "artifact_types"]) for (const item of value.catalogs[name]) { exactObject(item, ["key", "name", "category"], `catalogs.${name}.${item.key}`); if (typeof item.name !== "string" || !item.name.trim() || typeof item.category !== "string" || !item.category.trim()) throw new Error(`catalogs.${name}.${item.key}: metadata required`); }
  for (const name of ["quality_modes", "planning_levels"]) for (const item of value.catalogs[name]) { exactObject(item, ["key", "name", "ordinal"], `catalogs.${name}.${item.key}`); if (typeof item.name !== "string" || !item.name.trim() || !Number.isInteger(item.ordinal)) throw new Error(`catalogs.${name}.${item.key}: metadata required`); }
  array(value.resources, "resources"); unique(value.resources, resource => semanticKey(resource.alias, "resource.alias"), "resources");
  const resourceAliases = new Set(value.resources.map(resource => resource.alias));
  for (const resource of value.resources) {
    exactObject(resource, ["alias", "kind", "purpose"], `resource.${resource.alias}`);
    if (!RESOURCE_KINDS.includes(resource.kind) || (resource.purpose !== null && typeof resource.purpose !== "string")) throw new Error(`resource.${resource.alias}: invalid portable requirement`);
  }
  array(value.roles, "roles"); unique(value.roles, role => semanticKey(role.key, "role.key"), "roles"); const roleKeys = new Set(value.roles.map(role => role.key));
  const contractFields = ["version", "purpose", "boundaries", "allowed_work_types", "allowed_artifact_types", "allowed_tools", "allowed_skills", "required_checks", "allowed_transitions", "allowed_profile_keys", "context_limit_bytes", "max_calls", "max_correction_cycles", "timeout_seconds", "result_schema_key", "prompt_template_version", "escalation"];
  for (const role of value.roles) { exactObject(role, ["key", "name", "contract"], `role.${role.key}`); exactObject(role.contract, contractFields, `role.${role.key}.contract`); const c = role.contract; if (!String(c.purpose ?? "").trim()) throw new Error(`role.${role.key}: executable purpose is required`); if (!SEMVER.test(c.version) || !SEMVER.test(c.prompt_template_version) || !Number.isInteger(c.context_limit_bytes) || c.context_limit_bytes < 1024 || !Number.isInteger(c.max_calls) || c.max_calls < 1 || !Number.isInteger(c.max_correction_cycles) || c.max_correction_cycles < 0 || !Number.isInteger(c.timeout_seconds) || c.timeout_seconds < 1) throw new Error(`role.${role.key}: invalid contract`); for (const workType of array(c.allowed_work_types, "contract.allowed_work_types")) if (!catalogs.work_types.has(workType)) throw new Error(`role.${role.key}: missing work type ${workType}`); for (const artifact of array(c.allowed_artifact_types, "contract.allowed_artifact_types")) if (!catalogs.artifact_types.has(artifact)) throw new Error(`role.${role.key}: missing artifact ${artifact}`); }
  array(value.profiles, "profiles"); unique(value.profiles, profile => semanticKey(profile.key, "profile.key"), "profiles"); const profileKeys = new Set(value.profiles.map(profile => profile.key));
  for (const profile of value.profiles) { exactObject(profile, ["key", "role_key", "provider_family", "capabilities", "operational_levels"], `profile.${profile.key}`); if (!roleKeys.has(profile.role_key)) throw new Error(`profile.${profile.key}: missing role`); array(profile.capabilities, "profile.capabilities"); array(profile.operational_levels, "profile.operational_levels"); }
  for (const role of value.roles) for (const profileKey of role.contract.allowed_profile_keys) if (profileKey !== "*" && !profileKeys.has(profileKey)) throw new Error(`role.${role.key}: missing profile ${profileKey}`);
  array(value.checks, "checks"); unique(value.checks, check => semanticKey(check.key, "check.key"), "checks"); const checkKeys = new Set(value.checks.map(check => check.key));
  for (const check of value.checks) { exactObject(check, ["key", "name", "runner", "kind", "config", "timeout_seconds", "bindings"], `check.${check.key}`); if (!String(check.runner ?? "").trim()) throw new Error(`check.${check.key}: executable runner is required`); if (!Number.isInteger(check.timeout_seconds) || check.timeout_seconds < 1) throw new Error(`check.${check.key}: invalid timeout`); const bindings = array(check.bindings, "check.bindings"); unique(bindings, binding => binding.quality_mode_key, `check.${check.key}.bindings_by_quality`); for (const binding of bindings) { exactObject(binding, ["quality_mode_key", "artifact_type_key", "required"], "check.binding"); if (!catalogs.quality_modes.has(binding.quality_mode_key) || (binding.artifact_type_key && !catalogs.artifact_types.has(binding.artifact_type_key))) throw new Error(`check.${check.key}: missing binding dependency`); } }
  for (const role of value.roles) for (const checkKey of role.contract.required_checks) if (!checkKeys.has(checkKey)) throw new Error(`role.${role.key}: missing check ${checkKey}`);
  array(value.workflows, "workflows"); unique(value.workflows, workflow => semanticKey(workflow.key, "workflow.key"), "workflows"); const workflowKeys = new Set(value.workflows.map(workflow => workflow.key));
  for (const workflow of value.workflows) { exactObject(workflow, ["key", "name", "default_quality", "default_level", "status", "discovery", "history_budget_bytes", "steps", "transitions", "questions"], `workflow.${workflow.key}`); if (!catalogs.quality_modes.has(workflow.default_quality) || !catalogs.planning_levels.has(workflow.default_level) || !Number.isInteger(workflow.history_budget_bytes) || workflow.history_budget_bytes < 1024) throw new Error(`workflow.${workflow.key}: invalid settings`); unique(array(workflow.steps, "workflow.steps"), step => semanticKey(step.key, "step.key"), `workflow.${workflow.key}.steps`); const stepKeys = new Set(workflow.steps.map(step => step.key)); for (const step of workflow.steps) { exactObject(step, ["key", "ordinal", "role_key", "required", "irreversible", "input_schema_key", "output_schema_key", "artifact_type_keys", "check_keys", "resources", "correction", "escalation"], `step.${step.key}`); if (step.role_key && !roleKeys.has(step.role_key)) throw new Error(`step.${step.key}: missing role`); for (const checkKey of step.check_keys) if (!checkKeys.has(checkKey)) throw new Error(`step.${step.key}: missing check ${checkKey}`); for (const artifact of step.artifact_type_keys) if (!catalogs.artifact_types.has(artifact)) throw new Error(`step.${step.key}: missing artifact ${artifact}`); for (const resource of array(step.resources, `step.${step.key}.resources`)) { exactObject(resource, ["alias", "mode"], `step.${step.key}.resource`); if (!resourceAliases.has(resource.alias) || !RESOURCE_MODES.includes(resource.mode)) throw new Error(`step.${step.key}: missing or invalid resource ${resource.alias}`); } } for (const transition of array(workflow.transitions, "workflow.transitions")) { exactObject(transition, ["from", "to", "condition"], "workflow.transition"); if (!stepKeys.has(transition.from) || !stepKeys.has(transition.to)) throw new Error(`workflow.${workflow.key}: transition dependency missing`); } for (const question of array(workflow.questions, "workflow.questions")) { exactObject(question, ["key", "phase", "prompt", "answer_schema", "required"], "workflow.question"); semanticKey(question.key, "question.key"); } }
  for (const route of array(value.routes, "routes")) { exactObject(route, ["work_type_key", "workflow_key", "enabled", "priority"], "route"); if (!catalogs.work_types.has(route.work_type_key) || !workflowKeys.has(route.workflow_key)) throw new Error("route: dependency missing"); }
  exactObject(value.state_machine, ["task_states", "run_states", "step_states", "attempt_states", "transitions"], "state_machine"); if (stableJson(value.state_machine) !== stableJson(stateContract())) throw new Error("state_machine: incompatible runtime contract");
  const policies = array(value.operational_levels, "operational_levels");
  unique(policies, policy => policy.level, "operational_levels");
  if (policies.length !== QUALITY_LEVELS.length || QUALITY_LEVELS.some(level => !policies.some(policy => policy.level === level))) throw new Error("operational_levels: all four quality contracts are required");
  const softwarePackage = value.roles.some(role => role.contract.allowed_artifact_types.some(type => ["code", "prototype", "release_package"].includes(type)));
  for (const policy of policies) {
    exactObject(policy, ["level", "improvement_strategy", "budgets", "required_check_keys", "correction_limit", "escalation"], "operational_level");
    if (!["standard", "gauntlet"].includes(policy.improvement_strategy)) throw new Error(`operational_level.${policy.level}: invalid improvement strategy`);
    const consiliumMembers = policy.escalation?.max_parallel_consilium_members;
    if (consiliumMembers !== undefined && (!Number.isInteger(consiliumMembers) || consiliumMembers < 1 || consiliumMembers > 3)) throw new Error(`operational_level.${policy.level}: max_parallel_consilium_members must be an integer from 1 to 3`);
    const reviewMemberCount = ["reviewer", "adversarial_reviewer", "evidence_reviewer"].filter(role => roleKeys.has(role)).length;
    if (policy.improvement_strategy === "gauntlet" && Number(consiliumMembers ?? 2) > 1 && reviewMemberCount > 1 && !roleKeys.has("judge")) throw new Error(`operational_level.${policy.level}: multi-member consilium requires judge`);
    const qualityContract = DEFAULT_QUALITY_CONTRACTS.find(item => item.level === policy.level);
    if (!qualityContract || !Number.isInteger(policy.correction_limit) || policy.correction_limit < 0 || policy.correction_limit !== Number(policy.budgets.correction_cycles)) throw new Error(`operational_level.${policy.level}: invalid correction contract`);
    const budgetKeys = Object.keys(policy.budgets).sort();
    if (stableJson(budgetKeys) !== stableJson(["calls", "correction_cycles", "cost_usd", "duration_ms"])) throw new Error(`operational_level.${policy.level}: budgets must be normalized`);
    for (const budget of qualityContract.budgets) {
      const configured = Number(policy.budgets[budget.metric]);
      if (!Number.isFinite(configured) || configured < 0) throw new Error(`operational_level.${policy.level}: invalid budget`);
      if (policy.improvement_strategy === "standard" && configured !== Number(budget.limit)) throw new Error(`operational_level.${policy.level}: standard budget differs from universal contract`);
    }
    const inheritedQualities = new Set(qualityModesThrough(policy.level));
    for (const checkKey of policy.required_check_keys) {
      if (!checkKeys.has(checkKey)) throw new Error(`operational_level.${policy.level}: missing check`);
      const check = value.checks.find(item => item.key === checkKey);
      if (!check.bindings.some(binding => inheritedQualities.has(binding.quality_mode_key) && binding.required)) throw new Error(`operational_level.${policy.level}: check is not bound: ${checkKey}`);
    }
    if (softwarePackage && !policy.required_check_keys.length) throw new Error(`operational_level.${policy.level}: software package requires checks`);
  }
  array(value.evidence_flows, "evidence_flows"); unique(value.evidence_flows, flow => semanticKey(flow.key, "evidence_flow.key"), "evidence_flows");
  for (const flow of value.evidence_flows) {
    exactObject(flow, ["key", "claim_type", "subject", "target", "workflow_keys", "nodes", "required_edges", "material_symbols", "transition", "status"], `evidence_flow.${flow.key}`);
    semanticKey(flow.claim_type, `evidence_flow.${flow.key}.claim_type`);
    if (!String(flow.subject).trim() || !String(flow.target).trim() || !["active", "disabled"].includes(flow.status)) throw new Error(`evidence_flow.${flow.key}: invalid metadata`);
    for (const workflowKey of array(flow.workflow_keys, `evidence_flow.${flow.key}.workflow_keys`)) if (!workflowKeys.has(workflowKey)) throw new Error(`evidence_flow.${flow.key}: missing workflow ${workflowKey}`);
    unique(array(flow.nodes, `evidence_flow.${flow.key}.nodes`), node => semanticKey(node.key, "evidence_flow.node.key"), `evidence_flow.${flow.key}.nodes`);
    const nodeKeys = new Set(flow.nodes.map(node => node.key));
    for (const node of flow.nodes) {
      exactObject(node, ["key", "step_keys", "path_hints", "anchor_terms"], `evidence_flow.${flow.key}.node.${node.key}`);
      for (const list of [node.step_keys, node.path_hints, node.anchor_terms]) if (!Array.isArray(list) || list.some(item => typeof item !== "string")) throw new Error(`evidence_flow.${flow.key}.node.${node.key}: string arrays required`);
    }
    for (const edge of array(flow.required_edges, `evidence_flow.${flow.key}.required_edges`)) {
      const [from, to, ...extra] = String(edge).split("->");
      if (extra.length || !nodeKeys.has(from) || !nodeKeys.has(to)) throw new Error(`evidence_flow.${flow.key}: invalid edge ${edge}`);
    }
    if (!Array.isArray(flow.material_symbols) || flow.material_symbols.some(item => typeof item !== "string")) throw new Error(`evidence_flow.${flow.key}: material_symbols must be strings`);
    exactObject(flow.transition, ["adapter", "method"], `evidence_flow.${flow.key}.transition`);
    if ((flow.transition.adapter === null) !== (flow.transition.method === null)) throw new Error(`evidence_flow.${flow.key}: transition adapter and method must both be set or null`);
  }
  array(value.documents, "documents"); unique(value.documents, document => semanticKey(document.key, "document.key"), "documents"); for (const document of value.documents) { exactObject(document, ["key", "path", "root", "type", "authority", "status", "bindings"], `document.${document.key}`);
    if (typeof document.root !== "string" || !document.root) throw new Error(`document.${document.key}: root is required`); if (path.isAbsolute(document.path) || document.path.split(/[\\/]/).includes("..")) throw new Error(`document.${document.key}: unsafe path`); for (const binding of array(document.bindings, "document.bindings")) { exactObject(binding, ["role_key", "read", "write", "purpose", "priority"], "document.binding"); if (!roleKeys.has(binding.role_key)) throw new Error(`document.${document.key}: missing role`); } }
  array(value.prompt_templates, "prompt_templates"); unique(value.prompt_templates, template => semanticKey(template.key, "prompt_template.key"), "prompt_templates"); for (const template of value.prompt_templates) { exactObject(template, ["key", "version", "role_key", "result_schema_key", "template", "content_hash"], `prompt.${template.key}`); if (!roleKeys.has(template.role_key) || !SEMVER.test(template.version) || template.content_hash !== digest(template.template)) throw new Error(`prompt.${template.key}: invalid contract`); }
  array(value.test_scenarios, "test_scenarios"); unique(value.test_scenarios, scenario => semanticKey(scenario.key, "scenario.key"), "test_scenarios"); for (const scenario of value.test_scenarios) { exactObject(scenario, ["key", "input", "expected", "anonymized"], `scenario.${scenario.key}`); if (scenario.anonymized !== true) throw new Error(`scenario.${scenario.key}: must be anonymized`); }
  scanPortable(value); return value;
}

export function serializeWorkflowPackage(value) { const valid = validateWorkflowPackage(value); return `<workflow_package key="${escapeXml(valid.key)}" version="${escapeXml(valid.version)}" schema_version="${PACKAGE_SCHEMA_VERSION}">\n  <purpose>${escapeXml(valid.purpose)}</purpose>\n  <payload format="application/json">${escapeXml(stableJson(valid))}</payload>\n</workflow_package>\n`; }
export function parseWorkflowPackage(source) { const root = parseLimitedXml(source); if (root.name !== "workflow_package") throw new Error("PACKAGE_ROOT_INVALID"); const attributes = exactAttributes(root, ["key", "version", "schema_version"]), [purpose, payload] = exactChildren(root, ["purpose", "payload"]); exactAttributes(purpose, []); exactAttributes(payload, ["format"]); if (purpose.children.length || payload.children.length || payload.attributes.format !== "application/json") throw new Error("PACKAGE_ENVELOPE_INVALID"); if (attributes.schema_version === "1") throw new Error("WORKFLOW_PACKAGE_SCHEMA_MIGRATION_REQUIRED: schema_version 1 -> 2"); const value = validateWorkflowPackage(JSON.parse(payload.text)); if (attributes.schema_version !== String(PACKAGE_SCHEMA_VERSION) || attributes.key !== value.key || attributes.version !== value.version || purpose.text !== value.purpose) throw new Error("PACKAGE_ENVELOPE_MISMATCH"); return value; }

export function exportWorkflowPackage(dbFile, outputFile, projectId, workflowKey = null) { const db = openDb(dbFile); try { const value = buildWorkflowPackageValue(db, projectId, workflowKey), source = serializeWorkflowPackage(value), resolved = path.resolve(outputFile); fs.mkdirSync(path.dirname(resolved), { recursive: true }); fs.writeFileSync(resolved, source, "utf8"); return { status: "exported", file: resolved, project: projectId, package_key: value.key, version: value.version, package_hash: digest(value), counts: { roles: value.roles.length, profiles: value.profiles.length, workflows: value.workflows.length, checks: value.checks.length, documents: value.documents.length, scenarios: value.test_scenarios.length } }; } finally { db.close(); } }
export function inspectWorkflowPackage(file) { try { const value = parseWorkflowPackage(fs.readFileSync(file, "utf8")); return { status: "passed", errors: [], package: value, package_hash: digest(value) }; } catch (error) { return { status: "failed", errors: [error.message] }; } }

function targetSnapshot(db, projectId, packageKey) { const specs = [["workflow_package_releases", "project_id=? AND package_key=?", [projectId, packageKey]], ["portable_profile_requirements", "project_id=? AND package_key=?", [projectId, packageKey]], ["project_resources", "project_id=?", [projectId]], ["evidence_flow_adapters", "project_id=? AND package_key=?", [projectId, packageKey]], ["workflows", "project_id=?", [projectId]], ["role_contracts", "project_id=?", [projectId]], ["project_checks", "project_id=?", [projectId]], ["project_documents", "project_id=?", [projectId]], ["role_documents", "project_id=?", [projectId]], ["workflow_routes", "project_id=?", [projectId]], ["workflow_step_templates", "project_id=?", [projectId]], ["workflow_transition_templates", "project_id=?", [projectId]], ["workflow_questions", "project_id=?", [projectId]], ["operational_level_policies", "project_id=? AND package_key=?", [projectId, packageKey]], ["operational_level_budget_limits", "project_id=? AND package_key=?", [projectId, packageKey]], ["operational_level_escalation_rules", "project_id=? AND package_key=?", [projectId, packageKey]], ["prompt_templates", "project_id=? AND package_key=?", [projectId, packageKey]], ["package_test_scenarios", "project_id=? AND package_key=?", [projectId, packageKey]]]; return digest(specs.map(([table, where, parameters]) => ({ table, rows: rows(db, `SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`, ...parameters) }))); }
function proposalTargetSnapshot(db, projectId, packageKey, migrationFrom = null) { return digest([targetSnapshot(db, projectId, packageKey), migrationFrom ? targetSnapshot(db, projectId, migrationFrom) : null]); }

function versionCompare(left, right) { const a = left.split("-")[0].split(".").map(Number), b = right.split("-")[0].split(".").map(Number); for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]; return 0; }
function packageDiff(db, projectId, value) {
  const changes = [], add = (type, itemKey, exists) => changes.push({ entity_type: type, semantic_key: itemKey, action: exists ? "update" : "add" });
  for (const [table, list, third] of [["work_types", value.catalogs.work_types, "category"], ["artifact_types", value.catalogs.artifact_types, "category"], ["quality_modes", value.catalogs.quality_modes, "ordinal"], ["planning_levels", value.catalogs.planning_levels, "ordinal"]]) for (const item of list) { const current = db.prepare(`SELECT name,${third} FROM ${table} WHERE id=?`).get(item.key); if (current && (current.name !== item.name || current[third] !== item[third])) throw new Error(`PACKAGE_COLLISION: ${table}:${item.key}`); }
  for (const role of value.roles) { const current = db.prepare("SELECT name FROM roles WHERE id=?").get(role.key); if (current && current.name.toLowerCase() !== role.name.toLowerCase()) throw new Error(`PACKAGE_COLLISION: role:${role.key}`); add("role", role.key, current); add("role_contract", role.key, db.prepare("SELECT 1 FROM role_contracts WHERE project_id=? AND role_id=? AND status='active'").get(projectId, role.key)); }
  for (const check of value.checks) add("check", check.key, null); for (const workflow of value.workflows) add("workflow", workflow.key, null);
  for (const flow of value.evidence_flows) add("evidence_flow", flow.key, db.prepare("SELECT 1 FROM evidence_flow_adapters WHERE project_id=? AND package_key=? AND flow_key=?").get(projectId, value.key, flow.key));
  for (const document of value.documents) { const collision = db.prepare("SELECT id FROM project_documents WHERE project_id=? AND path=? AND root_key=?").get(projectId, document.path, document.root); if (collision && mappedKey(db, projectId, "document", collision.id) !== document.key) throw new Error(`PACKAGE_COLLISION: document_path:${document.root}/${document.path}`); add("document", document.key, collision); }
  for (const template of value.prompt_templates) add("prompt_template", template.key, null); for (const scenario of value.test_scenarios) add("test_scenario", scenario.key, null);
  const active = activeRelease(db, projectId, value.key); if (active && versionCompare(value.version, active.version) < 0) throw new Error(`PACKAGE_DOWNGRADE_FORBIDDEN: ${active.version} -> ${value.version}`); if (active && versionCompare(value.version, active.version) === 0 && active.manifest_hash !== digest(value)) throw new Error("PACKAGE_VERSION_COLLISION: same version has different content");
  return { summary: changes.reduce((summary, item) => ({ ...summary, [item.action]: (summary[item.action] ?? 0) + 1 }), {}), already_active: Boolean(active && versionCompare(value.version, active.version) === 0 && active.manifest_hash === digest(value)), changes };
}

export function proposeWorkflowImport(dbFile, packageFile, proposalFile, projectId, options = {}) { const packageSource = fs.readFileSync(packageFile, "utf8"), lint = inspectWorkflowPackage(packageFile); if (lint.status !== "passed") return { status: "rejected", lint }; const migrationFrom = options.migrationFrom ? String(options.migrationFrom) : null; const db = openDb(dbFile); try { if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) throw new Error(`IMPORT_TARGET_PROJECT_NOT_FOUND: ${projectId}`); if (migrationFrom) { if (migrationFrom === lint.package.key) throw new Error("PACKAGE_MIGRATION_IDENTITY_INVALID"); if (!activeRelease(db, projectId, migrationFrom)) throw new Error(`PACKAGE_MIGRATION_SOURCE_NOT_ACTIVE: ${migrationFrom}`); } const diff = packageDiff(db, projectId, lint.package); if (migrationFrom) diff.migration = { from: migrationFrom, to: lint.package.key }; if (diff.already_active) return { status: "no_changes", target_project_id: projectId, package_key: lint.package.key, package_version: lint.package.version, package_hash: lint.package_hash, diff }; const core = { schema_version: 1, id: `import_${structuredHash([projectId, lint.package_hash, migrationFrom, Date.now()]).slice(0, 20)}`, status: "pending", target_project_id: projectId, package_file: path.resolve(packageFile), package_file_hash: digest(packageSource), package_key: lint.package.key, package_version: lint.package.version, package_hash: lint.package_hash, target_snapshot_hash: proposalTargetSnapshot(db, projectId, lint.package.key, migrationFrom), diff, package: lint.package, ...(migrationFrom ? { migration_from: migrationFrom } : {}), created_at: now() }; const proposal = { ...core, proposal_hash: digest(core) }; db.prepare("INSERT INTO workflow_import_proposals(id,target_project_id,package_key,package_version,package_hash,target_snapshot_hash,proposal_hash,diff_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(proposal.id, projectId, proposal.package_key, proposal.package_version, proposal.package_hash, proposal.target_snapshot_hash, proposal.proposal_hash, stableJson(diff), "pending", proposal.created_at); atomicJson(proposalFile, proposal); return proposal; } finally { db.close(); } }

export function proposeWorkflowMigration(dbFile, packageFile, proposalFile, projectId, fromPackageKey) {
  if (!fromPackageKey) throw new Error("PACKAGE_MIGRATION_SOURCE_REQUIRED");
  return proposeWorkflowImport(dbFile, packageFile, proposalFile, projectId, { migrationFrom: fromPackageKey });
}

function technicalId(projectId, packageKey, type, itemKey) { return `imp_${type}_${structuredHash([projectId, packageKey, itemKey]).slice(0, 20)}`; }
function mapEntity(db, proposal, projectId, packageKey, type, itemKey) {
  const current = db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id
    WHERE p.target_project_id=? AND p.package_key=? AND p.status='applied' AND m.entity_type=? AND m.semantic_key=? ORDER BY p.applied_at DESC LIMIT 1`).get(projectId, packageKey, type, itemKey)?.local_id;
  const migrated = proposal.migration_from && type !== "package_release" ? db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id
    WHERE p.target_project_id=? AND p.package_key=? AND p.status='applied' AND m.entity_type=? AND m.semantic_key=? ORDER BY p.applied_at DESC LIMIT 1`).get(projectId, proposal.migration_from, type, itemKey)?.local_id : null;
  const value = current ?? migrated ?? technicalId(projectId, packageKey, type, itemKey);
  db.prepare("INSERT OR REPLACE INTO package_import_mappings(proposal_id,entity_type,semantic_key,local_id) VALUES(?,?,?,?)").run(proposal.id, type, itemKey, value);
  return value;
}

function applyCatalogs(db, value) {
  for (const item of value.catalogs.domains) db.prepare("INSERT INTO domains(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(item.key, item.name);
  for (const item of value.catalogs.disciplines) db.prepare("INSERT INTO disciplines(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(item.key, item.name);
  for (const item of value.catalogs.work_types) db.prepare("INSERT INTO work_types(id,name,category) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category").run(item.key, item.name, item.category);
  for (const item of value.catalogs.artifact_types) db.prepare("INSERT INTO artifact_types(id,name,category) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category").run(item.key, item.name, item.category);
  for (const item of value.catalogs.quality_modes) db.prepare("INSERT INTO quality_modes(id,name,ordinal) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,ordinal=excluded.ordinal").run(item.key, item.name, item.ordinal);
  for (const item of value.catalogs.planning_levels) db.prepare("INSERT INTO planning_levels(id,name,ordinal) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,ordinal=excluded.ordinal").run(item.key, item.name, item.ordinal);
}

function applyResources(db, projectId, value) {
  for (const resource of value.resources) declareProjectResourceRequirement(db, { projectId, alias: resource.alias, kind: resource.kind, purpose: resource.purpose });
}

function applyRoles(db, proposal, projectId, value) {
  for (const role of value.roles) db.prepare("INSERT INTO roles(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(role.key, role.name);
  for (const role of value.roles) {
    db.prepare("UPDATE role_contracts SET status='superseded' WHERE project_id=? AND role_id=? AND status='active'").run(projectId, role.key);
    const mappedId = mapEntity(db, proposal, projectId, value.key, "role_contract", role.key), c = role.contract;
    // Role contracts are project identities, while package mappings describe provenance. Two packages
    // may intentionally compose the same versioned role in one project; reuse that canonical contract
    // instead of inventing a second row that violates (project, role, version).
    const existing = db.prepare("SELECT id FROM role_contracts WHERE project_id=? AND role_id=? AND version=?").get(projectId, role.key, c.version);
    const contractId = existing?.id ?? mappedId;
    if (contractId !== mappedId) db.prepare("INSERT OR REPLACE INTO package_import_mappings(proposal_id,entity_type,semantic_key,local_id) VALUES(?,?,?,?)").run(proposal.id, "role_contract", role.key, contractId);
    db.prepare(`INSERT INTO role_contracts(id,project_id,role_id,version,purpose,boundaries_json,allowed_work_types_json,allowed_artifact_types_json,allowed_tools_json,allowed_skills_json,required_checks_json,allowed_transitions_json,allowed_profiles_json,context_limit_bytes,max_calls,max_correction_cycles,timeout_seconds,result_schema_key,prompt_template_version,escalation_json,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,purpose=excluded.purpose,boundaries_json=excluded.boundaries_json,allowed_work_types_json=excluded.allowed_work_types_json,allowed_artifact_types_json=excluded.allowed_artifact_types_json,allowed_tools_json=excluded.allowed_tools_json,allowed_skills_json=excluded.allowed_skills_json,required_checks_json=excluded.required_checks_json,allowed_transitions_json=excluded.allowed_transitions_json,allowed_profiles_json=excluded.allowed_profiles_json,context_limit_bytes=excluded.context_limit_bytes,max_calls=excluded.max_calls,max_correction_cycles=excluded.max_correction_cycles,timeout_seconds=excluded.timeout_seconds,result_schema_key=excluded.result_schema_key,prompt_template_version=excluded.prompt_template_version,escalation_json=excluded.escalation_json,status='active'`)
      .run(contractId, projectId, role.key, c.version, c.purpose, stableJson(c.boundaries), stableJson(c.allowed_work_types), stableJson(c.allowed_artifact_types), stableJson(c.allowed_tools), stableJson(c.allowed_skills), stableJson(c.required_checks), stableJson(c.allowed_transitions), stableJson(c.allowed_profile_keys), c.context_limit_bytes, c.max_calls, c.max_correction_cycles, c.timeout_seconds, c.result_schema_key, c.prompt_template_version, stableJson(c.escalation), "active");
  }
}

function applyChecks(db, proposal, projectId, value) {
  const checkMap = new Map();
  const currentKeys = new Set(value.checks.map(check => check.key));
  const priorPackageChecks = db.prepare(`SELECT DISTINCT m.semantic_key,m.local_id
    FROM package_import_mappings m
    JOIN workflow_import_proposals p ON p.id=m.proposal_id
    WHERE p.target_project_id=? AND p.package_key=? AND p.status='applied' AND m.entity_type='check'`).all(projectId, value.key);
  for (const prior of priorPackageChecks) {
    if (currentKeys.has(prior.semantic_key)) continue;
    db.prepare("DELETE FROM project_diagnostic_policies WHERE project_id=? AND check_id=?").run(projectId, prior.local_id);
    db.prepare("DELETE FROM project_checks WHERE project_id=? AND check_id=?").run(projectId, prior.local_id);
  }
  for (const check of value.checks) {
    const checkId = mapEntity(db, proposal, projectId, value.key, "check", check.key); checkMap.set(check.key, checkId);
    const existing = db.prepare("SELECT kind FROM check_definitions WHERE id=?").get(checkId);
    // A disabled portable check is an installation hook, not an instruction to erase machine-local
    // executable paths. Once the owner has bound that hook to a real runner, package upgrades may still
    // update its project bindings below but must preserve the local definition.
    const localHook = check.runner.startsWith("requires_local_") || String(check.config?.reason ?? "").startsWith("requires_local_");
    const preserveLocalDefinition = check.kind === "disabled" && localHook && existing && existing.kind !== "disabled";
    if (!preserveLocalDefinition) db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,runner=excluded.runner,kind=excluded.kind,config_json=excluded.config_json,timeout_seconds=excluded.timeout_seconds").run(checkId, check.name, check.runner, check.kind, stableJson(check.config), check.timeout_seconds);
    db.prepare("DELETE FROM project_checks WHERE project_id=? AND check_id=?").run(projectId, checkId);
    for (const binding of check.bindings) db.prepare("INSERT INTO project_checks(project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES(?,?,?,?,?)").run(projectId, checkId, binding.quality_mode_key, Number(binding.required), binding.artifact_type_key);
  }
  return checkMap;
}

function applyWorkflows(db, proposal, projectId, value) {
  const workflowMap = new Map();
  for (const workflow of value.workflows) {
    const workflowId = mapEntity(db, proposal, projectId, value.key, "workflow", workflow.key); workflowMap.set(workflow.key, workflowId);
    db.prepare(`INSERT INTO workflows(id,name,project_id,package_key,package_version,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,package_key=excluded.package_key,package_version=excluded.package_version,default_quality=excluded.default_quality,default_level=excluded.default_level,status=excluded.status,discovery_json=excluded.discovery_json,history_budget_bytes=excluded.history_budget_bytes`)
      .run(workflowId, workflow.name, projectId, value.key, value.version, workflow.default_quality, workflow.default_level, workflow.status, stableJson(workflow.discovery), workflow.history_budget_bytes);
    db.prepare("DELETE FROM workflow_step_templates WHERE project_id=? AND workflow_id=?").run(projectId, workflowId);
    db.prepare("DELETE FROM workflow_transition_templates WHERE project_id=? AND workflow_id=?").run(projectId, workflowId);
    db.prepare("DELETE FROM workflow_questions WHERE project_id=? AND workflow_id=?").run(projectId, workflowId);
    for (const step of workflow.steps) db.prepare("INSERT INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,resources_json,correction_json,escalation_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(projectId, workflowId, step.key, step.ordinal, step.role_key, Number(step.required), Number(step.irreversible), step.input_schema_key, step.output_schema_key, stableJson(step.artifact_type_keys), stableJson(step.check_keys), stableJson(step.resources), stableJson(step.correction), stableJson(step.escalation));
    for (const transition of workflow.transitions) db.prepare("INSERT INTO workflow_transition_templates(project_id,workflow_id,from_step_key,to_step_key,condition_json) VALUES(?,?,?,?,?)").run(projectId, workflowId, transition.from, transition.to, stableJson(transition.condition));
    for (const question of workflow.questions) db.prepare("INSERT INTO workflow_questions(project_id,workflow_id,question_key,phase,prompt,answer_schema_json,required) VALUES(?,?,?,?,?,?,?)").run(projectId, workflowId, question.key, question.phase, question.prompt, stableJson(question.answer_schema), Number(question.required));
  }
  return workflowMap;
}

function applyBindingsAndPolicies(db, proposal, projectId, value, workflowMap) {
  db.prepare("DELETE FROM portable_profile_requirements WHERE project_id=? AND package_key=?").run(projectId, value.key);
  for (const profile of value.profiles) db.prepare("INSERT INTO portable_profile_requirements(project_id,package_key,profile_key,role_id,provider_family,capabilities_json,operational_levels_json) VALUES(?,?,?,?,?,?,?)").run(projectId, value.key, profile.key, profile.role_key, profile.provider_family, stableJson(profile.capabilities), stableJson(profile.operational_levels));
  db.prepare("DELETE FROM workflow_routes WHERE project_id=? AND workflow_id IN (SELECT id FROM workflows WHERE project_id=? AND package_key=?)").run(projectId, projectId, value.key);
  for (const route of value.routes) db.prepare("INSERT INTO workflow_routes(project_id,work_type_id,workflow_id,enabled,priority) VALUES(?,?,?,?,?)").run(projectId, route.work_type_key, workflowMap.get(route.workflow_key), Number(route.enabled), route.priority);
  for (const document of value.documents) {
    const documentId = mapEntity(db, proposal, projectId, value.key, "document", document.key);
    db.prepare("INSERT INTO project_documents(id,project_id,path,root_key,document_type,authority,status,active) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET path=excluded.path,root_key=excluded.root_key,document_type=excluded.document_type,authority=excluded.authority,status=excluded.status,active=1").run(documentId, projectId, document.path, document.root, document.type, document.authority, document.status);
    db.prepare("DELETE FROM role_documents WHERE project_id=? AND document_id=?").run(projectId, documentId);
    for (const binding of document.bindings) db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES(?,?,?,?,?,?,?)").run(projectId, binding.role_key, documentId, Number(binding.read), Number(binding.write), binding.purpose, binding.priority);
  }
  db.prepare("DELETE FROM operational_level_policies WHERE project_id=? AND package_key=?").run(projectId, value.key);
  db.prepare("DELETE FROM operational_level_budget_limits WHERE project_id=? AND package_key=?").run(projectId, value.key);
  db.prepare("DELETE FROM operational_level_escalation_rules WHERE project_id=? AND package_key=?").run(projectId, value.key);
  for (const policy of value.operational_levels) {
    db.prepare("INSERT INTO operational_level_policies(project_id,package_key,level,budgets_json,required_checks_json,correction_limit,escalation_json,improvement_strategy) VALUES(?,?,?,?,?,?,?,?)").run(projectId, value.key, policy.level, stableJson(policy.budgets), stableJson(policy.required_check_keys), policy.correction_limit, stableJson(policy.escalation), policy.improvement_strategy);
    const budgetValues = { ...policy.budgets, correction_cycles: policy.correction_limit };
    for (const [metric, limit] of Object.entries(budgetValues)) db.prepare("INSERT INTO operational_level_budget_limits(project_id,package_key,level,metric,limit_value) VALUES(?,?,?,?,?)").run(projectId, value.key, policy.level, metric, Number(limit));
    let ordinal = 0;
    for (const [event, setting] of Object.entries(policy.escalation)) {
      ordinal += 1;
      const numeric = typeof setting === "number" ? setting : null;
      const action = setting === true ? "required" : setting === false ? "disabled" : numeric !== null ? "threshold" : String(setting);
      db.prepare("INSERT INTO operational_level_escalation_rules(project_id,package_key,level,event_key,action_key,threshold_value,ordinal) VALUES(?,?,?,?,?,?,?)").run(projectId, value.key, policy.level, event, action, numeric, ordinal);
    }
  }
}

function applyTemplatesAndScenarios(db, proposal, projectId, value) {
  for (const template of value.prompt_templates) {
    db.prepare("UPDATE prompt_templates SET status='superseded' WHERE project_id=? AND package_key=? AND template_key=? AND status='active'").run(projectId, value.key, template.key);
    const promptId = mapEntity(db, proposal, projectId, value.key, "prompt_template", template.key);
    db.prepare("INSERT INTO prompt_templates(id,project_id,package_key,template_key,version,role_id,result_schema_key,template_text,content_hash,status) VALUES(?,?,?,?,?,?,?,?,?,'active') ON CONFLICT(id) DO UPDATE SET package_key=excluded.package_key,version=excluded.version,role_id=excluded.role_id,result_schema_key=excluded.result_schema_key,template_text=excluded.template_text,content_hash=excluded.content_hash,status='active'").run(promptId, projectId, value.key, template.key, template.version, template.role_key, template.result_schema_key, template.template, template.content_hash);
  }
  for (const scenario of value.test_scenarios) {
    const scenarioId = technicalId(projectId, value.key, "scenario", `${value.version}:${scenario.key}`);
    db.prepare("INSERT OR REPLACE INTO package_import_mappings(proposal_id,entity_type,semantic_key,local_id) VALUES(?,?,?,?)").run(proposal.id, "test_scenario", scenario.key, scenarioId);
    db.prepare("INSERT INTO package_test_scenarios(id,project_id,package_key,package_version,scenario_key,input_json,expected_json,anonymized) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET input_json=excluded.input_json,expected_json=excluded.expected_json,anonymized=1").run(scenarioId, projectId, value.key, value.version, scenario.key, stableJson(scenario.input), stableJson(scenario.expected));
  }
}

function applyEvidenceFlows(db, projectId, value) {
  db.prepare("DELETE FROM evidence_flow_adapters WHERE project_id=? AND package_key=?").run(projectId, value.key);
  const insert = db.prepare(`INSERT INTO evidence_flow_adapters(project_id,package_key,flow_key,claim_type,subject,target,workflow_keys_json,nodes_json,required_edges_json,material_symbols_json,transition_adapter,transition_method,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const flow of value.evidence_flows) insert.run(projectId, value.key, flow.key, flow.claim_type, flow.subject, flow.target,
    stableJson(flow.workflow_keys), stableJson(flow.nodes), stableJson(flow.required_edges), stableJson(flow.material_symbols), flow.transition.adapter, flow.transition.method, flow.status);
}

function retireMigratedPackage(db, proposal, projectId) {
  const oldKey = proposal.migration_from;
  if (!oldKey) return;
  const newMappings = new Set(db.prepare("SELECT entity_type,local_id FROM package_import_mappings WHERE proposal_id=?").all(proposal.id).map(item => `${item.entity_type}:${item.local_id}`));
  const oldMappings = db.prepare(`SELECT DISTINCT m.entity_type,m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id
    WHERE p.target_project_id=? AND p.package_key=? AND p.status='applied'`).all(projectId, oldKey);
  for (const item of oldMappings) {
    if (newMappings.has(`${item.entity_type}:${item.local_id}`)) continue;
    if (item.entity_type === "workflow") {
      db.prepare("DELETE FROM workflow_routes WHERE project_id=? AND workflow_id=?").run(projectId, item.local_id);
      db.prepare("UPDATE workflows SET status='retired' WHERE id=? AND project_id=? AND package_key=?").run(item.local_id, projectId, oldKey);
    } else if (item.entity_type === "role_contract") db.prepare("UPDATE role_contracts SET status='superseded' WHERE id=? AND project_id=?").run(item.local_id, projectId);
    else if (item.entity_type === "check") {
      db.prepare("DELETE FROM project_diagnostic_policies WHERE project_id=? AND check_id=?").run(projectId, item.local_id);
      db.prepare("DELETE FROM project_checks WHERE project_id=? AND check_id=?").run(projectId, item.local_id);
    } else if (item.entity_type === "document") {
      db.prepare("DELETE FROM role_documents WHERE project_id=? AND document_id=?").run(projectId, item.local_id);
      db.prepare("UPDATE project_documents SET active=0 WHERE id=? AND project_id=?").run(item.local_id, projectId);
    }
  }
  db.prepare("DELETE FROM portable_profile_requirements WHERE project_id=? AND package_key=?").run(projectId, oldKey);
  db.prepare("DELETE FROM evidence_flow_adapters WHERE project_id=? AND package_key=?").run(projectId, oldKey);
  db.prepare("DELETE FROM operational_level_escalation_rules WHERE project_id=? AND package_key=?").run(projectId, oldKey);
  db.prepare("DELETE FROM operational_level_budget_limits WHERE project_id=? AND package_key=?").run(projectId, oldKey);
  db.prepare("DELETE FROM operational_level_policies WHERE project_id=? AND package_key=?").run(projectId, oldKey);
  db.prepare("UPDATE prompt_templates SET status='superseded' WHERE project_id=? AND package_key=? AND status='active'").run(projectId, oldKey);
  db.prepare("DELETE FROM package_test_scenarios WHERE project_id=? AND package_key=?").run(projectId, oldKey);
  db.prepare("UPDATE workflow_package_releases SET status='superseded' WHERE project_id=? AND package_key=? AND status='active'").run(projectId, oldKey);
}

export function applyWorkflowImport(dbFile, proposalFile, projectId, options = {}) {
  const proposal = JSON.parse(fs.readFileSync(proposalFile, "utf8")), confirmedBy = String(options.confirmedBy ?? "").trim();
  if (!confirmedBy) throw new Error("IMPORT_CONFIRMATION_REQUIRED");
  if (proposal.status !== "pending" || proposal.target_project_id !== projectId) throw new Error("IMPORT_PROPOSAL_INVALID");
  const core = { ...proposal }; delete core.proposal_hash;
  if (proposal.proposal_hash !== digest(core) || proposal.package_hash !== digest(validateWorkflowPackage(proposal.package))) throw new Error("IMPORT_PROPOSAL_TAMPERED");
  const packageSource = fs.readFileSync(proposal.package_file, "utf8");
  if (digest(packageSource) !== proposal.package_file_hash || digest(parseWorkflowPackage(packageSource)) !== proposal.package_hash) throw new Error("IMPORT_PACKAGE_CHANGED");
  const db = openDb(dbFile);
  try {
    const record = db.prepare("SELECT * FROM workflow_import_proposals WHERE id=?").get(proposal.id);
    if (!record || record.status !== "pending" || record.proposal_hash !== proposal.proposal_hash) throw new Error("IMPORT_PROPOSAL_NOT_PENDING");
    if (proposalTargetSnapshot(db, projectId, proposal.package_key, proposal.migration_from ?? null) !== proposal.target_snapshot_hash) { db.prepare("UPDATE workflow_import_proposals SET status='stale' WHERE id=?").run(proposal.id); proposal.status = "stale"; atomicJson(proposalFile, proposal); throw new Error("IMPORT_TARGET_CHANGED"); }
    const value = proposal.package;
    db.exec("BEGIN IMMEDIATE");
    try {
      applyCatalogs(db, value); applyResources(db, projectId, value); applyRoles(db, proposal, projectId, value); applyChecks(db, proposal, projectId, value); const workflowMap = applyWorkflows(db, proposal, projectId, value); applyBindingsAndPolicies(db, proposal, projectId, value, workflowMap); applyEvidenceFlows(db, projectId, value); applyTemplatesAndScenarios(db, proposal, projectId, value); retireMigratedPackage(db, proposal, projectId);
      const prior = activeRelease(db, projectId, value.key); db.prepare("UPDATE workflow_package_releases SET status='superseded' WHERE project_id=? AND package_key=? AND status='active'").run(projectId, value.key);
      const releaseId = mapEntity(db, proposal, projectId, value.key, "package_release", value.version);
      db.prepare("INSERT INTO workflow_package_releases(id,project_id,package_key,version,purpose,prompt_builder_version,manifest_hash,parent_version,status,created_at,domain_keys_json,discipline_keys_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(releaseId, projectId, value.key, value.version, value.purpose, value.prompt_builder_version, proposal.package_hash, prior?.version ?? null, "active", now(), stableJson(value.catalogs.domains.map(item => item.key)), stableJson(value.catalogs.disciplines.map(item => item.key)));
      const appliedAt = now(); db.prepare("UPDATE workflow_import_proposals SET status='applied',confirmed_by=?,applied_at=? WHERE id=?").run(confirmedBy, appliedAt, proposal.id); db.exec("COMMIT"); proposal.status = "applied"; proposal.confirmed_by = confirmedBy; proposal.applied_at = appliedAt;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    atomicJson(proposalFile, proposal); return proposal;
  } finally { db.close(); }
}
