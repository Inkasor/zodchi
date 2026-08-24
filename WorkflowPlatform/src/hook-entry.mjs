const CLAUDE_INSTRUCTION = "This turn has already been processed by Zodchi. Use the prepared result below as the only result for this user message. Do not run commands, create or edit files, run tests or builds, invoke skills, or perform independent research. If the result asks for confirmation, ask only that question. Do not expose implementation details.";

const marker = value => typeof value === "string" && value.length > 0;

export function isClaudeCodeEvent(event = {}) {
  if (event.user_input !== undefined || event.user_input_raw !== undefined) return true;
  if (marker(event.prompt_id) || marker(event.promptId) || marker(event.transcript_path) || marker(event.transcriptPath)) return true;
  return String(event.hook_event_name ?? event.hookEventName ?? "").toLowerCase() === "userpromptsubmit" && marker(event.session_id);
}

export function parseHookEvent(event = {}, { env = process.env, argv = [], settings = {} } = {}) {
  const claude = isClaudeCodeEvent(event);
  const message = (claude ? undefined : env.CODEX_USER_PROMPT) ?? event.prompt ?? event.user_input ?? event.user_input_raw ?? event.user_prompt ?? event.userPrompt ?? event.message ?? argv.join(" ");
  const eventKey = (claude ? undefined : env.CODEX_EVENT_ID) ?? event.prompt_id ?? event.promptId ?? event.event_id ?? event.eventId ?? event.id ?? event.message_id ?? event.messageId ?? event.turn_id ?? event.turnId ?? null;
  return {
    client: claude ? "claude-code" : "codex",
    eventSource: claude ? "claude-code-hook" : "codex-hook",
    message: message ? String(message) : null,
    eventKey,
    project: settings.project ?? event.cwd ?? event.project ?? null,
    preferredLanguage: event.language ?? event.locale ?? event.user_language ?? event.userLocale ?? settings.responseLanguage ?? null
  };
}

export function formatHookOutput(result = {}) {
  const context = result.response ?? (result.route === "conversation"
    ? "Continue the conversation naturally and directly."
    : "The workflow has finished. Explain the next step without exposing internal identifiers, roles, levels, prompts, or JSON.");
  const additionalContext = `${CLAUDE_INSTRUCTION} Reply naturally in ${result.response_language ?? "the user's current language"}.\n\n${context}`;
  return { additionalContext, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}
