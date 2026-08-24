import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const gatewayRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function configuredPath(value, fallback, base = gatewayRoot) {
  const selected = value || fallback;
  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(base, selected);
}

export function resolveGatewayPaths(env = process.env) {
  const dataRoot = configuredPath(env.AGENT_GATEWAY_DATA, "data");
  return {
    root: gatewayRoot,
    dataRoot,
    databasePath: configuredPath(env.AGENT_GATEWAY_DB, path.join(dataRoot, "gateway.sqlite")),
    policyPath: configuredPath(env.AGENT_GATEWAY_POLICY, "policy.json"),
    tempRoot: configuredPath(env.AGENT_GATEWAY_TEMP, path.join(os.tmpdir(), "agent-gateway")),
    codexSourceHome: configuredPath(env.CODEX_SOURCE_HOME || env.CODEX_HOME, path.join(os.homedir(), ".codex")),
    kimiSourceHome: configuredPath(env.KIMI_SOURCE_HOME || env.KIMI_CODE_HOME, path.join(os.homedir(), ".kimi-code")),
    opencodeSourceHome: configuredPath(env.OPENCODE_SOURCE_HOME, path.join(os.homedir(), ".local", "share", "opencode"))
  };
}
