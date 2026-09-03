export const EXECUTOR_CAPABILITIES = Object.freeze([
  "context_input",
  "project_read",
  "file_search",
  "language_server",
  "process_execution",
  "local_endpoint",
  "external_mutation",
  "long_lived_process",
  "project_write",
  "network",
  "browser_automation",
  "screen_capture",
  "mcp",
  "skills"
]);

const CAPABILITIES = new Set(EXECUTOR_CAPABILITIES);

function normalizedNames(items, field) {
  if (!Array.isArray(items) || items.some(item => typeof item !== "string" || !CAPABILITIES.has(item))) throw new Error(`EXECUTOR_CAPABILITY_REQUIREMENTS_INVALID: ${field}`);
  return [...new Set(items)].sort();
}

export function normalizeExecutorCapabilityRequirements(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("EXECUTOR_CAPABILITY_REQUIREMENTS_INVALID");
  const required = normalizedNames(value.required, "required"), forbidden = normalizedNames(value.forbidden, "forbidden");
  const overlap = required.find(name => forbidden.includes(name));
  if (overlap) throw new Error(`EXECUTOR_CAPABILITY_REQUIREMENTS_CONTRADICTORY: ${overlap}`);
  const stringList = (name) => {
    const items = value[name] ?? [];
    if (!Array.isArray(items) || items.some(item => typeof item !== "string" || !item.trim())) throw new Error(`EXECUTOR_CAPABILITY_REQUIREMENTS_INVALID: ${name}`);
    return Object.freeze([...new Set(items.map(item => item.trim()))].sort());
  };
  return Object.freeze({
    required: Object.freeze(required),
    forbidden: Object.freeze(forbidden),
    allowed_skills: stringList("allowed_skills"),
    allowed_mcp_servers: stringList("allowed_mcp_servers"),
    native_instruction_files: stringList("native_instruction_files"),
    external_tools: Object.freeze(Array.isArray(value.external_tools) ? value.external_tools.map(item => Object.freeze({ ...item })) : [])
  });
}

export function executorCapabilityRequirements(contract = {}, { direct = false, portable = [] } = {}) {
  const tools = direct ? [] : (contract.allowed_tools ?? []);
  const writes = direct ? false : contract.boundaries?.writes === true;
  const declared = direct ? [] : (contract.boundaries?.required_executor_capabilities ?? []);
  const required = new Set(["context_input", ...portable, ...declared]);
  const forbidden = new Set();
  if (writes || tools.includes("apply_patch")) required.add("project_write");
  else forbidden.add("project_write");
  if (tools.includes("exec_command")) required.add("process_execution");
  if ((contract.allowed_skills ?? []).length) required.add("skills");
  if ((contract.allowed_mcp_servers ?? []).length) required.add("mcp");
  if (contract.boundaries?.local_endpoint === true) required.add("local_endpoint");
  else forbidden.add("local_endpoint");
  if (contract.boundaries?.external_mutation === true) required.add("external_mutation");
  else forbidden.add("external_mutation");
  if (!direct && contract.boundaries?.screen_capture === false) forbidden.add("screen_capture");
  if (!direct && contract.boundaries?.long_lived_processes === false) forbidden.add("long_lived_process");
  return normalizeExecutorCapabilityRequirements({
    required: [...required], forbidden: [...forbidden],
    allowed_skills: contract.allowed_skills ?? [],
    allowed_mcp_servers: contract.allowed_mcp_servers ?? [],
    native_instruction_files: contract.native_instruction_files ?? [],
    external_tools: contract.external_tools ?? []
  });
}

export function portableCapabilitiesForContract(contract) {
  return executorCapabilityRequirements(contract).required;
}

export function executorCapabilityRequirementsForProject(db, projectId, contract = {}, options = {}) {
  const externalTools = (contract.allowed_mcp_servers ?? []).map(name => {
    const row = db.prepare(`SELECT name,transport,endpoint,read_only_mode_json,arbitrary_execution,contains_model,self_liftable_boundary,doubles_as_provider,pinned_version
      FROM external_tool_registry WHERE project_id=? AND name=? AND active=1`).get(projectId, name);
    if (!row) return { name, missing: true, nested_model_allowed: contract.boundaries?.nested_model_calls === true };
    return {
      name: row.name, transport: row.transport, endpoint: row.endpoint,
      read_only_mode: row.read_only_mode_json ? JSON.parse(row.read_only_mode_json) : null,
      arbitrary_execution: Boolean(row.arbitrary_execution), contains_model: Boolean(row.contains_model),
      self_liftable_boundary: Boolean(row.self_liftable_boundary), doubles_as_provider: Boolean(row.doubles_as_provider),
      pinned_version: row.pinned_version, missing: false, nested_model_allowed: contract.boundaries?.nested_model_calls === true
    };
  });
  return executorCapabilityRequirements({ ...contract, external_tools: externalTools }, options);
}
