export const EXECUTOR_CAPABILITIES = Object.freeze([
  "context_input",
  "project_read",
  "file_search",
  "language_server",
  "process_execution",
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
  return Object.freeze({ required: Object.freeze(required), forbidden: Object.freeze(forbidden) });
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
  if (!direct && contract.boundaries?.screen_capture === false) forbidden.add("screen_capture");
  if (!direct && contract.boundaries?.long_lived_processes === false) forbidden.add("long_lived_process");
  return normalizeExecutorCapabilityRequirements({ required: [...required], forbidden: [...forbidden] });
}

export function portableCapabilitiesForContract(contract) {
  return executorCapabilityRequirements(contract).required;
}
