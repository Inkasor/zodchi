import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { resolveGatewayPaths } from "./paths.mjs";
import { openGatewayDb } from "./db.mjs";
import { providerCommandInvocation, resolveProviderCommand } from "./command.mjs";
import { loadGatewayPolicy } from "./policy.mjs";

const paths = resolveGatewayPaths();
const { dataRoot, databasePath } = paths;
fs.mkdirSync(dataRoot, { recursive: true });
const db = openGatewayDb(databasePath);
const policy = loadGatewayPolicy(paths);

function command(file, args) {
  try {
    const { executable, args: commandArgs } = providerCommandInvocation(file, args);
    const result = spawnSync(executable, commandArgs, { encoding: "utf8", windowsHide: true });
    const output = `${result.stdout ?? ""}`.trim();
    const error = `${result.stderr ?? ""}`.trim();
    return { code: result.status ?? 1, output: output || error, error: output ? error : "" };
  } catch (error) {
    return { code: error.status ?? 1, output: String(error.stdout ?? "").trim(), error: String(error.stderr ?? error.message ?? "").trim() };
  }
}

function field(value, dotted) {
  return String(dotted ?? "").split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
}

function providerStatus(provider, config) {
  if (config.type === "openai-compatible") {
    const profiles = Object.values(config.profiles ?? {});
    const configured = profiles.length > 0;
    const authenticated = configured
      ? profiles.some(profile => profile.allowAnonymous === true || (profile.apiKeyEnv && process.env[profile.apiKeyEnv]))
      : false;
    return {
      code: configured && authenticated ? 0 : 1,
      output: "",
      error: "",
      authenticated: configured ? (authenticated ? 1 : 0) : null,
      subscriptionType: null,
      failureCategory: configured ? (authenticated ? null : "credential_missing") : "provider_not_configured"
    };
  }
  const status = config.status;
  if (!status?.args || !config.command) return { code: 1, output: "", error: "", authenticated: null, subscriptionType: null, failureCategory: "status_check_not_configured" };
  const result = command(resolveProviderCommand(config), status.args);
  let parsed = null;
  try { parsed = JSON.parse(result.output); } catch { /* text status */ }
  const authenticated = status.jsonAuthenticatedField
    ? (field(parsed, status.jsonAuthenticatedField) === true ? 1 : field(parsed, status.jsonAuthenticatedField) === false ? 0 : null)
    : status.authenticatedPattern
      ? (new RegExp(status.authenticatedPattern, "i").test(result.output) ? 1 : result.code === 0 ? 0 : null)
      : null;
  return {
    ...result,
    authenticated,
    subscriptionType: status.jsonSubscriptionField ? field(parsed, status.jsonSubscriptionField) ?? null : null,
    failureCategory: result.code === 0 ? null : "provider_status_error"
  };
}

const now = new Date().toISOString();
const results = Object.entries(policy.providers ?? {}).map(([provider, config]) => [provider, providerStatus(provider, config)]);
const insert = db.prepare(`INSERT INTO provider_snapshots
  (snapshot_id, provider, checked_at, authenticated, subscription_type, status, failure_category)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
for (const [provider, result] of results) {
  const authenticated = result.authenticated;
  const subscription = result.subscriptionType;
  const status = result.code === 0 ? "available" : result.failureCategory === "provider_not_configured" ? "unavailable" : "error";
  const failureCategory = result.failureCategory;
  insert.run(`${now}-${provider}`, provider, now, authenticated, subscription, status, failureCategory);
  process.stdout.write(JSON.stringify({ provider, checkedAt: now, authenticated, subscriptionType: subscription, status, failureCategory }) + "\n");
}
db.close();
