import path from "node:path";
import { inside } from "./project-roots.mjs";
import { now } from "./db.mjs";

export const ZODCHI_COMMAND = "/zodchi";
export const CHAT_CLIENTS = Object.freeze(["codex", "claude-code"]);

function required(value, code) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(code);
  return text;
}

export function parseZodchiCommand(prompt) {
  const text = String(prompt ?? "");
  const match = /^\s*\/zodchi(?:\s+([\s\S]*?))?\s*$/u.exec(text);
  if (!match) return null;
  return Object.freeze({ command: ZODCHI_COMMAND, message: match[1]?.trim() || null });
}

export function registeredProjectAt(db, origin) {
  const resolved = path.resolve(required(origin, "ZODCHI_SESSION_ORIGIN_REQUIRED"));
  const projects = db.prepare("SELECT id,root_path FROM projects").all()
    .filter(project => inside(project.root_path, resolved))
    .sort((left, right) => path.resolve(right.root_path).length - path.resolve(left.root_path).length);
  return projects[0] ?? null;
}

export function chatSession(db, { client, sessionId }) {
  return db.prepare("SELECT * FROM zodchi_chat_sessions WHERE client=? AND session_id=?").get(
    required(client, "ZODCHI_SESSION_CLIENT_REQUIRED"),
    required(sessionId, "ZODCHI_SESSION_ID_REQUIRED")
  ) ?? null;
}

export function activateChatSession(db, { client, sessionId, origin, message = null }) {
  const normalizedClient = required(client, "ZODCHI_SESSION_CLIENT_REQUIRED");
  if (!CHAT_CLIENTS.includes(normalizedClient)) throw new Error(`ZODCHI_SESSION_CLIENT_INVALID: ${normalizedClient}`);
  const normalizedSession = required(sessionId, "ZODCHI_SESSION_ID_REQUIRED");
  const project = registeredProjectAt(db, origin);
  if (!project) throw new Error(`ZODCHI_SESSION_PROJECT_NOT_REGISTERED: ${path.resolve(origin)}`);
  const timestamp = now();
  const existing = chatSession(db, { client: normalizedClient, sessionId: normalizedSession });
  if (existing && existing.project_id !== project.id) {
    throw new Error(`ZODCHI_SESSION_PROJECT_MISMATCH: ${existing.project_id} != ${project.id}`);
  }
  db.prepare(`INSERT INTO zodchi_chat_sessions(client,session_id,project_id,origin,state,pending_message,pending_profile_json,entered_at,last_seen_at,ended_at)
    VALUES(?,?,?,?, 'active',?,NULL,?,?,NULL)
    ON CONFLICT(client,session_id) DO UPDATE SET
      origin=excluded.origin,state='active',pending_message=excluded.pending_message,pending_profile_json=NULL,last_seen_at=excluded.last_seen_at,ended_at=NULL`)
    .run(normalizedClient, normalizedSession, project.id, path.resolve(origin), message ? String(message) : null, existing?.entered_at ?? timestamp, timestamp);
  return chatSession(db, { client: normalizedClient, sessionId: normalizedSession });
}

export function touchChatSession(db, { client, sessionId, origin }) {
  const session = chatSession(db, { client, sessionId });
  if (!session || session.state !== "active") return null;
  const project = registeredProjectAt(db, origin);
  if (!project || project.id !== session.project_id) throw new Error(`ZODCHI_SESSION_PROJECT_MISMATCH: ${session.project_id} != ${project?.id ?? "unregistered"}`);
  db.prepare("UPDATE zodchi_chat_sessions SET origin=?,last_seen_at=? WHERE client=? AND session_id=?")
    .run(path.resolve(origin), now(), client, sessionId);
  return chatSession(db, { client, sessionId });
}

export function consumePendingMessage(db, { client, sessionId }) {
  const session = chatSession(db, { client, sessionId });
  if (!session?.pending_message) return null;
  db.prepare("UPDATE zodchi_chat_sessions SET pending_message=NULL,pending_profile_json=NULL,last_seen_at=? WHERE client=? AND session_id=?")
    .run(now(), client, sessionId);
  return { message: session.pending_message, profile: session.pending_profile_json ? JSON.parse(session.pending_profile_json) : null };
}

export function setPendingMessage(db, { client, sessionId, message, profile = null }) {
  const session = chatSession(db, { client, sessionId });
  if (!session || session.state !== "active") throw new Error("ZODCHI_SESSION_NOT_ACTIVE");
  db.prepare("UPDATE zodchi_chat_sessions SET pending_message=?,pending_profile_json=?,last_seen_at=? WHERE client=? AND session_id=?")
    .run(required(message, "ZODCHI_PENDING_MESSAGE_REQUIRED"), profile ? JSON.stringify(profile) : null, now(), client, sessionId);
  return chatSession(db, { client, sessionId });
}

export function endChatSession(db, { client, sessionId }) {
  const timestamp = now();
  const result = db.prepare("UPDATE zodchi_chat_sessions SET state='ended',pending_message=NULL,pending_profile_json=NULL,last_seen_at=?,ended_at=? WHERE client=? AND session_id=? AND state='active'")
    .run(timestamp, timestamp, required(client, "ZODCHI_SESSION_CLIENT_REQUIRED"), required(sessionId, "ZODCHI_SESSION_ID_REQUIRED"));
  return result.changes === 1;
}

export function routeChatPrompt(db, { client, sessionId, origin, prompt }) {
  const command = parseZodchiCommand(prompt);
  if (command) {
    const session = activateChatSession(db, { client, sessionId, origin, message: command.message });
    return Object.freeze({ action: command.message ? "route" : "activated", session, message: command.message });
  }
  const session = touchChatSession(db, { client, sessionId, origin });
  if (!session) return Object.freeze({ action: "pass", session: null, message: null });
  return Object.freeze({ action: "route", session, message: String(prompt ?? "") });
}
