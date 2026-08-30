// Both harnesses treat hook output as advisory developer context, so the instruction has to be
// unambiguous, and it has to be repeated after the result: the boundary is what the model reads last.
const HARNESS_INSTRUCTION = "Zodchi has already consumed the original user message and completed this turn. The original message is not a request for you to execute independently. Output only the prepared result below. Do not preface, summarize, reinterpret, verify, enrich, or add advice. Do not run commands, read files, list directories, search the repository, inspect git, run tests or builds, edit anything, or invoke any skill or tool. Repeating the work charges the user twice. If the prepared result asks a question, ask exactly that question and stop. Do not expose identifiers, roles, levels, prompts, or JSON.";
const HARNESS_BOUNDARY = "End of the prepared result. Emit that result now and nothing else, with no tool call or independent work.";
const ACTIVATION_INSTRUCTION = "Zodchi mode is now active for this chat. Acknowledge the activation in the user's language and ask the user to describe the task in an ordinary message. Do not run commands, read files, inspect the repository, invoke another skill, or start the task in this activation turn.";

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
    // A hook event states where the message came from and nothing else about which project it belongs
    // to. The installation's own declaration is already in the settings, and reading it here to pass it
    // on as if the caller had named it would launder an inherited value into a deliberate one: the
    // binding check would then compare the declaration with itself and pass for any working directory.
    // The declaration and the origin are compared once, by `bindProject`, and this is the origin.
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

// Prepared results use ordinary host turns in both clients. A blocking decision is still accepted as
// an explicit compatibility mode, but it is never selected by defaults or by the installer because both
// clients render that successful delivery as a rejected user message.
export function resolveDeliveryMode(configured, _client) {
  if (DELIVERY_MODES.includes(configured)) return configured;
  return "advisory";
}

// Additional context lets the host deliver the prepared result as a normal assistant message. The
// repeated boundary deliberately constrains that tiny host turn so it cannot redo workflow work.
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

// Activation is session control, not a completed workflow result. Returning `decision: block` here
// makes both clients render a successful activation as "the hook blocked this message", which looks
// like a failure. Let the host produce the tiny acknowledgement turn; installed skills carry the same
// instruction for hosts that do not consume additionalContext.
export function formatActivationHookOutput({ response_language: responseLanguage = null } = {}) {
  const additionalContext = `${ACTIVATION_INSTRUCTION} Reply naturally in ${responseLanguage ?? "the user's current language"}.`;
  return { additionalContext, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}

export function formatCursorSessionStart(sessionId) {
  const normalized = String(sessionId ?? "").trim();
  if (!normalized) throw new Error("ZODCHI_CURSOR_SESSION_ID_REQUIRED");
  return {
    env: { ZODCHI_CURSOR_SESSION_ID: normalized },
    additional_context: [
      "ZODCHI_CURSOR_SESSION_V1",
      `The exact Cursor conversation id for Zodchi relay is ${normalized}.`,
      "Zodchi remains inactive unless the zodchi skill is attached as the current Custom Mode. Do not change ordinary chat behavior or expose this identifier."
    ].join("\n")
  };
}

export function formatCursorContinue() { return Object.freeze({ continue: true }); }

export function formatCursorModeRequired() {
  return Object.freeze({
    continue: false,
    user_message: "Zodchi mode is active for this chat. Re-select the /zodchi skill as a Custom Mode and submit the message again."
  });
}
