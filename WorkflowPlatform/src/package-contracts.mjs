const CHECK_STATES = new Set(["passed", "failed", "timed_out", "unavailable"]);

export function simulateOneCCheckOutcome(packageValue, checkStatus) {
  if (packageValue?.key !== "one-c.development") throw new Error("ONE_C_PACKAGE_REQUIRED");
  if (!CHECK_STATES.has(checkStatus)) throw new Error(`ONE_C_CHECK_STATUS_INVALID: ${checkStatus}`);
  const scenario = packageValue.test_scenarios.find(item => item.input?.project_check === checkStatus);
  if (!scenario) throw new Error(`ONE_C_SCENARIO_MISSING: ${checkStatus}`);
  return { classification: "implementation", route: scenario.expected.route, gate_status: checkStatus, state: scenario.expected.state, human_response: scenario.expected.response, source_acceptance: checkStatus === "passed" ? "passed" : checkStatus, build_acceptance: "not_run", runtime_acceptance: "not_run", user_acceptance: "pending" };
}

export function packageAcceptanceGates(packageValue) {
  if (packageValue.key.startsWith("indie-studio.")) return { technical: "configured", gameplay: "owner", visual: "owner", product: "owner", publication: "owner" };
  if (packageValue.key === "shared-map-engine.core") return { technical: "configured", consumer_m: "configured_or_unavailable", consumer_r: "configured_or_unavailable", gameplay: "owner", visual: "owner" };
  if (packageValue.key === "shared-lore.canon") return { continuity: "configured_or_unavailable", canon: "owner", consumer_updates: "separate" };
  if (packageValue.key === "one-c.development") return { source: "configured_or_unavailable", build: "separate", runtime: "separate", business: "owner", user: "owner" };
  throw new Error(`PACKAGE_FAMILY_UNKNOWN: ${packageValue.key}`);
}
