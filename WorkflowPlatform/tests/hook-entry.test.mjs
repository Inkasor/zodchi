import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isClaudeCodeEvent, hookEventFields, parseHookEvent, formatHookOutput, normalizeDeliveryMode } from "../src/hook-entry.mjs";

const projectRoot = path.join(os.tmpdir(), "zodchi-hook-entry-project");

const claudeEvent = {
  session_id: "session-1",
  prompt_id: "550e8400-e29b-41d4-a716-446655440000",
  transcript_path: path.join(projectRoot, "transcript.jsonl"),
  cwd: projectRoot,
  permission_mode: "default",
  hook_event_name: "UserPromptSubmit",
  user_input: "Prepare the release notes",
  user_input_raw: "Prepare the release notes"
};
const codexEvent = { event_id: "codex-event-1", prompt: "Prepare the release notes", cwd: projectRoot };

// Shape observed from an installed Claude Code release: the prompt text arrives in `prompt`,
// while the documented `user_input` pair is absent.
const claudeEventWithPrompt = {
  session_id: "session-1",
  prompt_id: "550e8400-e29b-41d4-a716-446655440000",
  transcript_path: path.join(projectRoot, "transcript.jsonl"),
  cwd: projectRoot,
  permission_mode: "auto",
  hook_event_name: "UserPromptSubmit",
  prompt: "Prepare the release notes"
};

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
  assert.equal(entry.project, projectRoot);
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
  assert.match(output.additionalContext, /End of the prepared result\./);
  assert.equal(output.additionalContext.indexOf("The release notes are ready.") < output.additionalContext.indexOf("End of the prepared result."), true);
});

test("hook output falls back to a route-specific instruction when there is no prepared response", () => {
  assert.match(formatHookOutput({ route: "conversation" }).additionalContext, /Continue the conversation naturally/);
  assert.match(formatHookOutput({ route: "product" }).additionalContext, /The workflow has finished/);
  assert.match(formatHookOutput({}).additionalContext, /the user's current language/);
});

test("a Claude Code event that carries the prompt in `prompt` is still recognized", () => {
  assert.equal(isClaudeCodeEvent(claudeEventWithPrompt), true);
  const entry = parseHookEvent(claudeEventWithPrompt, { env: {}, argv: [], settings: {} });
  assert.equal(entry.client, "claude-code");
  assert.equal(entry.eventSource, "claude-code-hook");
  assert.equal(entry.message, "Prepare the release notes");
  assert.equal(entry.eventKey, "550e8400-e29b-41d4-a716-446655440000");
});

test("a Codex event is never mistaken for Claude Code", () => {
  assert.equal(isClaudeCodeEvent(codexEvent), false);
  assert.equal(isClaudeCodeEvent({ event_id: "e", prompt: "p", session_id: "" }), false);
  assert.equal(isClaudeCodeEvent({ prompt_id: "" }), false);
});

// Documented Codex UserPromptSubmit payload. It carries the session id, transcript path,
// permission mode and prompt that Claude Code also sends, so only turn_id and model separate them.
const codexSessionEvent = {
  session_id: "01a03543-a6c7-7e83-8d39-340edc4107c0",
  transcript_path: path.join(projectRoot, "codex-transcript.jsonl"),
  cwd: projectRoot,
  hook_event_name: "UserPromptSubmit",
  model: "gpt-5.6-luna",
  turn_id: "01a0353a-69b6-7a71-a7fb-4b39a0abbce5",
  prompt: "Prepare the release notes",
  permission_mode: "read-only"
};

test("a Codex event is recorded as Codex even though it shares Claude Code's session and transcript fields", () => {
  assert.equal(isClaudeCodeEvent(codexSessionEvent), false);
  const entry = parseHookEvent(codexSessionEvent, { env: {}, argv: [], settings: {} });
  assert.equal(entry.client, "codex");
  assert.equal(entry.eventSource, "codex-hook");
  assert.equal(entry.message, "Prepare the release notes");
  assert.equal(entry.eventKey, "01a0353a-69b6-7a71-a7fb-4b39a0abbce5");
});

test("a Claude Code event stays Claude Code and never claims a Codex turn", () => {
  assert.equal(isClaudeCodeEvent(claudeEventWithPrompt), true);
  assert.equal(isClaudeCodeEvent({ ...claudeEventWithPrompt, model: "gpt-5.6-luna" }), false);
});

test("the hook records the event field names so the sending harness stays identifiable", () => {
  assert.deepEqual(hookEventFields(codexSessionEvent), ["cwd", "hook_event_name", "model", "permission_mode", "prompt", "session_id", "transcript_path", "turn_id"]);
  assert.deepEqual(parseHookEvent(claudeEventWithPrompt, { env: {}, argv: [], settings: {} }).eventFields,
    ["cwd", "hook_event_name", "permission_mode", "prompt", "prompt_id", "session_id", "transcript_path"]);
  assert.deepEqual(hookEventFields({}), []);
});

test("final delivery mode ends the turn and hands the prepared answer straight to the user", () => {
  const output = formatHookOutput({ response: "Какие старые документы проверить первыми?", route: "clarification" }, { deliveryMode: "final" });
  assert.equal(output.decision, "block");
  assert.equal(output.reason, "Какие старые документы проверить первыми?");
  assert.equal(output.additionalContext, undefined);
  assert.equal(output.hookSpecificOutput, undefined);
});

test("final delivery mode falls back to advisory when Zodchi prepared no answer", () => {
  const output = formatHookOutput({ route: "product" }, { deliveryMode: "final" });
  assert.equal(output.decision, undefined);
  assert.match(output.additionalContext, /The workflow has finished/);
});

test("delivery mode defaults to advisory and rejects unknown values", () => {
  assert.equal(normalizeDeliveryMode(undefined), "advisory");
  assert.equal(normalizeDeliveryMode("block"), "advisory");
  assert.equal(normalizeDeliveryMode("final"), "final");
  assert.equal(formatHookOutput({ response: "ready" }).decision, undefined);
  assert.equal(formatHookOutput({ response: "ready" }, { deliveryMode: "nonsense" }).decision, undefined);
});

test("the hook command carries the delivery mode, and flags never leak into the message", () => {
  const argv = ["--delivery-mode=final"];
  assert.equal(parseHookEvent(claudeEventWithPrompt, { env: {}, argv, settings: {} }).deliveryMode, "final");
  assert.equal(parseHookEvent(claudeEventWithPrompt, { env: {}, argv: [], settings: { deliveryMode: "final" } }).deliveryMode, "final");
  assert.equal(parseHookEvent(claudeEventWithPrompt, { env: {}, argv: [], settings: {} }).deliveryMode, "advisory");
  assert.equal(parseHookEvent(claudeEventWithPrompt, { env: {}, argv: ["--delivery-mode=shout"], settings: {} }).deliveryMode, "advisory");
  assert.equal(parseHookEvent({}, { env: {}, argv: ["--delivery-mode=final"], settings: {} }).message, null);
  assert.equal(parseHookEvent({}, { env: {}, argv: ["--delivery-mode=final", "spoken", "words"], settings: {} }).message, "spoken words");
});
