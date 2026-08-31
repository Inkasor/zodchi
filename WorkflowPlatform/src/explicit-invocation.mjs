import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { processMessage } from "./workflow-app.mjs";

const CLIENTS = new Set(["claude-code", "codex"]);
const MAX_MESSAGE_BYTES = 1024 * 1024;

function requiredDirectory(value, code) {
  if (!value) throw new Error(`${code}: value is required`);
  const resolved = path.resolve(String(value));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`${code}: ${resolved}`);
  return resolved;
}
function readMessageFile(file) {
  if (!file) throw new Error("EXPLICIT_MESSAGE_FILE_REQUIRED");
  const resolved = path.resolve(String(file));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`EXPLICIT_MESSAGE_FILE_MISSING: ${resolved}`);
  const size = fs.statSync(resolved).size;
  if (size > MAX_MESSAGE_BYTES) throw new Error(`EXPLICIT_MESSAGE_TOO_LARGE: ${size} > ${MAX_MESSAGE_BYTES}`);
  const bytes = fs.readFileSync(resolved);
  let message;
  try { message = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("EXPLICIT_MESSAGE_UTF8_INVALID"); }
  if (!message.trim()) throw new Error("EXPLICIT_MESSAGE_EMPTY");
  return { file: resolved, message, bytes };
}

export async function invokeExplicitTask(options, dependencies = {}) {
  const client = String(options.client ?? "");
  if (!CLIENTS.has(client)) throw new Error(`EXPLICIT_CLIENT_INVALID: ${client || "missing"}`);
  const origin = requiredDirectory(options.origin, "EXPLICIT_ORIGIN_INVALID");
  const source = readMessageFile(options.messageFile);
  const process = dependencies.processMessage ?? processMessage;
  try {
    const result = await process({
      message: source.message,
      origin,
      dbFile: options.dbFile,
      workflow: options.workflow ?? null,
      eventSource: `${client}-skill`,
      eventKey: options.eventKey ?? null,
      eventFields: ["explicit_skill", "message_file"],
      client,
      semanticScope: { mode: "stateless" },
      preferredLanguage: options.preferredLanguage ?? null,
      execute: true
    });
    return Object.freeze({
      schema_version: 1,
      invocation: "explicit",
      client,
      source_sha256: crypto.createHash("sha256").update(source.bytes).digest("hex"),
      source_bytes: source.bytes.length,
      run_id: result.run_id ?? null,
      route: result.route ?? null,
      response_language: result.response_language ?? null,
      response: result.response ?? null
    });
  } finally {
    if (options.deleteMessageFile) fs.rmSync(source.file, { force: true });
  }
}
