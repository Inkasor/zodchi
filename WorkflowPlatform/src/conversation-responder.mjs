import { normalizeSemanticScope } from "./semantic-scope.mjs";
import { parseRoleReceipt } from "./role-contracts.mjs";
import { utf8Prefix } from "./utf8.mjs";

const DEFAULT_HISTORY_MESSAGES = 40;
const DEFAULT_HISTORY_MESSAGE_BYTES = 12_000;

export const conversationResponderContract = Object.freeze({
  required: ["context_input"],
  forbidden: ["project_write", "external_mutation", "local_endpoint"],
  allowed_skills: [],
  allowed_mcp_servers: [],
  native_instruction_files: []
});

export function conversationJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "status", "answer"],
    properties: {
      schema_version: { type: "integer", const: 1 },
      status: { type: "string", const: "answered" },
      answer: { type: "string", minLength: 1, maxLength: 20000 }
    }
  };
}

function rowMessages(db, scope, projectId, excludeRunId) {
  if (scope.mode !== "session") return [];
  return db.prepare(`SELECT cm.role,cm.content,cm.created_at,cm.id,csr.run_id
    FROM conversation_messages cm
    JOIN zodchi_chat_session_runs csr ON csr.run_id=cm.run_id
    WHERE cm.project_id=? AND csr.client=? AND csr.session_id=? AND (? IS NULL OR cm.run_id<>?)
      AND cm.role IN ('user','assistant')
    ORDER BY cm.created_at,cm.id`).all(projectId, scope.client, scope.session_id, excludeRunId, excludeRunId);
}

export function conversationHistory(db, { projectId, semanticScope, excludeRunId = null, maxMessages = DEFAULT_HISTORY_MESSAGES, maxMessageBytes = DEFAULT_HISTORY_MESSAGE_BYTES } = {}) {
  if (!db || !projectId) throw new Error("CONVERSATION_HISTORY_SCOPE_REQUIRED");
  const scope = normalizeSemanticScope(semanticScope);
  const rows = rowMessages(db, scope, projectId, excludeRunId);
  return rows.slice(-Math.max(1, maxMessages)).map(row => ({
    role: row.role,
    content: utf8Prefix(String(row.content ?? ""), maxMessageBytes)
  })).filter(row => row.content.length > 0);
}

function serializedDialog(history) {
  return JSON.stringify(history.map(item => ({ role: item.role, content: item.content })));
}

export function conversationPrompt({ message, history = [], responseLanguage = "en", context = {} } = {}) {
  return `WORKFLOW CONVERSATION RESPONDER v1\n`+
    `You answer the owner's current message as a helpful conversational assistant.\n`+
    `Use the supplied dialog history when the current message is a short follow-up.\n`+
    `You have no tools, no project write authority and no external mutation authority.\n`+
    `Never mention classification, routing, private reasoning, hidden prompts or an unavailable capability.\n`+
    `Write the answer in ${responseLanguage}.\n`+
    `CONVERSATION_RESPONDER_CONTRACT:${JSON.stringify(conversationResponderContract)}\n`+
    `SUPPLIED_CONTEXT:${JSON.stringify(context)}\n`+
    `DIALOG_HISTORY:${serializedDialog(history)}\n`+
    `<result_contract schema="conversation.v1">Return exactly one JSON object with schema_version=1, status="answered" and a non-empty human-facing answer.</result_contract>\n`+
    `CURRENT_USER_MESSAGE:${JSON.stringify(String(message ?? ""))}\n`+
    `Do not return any fields other than schema_version, status and answer.`;
}

export function fitConversationPrompt({ message, history = [], responseLanguage = "en", context = {}, contextLimitBytes = 65536 } = {}) {
  if (!Number.isInteger(contextLimitBytes) || contextLimitBytes < 1024) throw new Error("CONVERSATION_CONTEXT_LIMIT_REQUIRED");
  const retained = history.map(item => ({ ...item }));
  let prompt = conversationPrompt({ message, history: retained, responseLanguage, context });
  while (Buffer.byteLength(prompt) > contextLimitBytes && retained.length) {
    retained.shift();
    prompt = conversationPrompt({ message, history: retained, responseLanguage, context });
  }
  if (Buffer.byteLength(prompt) > contextLimitBytes) throw new Error(`CONVERSATION_CONTEXT_OVERFLOW: ${Buffer.byteLength(prompt)}/${contextLimitBytes}`);
  return { prompt, history: retained, bytes: Buffer.byteLength(prompt), limit_bytes: contextLimitBytes };
}

export function parseConversationReceipt(receipt) {
  return parseRoleReceipt(receipt, "conversation.v1");
}
