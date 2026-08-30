import { CHAT_CLIENTS, chatSession } from "./chat-session.mjs";
import { openDb } from "./db.mjs";

function required(value, code) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(code);
  return text;
}

export function activationStatus({ dbFile, client, sessionId }) {
  const normalizedClient = required(client, "ZODCHI_SESSION_CLIENT_REQUIRED");
  if (!CHAT_CLIENTS.includes(normalizedClient)) throw new Error(`ZODCHI_SESSION_CLIENT_INVALID: ${normalizedClient}`);
  const normalizedSession = String(sessionId ?? "").trim();
  if (!normalizedSession) return Object.freeze({ status: "inactive", reason: "session_id_missing" });

  let db;
  try {
    db = openDb(required(dbFile, "DATABASE_PATH_REQUIRED"));
    const session = chatSession(db, { client: normalizedClient, sessionId: normalizedSession });
    return session?.state === "active"
      ? Object.freeze({ status: "active" })
      : Object.freeze({ status: "inactive", reason: session ? "session_not_active" : "session_not_found" });
  } catch {
    return Object.freeze({ status: "unavailable", reason: "database_unavailable" });
  } finally {
    db?.close();
  }
}

