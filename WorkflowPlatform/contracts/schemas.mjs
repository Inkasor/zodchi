import { TASK_STATES } from "../src/state-machine.mjs";

export const LEVELS = ["L0", "L1", "L2", "L3", "L4"];
export const QUALITY = ["prototype", "mvp", "production", "security"];
export const STATES = [...TASK_STATES];
export const CLASSIFICATION_KINDS = ["conversation", "continuation", "clarification", "task", "decision", "research", "implementation", "documentation", "review", "verification", "testing", "planning", "fix", "content", "marketing", "release", "deployment", "data_change", "incident", "access_management", "project_bootstrap", "security_review", "game_design", "narrative", "map_design", "technical_art", "art_direction", "audio", "asset", "prototype", "producer"];
export function assertFields(value, fields, name) { for (const field of fields) if (value?.[field] === undefined || value[field] === null || value[field] === "") throw new Error(`${name}: missing ${field}`); return value; }
// The work types a project accepts are registered, and a package may add its own. This list is what a
// caller without a registry falls back to, never the authority: a registered work type rejected here
// would leave the route that declares it unreachable while every catalog still offered it.
export function validateClassification(v, kinds = CLASSIFICATION_KINDS) { assertFields(v, ["kind", "domain", "discipline", "risk", "level", "quality"], "classification"); if (!kinds.includes(v.kind)) throw new Error("classification: invalid kind"); if (!LEVELS.includes(v.level)) throw new Error("classification: invalid level"); if (!QUALITY.includes(v.quality)) throw new Error("classification: invalid quality"); return v; }
export function validateGatewayReceipt(v) { assertFields(v, ["status", "receipt_id", "gateway_task_id"], "gateway receipt"); return v; }
export const DOCUMENT_OPERATIONS = ["create_document", "update_section", "append_decision", "append_evidence", "change_status", "supersede_document", "create_plan", "create_package_record"];
export function validateDocumentPatch(v) { assertFields(v, ["operation"], "document patch"); if (!DOCUMENT_OPERATIONS.includes(v.operation)) throw new Error(`document patch: unsupported operation ${v.operation}`); if (v.operation !== "change_status") assertFields(v, ["content"], "document patch"); if (v.operation === "update_section") assertFields(v, ["section_id"], "document patch"); if (v.operation === "change_status") assertFields(v, ["status"], "document patch"); return v; }
