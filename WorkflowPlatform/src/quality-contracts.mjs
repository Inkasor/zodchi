import { BudgetManager } from "./budget.mjs";
import { escapeXml, exactAttributes, exactChildren, parseLimitedXml } from "./limited-xml.mjs";

export const QUALITY_LEVELS = Object.freeze(["prototype", "mvp", "production", "security-audit"]);
const REVIEW_POLICIES = new Set(["none", "conditional", "required", "security_required"]);
const DOCUMENTATION_POLICIES = new Set(["evidence", "verified_result", "release_record", "security_report"]);
const RULE_TYPES = new Set(["success", "allowed_shortcut", "forbidden_shortcut", "required_evidence"]);
const BUDGET_METRICS = new Set(["calls", "duration_ms", "correction_cycles", "cost_usd"]);

const rules = (level, values) => Object.entries(values).flatMap(([type, entries]) => entries.map(([key, description], index) => ({ level, type, key, description, ordinal: index + 1 })));
const budgets = (calls, duration, corrections, costUsd) => [
  { metric: "calls", limit: calls },
  { metric: "duration_ms", limit: duration },
  { metric: "correction_cycles", limit: corrections },
  { metric: "cost_usd", limit: costUsd }
];
const escalations = entries => entries.map(([event, action, threshold, description], index) => ({ event, action, threshold, description, ordinal: index + 1 }));

export const DEFAULT_QUALITY_CONTRACTS = Object.freeze([
  {
    level: "prototype", version: "1.0.0", name: "Prototype",
    purpose: "Test one highest-risk assumption with the smallest reversible artifact.", reviewer_policy: "none", documentation_policy: "evidence", correction_limit: 0, status: "active",
    budgets: budgets(4, 600000, 0, 0.5),
    rules: rules("prototype", {
      success: [["assumption_answered", "The named risky assumption is answered by observable evidence."], ["artifact_inspectable", "The artifact can be inspected or run inside the declared boundary."]],
      allowed_shortcut: [["narrow_happy_path", "One primary path, fixtures, stubs and mocks are allowed when declared."]],
      forbidden_shortcut: [["skip_static_checks", "Configured static diagnostics may not be skipped or hidden."], ["readiness_claim", "Prototype evidence may not be presented as production readiness."]],
      required_evidence: [["target_signal", "Record at least one target signal and the known limitations."]]
    }),
    escalations: escalations([["owner_decision", "ask_owner", null, "Escalate only an owner decision or a blocked target signal."]])
  },
  {
    level: "mvp", version: "1.0.0", name: "MVP",
    purpose: "Deliver one complete relevant user scenario with deterministic evidence.", reviewer_policy: "conditional", documentation_policy: "verified_result", correction_limit: 1, status: "active",
    budgets: budgets(12, 3600000, 1, 2),
    rules: rules("mvp", {
      success: [["complete_scenario", "One relevant end-to-end user scenario works inside the accepted scope."], ["deterministic_green", "All applicable static checks, dedicated tests and document lint are green."]],
      allowed_shortcut: [["secondary_scope", "Secondary paths, polish and scale work may remain explicit follow-up work."]],
      forbidden_shortcut: [["missing_tests", "Relevant newly created behavior may not ship without dedicated tests."], ["hidden_limitations", "Known limitations and skipped coverage may not be omitted."]],
      required_evidence: [["scenario_and_gates", "Record the scenario result, gate results and remaining owner acceptance."]]
    }),
    escalations: escalations([
      ["high_risk", "independent_review", null, "Use an independent reviewer for high-risk work."],
      ["correction_used", "independent_review", 1, "Use an independent reviewer after a correction cycle."],
      ["protected_boundary", "independent_review", null, "Review data, access, external contracts and cross-project boundaries."]
    ])
  },
  {
    level: "production", version: "1.0.0", name: "Production",
    purpose: "Prepare and verify a real release and deployment with rollback boundaries.", reviewer_policy: "required", documentation_policy: "release_record", correction_limit: 1, status: "active",
    budgets: budgets(18, 7200000, 1, 8),
    rules: rules("production", {
      success: [["release_verified", "The exact release is built, deployed and verified in the authorized target."], ["rollback_ready", "Rollback, observability, compatibility and data-safety boundaries are explicit."]],
      allowed_shortcut: [["none_undeclared", "Only explicitly accepted non-blocking limitations are allowed."]],
      forbidden_shortcut: [["unapproved_deploy", "Deployment or publication may not occur without recorded owner approval."], ["partial_regression", "Applicable MVP checks and release checks may not be reduced."]],
      required_evidence: [["release_record", "Record revision, target, checks, deployment verification and rollback evidence."]]
    }),
    escalations: escalations([
      ["gate_green", "independent_review", null, "Production always requires an independent reviewer after green gates."],
      ["irreversible_action", "owner_approval", null, "Deployment, publication and irreversible actions require owner approval."]
    ])
  },
  {
    level: "security-audit", version: "1.0.0", name: "Security audit",
    purpose: "Perform a read-only scoped security assessment and report residual risk.", reviewer_policy: "security_required", documentation_policy: "security_report", correction_limit: 0, status: "active",
    budgets: budgets(8, 3600000, 0, 4),
    rules: rules("security-audit", {
      success: [["scoped_assessment", "Assets, trust boundaries, threat model and coverage are explicit."], ["findings_ranked", "Findings include severity, evidence, mitigation and residual risk."]],
      allowed_shortcut: [["none_silent", "Coverage limits are allowed only when reported as limits."]],
      forbidden_shortcut: [["silent_remediation", "The audit may not modify the target unless a separate change is authorized."], ["empty_coverage_pass", "Missing security coverage is unavailable, never passed."]],
      required_evidence: [["security_report", "Record scoped findings, evidence references and residual risk."]]
    }),
    escalations: escalations([
      ["audit_ready", "security_review", null, "A designated security reviewer is mandatory."],
      ["remediation_requested", "separate_workflow", null, "Remediation is a separate authorized workflow."]
    ])
  }
].map(Object.freeze));

