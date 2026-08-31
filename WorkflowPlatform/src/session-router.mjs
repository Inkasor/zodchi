import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "./db.mjs";
import { formatActivationHookOutput, formatCursorContinue, formatCursorModeRequired, formatCursorSessionStart, formatHookOutput, hookEventFields } from "./hook-entry.mjs";
import { bindChatSessionResult, chatSession, consumePendingMessage, endChatSession, routeChatPrompt, setPendingMessage } from "./chat-session.mjs";
import { processMessage } from "./workflow-app.mjs";

function eventMessage(event) {
  return event.prompt ?? event.user_input ?? event.user_input_raw ?? event.user_prompt ?? event.userPrompt ?? event.message ?? null;
}

function sessionId(event) { return event.conversation_id ?? event.conversationId ?? event.session_id ?? event.sessionId ?? null; }
function eventOrigin(event, client) {
  if (client !== "cursor") return event.cwd ?? event.project ?? null;
  const roots = Array.isArray(event.workspace_roots) ? event.workspace_roots.filter(Boolean) : [];
  return roots.length === 1 ? roots[0] : null;
}
const EXPANDED_SKILL_MARKER = "ZODCHI_SESSION_ACTIVATION_V1";
const EXECUTION_CONFIRMATION = /^\s*(?:делай|начинай|запускай|продолжай|поехали|да|execute|proceed|go ahead|start)\s*[.!]?\s*$/iu;
const PROFILE_CARD = /^\s*["“«]?\s*(?:Профиль выполнения|Execution profile)\s*:/iu;

// A blocking hook is sometimes quoted into the next visible user message by the host. Treat the
// final line as confirmation only when the preceding text is recognizably Zodchi's profile card;
// arbitrary task prose that merely ends in "start" must remain ordinary input.
export function isExecutionConfirmation(prompt) {
  const text = String(prompt ?? "").trim();
  if (EXECUTION_CONFIRMATION.test(text)) return true;
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  return lines.length > 1 && PROFILE_CARD.test(lines[0]) && EXECUTION_CONFIRMATION.test(lines.at(-1));
}

function samePath(left, right) {
  if (!left || !right) return false;
  const canonical = value => {
    const resolved = path.resolve(String(value));
    try { return fs.realpathSync.native(resolved); }
    catch { return resolved; }
  };
  const a = canonical(left), b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function attachedCursorSkill(event, activationSkillPaths) {
  const allowed = activationSkillPaths.filter(Boolean);
  if (!allowed.length) return false;
  return (event.attachments ?? []).some(item => item?.type === "rule" && allowed.some(skill => samePath(item.file_path, skill)));
}

function explicitSkillPrompt(rawPrompt, { client, activationSkillPath, cursorSkillAttached = false, cursorSessionActive = false }) {
  if (typeof rawPrompt !== "string") return rawPrompt;
  if (rawPrompt.includes(EXPANDED_SKILL_MARKER)) return "/zodchi";
  if (client === "cursor" && cursorSkillAttached && !cursorSessionActive) {
    const task = rawPrompt.trim();
    if (/^\/zodchi(?:\s|$)/u.test(task)) return task;
    return task ? `/zodchi ${task}` : "/zodchi";
  }
  if (client !== "codex") return rawPrompt;

  // Codex app-server invokes a skill as a `$name` input item. Codex Desktop persists that item in
  // the visible user message as a Markdown link, while CLI clients may keep the `$name` token.
  // UserPromptSubmit receives this host representation before the model reads SKILL.md, so looking
  // only for a marker inside the skill body can never activate a real Codex turn.
  const linked = /^\s*\[\$zodchi\]\(([^)\r\n]+)\)(?:\s+([\s\S]*?))?\s*$/u.exec(rawPrompt);
  if (linked) {
    if (!samePath(linked[1], activationSkillPath)) return rawPrompt;
    return linked[2]?.trim() ? `/zodchi ${linked[2].trim()}` : "/zodchi";
  }
  const token = /^\s*\$zodchi(?:\s+([\s\S]*?))?\s*$/u.exec(rawPrompt);
  if (token) return token[1]?.trim() ? `/zodchi ${token[1].trim()}` : "/zodchi";
  return rawPrompt;
}

export async function routeSessionEvent({ event, client, dbFile, workflow = null, preferredLanguage = null, deliveryMode = "advisory", activationSkillPath = null, alternateActivationSkillPath = null }, dependencies = {}) {
  if (process.env.ZODCHI_INTERNAL_INVOCATION === "1") return null;
  const id = sessionId(event);
  if (!id) throw new Error("ZODCHI_SESSION_ID_REQUIRED");
  const eventName = event.hook_event_name ?? event.hookEventName ?? "UserPromptSubmit";
  if (client === "cursor" && eventName === "sessionStart") return formatCursorSessionStart(id);
  const db = (dependencies.openDb ?? openDb)(dbFile);
  if (eventName === "SessionEnd" || eventName === "sessionEnd") {
    try { endChatSession(db, { client, sessionId: id }); }
    finally { db.close(); }
    return null;
  }
  const submitEvent = eventName === "UserPromptSubmit" || (client === "cursor" && eventName === "beforeSubmitPrompt");
  if (!submitEvent) { db.close(); return null; }
  const cursorAttached = client === "cursor" && attachedCursorSkill(event, [activationSkillPath, alternateActivationSkillPath]);
  const existing = chatSession(db, { client, sessionId: id });
  if (client === "cursor" && existing?.state === "active" && !cursorAttached) { db.close(); return formatCursorModeRequired(); }
  const origin = eventOrigin(event, client);
  if (client === "cursor" && cursorAttached && !origin) { db.close(); return { continue: false, user_message: "Zodchi requires one Cursor workspace root for this chat." }; }
  const rawPrompt = eventMessage(event);
  const prompt = explicitSkillPrompt(rawPrompt, { client, activationSkillPath, cursorSkillAttached: cursorAttached, cursorSessionActive: existing?.state === "active" });
  const turnKey = String(event.generation_id ?? event.generationId ?? event.turn_id ?? event.turnId ?? event.prompt_id ?? event.promptId ?? event.event_id ?? event.eventId ?? randomUUID());
  if (prompt === null) { db.close(); return null; }
  let routing, prepared = null;
  try {
    routing = routeChatPrompt(db, { client, sessionId: id, origin, prompt, turnKey });
    if (routing.action === "route" && routing.session?.pending_message && isExecutionConfirmation(prompt)) {
      prepared = consumePendingMessage(db, { client, sessionId: id });
    }
  }
  finally { db.close(); }
  if (routing.action === "pass") return null;
  if (routing.action === "activated") {
    return client === "cursor" ? formatCursorContinue() : formatActivationHookOutput({ response_language: preferredLanguage });
  }
  const processTask = dependencies.processMessage ?? processMessage;
  const result = await processTask({
    message: prepared?.message ?? routing.message,
    project: routing.session.project_id,
    origin,
    dbFile,
    workflow,
    execute: true,
    eventSource: `${client}-zodchi-session`,
    eventKey: event.generation_id ?? event.generationId ?? event.turn_id ?? event.turnId ?? event.prompt_id ?? event.promptId ?? event.event_id ?? event.eventId ?? null,
    eventFields: hookEventFields(event),
    client,
    chatSession: { client, session_id: id },
    semanticScope: { client, session_id: id },
    preferredLanguage,
    prepareOnly: prepared === null,
    runProfileOverrides: prepared?.profile ? {
      quality_mode: prepared.profile.quality_mode,
      execution_mode: prepared.profile.execution_mode,
      verification_mode: prepared.profile.verification_mode,
      planning_mode: prepared.profile.planning_mode
    } : {}
  });
  const state = (dependencies.openDb ?? openDb)(dbFile);
  try {
    if (result.route === "prepared") setPendingMessage(state, { client, sessionId: id, message: routing.message, profile: result.run_profile ?? null });
    if (result.run_id) bindChatSessionResult(state, { client, sessionId: id, runId: result.run_id, turnKey });
  } finally { state.close(); }
  return client === "cursor" ? formatCursorContinue() : formatHookOutput(result, { deliveryMode });
}
