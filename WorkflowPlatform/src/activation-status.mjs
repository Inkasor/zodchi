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

export function activationStatus({ dbFile, client, sessionId }) {
  const normalizedClient = required(client, "ZODCHI_SESSION_CLIENT_REQUIRED");
  if (!CHAT_CLIENTS.includes(normalizedClient)) throw new Error(`ZODCHI_SESSION_CLIENT_INVALID: ${normalizedClient}`);
  const normalizedSession = String(sessionId ?? "").trim();
  if (!normalizedSession) return Object.freeze({ status: "inactive", reason: "session_id_missing" });

  let db;
  try {
    const file = path.resolve(required(dbFile, "DATABASE_PATH_REQUIRED"));
    if (!fs.existsSync(file)) return Object.freeze({ status: "unavailable", reason: "database_unavailable" });
    // This command runs inside the Codex tool sandbox. It must not create WAL files, apply
    // migrations, or otherwise require write access to installation data outside the project.
    const databaseUrl = pathToFileURL(file); databaseUrl.searchParams.set("immutable", "1");
    db = new DatabaseSync(databaseUrl, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
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
