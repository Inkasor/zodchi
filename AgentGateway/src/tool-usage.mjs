const STREAM_PROVIDERS = new Set(["codex", "kimi", "opencode", "cursor"]);

export function canonicalTool(nativeName) {
  const name = String(nativeName ?? "").replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
  if (!name) return null;
  if (/(?:applypatch|filechange|write|edit|multiedit|notebookedit|deletefile|createfile|movefile|renamefile)/.test(name)) return "apply_patch";
  if (/(?:execcommand|commandexecution|runterminal|terminalcommand|shell|bash)/.test(name)) return "exec_command";
  return null;
}

function addCall(calls, nativeName, callId, ordinal) {
  const name = String(nativeName ?? "").trim().slice(0, 120);
  if (!name) return;
  const key = callId ? `id:${String(callId).slice(0, 160)}` : `ordinal:${ordinal}:${name}`;
  if (!calls.has(key)) calls.set(key, { native_name: name, canonical_tool: canonicalTool(name) });
}

function cursorToolName(toolCall) {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return null;
  return Object.keys(toolCall).find(key => /ToolCall$/i.test(key)) ?? null;
}

function collectEvent(value, calls, ordinal) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (Array.isArray(value.tool_calls)) for (const call of value.tool_calls) addCall(calls, call?.function?.name ?? call?.name, call?.id, ordinal);
  if (value.type === "tool_call") addCall(calls, cursorToolName(value.tool_call) ?? value.name, value.call_id ?? value.callId, ordinal);
  if (["item.started", "item.completed"].includes(value.type) && value.item) {
    addCall(calls, value.item.type === "mcp_tool_call" ? `mcp:${value.item.server ?? "unknown"}:${value.item.tool ?? value.item.name ?? "unknown"}` : value.item.type, value.item.id, ordinal);
  }
  if (["tool_use", "tool"].includes(value.type) || ["tool_use", "tool"].includes(value.part?.type)) {
    addCall(calls, value.part?.tool ?? value.part?.name ?? value.tool ?? value.name, value.part?.callID ?? value.part?.call_id ?? value.callID ?? value.call_id ?? value.id, ordinal);
  }
}

export function observeToolUsage(provider, stdout, providerConfig = {}) {
  const configuredStream = provider !== "cursor" || (providerConfig.args ?? []).includes("stream-json");
  const observable = STREAM_PROVIDERS.has(provider) && configuredStream;
  if (!observable) return Object.freeze({
    status: "unavailable", enforcement: "unknown",
    // Claude uses one final JSON result in the shipped contour. Its allowedTools/disallowedTools boundary
    // is technical, but that transport does not expose a post-factum event stream to this observer.
    source: provider === "claude" ? "claude:single-json-tool-events-not-exposed" : `${provider}:tool-events-not-exposed`,
    native_tools: [], canonical_tools: [], unknown_native_tools: []
  });
  const calls = new Map();
  let parseErrors = 0, ordinal = 0, parsedEvents = 0;
  for (const line of String(stdout ?? "").split(/\r?\n/).filter(line => line.trim())) {
    ordinal += 1;
    try { collectEvent(JSON.parse(line), calls, ordinal); parsedEvents += 1; }
    catch { parseErrors += 1; }
  }
  const counts = new Map();
  for (const call of calls.values()) {
    const key = `${call.native_name}\u0000${call.canonical_tool ?? ""}`;
    const current = counts.get(key) ?? { ...call, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  const nativeTools = [...counts.values()].sort((left, right) => left.native_name.localeCompare(right.native_name));
  return Object.freeze({
    status: parseErrors ? "partial" : "complete",
    enforcement: "technical",
    source: `${provider}:structured-tool-events`,
    parsed_events: parsedEvents,
    parse_errors: parseErrors,
    native_tools: nativeTools,
    canonical_tools: [...new Set(nativeTools.map(item => item.canonical_tool).filter(Boolean))].sort(),
    unknown_native_tools: nativeTools.filter(item => !item.canonical_tool).map(item => item.native_name)
  });
}
