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
const result = await processMessage({
  message: String(message),
  project: settings.project ?? event.cwd ?? event.project ?? null,
  dbFile: settings.databasePath,
  workflow: settings.workflow,
  eventSource: "codex-hook",
  eventKey: process.env.CODEX_EVENT_ID ?? event.event_id ?? event.eventId ?? event.id ?? event.message_id ?? event.messageId ?? event.turn_id ?? event.turnId ?? null,
  execute: true
});

const context = result.response ?? (result.route === "conversation"
  ? "Продолжи разговор с пользователем по существу и простым русским языком."
  : "Разбор задачи завершён. Объясни пользователю следующий шаг простым русским языком. Не показывай внутренние идентификаторы, роли, уровни и JSON.");

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `Этот шаг уже обработан Workflow Platform. Используй готовый результат ниже как единственный результат этого сообщения. Не выполняй команды, не создавай и не изменяй файлы, не запускай тесты или сборку, не запускай навыки и не проводи самостоятельное исследование. Если результат просит подтверждение — задай пользователю только этот вопрос. Не показывай техническую кухню. Общайся с пользователем естественно и простым русским языком.\n\n${context}`
  }
}));
