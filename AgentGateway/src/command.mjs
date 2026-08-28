import fs from "node:fs";
import path from "node:path";

export function expandEnvironmentTemplate(value, env = process.env) {
  return String(value).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => env[name] ?? match);
}

export function resolveProviderCommand(providerConfig, { platform = process.platform, env = process.env } = {}) {
  const configured = [platform === "win32" ? providerConfig.windowsCommand : null, providerConfig.command].filter(Boolean).map(value => expandEnvironmentTemplate(value, env));
  if (!configured.length) throw new Error("PROVIDER_COMMAND_REQUIRED");
  const pathEntries = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const value of configured) {
    const hasPath = path.isAbsolute(value) || value.includes("/") || value.includes("\\");
    if (hasPath && fs.existsSync(value)) return path.resolve(value);
    if (hasPath) continue;
    const names = platform === "win32" && !/\.(?:exe|cmd|bat|com)$/i.test(value) ? [`${value}.cmd`, `${value}.exe`, `${value}.bat`, value] : [value];
    for (const directory of pathEntries) for (const name of names) {
      const candidate = path.resolve(directory, name);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  const error = new Error(`PROVIDER_COMMAND_UNAVAILABLE: ${configured.join(" | ")}`); error.code = "PROVIDER_COMMAND_UNAVAILABLE"; throw error;
}

export function providerCommandInvocation(command, args, { platform = process.platform, env = process.env } = {}) {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) return Object.freeze({ executable: env.ComSpec ?? env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", command, ...args] });
  return Object.freeze({ executable: command, args: [...args] });
}
