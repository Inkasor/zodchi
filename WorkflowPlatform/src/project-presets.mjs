import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCE_KINDS, RESOURCE_MODES } from "./resource-locks.mjs";

const KEY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ACCEPTANCE = new Set(["KNOWN_ANSWER_PRIVATE", "OWNER_READ_REQUIRED"]);
const CONTROL_BUNDLES = new Set(["external-control-plane"]);
export const defaultProjectPresetCatalogFile = fileURLToPath(new URL("../presets/catalog.json", import.meta.url));
export const defaultPublicPackageCatalogFile = fileURLToPath(new URL("../packages/catalog.json", import.meta.url));

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: object required`);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: exact fields required: ${expected.join(",")}`);
}

function strings(value, label, { nonempty = true } = {}) {
  if (!Array.isArray(value) || (nonempty && !value.length) || value.some(item => typeof item !== "string" || !item.trim())) throw new Error(`${label}: non-empty string list required`);
  return value;
}

function publicText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}: text required`);
  if (/(?:^|\s)[A-Za-z]:[\\/]|(?:^|\s)\/(?:Users|home|private|Volumes)\//i.test(value) || /UT-\d{8}-\d{6}-[a-z0-9]+/i.test(value)) throw new Error(`${label}: private identity forbidden`);
  return value;
}

export function validateProjectPresetCatalog(value, packageCatalog) {
  exact(value, ["schema_version", "presets"], "preset_catalog");
  if (value.schema_version !== 1 || !Array.isArray(value.presets) || !value.presets.length) throw new Error("PRESET_CATALOG_INVALID");
  const packageKeys = new Set((packageCatalog?.packages ?? []).map(item => item.key));
  const packageWorkTypes = new Map((packageCatalog?.packages ?? []).map(item => [item.key, new Set(item.work_types ?? [])]));
  const seen = new Set();
  for (const preset of value.presets) {
    exact(preset, ["key", "profile_role", "package_keys", "horizontal_bundles", "source_scopes", "adapters", "authority", "resources", "first_value", "public_fixture", "private_acceptance", "substitution_metric", "migration_notes"], `preset.${preset?.key ?? "unknown"}`);
    if (!KEY.test(preset.key) || seen.has(preset.key)) throw new Error(`PRESET_KEY_INVALID_OR_DUPLICATE: ${preset.key}`);
    seen.add(preset.key); publicText(preset.profile_role, `preset.${preset.key}.profile_role`);
    strings(preset.package_keys, `preset.${preset.key}.package_keys`);
    for (const key of preset.package_keys) if (!packageKeys.has(key)) throw new Error(`PRESET_PACKAGE_UNKNOWN: ${preset.key}: ${key}`);
    strings(preset.horizontal_bundles, `preset.${preset.key}.horizontal_bundles`, { nonempty: false });
    for (const key of preset.horizontal_bundles) if (!CONTROL_BUNDLES.has(key)) throw new Error(`PRESET_BUNDLE_UNKNOWN: ${preset.key}: ${key}`);
    for (const scope of strings(preset.source_scopes, `preset.${preset.key}.source_scopes`)) publicText(scope, `preset.${preset.key}.source_scope`);
    if (!Array.isArray(preset.adapters)) throw new Error(`preset.${preset.key}.adapters: array required`);
    for (const adapter of preset.adapters) {
      exact(adapter, ["capability", "required", "evidence_contract"], `preset.${preset.key}.adapter`);
      if (!KEY.test(adapter.capability) || typeof adapter.required !== "boolean") throw new Error(`PRESET_ADAPTER_INVALID: ${preset.key}`);
      publicText(adapter.evidence_contract, `preset.${preset.key}.adapter.evidence_contract`);
    }
    exact(preset.authority, ["default_mode", "live_mutation", "publication"], `preset.${preset.key}.authority`);
    if (!new Set(["read_only", "change"]).has(preset.authority.default_mode) || !new Set(["forbidden", "approval_required"]).has(preset.authority.live_mutation) || !new Set(["forbidden", "approval_required"]).has(preset.authority.publication)) throw new Error(`PRESET_AUTHORITY_INVALID: ${preset.key}`);
    if (!Array.isArray(preset.resources)) throw new Error(`preset.${preset.key}.resources: array required`);
    const resourceAliases = new Set();
    for (const resource of preset.resources) {
      exact(resource, ["alias", "kind", "modes"], `preset.${preset.key}.resource`);
      if (!KEY.test(resource.alias) || resourceAliases.has(resource.alias) || !RESOURCE_KINDS.includes(resource.kind)) throw new Error(`PRESET_RESOURCE_INVALID: ${preset.key}: ${resource.alias}`);
      resourceAliases.add(resource.alias);
      for (const mode of strings(resource.modes, `preset.${preset.key}.resource.modes`)) if (!RESOURCE_MODES.includes(mode)) throw new Error(`PRESET_RESOURCE_MODE_INVALID: ${preset.key}: ${mode}`);
    }
    exact(preset.first_value, ["work_type", "scenario", "expected_outcome"], `preset.${preset.key}.first_value`);
    const routed = preset.package_keys.some(key => packageWorkTypes.get(key)?.has(preset.first_value.work_type));
    if (!routed) throw new Error(`PRESET_WORK_TYPE_UNROUTED: ${preset.key}: ${preset.first_value.work_type}`);
    publicText(preset.first_value.scenario, `preset.${preset.key}.first_value.scenario`); publicText(preset.first_value.expected_outcome, `preset.${preset.key}.first_value.expected_outcome`);
    exact(preset.public_fixture, ["status", "proves", "does_not_prove"], `preset.${preset.key}.public_fixture`);
    if (preset.public_fixture.status !== "MECHANICS_ONLY") throw new Error(`PRESET_PUBLIC_FIXTURE_STATUS_INVALID: ${preset.key}`);
    strings(preset.public_fixture.proves, `preset.${preset.key}.public_fixture.proves`); strings(preset.public_fixture.does_not_prove, `preset.${preset.key}.public_fixture.does_not_prove`);
    if (!preset.public_fixture.does_not_prove.includes("domain_truth") || !preset.public_fixture.does_not_prove.includes("product_fit")) throw new Error(`PRESET_PUBLIC_FIXTURE_OVERCLAIMS: ${preset.key}`);
    exact(preset.private_acceptance, ["status", "owner_required", "real_repository_required", "expected_contract"], `preset.${preset.key}.private_acceptance`);
    if (!ACCEPTANCE.has(preset.private_acceptance.status) || preset.private_acceptance.owner_required !== true || preset.private_acceptance.real_repository_required !== true) throw new Error(`PRESET_PRIVATE_ACCEPTANCE_INVALID: ${preset.key}`);
    publicText(preset.private_acceptance.expected_contract, `preset.${preset.key}.private_acceptance.expected_contract`);
    publicText(preset.substitution_metric, `preset.${preset.key}.substitution_metric`);
    for (const note of strings(preset.migration_notes, `preset.${preset.key}.migration_notes`)) publicText(note, `preset.${preset.key}.migration_note`);
  }
  return Object.freeze({ schema_version: 1, presets: Object.freeze(value.presets.map(item => Object.freeze(item))) });
}

export function loadProjectPresetCatalog(file, packageCatalog) {
  const resolved = path.resolve(file);
  return validateProjectPresetCatalog(JSON.parse(fs.readFileSync(resolved, "utf8")), packageCatalog);
}

export function loadDefaultProjectPresetCatalog({ presetFile = defaultProjectPresetCatalogFile, packageFile = defaultPublicPackageCatalogFile } = {}) {
  return loadProjectPresetCatalog(presetFile, JSON.parse(fs.readFileSync(packageFile, "utf8")));
}
