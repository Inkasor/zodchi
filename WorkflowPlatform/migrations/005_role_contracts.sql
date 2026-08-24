CREATE TABLE role_contracts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  version TEXT NOT NULL,
  purpose TEXT NOT NULL,
  boundaries_json TEXT NOT NULL,
  allowed_work_types_json TEXT NOT NULL,
  allowed_artifact_types_json TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  allowed_skills_json TEXT NOT NULL,
  required_checks_json TEXT NOT NULL,
  allowed_transitions_json TEXT NOT NULL,
  allowed_profiles_json TEXT NOT NULL,
  context_limit_bytes INTEGER NOT NULL CHECK (context_limit_bytes >= 1024),
  max_calls INTEGER NOT NULL CHECK (max_calls > 0),
  max_correction_cycles INTEGER NOT NULL CHECK (max_correction_cycles >= 0),
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds > 0),
  result_schema_key TEXT NOT NULL,
  prompt_template_version TEXT NOT NULL,
  escalation_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','disabled')),
  UNIQUE(project_id,role_id,version)
);
CREATE UNIQUE INDEX idx_role_contract_active ON role_contracts(project_id,role_id) WHERE status='active';

CREATE TABLE role_profile_assignments (
  project_id TEXT NOT NULL REFERENCES projects(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  operational_level TEXT NOT NULL CHECK (operational_level IN ('prototype','mvp','production','security-audit')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  PRIMARY KEY(project_id,role_id,operational_level)
);

ALTER TABLE plans ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plans ADD COLUMN outcome TEXT;
ALTER TABLE plans ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE plans ADD COLUMN allowed_paths_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plans ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plans ADD COLUMN checks_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plans ADD COLUMN risks_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plans ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plans ADD COLUMN completion_criteria_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE plans ADD COLUMN questions_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE workflow_steps ADD COLUMN contract_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_steps ADD COLUMN result_json TEXT;
ALTER TABLE workflow_steps ADD COLUMN result_schema_key TEXT;

ALTER TABLE gateway_calls ADD COLUMN contract_hash TEXT;
ALTER TABLE gateway_calls ADD COLUMN result_hash TEXT;
ALTER TABLE gateway_calls ADD COLUMN artifact_ref TEXT;
ALTER TABLE gateway_calls ADD COLUMN decision_ref TEXT;

ALTER TABLE project_documents ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_documents ADD COLUMN content_hash TEXT;
ALTER TABLE project_documents ADD COLUMN updated_at TEXT;

ALTER TABLE document_operations ADD COLUMN document_id TEXT REFERENCES project_documents(id);
ALTER TABLE document_operations ADD COLUMN expected_version TEXT;
ALTER TABLE document_operations ADD COLUMN rollback_status TEXT;

ALTER TABLE check_definitions ADD COLUMN kind TEXT NOT NULL DEFAULT 'command';
ALTER TABLE check_definitions ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE check_definitions ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 900 CHECK (timeout_seconds > 0);
ALTER TABLE project_checks ADD COLUMN artifact_type_id TEXT;
