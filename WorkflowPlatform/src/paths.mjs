import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDeliveryMode } from "./hook-entry.mjs";
import { normalizeLanguage } from "./language.mjs";

export const workflowPlatformRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function configuredPath(value, fallback, base = workflowPlatformRoot) {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(base, selected);
}

// The environment says where an installation lives. It must not say which project a message is about:
// a shell variable outlives the directory it was exported in, and both harnesses hand their hook whatever
// environment they inherited. Recording where each value came from is what lets a later check tell an
// installation's own declaration apart from one that leaked in from another project's shell.
function provenance(fromEnvironment, fromConfiguration) {
  if (fromEnvironment) return "environment";
  return fromConfiguration === undefined || fromConfiguration === null || fromConfiguration === "" ? "default" : "installation";
}

function readConfiguration(file) {
  if (!fs.existsSync(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("WORKFLOW_CONFIG_INVALID: expected a JSON object");
  return value;
}

export function resolveWorkflowSettings(env = process.env) {
  const configFile = configuredPath(env.WORKFLOW_PLATFORM_CONFIG, path.join("config", "runtime.json"));
  const configured = fs.existsSync(configFile);
  const config = readConfiguration(configFile);
  const dataRoot = configuredPath(env.WORKFLOW_PLATFORM_DATA || config.dataRoot, "data");
  const gatewayRoot = configuredPath(env.AGENT_GATEWAY_ROOT || config.agentGatewayRoot, path.join("..", "AgentGateway"));
  return {
    root: workflowPlatformRoot,
    configFile,
    configured,
    sources: Object.freeze({
      configFile: env.WORKFLOW_PLATFORM_CONFIG ? "environment" : "default",
      project: provenance(env.WORKFLOW_PROJECT, config.projectRoot),
      workflow: provenance(env.WORKFLOW_ID, config.workflow),
      database: provenance(env.WORKFLOW_DB, config.database),
      packageDefinitions: provenance(env.ZODCHI_PACKAGE_DEFINITIONS, config.packageDefinitions)
    }),
    config,
    dataRoot,
    databasePath: configuredPath(env.WORKFLOW_DB || config.database, path.join(dataRoot, "workflow.sqlite")),
    workflowsRoot: configuredPath(config.workflowsRoot, "workflows"),
    packagesRoot: configuredPath(config.packagesRoot, "packages"),
    packageDefinitions: configuredPath(env.ZODCHI_PACKAGE_DEFINITIONS || config.packageDefinitions, path.join("packages", "example", "definitions.mjs")),
    tempRoot: configuredPath(env.WORKFLOW_TEMP || config.tempRoot, path.join(os.tmpdir(), "workflow-platform")),
    backgroundErrorLog: configuredPath(config.backgroundErrorLog, path.join(dataRoot, "background-errors.log")),
    gatewayRoot,
    gatewayEntry: configuredPath(env.AGENT_GATEWAY_ENTRY || config.agentGatewayEntry, path.join(gatewayRoot, "src", "cli.mjs")),
    gatewayPolicyPath: configuredPath(env.AGENT_GATEWAY_POLICY || config.agentGatewayPolicy, path.join(gatewayRoot, "data", "policy.local.json")),
    gatewayDatabasePath: configuredPath(env.AGENT_GATEWAY_DB || config.agentGatewayDatabase, path.join(gatewayRoot, "data", "gateway.sqlite")),
    project: env.WORKFLOW_PROJECT || config.projectRoot || null,
    workflow: env.WORKFLOW_ID || config.workflow || null,
    responseLanguage: normalizeLanguage(env.ZODCHI_LANGUAGE || config.responseLanguage) ?? null,
    deliveryMode: normalizeDeliveryMode(env.ZODCHI_DELIVERY_MODE || config.deliveryMode)
  };
}
