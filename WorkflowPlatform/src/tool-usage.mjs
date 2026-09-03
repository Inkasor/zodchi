export function reconcileRoleToolUsage(receipt, contract = {}) {
  const observed = receipt?.toolUsage ?? receipt?.environment?.tool_usage ?? null;
  const allowedTools = [...new Set(contract.allowed_tools ?? [])].sort();
  const canonicalTools = [...new Set(observed?.canonical_tools ?? [])].sort();
  const disallowedTools = canonicalTools.filter(tool => !allowedTools.includes(tool));
  const contractCheck = {
    status: disallowedTools.length ? "mismatch" : observed?.status === "complete" ? "matched" : "unavailable",
    allowed_tools: allowedTools,
    disallowed_tools: disallowedTools
  };
  receipt.environment = { ...(receipt.environment ?? {}), tool_usage: { ...(observed ?? { status: "unavailable", enforcement: "unknown", source: "legacy-receipt", native_tools: [], canonical_tools: [], unknown_native_tools: [] }), contract_check: contractCheck } };
  if (disallowedTools.length) {
    const error = new Error(`ROLE_TOOL_USAGE_MISMATCH: role=${contract.role_id ?? receipt.role ?? "unknown"}; disallowed=${disallowedTools.join(",")}`);
    error.code = "ROLE_TOOL_USAGE_MISMATCH";
    error.toolUsage = receipt.environment.tool_usage;
    throw error;
  }
  return contractCheck;
}
