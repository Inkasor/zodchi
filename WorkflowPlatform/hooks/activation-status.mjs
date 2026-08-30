import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activationStatus } from "../src/activation-status.mjs";
import { resolveWorkflowSettings } from "../src/paths.mjs";

function argsObject(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) {
    const key = argv[index].slice(2);
    result[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

function environmentSession(client, env) {
  if (client === "codex") return env.CODEX_SESSION_ID;
  if (client === "cursor") return env.ZODCHI_CURSOR_SESSION_ID;
  return null;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = argsObject(argv), settings = resolveWorkflowSettings(env);
  const client = String(args.client ?? "");
  const result = activationStatus({
    client,
    sessionId: args.session ?? environmentSession(client, env),
    dbFile: args.db ?? settings.databasePath
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

function canonicalFile(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync.native(resolved); }
  catch { return resolved; }
}

if (process.argv[1] && canonicalFile(process.argv[1]) === canonicalFile(fileURLToPath(import.meta.url))) {
  try { main(); }
  catch { process.stdout.write(`${JSON.stringify({ status: "unavailable", reason: "verification_failed" })}\n`); }
}
