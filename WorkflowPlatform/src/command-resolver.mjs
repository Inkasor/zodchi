import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CAPABILITIES = Object.freeze({
  "node.runtime": { intrinsic: () => process.execPath },
  "node.package_manager": { names: { win32: ["npm.cmd", "npm.exe", "npm"], default: ["npm"] } },
  "security.gitleaks": { names: { win32: ["gitleaks.exe", "gitleaks"], default: ["gitleaks"] } },
  "security.osv_scanner": { names: { win32: ["osv-scanner.exe", "osv-scanner"], default: ["osv-scanner"] } },
  "shell.powershell": { names: { win32: ["pwsh.exe", "powershell.exe", "pwsh", "powershell"], default: ["pwsh", "powershell"] } }
});

function executableInPath(name, env, platform) {
  const values = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of values) {
    const candidate = path.resolve(directory, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  // A bare command is still useful when a launcher resolves it outside PATH (for example an execution
  // environment shim), but only the configured-command compatibility path may use one. Capabilities are
  // installation facts and therefore fail closed when no concrete file is discoverable.
  return null;
}

export function resolveCommandCapability(capability, { env = process.env, platform = process.platform, execPath = process.execPath } = {}) {
  const spec = CAPABILITIES[capability];
  if (!spec) throw new Error(`COMMAND_CAPABILITY_UNKNOWN: ${capability}`);
  if (spec.intrinsic) return Object.freeze({ capability, command: spec.intrinsic({ env, platform, execPath }), source: "runtime" });
  if (capability === "node.package_manager" && env.npm_execpath) {
    const configured = path.resolve(env.npm_execpath);
    if (fs.existsSync(configured)) return Object.freeze({ capability, command: configured, source: "npm_execpath" });
  }
  const names = spec.names[platform] ?? spec.names.default;
  // npm is normally adjacent to node even when the parent directory was intentionally omitted from PATH.
  const adjacent = capability === "node.package_manager" ? names.map(name => path.join(path.dirname(execPath), name)) : [];
  for (const candidate of adjacent) if (fs.existsSync(candidate)) return Object.freeze({ capability, command: candidate, source: "node_directory" });
  for (const name of names) {
    const found = executableInPath(name, env, platform);
    if (found) return Object.freeze({ capability, command: found, source: "path" });
  }
  const error = new Error(`COMMAND_CAPABILITY_UNAVAILABLE: ${capability}`); error.code = "COMMAND_CAPABILITY_UNAVAILABLE"; throw error;
}

export function resolveCommandConfiguration(config, options = {}) {
  if (typeof config?.capability === "string") return resolveCommandCapability(config.capability, options);
  if (typeof config?.command === "string") return Object.freeze({ capability: null, command: config.command, source: "configured" });
  throw new Error("COMMAND_CONFIGURATION_INVALID");
}

export const COMMAND_CAPABILITIES = Object.freeze(Object.keys(CAPABILITIES));
