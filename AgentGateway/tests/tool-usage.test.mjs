import assert from "node:assert/strict";
import test from "node:test";
import { observeToolUsage } from "../src/tool-usage.mjs";

test("structured provider events expose canonical mutating tools without persisting arguments", () => {
  const kimi = observeToolUsage("kimi", [
    JSON.stringify({ role: "assistant", tool_calls: [{ id: "read-1", function: { name: "Read", arguments: "secret" } }] }),
    JSON.stringify({ role: "assistant", tool_calls: [{ id: "write-1", function: { name: "Write", arguments: "secret" } }] })
  ].join("\n"));
  assert.equal(kimi.status, "complete");
  assert.deepEqual(kimi.canonical_tools, ["apply_patch"]);
  assert.deepEqual(kimi.unknown_native_tools, ["Read"]);
  assert.equal(JSON.stringify(kimi).includes("secret"), false);

  const cursor = observeToolUsage("cursor", [
    JSON.stringify({ type: "tool_call", subtype: "started", call_id: "call-1", tool_call: { writeToolCall: { args: { fileText: "secret" } } } }),
    JSON.stringify({ type: "tool_call", subtype: "completed", call_id: "call-1", tool_call: { writeToolCall: { result: { success: true } } } })
  ].join("\n"), { args: ["--output-format", "stream-json"] });
  assert.deepEqual(cursor.native_tools, [{ native_name: "writeToolCall", canonical_tool: "apply_patch", count: 1 }]);
});

test("a transport without structured tool events remains unavailable instead of passing empty", () => {
  const cursorJson = observeToolUsage("cursor", JSON.stringify({ type: "result", result: "done" }), { args: ["--output-format", "json"] });
  assert.equal(cursorJson.status, "unavailable");
  const claude = observeToolUsage("claude", JSON.stringify({ type: "result", result: "done" }), { args: ["--output-format", "json"] });
  assert.equal(claude.status, "unavailable");
});
