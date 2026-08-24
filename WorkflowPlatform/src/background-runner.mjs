import fs from "node:fs";
import path from "node:path";
import { processMessage } from "./workflow-app.mjs";
import { resolveWorkflowSettings } from "./paths.mjs";
process.env.WORKFLOW_INTERNAL = "1";
const inputFile = process.argv[2];
if (!inputFile) throw new Error("background runner requires an input file");
const input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
const settings = resolveWorkflowSettings();
try { await processMessage({ dbFile: settings.databasePath, ...input, execute: true }); }
catch (error) { fs.mkdirSync(path.dirname(settings.backgroundErrorLog), { recursive: true }); fs.appendFileSync(settings.backgroundErrorLog, `${new Date().toISOString()}\t${error?.stack ?? error}\n`, "utf8"); }
finally { fs.rmSync(inputFile, { force: true }); }
