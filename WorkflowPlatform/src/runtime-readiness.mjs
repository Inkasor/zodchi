import { checkGatewayProfileRequirements } from "./gateway.mjs";

const DIRECT_RUNTIME_ROLES = Object.freeze(["classifier", "researcher"]);

export function projectRuntimeReadiness(db, projectId, { profileCheck = requirements => checkGatewayProfileRequirements({ requirements }) } = {}) {
  const project = db.prepare("SELECT id,name FROM projects WHERE id=?").get(projectId);
  if (!project) throw new Error(`PROJECT_NOT_REGISTERED: ${projectId}`);

  const assignments = db.prepare(`SELECT a.role_id,a.operational_level,p.id AS profile_id,p.provider,p.name AS profile_name,rc.boundaries_json
    FROM role_profile_assignments a JOIN profiles p ON p.id=a.profile_id
    LEFT JOIN role_contracts rc ON rc.project_id=a.project_id AND rc.role_id=a.role_id AND rc.status='active'
    WHERE a.project_id=? AND a.enabled=1
    ORDER BY a.role_id,CASE a.operational_level WHEN 'prototype' THEN 0 WHEN 'mvp' THEN 1 WHEN 'production' THEN 2 ELSE 3 END`)
    .all(projectId);
  const directRoles = Object.fromEntries(DIRECT_RUNTIME_ROLES.map(roleId => {
    const bindings = assignments.filter(row => row.role_id === roleId);
    return [roleId, {
      status: bindings.length ? "configured" : "missing",
      bindings: bindings.map(({ role_id, ...binding }) => binding)
    }];
  }));
  const missing = DIRECT_RUNTIME_ROLES.filter(roleId => directRoles[roleId].status === "missing");
  const requirements = assignments.map(assignment => {
    let boundaries = {};
    try { boundaries = JSON.parse(assignment.boundaries_json ?? "{}"); } catch { /* active contract validation owns malformed JSON */ }
    return {
      role: assignment.role_id,
      provider: assignment.provider,
      profile: assignment.profile_name,
      requires_write: DIRECT_RUNTIME_ROLES.includes(assignment.role_id) ? false : boundaries.writes === true,
      operational_level: assignment.operational_level
    };
  });
  let profileRequirements;
  if (missing.length) profileRequirements = { status: "not_checked", checks: [], conflicts: [], reason: "direct_runtime_roles_missing" };
  else {
    try { profileRequirements = profileCheck(requirements); }
    catch (error) { profileRequirements = { status: "unavailable", checks: [], conflicts: [], reason: error.code ?? "PROFILE_REQUIREMENTS_CHECK_FAILED", message: error.message }; }
  }
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
    status: missing.length || profileRequirements.status !== "compatible" ? "unavailable" : "ready",
    project: { id: project.id, name: project.name },
    direct_roles: directRoles,
    missing_role_assignments: missing,
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

export function assertProjectRuntimeReady(db, projectId, options = undefined) {
  const readiness = projectRuntimeReadiness(db, projectId, options);
  if (readiness.status !== "ready") {
    const reasons = [];
    if (readiness.missing_role_assignments.length) reasons.push(`missing ${readiness.missing_role_assignments.join(",")}`);
    for (const conflict of readiness.profile_write_requirements.conflicts ?? []) reasons.push(`${conflict.code}: role=${conflict.role}; profile=${conflict.profile}`);
    if (readiness.profile_write_requirements.status === "unavailable") reasons.push(`${readiness.profile_write_requirements.reason}: ${readiness.profile_write_requirements.message}`);
    const error = new Error(`PROJECT_RUNTIME_NOT_READY: ${projectId}: ${reasons.join("; ")}`);
    error.code = "PROJECT_RUNTIME_NOT_READY";
    error.readiness = readiness;
    throw error;
  }
  return readiness;
}
