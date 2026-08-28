// Both harnesses treat hook output as advisory developer context, so the instruction has to be
// unambiguous, and it has to be repeated after the result: the boundary is what the model reads last.
const HARNESS_INSTRUCTION = "This turn is already complete. Zodchi has classified the message, made the model calls it needed, and produced the result below. Your only remaining job is to deliver that result to the user. Do not run commands, read files, list directories, search the repository, inspect git, run tests or builds, edit anything, or invoke any skill or tool. Do not gather context to verify or enrich the result: that work has already been done and paid for, and repeating it charges the user twice. If the result asks a question, ask exactly that question and stop. Do not expose identifiers, roles, levels, prompts, or JSON.";
const HARNESS_BOUNDARY = "End of the prepared result. Deliver it now, with no tool call and no independent research.";

const marker = value => typeof value === "string" && value.length > 0;

// The two harnesses send nearly the same UserPromptSubmit payload: session id, transcript path,
// working directory, event name, permission mode and prompt. Only three fields differ, so those
// are the only ones that identify the sender. Codex names the turn and the model it is running;
// Claude Code names the prompt.
const CODEX_FIELDS = Object.freeze(["turn_id", "turnId", "model"]);
const CLAUDE_FIELDS = Object.freeze(["prompt_id", "promptId", "user_input", "user_input_raw"]);

const present = (event, fields) => fields.some(field => event[field] !== undefined && event[field] !== null && event[field] !== "");

export function isCodexEvent(event = {}) { return present(event, CODEX_FIELDS); }

export function isClaudeCodeEvent(event = {}) {
  return !isCodexEvent(event) && present(event, CLAUDE_FIELDS);
}

// The field names of a hook event identify the harness that sent it; the values may hold the
// user's prompt, so only the names are recorded.
export function hookEventFields(event = {}) {
  return Object.keys(event).sort();
}

// Hooks are installed per project, so the delivery mode travels on the hook command itself. Nothing
// else in either harness carries a per-project value into the hook.
const DELIVERY_FLAG = "--delivery-mode=";

export function parseHookEvent(event = {}, { env = process.env, argv = [], settings = {} } = {}) {
  const claude = isClaudeCodeEvent(event);
  const flagged = argv.find(item => typeof item === "string" && item.startsWith(DELIVERY_FLAG));
  const words = argv.filter(item => typeof item === "string" && !item.startsWith("--"));
  const message = (claude ? undefined : env.CODEX_USER_PROMPT) ?? event.prompt ?? event.user_input ?? event.user_input_raw ?? event.user_prompt ?? event.userPrompt ?? event.message ?? words.join(" ");
  const eventKey = (claude ? undefined : env.CODEX_EVENT_ID) ?? event.prompt_id ?? event.promptId ?? event.event_id ?? event.eventId ?? event.id ?? event.message_id ?? event.messageId ?? event.turn_id ?? event.turnId ?? null;
  return {
    client: claude ? "claude-code" : "codex",
    eventSource: claude ? "claude-code-hook" : "codex-hook",
    message: message ? String(message) : null,
    eventKey,
    // Where the message came from and which project the installation declares are two different facts,
    // and collapsing them is what let one project's configuration answer another project's message. Both
    // travel, and the binding is decided once, by `bindProject`.
    project: settings.project ?? null,
    origin: event.cwd ?? event.project ?? null,
    eventFields: hookEventFields(event),
    deliveryMode: resolveDeliveryMode(flagged ? flagged.slice(DELIVERY_FLAG.length) : settings.deliveryMode, claude ? "claude-code" : "codex"),
    preferredLanguage: event.language ?? event.locale ?? event.user_language ?? event.userLocale ?? settings.responseLanguage ?? null
  };
}

export const DELIVERY_MODES = Object.freeze(["advisory", "final"]);

export function normalizeDeliveryMode(value) {
  return DELIVERY_MODES.includes(value) ? value : "advisory";
}

// Advisory output is delivered through the additional-context shape, and that shape is Claude Code's.
// A Codex turn was observed receiving neither the context nor the prepared text: the classification ran,
// the call was paid for, and the answer reached nobody, which is the worst of the possible outcomes. The
// blocking shape is the one both harnesses have been seen to honour, so it is what an unconfigured Codex
// project gets. This is a default, not a rule: a project that states a mode still gets the mode it
// stated, in either harness.
export function resolveDeliveryMode(configured, client) {
  if (DELIVERY_MODES.includes(configured)) return configured;
  return client === "codex" ? "final" : "advisory";
}

// Advisory output is only developer context: the chat is free to ignore it, research the answer
// again and charge the user a second time for work Zodchi already paid for. Both harnesses accept
// the same blocking shape, which ends the turn and shows the reason to the user directly, so a
// prepared answer can be delivered without a chat turn at all. It stays a per-project choice,
// because blocking also removes the exchange from the chat's own history.
export function formatHookOutput(result = {}, { deliveryMode = "advisory" } = {}) {
  const prepared = typeof result.response === "string" && result.response.trim() ? result.response.trim() : null;
  if (normalizeDeliveryMode(deliveryMode) === "final" && prepared) return { decision: "block", reason: prepared };
  const context = prepared ?? (result.route === "conversation"
    ? "Continue the conversation naturally and directly."
    : "The workflow has finished. Explain the next step without exposing internal identifiers, roles, levels, prompts, or JSON.");
  const additionalContext = [
    `${HARNESS_INSTRUCTION} Reply naturally in ${result.response_language ?? "the user's current language"}.`,
    context,
    HARNESS_BOUNDARY
  ].join("\n\n");
  return { additionalContext, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}
