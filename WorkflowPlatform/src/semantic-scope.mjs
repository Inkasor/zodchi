export function normalizeSemanticScope(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("ZODCHI_SEMANTIC_SCOPE_REQUIRED");
  const keys = Object.keys(value).sort();
  if (value.mode === "stateless" && JSON.stringify(keys) === JSON.stringify(["mode"])) return Object.freeze({ mode: "stateless" });
  if (value.mode === "session" && JSON.stringify(keys) === JSON.stringify(["client", "mode", "session_id"])) {
    const client = String(value.client ?? "").trim(), sessionId = String(value.session_id ?? "").trim();
    if (client && sessionId) return Object.freeze({ mode: "session", client, session_id: sessionId });
  }
  throw new Error("ZODCHI_SEMANTIC_SCOPE_INVALID");
}