export function operationalLevel(quality) {
  if (quality === "security") return "security-audit";
  if (!QUALITY_LEVELS.includes(quality)) throw new Error(`QUALITY_LEVEL_INVALID: ${quality}`);
  return quality;
}

// A workflow declares the quality it was built for, and that declaration carries its required
// checks. The classifier may raise a routed run above that level, but lowering it below would drop
// the very checks the workflow depends on, so the declared quality is a floor.
export function floorOperationalLevel(level, workflowQuality) {
  const requested = operationalLevel(level);
  if (!workflowQuality) return requested;
  const floor = operationalLevel(workflowQuality);
  return QUALITY_LEVELS.indexOf(requested) >= QUALITY_LEVELS.indexOf(floor) ? requested : floor;
}

// The owner may set a machine-readable lower bound without asking the classifier to infer policy from
// prose. Natural-language mentions deliberately do not count: only this exact structural element does.
export function ownerQualityFloor(message) {
  const matches = [...String(message ?? "").matchAll(/<quality_constraint\s+minimum="(prototype|mvp|production|security|security-audit)"\s*\/>/gi)]
    .map(match => operationalLevel(match[1].toLowerCase()));
  if (!matches.length) return null;
  if (new Set(matches).size !== 1) throw new Error("OWNER_QUALITY_CONSTRAINT_CONFLICT");
  return matches[0];
}

export function effectiveQualityMode(suggested, ...floors) {
  let level = operationalLevel(suggested);
  for (const floor of floors.filter(Boolean)) level = floorOperationalLevel(level, floor);
  return level === "security-audit" ? "security" : level;
}

export function qualityModesThrough(level) {
  const normalized = operationalLevel(level);
  const index = QUALITY_LEVELS.indexOf(normalized);
  return QUALITY_LEVELS.slice(0, index + 1).map(item => item === "security-audit" ? "security" : item);
}

