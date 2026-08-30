import fs from "node:fs";
import path from "node:path";

export function mergeGatewayPolicies(universal, local = null) {
  if (!local) return structuredClone(universal);
  if (local.schemaVersion !== undefined && universal.schemaVersion !== undefined && local.schemaVersion !== universal.schemaVersion) {
    throw new Error(`POLICY_SCHEMA_MISMATCH: universal=${universal.schemaVersion} local=${local.schemaVersion}`);
  }
  const providers = {};
  for (const key of new Set([...Object.keys(universal.providers ?? {}), ...Object.keys(local.providers ?? {})])) {
    const base = universal.providers?.[key] ?? {};
    const overlay = local.providers?.[key] ?? {};
    providers[key] = {
      ...base,
      ...overlay,
      profileDefaults: { ...(base.profileDefaults ?? {}), ...(overlay.profileDefaults ?? {}) },
      profiles: { ...(base.profiles ?? {}), ...(overlay.profiles ?? {}) }
    };
  }
  return {
    ...universal,
    ...local,
    levels: { ...(universal.levels ?? {}), ...(local.levels ?? {}) },
    providers
  };
}

export function loadGatewayPolicy({ root, policyPath }) {
  const universalPath = path.join(root, "policy.json");
  const universal = JSON.parse(fs.readFileSync(universalPath, "utf8"));
  if (path.resolve(policyPath) === path.resolve(universalPath)) return universal;
  if (!fs.existsSync(policyPath)) throw new Error(`LOCAL_POLICY_MISSING: ${policyPath}`);
  const local = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  return local.kind === "profile-overlay" ? mergeGatewayPolicies(universal, local) : local;
}
