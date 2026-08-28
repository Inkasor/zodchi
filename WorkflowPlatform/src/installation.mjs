import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkflowSettings } from "./paths.mjs";
import { normalizeLanguage } from "./language.mjs";
import { platformInstallationPaths } from "./platform-paths.mjs";

function assertNoSecretFields(value, trail = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const next = [...trail, key];
    const sensitive = /(?:api[_-]?key|secret|token|password|credential|cookie|authorization)/i.test(key);
    const environmentReference = /Env$/i.test(key) && typeof nested === "string" && /^[A-Z_][A-Z0-9_]*$/.test(nested);
    if (sensitive && !environmentReference) throw new Error(`INSTALLATION_CONFIG_SECRET_FIELD: ${next.join(".")}`);
    assertNoSecretFields(nested, next);
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function configureInstallation(spec, options = {}) {
  const shared = spec?.scope === "shared";
  if (!shared && (!spec?.projectRoot || !fs.existsSync(spec.projectRoot))) throw new Error("INSTALLATION_PROJECT_REQUIRED: projectRoot must exist");
  if (!shared && (!spec.workflow || typeof spec.workflow !== "string")) throw new Error("INSTALLATION_WORKFLOW_REQUIRED");
  if (shared && (spec.projectRoot || spec.workflow)) throw new Error("INSTALLATION_SHARED_SCOPE_CONFLICT: shared installation must route projects from the registry");
  assertNoSecretFields(spec);
  const settings = options.settings ?? resolveWorkflowSettings();
  const workflowRoot = options.workflowRoot ?? settings.root;
  const gatewayRoot = options.gatewayRoot ?? settings.gatewayRoot;
  const universalPolicyFile = options.universalPolicyFile ?? path.join(gatewayRoot, "policy.json");
  if (!fs.existsSync(universalPolicyFile)) throw new Error(`INSTALLATION_GATEWAY_POLICY_MISSING: ${universalPolicyFile}`);
  const policy = JSON.parse(fs.readFileSync(universalPolicyFile, "utf8"));
  const assignments = spec.gatewayProfiles ?? {};
  const localPolicy = { schemaVersion: policy.schemaVersion, kind: "profile-overlay", providers: {} };
  for (const [provider, profiles] of Object.entries(assignments)) {
    if (!policy.providers?.[provider]) throw new Error(`INSTALLATION_PROVIDER_UNKNOWN: ${provider}`);
    if (!profiles || Array.isArray(profiles) || typeof profiles !== "object") throw new Error(`INSTALLATION_PROFILES_INVALID: ${provider}`);
    localPolicy.providers[provider] = { profiles };
  }
  if (!Object.values(localPolicy.providers).some(provider => Object.keys(provider.profiles ?? {}).length)) throw new Error("INSTALLATION_PROFILE_REQUIRED: assign at least one local provider profile");

  const localDataRoot = spec.localDataRoot ? path.resolve(spec.localDataRoot) : shared ? path.resolve((options.platformPaths ?? platformInstallationPaths()).data) : null;
  const workflowDataRoot = options.workflowDataRoot ?? (localDataRoot ? path.join(localDataRoot, "workflow") : path.join(workflowRoot, spec.dataRoot ?? "data"));
  const gatewayDataRoot = options.gatewayDataRoot ?? (localDataRoot ? path.join(localDataRoot, "gateway") : path.join(gatewayRoot, "data"));
  const localPolicyFile = options.localPolicyFile ?? path.join(gatewayDataRoot, "policy.local.json");
  const runtimeFile = options.runtimeFile ?? (localDataRoot ? path.join(localDataRoot, "config", "runtime.json") : path.join(workflowRoot, "config", "runtime.json"));
  const runtime = {
    dataRoot: path.relative(workflowRoot, workflowDataRoot).replaceAll("\\", "/") || ".",
    database: path.relative(workflowRoot, path.join(workflowDataRoot, "workflow.sqlite")).replaceAll("\\", "/"),
    agentGatewayRoot: path.relative(workflowRoot, gatewayRoot).replaceAll("\\", "/") || ".",
    agentGatewayPolicy: path.relative(workflowRoot, localPolicyFile).replaceAll("\\", "/"),
    agentGatewayDatabase: path.relative(workflowRoot, path.join(gatewayDataRoot, "gateway.sqlite")).replaceAll("\\", "/"),
    projectRoot: shared ? null : path.resolve(spec.projectRoot),
    workflow: shared ? null : spec.workflow,
    responseLanguage: normalizeLanguage(spec.responseLanguage) ?? null
  };
  atomicJson(localPolicyFile, localPolicy);
  atomicJson(runtimeFile, runtime);
  return { status: "configured", scope: shared ? "shared" : "project", runtimeFile, localPolicyFile, workflowDatabase: path.join(workflowDataRoot, "workflow.sqlite"), gatewayDatabase: path.join(gatewayDataRoot, "gateway.sqlite"), projectRoot: runtime.projectRoot, workflow: runtime.workflow, environment: { WORKFLOW_PLATFORM_CONFIG: runtimeFile }, providers: Object.entries(assignments).filter(([, profiles]) => Object.keys(profiles).length).map(([provider]) => provider) };
}