export function validateQualityContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new Error("QUALITY_CONTRACT_OBJECT_REQUIRED");
  if (!QUALITY_LEVELS.includes(contract.level)) throw new Error(`QUALITY_CONTRACT_LEVEL_INVALID: ${contract.level}`);
  if (!/^\d+\.\d+\.\d+$/.test(contract.version) || !contract.name || !contract.purpose || contract.status !== "active") throw new Error(`QUALITY_CONTRACT_HEADER_INVALID: ${contract.level}`);
  if (!REVIEW_POLICIES.has(contract.reviewer_policy) || !DOCUMENTATION_POLICIES.has(contract.documentation_policy)) throw new Error(`QUALITY_CONTRACT_POLICY_INVALID: ${contract.level}`);
  if (!Number.isInteger(contract.correction_limit) || contract.correction_limit < 0) throw new Error(`QUALITY_CONTRACT_CORRECTION_INVALID: ${contract.level}`);
  const budgetMetrics = new Set();
  for (const budget of contract.budgets ?? []) {
    if (!BUDGET_METRICS.has(budget.metric) || !Number.isFinite(Number(budget.limit)) || Number(budget.limit) < 0 || budgetMetrics.has(budget.metric)) throw new Error(`QUALITY_CONTRACT_BUDGET_INVALID: ${contract.level}:${budget.metric}`);
    budgetMetrics.add(budget.metric);
  }
  for (const required of BUDGET_METRICS) if (!budgetMetrics.has(required)) throw new Error(`QUALITY_CONTRACT_BUDGET_MISSING: ${contract.level}:${required}`);
  if (Number(contract.budgets.find(item => item.metric === "correction_cycles").limit) !== contract.correction_limit) throw new Error(`QUALITY_CONTRACT_CORRECTION_MISMATCH: ${contract.level}`);
  const ruleKeys = new Set();
  for (const rule of contract.rules ?? []) {
    if (!RULE_TYPES.has(rule.type) || !rule.key || !rule.description || !Number.isInteger(rule.ordinal) || rule.ordinal < 1 || ruleKeys.has(`${rule.type}:${rule.key}`)) throw new Error(`QUALITY_CONTRACT_RULE_INVALID: ${contract.level}:${rule.key}`);
    ruleKeys.add(`${rule.type}:${rule.key}`);
  }
  for (const type of RULE_TYPES) if (!(contract.rules ?? []).some(rule => rule.type === type)) throw new Error(`QUALITY_CONTRACT_RULE_TYPE_MISSING: ${contract.level}:${type}`);
  const events = new Set();
  for (const escalation of contract.escalations ?? []) {
    if (!escalation.event || !escalation.action || !escalation.description || !Number.isInteger(escalation.ordinal) || escalation.ordinal < 1 || events.has(escalation.event)) throw new Error(`QUALITY_CONTRACT_ESCALATION_INVALID: ${contract.level}:${escalation.event}`);
    if (escalation.threshold !== null && escalation.threshold !== undefined && !Number.isFinite(Number(escalation.threshold))) throw new Error(`QUALITY_CONTRACT_ESCALATION_THRESHOLD_INVALID: ${contract.level}:${escalation.event}`);
    events.add(escalation.event);
  }
  return contract;
}

function renderContract(contract, indent = "  ") {
  validateQualityContract(contract);
  const budgetXml = [...contract.budgets].sort((a, b) => a.metric.localeCompare(b.metric, "en")).map(item => `${indent}    <budget metric="${escapeXml(item.metric)}" limit="${escapeXml(item.limit)}"/>`).join("\n");
  const ruleXml = [...contract.rules].sort((a, b) => a.type.localeCompare(b.type, "en") || a.ordinal - b.ordinal).map(item => `${indent}    <rule type="${escapeXml(item.type)}" id="${escapeXml(item.key)}" ordinal="${item.ordinal}">${escapeXml(item.description)}</rule>`).join("\n");
  const escalationXml = [...contract.escalations].sort((a, b) => a.ordinal - b.ordinal).map(item => `${indent}    <escalation event="${escapeXml(item.event)}" action="${escapeXml(item.action)}" threshold="${item.threshold === null || item.threshold === undefined ? "" : escapeXml(item.threshold)}" ordinal="${item.ordinal}">${escapeXml(item.description)}</escalation>`).join("\n");
  return `${indent}<quality_contract id="${escapeXml(contract.level)}" version="${escapeXml(contract.version)}" status="${escapeXml(contract.status)}" reviewer_policy="${escapeXml(contract.reviewer_policy)}" documentation_policy="${escapeXml(contract.documentation_policy)}" correction_limit="${contract.correction_limit}">\n${indent}  <name>${escapeXml(contract.name)}</name>\n${indent}  <purpose>${escapeXml(contract.purpose)}</purpose>\n${indent}  <budgets>\n${budgetXml}\n${indent}  </budgets>\n${indent}  <rules>\n${ruleXml}\n${indent}  </rules>\n${indent}  <escalations>\n${escalationXml}\n${indent}  </escalations>\n${indent}</quality_contract>`;
}

