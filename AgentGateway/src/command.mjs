export function expandEnvironmentTemplate(value, env = process.env) {
  return String(value).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => env[name] ?? match);
}

export function resolveProviderCommand(providerConfig, { platform = process.platform, env = process.env } = {}) {
  const configured = platform === "win32" && providerConfig.windowsCommand
    ? providerConfig.windowsCommand
    : providerConfig.command;
  if (!configured) throw new Error("PROVIDER_COMMAND_REQUIRED");
  return expandEnvironmentTemplate(configured, env);
}
