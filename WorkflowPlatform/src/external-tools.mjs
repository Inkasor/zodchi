import { now } from "./db.mjs";

const TRANSPORTS = new Set(["http", "stdio"]);
export function registerExternalTool(db, { projectId, name, transport, endpoint, readOnlyMode = null, arbitraryExecution = false, containsModel = false, selfLiftableBoundary = false, doublesAsProvider = false, pinnedVersion }) {
  if (!projectId || !name || !endpoint || !pinnedVersion || !TRANSPORTS.has(transport)) throw new Error("EXTERNAL_TOOL_REGISTRATION_INVALID");
  if (readOnlyMode !== null && (!readOnlyMode || typeof readOnlyMode !== "object" || Array.isArray(readOnlyMode))) throw new Error("EXTERNAL_TOOL_READ_ONLY_MODE_INVALID");
  const timestamp = now();
  db.prepare(`INSERT INTO external_tool_registry(project_id,name,transport,endpoint,read_only_mode_json,arbitrary_execution,contains_model,self_liftable_boundary,doubles_as_provider,pinned_version,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(project_id,name) DO UPDATE SET transport=excluded.transport,endpoint=excluded.endpoint,read_only_mode_json=excluded.read_only_mode_json,arbitrary_execution=excluded.arbitrary_execution,contains_model=excluded.contains_model,self_liftable_boundary=excluded.self_liftable_boundary,doubles_as_provider=excluded.doubles_as_provider,pinned_version=excluded.pinned_version,active=1,updated_at=excluded.updated_at`)
    .run(projectId, name, transport, endpoint, readOnlyMode === null ? null : JSON.stringify(readOnlyMode), Number(arbitraryExecution), Number(containsModel), Number(selfLiftableBoundary), Number(doublesAsProvider), pinnedVersion, timestamp, timestamp);
  return externalTools(db, projectId).find(item => item.name === name);
}

export function externalTools(db, projectId) {
  return db.prepare("SELECT project_id,name,transport,endpoint,read_only_mode_json,arbitrary_execution,contains_model,self_liftable_boundary,doubles_as_provider,pinned_version,active,created_at,updated_at FROM external_tool_registry WHERE project_id=? ORDER BY name").all(projectId).map(row => ({ ...row, read_only_mode: row.read_only_mode_json ? JSON.parse(row.read_only_mode_json) : null, read_only_mode_json: undefined, arbitrary_execution: Boolean(row.arbitrary_execution), contains_model: Boolean(row.contains_model), self_liftable_boundary: Boolean(row.self_liftable_boundary), doubles_as_provider: Boolean(row.doubles_as_provider), active: Boolean(row.active) }));
}