export function renderQualityContract(contract, indent = "") { return renderContract(contract, indent); }

export function serializeQualityContracts(contracts = DEFAULT_QUALITY_CONTRACTS) {
  validateQualityContracts(contracts);
  return `<quality_contracts schema_version="1" version="1.1.0" inheritance="cumulative">\n${contracts.map(item => renderContract(item)).join("\n")}\n</quality_contracts>\n`;
}

function integerAttribute(value, label) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label}_INVALID`);
  return Number(value);
}

export function parseQualityContracts(source) {
  const root = parseLimitedXml(source);
  if (root.name !== "quality_contracts") throw new Error("QUALITY_CONTRACTS_ROOT_INVALID");
  const rootAttributes = exactAttributes(root, ["schema_version", "version", "inheritance"]);
  if (rootAttributes.schema_version !== "1" || rootAttributes.version !== "1.1.0" || rootAttributes.inheritance !== "cumulative" || root.text.trim()) throw new Error("QUALITY_CONTRACTS_ENVELOPE_INVALID");
  const contracts = root.children.map(node => {
    if (node.name !== "quality_contract") throw new Error(`QUALITY_CONTRACT_NODE_INVALID: ${node.name}`);
    const attributes = exactAttributes(node, ["id", "version", "status", "reviewer_policy", "documentation_policy", "correction_limit"]);
    const [name, purpose, budgetRoot, ruleRoot, escalationRoot] = exactChildren(node, ["name", "purpose", "budgets", "rules", "escalations"]);
    exactAttributes(name, []); exactAttributes(purpose, []); exactAttributes(budgetRoot, []); exactAttributes(ruleRoot, []); exactAttributes(escalationRoot, []);
    if (name.children.length || purpose.children.length || budgetRoot.text.trim() || ruleRoot.text.trim() || escalationRoot.text.trim() || node.text.trim()) throw new Error(`QUALITY_CONTRACT_CONTENT_INVALID: ${attributes.id}`);
    const parsed = {
      level: attributes.id, version: attributes.version, name: name.text, purpose: purpose.text,
      reviewer_policy: attributes.reviewer_policy, documentation_policy: attributes.documentation_policy,
      correction_limit: integerAttribute(attributes.correction_limit, "QUALITY_CONTRACT_CORRECTION"), status: attributes.status,
      budgets: budgetRoot.children.map(item => { if (item.name !== "budget" || item.children.length || item.text.trim()) throw new Error("QUALITY_CONTRACT_BUDGET_NODE_INVALID"); const values = exactAttributes(item, ["metric", "limit"]); return { metric: values.metric, limit: Number(values.limit) }; }),
      rules: ruleRoot.children.map(item => { if (item.name !== "rule" || item.children.length || !item.text.trim()) throw new Error("QUALITY_CONTRACT_RULE_NODE_INVALID"); const values = exactAttributes(item, ["type", "id", "ordinal"]); return { level: attributes.id, type: values.type, key: values.id, description: item.text, ordinal: integerAttribute(values.ordinal, "QUALITY_CONTRACT_RULE_ORDINAL") }; }),
      escalations: escalationRoot.children.map(item => { if (item.name !== "escalation" || item.children.length || !item.text.trim()) throw new Error("QUALITY_CONTRACT_ESCALATION_NODE_INVALID"); const values = exactAttributes(item, ["event", "action", "threshold", "ordinal"]); return { event: values.event, action: values.action, threshold: values.threshold === "" ? null : Number(values.threshold), description: item.text, ordinal: integerAttribute(values.ordinal, "QUALITY_CONTRACT_ESCALATION_ORDINAL") }; })
    };
    return validateQualityContract(parsed);
  });
  return validateQualityContracts(contracts);
}

export function validateQualityContracts(contracts) {
  if (!Array.isArray(contracts) || contracts.length !== QUALITY_LEVELS.length) throw new Error("QUALITY_CONTRACT_SET_INCOMPLETE");
  const levels = contracts.map(item => validateQualityContract(item).level);
  if (new Set(levels).size !== levels.length || QUALITY_LEVELS.some(level => !levels.includes(level))) throw new Error("QUALITY_CONTRACT_SET_LEVELS_INVALID");
  return contracts;
}

export function qualityContractsLint(source) {
  try { const contracts = parseQualityContracts(source); return { kind: "quality_contracts", status: "passed", errors: [], contracts: contracts.length }; }
  catch (error) { return { kind: "quality_contracts", status: "failed", errors: [error.message], contracts: 0 }; }
}

export function loadQualityContract(db, level) {
  const normalizedLevel = operationalLevel(level);
  const row = db.prepare("SELECT * FROM quality_contracts WHERE level=? AND status='active'").get(normalizedLevel);
  if (!row) throw new Error(`QUALITY_CONTRACT_NOT_REGISTERED: ${normalizedLevel}`);
  return Object.freeze(validateQualityContract({
    level: row.level, version: row.version, name: row.name, purpose: row.purpose,
    reviewer_policy: row.reviewer_policy, documentation_policy: row.documentation_policy,
    correction_limit: row.correction_limit, status: row.status,
    budgets: db.prepare('SELECT metric,limit_value AS "limit" FROM quality_contract_budgets WHERE level=? ORDER BY metric').all(normalizedLevel),
    rules: db.prepare("SELECT level,rule_type AS type,rule_key AS key,description,ordinal FROM quality_contract_rules WHERE level=? ORDER BY rule_type,ordinal").all(normalizedLevel),
    escalations: db.prepare("SELECT event_key AS event,action_key AS action,threshold_value AS threshold,description,ordinal FROM quality_contract_escalations WHERE level=? ORDER BY ordinal").all(normalizedLevel)
  }));
}

export function loadOperationalPolicy(db, projectId, workflowId, level) {
  const contract = loadQualityContract(db, level);
  const workflow = db.prepare("SELECT package_key FROM workflows WHERE id=? AND project_id=?").get(workflowId, projectId);
  const packageKey = workflow?.package_key ?? workflowId;
  const row = db.prepare("SELECT * FROM operational_level_policies WHERE project_id=? AND package_key=? AND level=?").get(projectId, packageKey, contract.level);
  const overrides = db.prepare("SELECT metric,limit_value FROM operational_level_budget_limits WHERE project_id=? AND package_key=? AND level=?").all(projectId, packageKey, contract.level);
  const overrideMap = new Map(overrides.map(item => [item.metric, Number(item.limit_value)]));
  const projectEscalations = db.prepare("SELECT event_key AS event,action_key AS action,threshold_value AS threshold,ordinal FROM operational_level_escalation_rules WHERE project_id=? AND package_key=? AND level=? ORDER BY ordinal").all(projectId, packageKey, contract.level);
  let requiredChecks = [];
  try { requiredChecks = row ? JSON.parse(row.required_checks_json) : []; } catch { throw new Error(`OPERATIONAL_POLICY_CHECKS_INVALID: ${projectId}:${contract.level}`); }
  const strategy = row?.improvement_strategy ?? "standard";
  if (!["standard", "gauntlet"].includes(strategy)) throw new Error(`IMPROVEMENT_STRATEGY_INVALID: ${projectId}:${contract.level}:${strategy}`);
  // Standard is intentionally bounded by the global quality contract. Gauntlet is an
  // explicitly selected operating strategy and may raise a project-local allowance;
  // it still remains hard-bounded by that declared allowance and the emergency fuse.
  const limits = Object.fromEntries(contract.budgets.map(item => {
    const baseline = Number(item.limit), configured = overrideMap.get(item.metric);
    return [item.metric, configured === undefined ? baseline : strategy === "gauntlet" ? configured : Math.min(baseline, configured)];
  }));
  const parallelRule = projectEscalations.find(item => item.event === "max_parallel_consilium_members");
  const configuredConsiliumMembers = parallelRule?.threshold === null || parallelRule?.threshold === undefined ? 2 : Number(parallelRule.threshold);
  if (!Number.isInteger(configuredConsiliumMembers) || configuredConsiliumMembers < 1 || configuredConsiliumMembers > 3) throw new Error(`CONSILIUM_MEMBER_LIMIT_INVALID: ${projectId}:${contract.level}:${parallelRule?.threshold}`);
  const maxParallelConsiliumMembers = configuredConsiliumMembers;
  return Object.freeze({ contract, project_id: projectId, package_key: packageKey, limits, required_checks: requiredChecks, project_escalations: projectEscalations, improvement_strategy: strategy, max_parallel_consilium_members: maxParallelConsiliumMembers });
}

function directBudgetRequest(runtime, runId, metric, amount, key, reason) {
  const task = runtime.getTask(runId);
  return { scopes: [{ type: "project", id: task.project_id }, { type: "task", id: task.id }, { type: "workflow", id: runId }], metric, amount, idempotencyKey: key, taskId: task.id, runId, reason };
}

export function initializeQualityRun(runtime, runId, classification, classifierReceipt = null) {
  const run = runtime.get(runId);
  const requested = operationalLevel(classification.quality_mode ?? classification.quality);
  // Only routed work runs the workflow's steps and checks; a direct reply keeps the level the
  // classifier chose, because no step of the workflow is going to execute.
  const workflowQuality = classification.reply_mode === "work"
    ? runtime.db.prepare("SELECT default_quality FROM workflows WHERE id=?").get(run.workflow_id)?.default_quality
    : null;
  const level = floorOperationalLevel(requested, workflowQuality);
  const policy = loadOperationalPolicy(runtime.db, run.project_id, run.workflow_id, level);
  const manager = new BudgetManager(runtime.db), task = runtime.getTask(runId);
  for (const [metric, limit] of Object.entries(policy.limits)) {
    manager.define({ scopeType: "task", scopeId: task.id, metric, limit });
    manager.define({ scopeType: "workflow", scopeId: runId, metric, limit });
  }
  runtime.db.prepare("UPDATE workflow_runs SET operational_level=?,quality_contract_version=?,reviewer_policy=?,improvement_strategy=? WHERE id=?")
    .run(level, policy.contract.version, policy.contract.reviewer_policy, policy.improvement_strategy, runId);
  if (classifierReceipt) {
    manager.consume(directBudgetRequest(runtime, runId, "calls", 1, `${runId}:classifier:call`, "control:classifier"));
    chargeDirectReceipt(runtime, runId, classifierReceipt, "classifier");
  }
  return policy;
}

export function reserveDirectModelCall(runtime, runId, role, suffix = "call") {
  const manager = new BudgetManager(runtime.db);
  return manager.consume(directBudgetRequest(runtime, runId, "calls", 1, `${runId}:${role}:${suffix}`, `control:${role}`));
}

export function chargeDirectReceipt(runtime, runId, receipt, role) {
  const manager = new BudgetManager(runtime.db);
  const duration = receipt?.duration_ms ?? (receipt?.startedAt && receipt?.finishedAt ? Math.max(0, Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt)) : null);
  const cost = receipt?.usage?.cost_usd;
  if (Number.isFinite(Number(duration)) && Number(duration) > 0) manager.consume(directBudgetRequest(runtime, runId, "duration_ms", Number(duration), `${runId}:${role}:duration`, `control:${role}:duration`));
  if (Number.isFinite(Number(cost)) && Number(cost) > 0) manager.settleActual(directBudgetRequest(runtime, runId, "cost_usd", Number(cost), `${runId}:${role}:cost_usd`, `control:${role}:cost_usd`));
}

export function consumeCorrectionCycle(runtime, runId, cycle) {
  const manager = new BudgetManager(runtime.db);
  manager.consume(directBudgetRequest(runtime, runId, "correction_cycles", 1, `${runId}:correction:${cycle}`, `quality:correction:${cycle}`));
  runtime.db.prepare("UPDATE workflow_runs SET correction_cycles=? WHERE id=?").run(cycle, runId);
}

const PROTECTED_WORK_TYPES = new Set(["data_change", "access_management", "security_review", "release", "deployment", "incident"]);
const PROTECTED_ARTIFACTS = new Set(["data_migration", "access_change", "security_report", "release_package", "deployment_evidence"]);

export function reviewerRequirement(contract, classification, correctionCycles = 0, projectEscalations = []) {
  if (contract.reviewer_policy === "none") return { required: false, reason: "quality_contract_none" };
  if (contract.reviewer_policy === "required") return { required: true, reason: "quality_contract_required" };
  if (contract.reviewer_policy === "security_required") return { required: true, reason: "security_reviewer_required" };
  const explicit = projectEscalations.some(item => item.action === "independent_review" || item.action === "required" && /reviewer|review/.test(item.event));
  if (classification.risk === "high") return { required: true, reason: "high_risk" };
  if (correctionCycles > 0) return { required: true, reason: "correction_used" };
  if (PROTECTED_WORK_TYPES.has(classification.work_type) || PROTECTED_ARTIFACTS.has(classification.artifact_type)) return { required: true, reason: "protected_boundary" };
  if (explicit) return { required: true, reason: "project_policy" };
  return { required: false, reason: "mvp_green_low_risk" };
}

export function documentationOutcome(contract, { gateStatus, ownerAccepted = false } = {}) {
  const verified = gateStatus === "passed";
  return Object.freeze({
    quality_level: contract.level,
    contract_version: contract.version,
    documentation_policy: contract.documentation_policy,
    technical_status: verified ? "verified" : "open",
    evidence_type: verified ? "verified" : "observation",
    decision_status: ownerAccepted ? "accepted" : "proposed",
    owner_accepted: Boolean(ownerAccepted)
  });
}

function mappedCheckId(db, projectId, semanticKey) {
  return db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id
    WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type='check' AND m.semantic_key=?
    ORDER BY p.applied_at DESC LIMIT 1`).get(projectId, semanticKey)?.local_id ?? semanticKey;
}

