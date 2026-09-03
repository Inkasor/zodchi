import assert from "node:assert/strict";
import test from "node:test";
import { reconcileRoleToolUsage } from "../src/tool-usage.mjs";

function receipt(canonicalTools, status = "complete") {
  return { role: "reviewer", environment: { tool_usage: { status, enforcement: "technical", source: "fixture", native_tools: [], canonical_tools: canonicalTools, unknown_native_tools: [] } } };
}

test("role result acceptance rejects an observed tool outside the active contract", () => {
  const value = receipt(["apply_patch"]);
  assert.throws(() => reconcileRoleToolUsage(value, { role_id: "reviewer", allowed_tools: [] }), error => error.code === "ROLE_TOOL_USAGE_MISMATCH");
  assert.equal(value.environment.tool_usage.contract_check.status, "mismatch");
});

test("allowed and unobservable tool usage remain distinguishable", () => {
  const allowed = receipt(["apply_patch"]);
  assert.equal(reconcileRoleToolUsage(allowed, { allowed_tools: ["apply_patch"] }).status, "matched");
  const legacy = { role: "worker" };
  assert.equal(reconcileRoleToolUsage(legacy, { allowed_tools: [] }).status, "unavailable");
  assert.equal(legacy.environment.tool_usage.contract_check.status, "unavailable");
});
