import { checkGatewayProfileRequirements } from "./gateway.mjs";
import { executorCapabilityRequirements } from "./executor-capabilities.mjs";

const DIRECT_RUNTIME_ROLES = Object.freeze(["classifier", "researcher", "conversation_responder"]);
const PROFILE_REQUIREMENTS_READY = new Set(["compatible", "accepted_declarative"]);
const profileCheckDefault = requirements => checkGatewayProfileRequirements({ requirements });

function roleAssignments(db, projectId, roleIds, operationalLevel = null) {
  if (!roleIds.length) return [];
  const placeholders = roleIds.map(() => "?").join(",");
  const levelClause = operationalLevel ? "AND a.operational_level=?" : "";
  return db.prepare(`SELECT a.role_id,a.operational_level,a.project_id,p.id AS profile_id,p.provider,p.name AS profile_name,rc.id AS contract_id,rc.boundaries_json,rc.allowed_tools_json,rc.allowed_skills_json,rc.allowed_mcp_servers_json,rc.native_instruction_files_json
    FROM role_profile_assignments a JOIN profiles p ON p.id=a.profile_id
    LEFT JOIN role_contracts rc ON rc.project_id=a.project_id AND rc.role_id=a.role_id AND rc.status='active'
    WHERE a.project_id=? AND a.enabled=1 AND a.role_id IN (${placeholders}) ${levelClause}
    ORDER BY a.role_id,CASE a.operational_level WHEN 'prototype' THEN 0 WHEN 'mvp' THEN 1 WHEN 'production' THEN 2 ELSE 3 END`)
    .all(projectId, ...roleIds, ...(operationalLevel ? [operationalLevel] : []));
}

function requirement(db, assignment, direct = false) {
  let boundaries = {};
  let allowedTools = [];
  let allowedSkills = [], allowedMcpServers = [], nativeInstructionFiles = [];
  try { boundaries = JSON.parse(assignment.boundaries_json ?? "{}"); } catch { /* active contract validation owns malformed JSON */ }
  try { allowedTools = JSON.parse(assignment.allowed_tools_json ?? "[]"); } catch { /* active contract validation owns malformed JSON */ }
  try { allowedSkills = JSON.parse(assignment.allowed_skills_json ?? "[]"); } catch { /* active contract validation owns malformed JSON */ }
  try { allowedMcpServers = JSON.parse(assignment.allowed_mcp_servers_json ?? "[]"); } catch { /* active contract validation owns malformed JSON */ }
  try { nativeInstructionFiles = JSON.parse(assignment.native_instruction_files_json ?? "[]"); } catch { /* active contract validation owns malformed JSON */ }
  const externalTools = allowedMcpServers.map(name => db.prepare(`SELECT name,transport,endpoint,read_only_mode_json,arbitrary_execution,contains_model,self_liftable_boundary,doubles_as_provider,pinned_version
    FROM external_tool_registry WHERE project_id=? AND name=? AND active=1`).get(assignment.project_id, name) ?? { name, missing: true }).map(row => ({
      name: row.name, transport: row.transport, endpoint: row.endpoint,
      read_only_mode: row.read_only_mode_json ? JSON.parse(row.read_only_mode_json) : null,
      arbitrary_execution: Boolean(row.arbitrary_execution), contains_model: Boolean(row.contains_model),
      self_liftable_boundary: Boolean(row.self_liftable_boundary), doubles_as_provider: Boolean(row.doubles_as_provider), pinned_version: row.pinned_version,
      missing: row.missing === true, nested_model_allowed: boundaries.nested_model_calls === true
    }));
  return {
    role: assignment.role_id,
    provider: assignment.provider,
    profile: assignment.profile_name,
    capability_requirements: executorCapabilityRequirements({ boundaries, allowed_tools: allowedTools, allowed_skills: allowedSkills, allowed_mcp_servers: allowedMcpServers, native_instruction_files: nativeInstructionFiles, external_tools: externalTools }, { direct }),
    operational_level: assignment.operational_level
  };
}

