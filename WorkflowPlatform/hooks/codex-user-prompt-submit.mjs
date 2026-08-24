import { processMessage } from "../src/workflow-app.mjs";
import { resolveWorkflowSettings } from "../src/paths.mjs";

let input = "";
try { input = await new Promise(resolve => { let value = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => resolve(value)); }); } catch {}
let event = {};
try { event = input.trim() ? JSON.parse(input) : {}; } catch {}
if (process.env.WORKFLOW_INTERNAL === "1") process.exit(0);

const message = process.env.CODEX_USER_PROMPT ?? event.prompt ?? event.user_prompt ?? event.userPrompt ?? event.message ?? process.argv.slice(2).join(" ");
if (!message) throw new Error("CODEX_USER_PROMPT or prompt argument is required");

process.env.WORKFLOW_INTERNAL = "1";
const settings = resolveWorkflowSettings();
const preferredLanguage = event.language ?? event.locale ?? event.user_language ?? event.userLocale ?? settings.responseLanguage ?? null;
const result = await processMessage({
  message: String(message),
  project: settings.project ?? event.cwd ?? event.project ?? null,
  dbFile: settings.databasePath,
  workflow: settings.workflow,
  eventSource: "codex-hook",
  eventKey: process.env.CODEX_EVENT_ID ?? event.event_id ?? event.eventId ?? event.id ?? event.message_id ?? event.messageId ?? event.turn_id ?? event.turnId ?? null,
  preferredLanguage,
  execute: true
});

const context = result.response ?? (result.route === "conversation"
  ? "Continue the conversation naturally and directly."
  : "The workflow has finished. Explain the next step without exposing internal identifiers, roles, levels, prompts, or JSON.");

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `This turn has already been processed by Zodchi. Use the prepared result below as the only result for this user message. Do not run commands, create or edit files, run tests or builds, invoke skills, or perform independent research. If the result asks for confirmation, ask only that question. Do not expose implementation details. Reply naturally in ${result.response_language ?? "the user's current language"}.\n\n${context}`
  }
}));
