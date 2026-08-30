import { openDb } from "./db.mjs";
import { formatHookOutput, hookEventFields } from "./hook-entry.mjs";
import { consumePendingMessage, endChatSession, routeChatPrompt, setPendingMessage } from "./chat-session.mjs";
import { processMessage } from "./workflow-app.mjs";

function eventMessage(event) {
  return event.prompt ?? event.user_input ?? event.user_input_raw ?? event.user_prompt ?? event.userPrompt ?? event.message ?? null;
}

function sessionId(event) { return event.session_id ?? event.sessionId ?? null; }
const EXPANDED_SKILL_MARKER = "ZODCHI_SESSION_ACTIVATION_V1";
const EXECUTION_CONFIRMATION = /^\s*(?:делай|начинай|запускай|продолжай|поехали|да|execute|proceed|go ahead|start)\s*[.!]?\s*$/iu;

export async function routeSessionEvent({ event, client, dbFile, workflow = null, preferredLanguage = null, deliveryMode = "final" }, dependencies = {}) {
  if (process.env.ZODCHI_INTERNAL_INVOCATION === "1") return null;
  const id = sessionId(event);
  if (!id) throw new Error("ZODCHI_SESSION_ID_REQUIRED");
  const eventName = event.hook_event_name ?? event.hookEventName ?? "UserPromptSubmit";
  const db = (dependencies.openDb ?? openDb)(dbFile);
  if (eventName === "SessionEnd") {
    try { endChatSession(db, { client, sessionId: id }); }
    finally { db.close(); }
    return null;
  }
  if (eventName !== "UserPromptSubmit") { db.close(); return null; }
  const rawPrompt = eventMessage(event);
  const prompt = typeof rawPrompt === "string" && rawPrompt.includes(EXPANDED_SKILL_MARKER) ? "/zodchi" : rawPrompt;
  if (prompt === null) { db.close(); return null; }
  let routing, prepared = null;
  try {
    routing = routeChatPrompt(db, { client, sessionId: id, origin: event.cwd, prompt });
    if (routing.action === "route" && routing.session?.pending_message && EXECUTION_CONFIRMATION.test(String(prompt))) {
      prepared = consumePendingMessage(db, { client, sessionId: id });
    }
  }
  finally { db.close(); }
  if (routing.action === "pass") return null;
  if (routing.action === "activated") {
    return formatHookOutput({
      route: "conversation",
      response_language: preferredLanguage,
      response: preferredLanguage === "en"
        ? "Zodchi mode is active for this chat. Describe the task normally; before implementation Zodchi will fix the Quality, Execution, Verification, and Planning profile."
        : "Режим Zodchi включён для этого чата. Опишите задачу обычным сообщением; перед реализацией Zodchi зафиксирует профиль Quality, Execution, Verification и Planning."
    }, { deliveryMode });
  }
  const processTask = dependencies.processMessage ?? processMessage;
  const result = await processTask({
    message: prepared?.message ?? routing.message,
    project: routing.session.project_id,
    origin: event.cwd,
    dbFile,
    workflow,
    execute: true,
    eventSource: `${client}-zodchi-session`,
    eventKey: event.turn_id ?? event.turnId ?? event.prompt_id ?? event.promptId ?? event.event_id ?? event.eventId ?? null,
    eventFields: hookEventFields(event),
    client,
    preferredLanguage,
    prepareOnly: prepared === null,
    runProfileOverrides: prepared?.profile ? {
      quality_mode: prepared.profile.quality_mode,
      execution_mode: prepared.profile.execution_mode,
      verification_mode: prepared.profile.verification_mode,
      planning_mode: prepared.profile.planning_mode
    } : {}
  });
  if (result.route === "prepared") {
    const state = (dependencies.openDb ?? openDb)(dbFile);
    try { setPendingMessage(state, { client, sessionId: id, message: routing.message, profile: result.run_profile ?? null }); }
    finally { state.close(); }
  }
  return formatHookOutput(result, { deliveryMode });
}