function inspectRequirements(profileCheck, requirements, missing, missingReason) {
  if (missing.length) return { status: "not_checked", checks: [], conflicts: [], reason: missingReason };
  try { return profileCheck(requirements); }
  catch (error) { return { status: "unavailable", checks: [], conflicts: [], reason: error.code ?? "PROFILE_REQUIREMENTS_CHECK_FAILED", message: error.message }; }
}

function readinessReasons(readiness) {
  const reasons = [];
  if (readiness.missing_role_assignments.length) reasons.push(`missing ${readiness.missing_role_assignments.join(",")}`);
  if (readiness.missing_role_contracts?.length) reasons.push(`missing active role contracts ${readiness.missing_role_contracts.join(",")}`);
  for (const conflict of readiness.profile_capability_requirements.conflicts ?? []) reasons.push(`${conflict.code}: role=${conflict.role}; profile=${conflict.profile}`);
  if (readiness.profile_capability_requirements.status === "unavailable") reasons.push(`${readiness.profile_capability_requirements.reason}: ${readiness.profile_capability_requirements.message}`);
  for (const kind of readiness.external_operations?.missing ?? []) reasons.push(`missing registered external ${kind} operation`);
  return reasons;
}

function workflowExternalOperations(db, projectId, workflowId) {
  const schemas = db.prepare(`SELECT DISTINCT output_schema_key FROM workflow_step_templates
    WHERE project_id=? AND workflow_id=? AND output_schema_key IN ('release_operation.v1','access_change.v1')`).all(projectId, workflowId).map(row => row.output_schema_key);
  const required = schemas.map(schema => schema === "release_operation.v1" ? "release" : "access");
  const available = Object.fromEntries(required.map(kind => [kind, db.prepare(`SELECT COUNT(*) count FROM external_operation_definitions o
    JOIN external_executors e ON e.project_id=o.project_id AND e.id=o.executor_id
    WHERE o.project_id=? AND o.operation_kind=? AND o.active=1 AND e.active=1`).get(projectId, kind).count]));
  const missing = required.filter(kind => !available[kind]);
  return { status: missing.length ? "unavailable" : required.length ? "configured" : "not_required", required, available, missing };
}

export function projectRuntimeReadiness(db, projectId, { profileCheck = profileCheckDefault } = {}) {
  const project = db.prepare("SELECT id,name FROM projects WHERE id=?").get(projectId);
  if (!project) throw new Error(`PROJECT_NOT_REGISTERED: ${projectId}`);

  const assignments = roleAssignments(db, projectId, [...DIRECT_RUNTIME_ROLES]);
  const directRoles = Object.fromEntries(DIRECT_RUNTIME_ROLES.map(roleId => {
    const bindings = assignments.filter(row => row.role_id === roleId);
    const contracted = bindings.filter(row => row.contract_id);
    return [roleId, {
      status: !bindings.length ? "missing" : contracted.length ? "configured" : "missing_contract",
      bindings: bindings.map(({ role_id, ...binding }) => binding)
    }];
  }));
  const missing = DIRECT_RUNTIME_ROLES.filter(roleId => directRoles[roleId].status === "missing");
  const missingContracts = DIRECT_RUNTIME_ROLES.filter(roleId => directRoles[roleId].status === "missing_contract");
  const requirements = DIRECT_RUNTIME_ROLES.map(roleId => assignments.find(item => item.role_id === roleId && item.contract_id)).filter(Boolean).map(item => requirement(db, item, true));
  const profileRequirements = inspectRequirements(profileCheck, requirements, [...missing, ...missingContracts], missing.length ? "direct_runtime_roles_missing" : "direct_runtime_role_contracts_missing");
  const context = db.prepare(`SELECT COUNT(DISTINCT d.id) AS registered_documents,
      COUNT(DISTINCT CASE WHEN rd.role_id='researcher' AND rd.read_access=1 THEN d.id END) AS researcher_documents
    FROM project_documents d LEFT JOIN role_documents rd ON rd.project_id=d.project_id AND rd.document_id=d.id
    WHERE d.project_id=? AND d.active=1`).get(projectId);
  const registeredDocuments = Number(context.registered_documents ?? 0);
  const researcherDocuments = Number(context.researcher_documents ?? 0);
  const researcherContext = registeredDocuments === 0
    ? "no_controlled_documents"
    : researcherDocuments === 0 ? "no_read_access" : "available";

  return {
    status: missing.length || missingContracts.length || !PROFILE_REQUIREMENTS_READY.has(profileRequirements.status) ? "unavailable" : "ready",
    project: { id: project.id, name: project.name },
    direct_roles: directRoles,
    missing_role_assignments: missing,
    missing_role_contracts: missingContracts,
    profile_capability_requirements: profileRequirements,
    profile_write_requirements: profileRequirements,
    registered_context: {
      status: researcherContext,
      registered_documents: registeredDocuments,
      researcher_documents: researcherDocuments
    },
    warnings: researcherContext === "no_read_access"
      ? ["researcher has no read access to the project's controlled documents"]
      : researcherContext === "no_controlled_documents"
        ? ["the owner selected no controlled project documents; research will have no registered document context"]
        : []
  };
}

