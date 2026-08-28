function frozen(kind, value = {}) { return Object.freeze({ kind, ...value }); }
function strings(values, label) { if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value)) throw new Error(`PACKAGE_SDK_STRING_LIST_INVALID: ${label}`); return [...new Set(values)].sort(); }

export function coreLifecycle(spec) {
  if (!spec?.key || !spec.version || !spec.purpose) throw new Error("PACKAGE_SDK_CORE_METADATA_REQUIRED");
  const rolePreset = spec.rolePreset ?? "minimal";
  if (!["minimal", "reviewed", "editorial", "release", "full"].includes(rolePreset)) throw new Error(`PACKAGE_SDK_ROLE_PRESET_UNKNOWN: ${rolePreset}`);
  return frozen("core", {
    key: spec.key, version: spec.version, purpose: spec.purpose, rolePreset,
    domains: strings(spec.domains ?? ["software"], "domains"), disciplines: strings(spec.disciplines ?? ["software"], "disciplines"),
    checks: Object.freeze([...(spec.checks ?? [])]), documents: Object.freeze([...(spec.documents ?? [])]),
    resources: Object.freeze([...(spec.resources ?? [])]), evidenceFlows: Object.freeze([...(spec.evidenceFlows ?? [])])
  });
}

function capability(key, spec = {}) { return frozen("capability", { key, options: Object.freeze({ ...spec }) }); }
export const sourceChange = spec => capability("sourceChange", spec);
export const dataChange = spec => capability("dataChange", spec);
export const contentProduction = spec => capability("contentProduction", spec);
export const release = spec => capability("release", spec);
export const incident = spec => capability("incident", spec);
export const externalRuntime = spec => capability("externalRuntime", spec);
export const experiment = spec => capability("experiment", spec);
export const accessManagement = spec => capability("accessManagement", spec);
export const projectBootstrap = spec => capability("projectBootstrap", spec);
export const documentation = spec => capability("documentation", spec);
export const securityReview = spec => capability("securityReview", spec);
export const ownerAcceptance = spec => capability("ownerAcceptance", spec);
export function domainAdapter(spec) {
  if (!spec?.key) throw new Error("PACKAGE_SDK_ADAPTER_KEY_REQUIRED");
  if (spec.materialClaims && !(spec.evidenceFlows?.length)) throw new Error(`PACKAGE_SDK_EVIDENCE_POLICY_REQUIRED: ${spec.key}`);
  return capability(`adapter:${spec.key}`, spec);
}

export function composeLifecycle(core, ...capabilities) {
  if (core?.kind !== "core") throw new Error("PACKAGE_SDK_CORE_REQUIRED");
  const byKey = new Map();
  for (const item of capabilities.flat()) {
    if (item?.kind !== "capability") throw new Error("PACKAGE_SDK_CAPABILITY_INVALID");
    if (byKey.has(item.key)) throw new Error(`PACKAGE_SDK_CAPABILITY_DUPLICATE: ${item.key}`);
    byKey.set(item.key, item);
  }
  return Object.freeze({ ...core, capabilities: Object.freeze([...byKey.values()].sort((left, right) => left.key.localeCompare(right.key, "en"))) });
}
