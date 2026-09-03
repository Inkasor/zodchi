ALTER TABLE role_contracts ADD COLUMN allowed_mcp_servers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE role_contracts ADD COLUMN native_instruction_files_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE external_tool_registry (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport IN ('http','stdio')),
  endpoint TEXT NOT NULL,
  read_only_mode_json TEXT,
  arbitrary_execution INTEGER NOT NULL DEFAULT 0 CHECK(arbitrary_execution IN (0,1)),
  contains_model INTEGER NOT NULL DEFAULT 0 CHECK(contains_model IN (0,1)),
  self_liftable_boundary INTEGER NOT NULL DEFAULT 0 CHECK(self_liftable_boundary IN (0,1)),
  doubles_as_provider INTEGER NOT NULL DEFAULT 0 CHECK(doubles_as_provider IN (0,1)),
  pinned_version TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,name)
);

CREATE INDEX idx_external_tool_registry_active ON external_tool_registry(project_id,active,name);