export function workflowRuntimeReadiness(db, projectId, workflowId, operationalLevel, { profileCheck = profileCheckDefault } = {}) {
  const workflow = db.prepare("SELECT id,name FROM workflows WHERE id=? AND project_id=? AND status='active'").get(workflowId, projectId);
  if (!workflow) throw new Error(`WORKFLOW_NOT_REGISTERED: ${workflowId}`);
  const roleIds = db.prepare("SELECT DISTINCT role_id FROM workflow_step_templates WHERE project_id=? AND workflow_id=? AND role_id IS NOT NULL ORDER BY role_id").all(projectId, workflowId).map(row => row.role_id);
  const assignments = roleAssignments(db, projectId, roleIds, operationalLevel);
  const missing = roleIds.filter(roleId => !assignments.some(item => item.role_id === roleId));
  const missingContracts = roleIds.filter(roleId => assignments.some(item => item.role_id === roleId) && !assignments.some(item => item.role_id === roleId && item.contract_id));
  const requirements = assignments.filter(item => item.contract_id).map(item => requirement(db, item, DIRECT_RUNTIME_ROLES.includes(item.role_id)));
  const profileRequirements = inspectRequirements(profileCheck, requirements, [...missing, ...missingContracts], missing.length ? "workflow_role_assignments_missing" : "workflow_role_contracts_missing");
  const externalOperations = workflowExternalOperations(db, projectId, workflowId);
  return {
    status: missing.length || missingContracts.length || !PROFILE_REQUIREMENTS_READY.has(profileRequirements.status) || externalOperations.status === "unavailable" ? "unavailable" : "ready",
    project_id: projectId,
    workflow: { id: workflow.id, name: workflow.name },
    operational_level: operationalLevel,
    required_roles: roleIds,
    missing_role_assignments: missing,
    missing_role_contracts: missingContracts,
    profile_capability_requirements: profileRequirements,
    profile_write_requirements: profileRequirements,
    external_operations: externalOperations
  };
}

export function assertProjectRuntimeReady(db, projectId, options = undefined) {
  const readiness = projectRuntimeReadiness(db, projectId, options);
  if (readiness.status !== "ready") {
    const error = new Error(`PROJECT_RUNTIME_NOT_READY: ${projectId}: ${readinessReasons(readiness).join("; ")}`);
    error.code = "PROJECT_RUNTIME_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}

export function assertWorkflowRuntimeReady(db, projectId, workflowId, operationalLevel, options = undefined) {
  const readiness = workflowRuntimeReadiness(db, projectId, workflowId, operationalLevel, options);
  if (readiness.status !== "ready") {
    const error = new Error(`WORKFLOW_RUNTIME_NOT_READY: ${workflowId}:${operationalLevel}: ${readinessReasons(readiness).join("; ")}`);
    error.code = "WORKFLOW_RUNTIME_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}