export function operationalPoliciesLint(db, projectId = null) {
  const errors = [];
  try { validateQualityContracts(QUALITY_LEVELS.map(level => loadQualityContract(db, level))); }
  catch (error) { errors.push(error.message); }
  const packages = db.prepare(`SELECT DISTINCT project_id,COALESCE(package_key,id) package_key FROM workflows
    WHERE status='active' ${projectId ? "AND project_id=?" : ""} ORDER BY project_id,package_key`).all(...(projectId ? [projectId] : []));
  for (const item of packages) {
    const software = db.prepare(`SELECT 1 FROM role_contracts WHERE project_id=? AND status='active'
      AND (allowed_artifact_types_json LIKE '%"code"%' OR allowed_artifact_types_json LIKE '%"prototype"%' OR allowed_artifact_types_json LIKE '%"release_package"%') LIMIT 1`).get(item.project_id);
    for (const level of QUALITY_LEVELS) {
      const policy = db.prepare("SELECT * FROM operational_level_policies WHERE project_id=? AND package_key=? AND level=?").get(item.project_id, item.package_key, level);
      if (!policy) { errors.push(`missing policy: ${item.project_id}:${item.package_key}:${level}`); continue; }
      if (!["standard", "gauntlet"].includes(policy.improvement_strategy)) errors.push(`invalid improvement strategy: ${item.project_id}:${item.package_key}:${level}`);
      const contract = loadQualityContract(db, level);
      const limits = db.prepare("SELECT metric,limit_value FROM operational_level_budget_limits WHERE project_id=? AND package_key=? AND level=?").all(item.project_id, item.package_key, level);
      const map = new Map(limits.map(value => [value.metric, Number(value.limit_value)]));
      for (const budget of contract.budgets) {
        if (!map.has(budget.metric)) errors.push(`missing budget: ${item.project_id}:${item.package_key}:${level}:${budget.metric}`);
        // Standard policies may only tighten the universal quality contract. Gauntlet is an
        // explicit project-local operating strategy whose declared allowance is the hard bound;
        // loadOperationalPolicy applies the same distinction at runtime.
        else if (policy.improvement_strategy !== "gauntlet" && map.get(budget.metric) > Number(budget.limit)) errors.push(`budget exceeds contract: ${item.project_id}:${item.package_key}:${level}:${budget.metric}`);
      }
      let required = [];
      try { required = JSON.parse(policy.required_checks_json); } catch { errors.push(`invalid checks: ${item.project_id}:${item.package_key}:${level}`); }
      if (software && !required.length) errors.push(`software level has no checks: ${item.project_id}:${item.package_key}:${level}`);
      const inheritedQualities = qualityModesThrough(level);
      const placeholders = inheritedQualities.map(() => "?").join(",");
      for (const semanticKey of required) {
        const localId = mappedCheckId(db, item.project_id, semanticKey);
        if (!db.prepare(`SELECT 1 FROM project_checks WHERE project_id=? AND check_id=? AND quality_mode_id IN (${placeholders}) AND required=1`).get(item.project_id, localId, ...inheritedQualities)) errors.push(`check not bound: ${item.project_id}:${item.package_key}:${level}:${semanticKey}`);
      }
    }
  }
  return { kind: "operational_policies", status: errors.length ? "failed" : "passed", errors, projects: new Set(packages.map(item => item.project_id)).size, packages: packages.length };
}
