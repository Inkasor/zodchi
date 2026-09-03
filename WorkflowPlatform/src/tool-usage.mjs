export function reconcileRoleToolUsage(receipt, contract = {}) {
  const observed = receipt?.toolUsage ?? receipt?.environment?.tool_usage ?? null;
  const allowedTools = [...new Set(contract.allowed_tools ?? [])].sort();
  const canonicalTools = [...new Set(observed?.canonical_tools ?? [])].sort();
  const disallowedTools = canonicalTools.filter(tool => !allowedTools.includes(tool));
  const allowedSkills = [...new Set(contract.allowed_skills ?? [])].sort();
  const usedSkills = [...new Set(observed?.skills ?? [])].sort();
  const disallowedSkills = usedSkills.filter(skill => !allowedSkills.includes(skill));
  const allowedMcpServers = [...new Set(contract.allowed_mcp_servers ?? [])].sort();
  const usedMcpServers = [...new Set(observed?.mcp_servers ?? [])].sort();
  const disallowedMcpServers = usedMcpServers.filter(server => !allowedMcpServers.includes(server));
  const contractCheck = {
    status: disallowedTools.length ? "mismatch" : observed?.status === "complete" ? "matched" : "unavailable",
    allowed_tools: allowedTools,
    disallowed_tools: disallowedTools,
    allowed_skills: allowedSkills, disallowed_skills: disallowedSkills,
    allowed_mcp_servers: allowedMcpServers, disallowed_mcp_servers: disallowedMcpServers
  };
  receipt.environment = { ...(receipt.environment ?? {}), tool_usage: { ...(observed ?? { status: "unavailable", enforcement: "unknown", source: "legacy-receipt", native_tools: [], canonical_tools: [], unknown_native_tools: [] }), contract_check: contractCheck } };
  if (disallowedTools.length) {
    const error = new Error(`ROLE_TOOL_USAGE_MISMATCH: role=${contract.role_id ?? receipt.role ?? "unknown"}; disallowed=${disallowedTools.join(",")}`);
    error.code = "ROLE_TOOL_USAGE_MISMATCH";
    error.toolUsage = receipt.environment.tool_usage;
    throw error;
  }
  if (disallowedSkills.length || disallowedMcpServers.length) {
    const code = disallowedSkills.length ? "ROLE_SKILL_USAGE_MISMATCH" : "ROLE_MCP_USAGE_MISMATCH";
    const values = disallowedSkills.length ? disallowedSkills : disallowedMcpServers;
    const error = new Error(`${code}: role=${contract.role_id ?? receipt.role ?? "unknown"}; disallowed=${values.join(",")}`);
    error.code = code;
    error.toolUsage = receipt.environment.tool_usage;
    throw error;
  }
  return contractCheck;
}
