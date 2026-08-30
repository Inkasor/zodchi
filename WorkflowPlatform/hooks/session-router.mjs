import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkflowSettings } from "../src/paths.mjs";
import { routeSessionEvent } from "../src/session-router.mjs";

function argsObject(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) {
    const key = argv[index].slice(2);
    result[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

export async function main(argv = process.argv.slice(2)) {
  const args = argsObject(argv), settings = resolveWorkflowSettings(), event = await readStdin();
  const client = String(args.client ?? "");
  if (!new Set(["codex", "claude-code"]).has(client)) throw new Error(`ZODCHI_SESSION_CLIENT_INVALID: ${client || "missing"}`);
  const output = await routeSessionEvent({
    event, client,
    dbFile: args.db ?? settings.databasePath,
    workflow: args.workflow ?? settings.workflow,
    preferredLanguage: args.language ?? settings.responseLanguage,
    deliveryMode: args["delivery-mode"] ?? "advisory",
    activationSkillPath: args["skill-path"] ? path.resolve(String(args["skill-path"])) : null
  });
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

function canonicalFile(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync.native(resolved); }
  catch { return resolved; }
}

if (process.argv[1] && canonicalFile(process.argv[1]) === canonicalFile(fileURLToPath(import.meta.url))) {
  main().catch(error => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
