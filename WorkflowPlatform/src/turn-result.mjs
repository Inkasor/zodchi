import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { CHAT_CLIENTS, chatSession } from "./chat-session.mjs";

function required(value, code) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(code);
  return text;
}

export function turnResult({ dbFile, client, sessionId }) {
  const normalizedClient = required(client, "ZODCHI_SESSION_CLIENT_REQUIRED");
  if (!CHAT_CLIENTS.includes(normalizedClient)) throw new Error(`ZODCHI_SESSION_CLIENT_INVALID: ${normalizedClient}`);
  const normalizedSession = String(sessionId ?? "").trim();
  if (!normalizedSession) return Object.freeze({ status: "inactive", reason: "session_id_missing" });
  let db;
  try {
    const file = path.resolve(required(dbFile, "DATABASE_PATH_REQUIRED"));
    if (!fs.existsSync(file)) return Object.freeze({ status: "unavailable", reason: "database_unavailable" });
    const databaseUrl = pathToFileURL(file); databaseUrl.searchParams.set("immutable", "1");
    db = new DatabaseSync(databaseUrl, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    const session = chatSession(db, { client: normalizedClient, sessionId: normalizedSession });
    if (!session || session.state !== "active") return Object.freeze({ status: "inactive", reason: session ? "session_not_active" : "session_not_found" });
    if (!session.last_run_id) return Object.freeze({ status: "active", reason: "result_not_ready" });
    if (!session.last_result_at) return Object.freeze({ status: "active", reason: "result_not_ready" });
    const message = db.prepare("SELECT content,language FROM conversation_messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 1").get(session.last_run_id);
    if (!message?.content) return Object.freeze({ status: "unavailable", reason: "result_missing" });
    return Object.freeze({ status: "ready", response: message.content, response_language: message.language ?? null });
  } catch {
    return Object.freeze({ status: "unavailable", reason: "verification_failed" });
  } finally {
    db?.close();
  }
}
