import { processMessage } from "../src/workflow-app.mjs";
import { resolveWorkflowSettings } from "../src/paths.mjs";
import { parseHookEvent, formatHookOutput } from "../src/hook-entry.mjs";

let input = "";
try { input = await new Promise(resolve => { let value = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => resolve(value)); }); } catch {}
let event = {};
try { event = input.trim() ? JSON.parse(input) : {}; } catch {}
if (process.env.WORKFLOW_INTERNAL === "1") process.exit(0);

const settings = resolveWorkflowSettings();
const entry = parseHookEvent(event, { env: process.env, argv: process.argv.slice(2), settings });
if (!entry.message) throw new Error("HOOK_EVENT_WITHOUT_MESSAGE: expected Codex prompt or Claude Code user_input");

process.env.WORKFLOW_INTERNAL = "1";
const result = await processMessage({
  message: entry.message,
  origin: entry.origin,
  dbFile: settings.databasePath,
  workflow: settings.workflow,
  eventSource: entry.eventSource,
  eventKey: entry.eventKey,
  eventFields: entry.eventFields,
  client: entry.client,
  preferredLanguage: entry.preferredLanguage,
  execute: true
});

console.log(JSON.stringify(formatHookOutput(result, { deliveryMode: entry.deliveryMode })));
