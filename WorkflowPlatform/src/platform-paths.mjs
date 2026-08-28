import os from "node:os";
import path from "node:path";

export function platformInstallationPaths(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === "win32") {
    const base = path.win32.resolve(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"));
    return Object.freeze({ application: path.win32.join(base, "Zodchi"), data: path.win32.join(base, "ZodchiData") });
  }
  if (platform === "darwin") {
    const base = path.posix.join(home, "Library", "Application Support", "Zodchi");
    return Object.freeze({ application: path.posix.join(base, "app"), data: path.posix.join(base, "data") });
  }
  const base = path.posix.resolve(env.XDG_DATA_HOME || path.posix.join(home, ".local", "share"), "zodchi");
  return Object.freeze({ application: path.posix.join(base, "app"), data: path.posix.join(base, "data") });
}
