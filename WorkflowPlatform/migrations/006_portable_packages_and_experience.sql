CREATE TABLE workflow_package_releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  version TEXT NOT NULL,
  purpose TEXT NOT NULL,
  prompt_builder_version TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  parent_version TEXT,
  change_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active','superseded','proposed')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,package_key,version)
);
CREATE UNIQUE INDEX idx_package_release_active ON workflow_package_releases(project_id,package_key) WHERE status='active';

CREATE TABLE portable_profile_requirements (
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  profile_key TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id),
  provider_family TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  operational_levels_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(project_id,package_key,profile_key)
);

CREATE TABLE workflow_step_templates (
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  step_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  role_id TEXT REFERENCES roles(id),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  irreversible INTEGER NOT NULL DEFAULT 0 CHECK (irreversible IN (0,1)),
  input_schema_key TEXT NOT NULL,
  output_schema_key TEXT NOT NULL,
  artifact_types_json TEXT NOT NULL DEFAULT '[]',
  check_keys_json TEXT NOT NULL DEFAULT '[]',
  correction_json TEXT NOT NULL DEFAULT '{}',
  escalation_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(project_id,workflow_id,step_key),
  UNIQUE(project_id,workflow_id,ordinal)
);

CREATE TABLE workflow_transition_templates (
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  from_step_key TEXT NOT NULL,
  to_step_key TEXT NOT NULL,
  condition_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(project_id,workflow_id,from_step_key,to_step_key)
);

CREATE TABLE workflow_questions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  question_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer_schema_json TEXT NOT NULL DEFAULT '{}',
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  PRIMARY KEY(project_id,workflow_id,question_key)
);

CREATE TABLE operational_level_policies (
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('prototype','mvp','production','security-audit')),
  budgets_json TEXT NOT NULL DEFAULT '{}',
  required_checks_json TEXT NOT NULL DEFAULT '[]',
  correction_limit INTEGER NOT NULL DEFAULT 0 CHECK (correction_limit >= 0),
  escalation_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(project_id,package_key,level)
);

CREATE TABLE prompt_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  template_key TEXT NOT NULL,
  version TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id),
  result_schema_key TEXT NOT NULL,
  template_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','superseded')),
  UNIQUE(project_id,package_key,template_key,version)
);
CREATE UNIQUE INDEX idx_prompt_template_active ON prompt_templates(project_id,package_key,template_key) WHERE status='active';

CREATE TABLE package_test_scenarios (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  package_version TEXT NOT NULL,
  scenario_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  anonymized INTEGER NOT NULL DEFAULT 1 CHECK (anonymized IN (0,1)),
  UNIQUE(project_id,package_key,package_version,scenario_key)
);

CREATE TABLE workflow_import_proposals (
  id TEXT PRIMARY KEY,
  target_project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  package_version TEXT NOT NULL,
  package_hash TEXT NOT NULL,
  target_snapshot_hash TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','stale')),
  created_at TEXT NOT NULL,
  confirmed_by TEXT,
  applied_at TEXT
);

CREATE TABLE package_import_mappings (
  proposal_id TEXT NOT NULL REFERENCES workflow_import_proposals(id),
  entity_type TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  local_id TEXT NOT NULL,
  PRIMARY KEY(proposal_id,entity_type,semantic_key),
  UNIQUE(entity_type,local_id)
);

CREATE TABLE experience_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  package_version TEXT NOT NULL,
  scenario_key TEXT,
  role_key TEXT,
  structured_result_json TEXT,
  error_category TEXT,
  gate_outcomes_json TEXT NOT NULL DEFAULT '[]',
  human_feedback_json TEXT,
  calls INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  duration_ms INTEGER,
  cost_usd REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE experience_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  base_version TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('role_contract','prompt_template','check','route')),
  target_key TEXT NOT NULL,
  change_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','evaluated','applied','rejected','stale')),
  created_at TEXT NOT NULL,
  confirmed_by TEXT,
  applied_version TEXT
);

CREATE TABLE experience_evaluations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES experience_proposals(id),
  scenario_key TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(proposal_id,scenario_key)
);
