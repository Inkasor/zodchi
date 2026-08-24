import assert from "node:assert/strict";
import test from "node:test";
import { isClaudeCodeEvent, parseHookEvent, formatHookOutput } from "../src/hook-entry.mjs";

const claudeEvent = {
  session_id: "session-1",
  prompt_id: "550e8400-e29b-41d4-a716-446655440000",
  transcript_path: "C:\Users\person\.claude\projects\p\session-1.jsonl",
  cwd: "C:\projects\demo",
  permission_mode: "default",
  hook_event_name: "UserPromptSubmit",
  user_input: "Prepare the release notes",
  user_input_raw: "Prepare the release notes"
};
const codexEvent = { event_id: "codex-event-1", prompt: "Prepare the release notes", cwd: "C:\projects\demo" };

test("a Claude Code event is recognized and a Codex event is not", () => {
  assert.equal(isClaudeCodeEvent(claudeEvent), true);
  assert.equal(isClaudeCodeEvent(codexEvent), false);
  assert.equal(isClaudeCodeEvent({ hook_event_name: "UserPromptSubmit" }), false);
});

test("a Claude Code event maps user_input and prompt_id to the shared hook contract", () => {
  const entry = parseHookEvent(claudeEvent, { env: {}, argv: [], settings: {} });
  assert.equal(entry.client, "claude-code");
  assert.equal(entry.eventSource, "claude-code-hook");
  assert.equal(entry.message, "Prepare the release notes");
  assert.equal(entry.eventKey, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(entry.project, "C:\projects\demo");
});

test("a Codex event keeps its own identity and event key", () => {
  const entry = parseHookEvent(codexEvent, { env: {}, argv: [], settings: {} });
  assert.equal(entry.client, "codex");
  assert.equal(entry.eventSource, "codex-hook");
  assert.equal(entry.message, "Prepare the release notes");
  assert.equal(entry.eventKey, "codex-event-1");
});

test("a stale Codex environment variable never overrides a Claude Code event", () => {
  const env = { CODEX_USER_PROMPT: "stale prompt from another host", CODEX_EVENT_ID: "stale-event" };
  const claude = parseHookEvent(claudeEvent, { env, argv: [], settings: {} });
  assert.equal(claude.message, "Prepare the release notes");
  assert.equal(claude.eventKey, "550e8400-e29b-41d4-a716-446655440000");
  const codex = parseHookEvent(codexEvent, { env, argv: [], settings: {} });
  assert.equal(codex.message, "stale prompt from another host");
  assert.equal(codex.eventKey, "stale-event");
});

test("registered project settings win over the event working directory", () => {
  const entry = parseHookEvent(claudeEvent, { env: {}, argv: [], settings: { project: "registered-project", responseLanguage: "ru" } });
  assert.equal(entry.project, "registered-project");
  assert.equal(entry.preferredLanguage, "ru");
});

test("an event without a message resolves to null instead of an empty run", () => {
  assert.equal(parseHookEvent({}, { env: {}, argv: [], settings: {} }).message, null);
  assert.equal(parseHookEvent({ hook_event_name: "UserPromptSubmit", user_input: "" }, { env: {}, argv: [], settings: {} }).message, null);
});

test("hook output carries additionalContext at the top level for Claude Code and nested for Codex", () => {
  const output = formatHookOutput({ response: "The release notes are ready.", response_language: "ru", route: "product" });
  assert.equal(typeof output.additionalContext, "string");
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(output.hookSpecificOutput.additionalContext, output.additionalContext);
  assert.match(output.additionalContext, /The release notes are ready\./);
  assert.match(output.additionalContext, /Reply naturally in ru\./);
  assert.match(output.additionalContext, /Do not run commands/);
});

test("hook output falls back to a route-specific instruction when there is no prepared response", () => {
  assert.match(formatHookOutput({ route: "conversation" }).additionalContext, /Continue the conversation naturally/);
  assert.match(formatHookOutput({ route: "product" }).additionalContext, /The workflow has finished/);
  assert.match(formatHookOutput({}).additionalContext, /the user's current language/);
});
