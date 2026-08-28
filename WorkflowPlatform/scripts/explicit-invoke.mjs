import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { invokeExplicitTask } from "../src/explicit-invocation.mjs";
import { resolveWorkflowSettings } from "../src/paths.mjs";

function argsObject(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) {
    const key = argv[index].slice(2);
    result[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = argsObject(argv), settings = resolveWorkflowSettings();
  const result = await invokeExplicitTask({
    client: args.client,
    origin: args.origin,
    messageFile: args["message-file"],
    deleteMessageFile: args["keep-message-file"] !== true,
    dbFile: args.db ?? settings.databasePath,
    workflow: args.workflow ?? settings.workflow,
    eventKey: args["event-key"] ?? null,
    preferredLanguage: args.language ?? settings.responseLanguage
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}

