CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','completed','cancelled','blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  goal_id TEXT REFERENCES goals(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  stage_key TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','active','completed','cancelled','blocked')),
  ordinal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, stage_key)
);

CREATE TABLE work_types (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL);
CREATE TABLE domains (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE disciplines (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE quality_modes (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, ordinal INTEGER NOT NULL);
CREATE TABLE planning_levels (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, ordinal INTEGER NOT NULL);
CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE profiles (id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL UNIQUE, role_id TEXT REFERENCES roles(id));
CREATE TABLE semantic_statuses (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL);
CREATE TABLE evidence_types (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE check_definitions (id TEXT PRIMARY KEY, name TEXT NOT NULL, runner TEXT NOT NULL);

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT,
  package_version TEXT,
  default_quality TEXT NOT NULL,
  default_level TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE project_checks (
  project_id TEXT NOT NULL REFERENCES projects(id),
  check_id TEXT NOT NULL REFERENCES check_definitions(id),
  quality_mode_id TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0,1)),
  PRIMARY KEY (project_id, check_id, quality_mode_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  goal_id TEXT REFERENCES goals(id),
  stage_id TEXT REFERENCES stages(id),
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('received','discovering','classifying','clarification_required','classified','classification_failed','planning','executing','documenting','verifying','review_required','changes_requested','approval_required','documented','completed','cancelled','rejected','failed','paused','blocked','retry_scheduled')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  state TEXT NOT NULL CHECK (state IN ('received','discovering','classifying','clarification_required','classified','classification_failed','planning','executing','documenting','verifying','review_required','changes_requested','approval_required','documented','completed','cancelled','rejected','failed','paused','blocked','retry_scheduled')),
  operational_level TEXT NOT NULL DEFAULT 'mvp' CHECK (operational_level IN ('prototype','mvp','production','security-audit')),
  user_message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  role_id TEXT REFERENCES roles(id),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','leased','running','verifying','review_required','changes_requested','approval_required','documented','completed','failed','cancelled','blocked','retry_scheduled')),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  irreversible INTEGER NOT NULL DEFAULT 0 CHECK (irreversible IN (0,1)),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, step_key),
  UNIQUE(run_id, idempotency_key)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','failed','timed_out','cancelled')),
  provider TEXT,
  profile TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_category TEXT,
  UNIQUE(step_id, ordinal)
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT REFERENCES workflow_runs(id),
  step_id TEXT REFERENCES workflow_steps(id),
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  source TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT REFERENCES workflow_runs(id),
  step_id TEXT REFERENCES workflow_steps(id),
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled')),
  decision_id TEXT REFERENCES decisions(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT REFERENCES workflow_runs(id),
  step_id TEXT REFERENCES workflow_steps(id),
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  content_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','created','verified','accepted','rejected','superseded')),
  provenance_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  run_id TEXT REFERENCES workflow_runs(id),
  step_id TEXT REFERENCES workflow_steps(id),
  attempt_id TEXT REFERENCES attempts(id),
  kind TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project','task','workflow','role','attempt')),
  scope_id TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('calls','input_tokens','output_tokens','total_tokens','duration_ms','correction_cycles','cost_usd')),
  limit_value REAL NOT NULL CHECK (limit_value >= 0),
  used_value REAL NOT NULL DEFAULT 0 CHECK (used_value >= 0),
  status TEXT NOT NULL CHECK (status IN ('active','exhausted','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope_type, scope_id, metric)
);

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL UNIQUE REFERENCES workflow_steps(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  released_at TEXT
);

CREATE TABLE classifications (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  decision_id TEXT REFERENCES decisions(id),
  kind TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  discipline_id TEXT NOT NULL,
  risk TEXT NOT NULL,
  planning_level_id TEXT NOT NULL,
  quality_mode_id TEXT NOT NULL,
  planning_required INTEGER NOT NULL CHECK (planning_required IN (0,1)),
  human_required INTEGER NOT NULL CHECK (human_required IN (0,1)),
  document_required INTEGER NOT NULL DEFAULT 0 CHECK (document_required IN (0,1))
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  authority TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE gateway_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES workflow_steps(id),
  attempt_id TEXT REFERENCES attempts(id),
  provider TEXT NOT NULL,
  profile_id TEXT,
  role_id TEXT,
  receipt_id TEXT NOT NULL,
  gateway_task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  started_at TEXT,
  finished_at TEXT,
  input_tokens INTEGER,
  cached_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  duration_ms INTEGER
);

CREATE TABLE gates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES workflow_steps(id),
  kind TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('pending','passed','failed','timed_out','unavailable','skipped')),
  duration_ms INTEGER,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE gate_runs (
  gate_id TEXT PRIMARY KEY,
  task_id TEXT,
  run_id TEXT REFERENCES workflow_runs(id),
  project TEXT NOT NULL,
  level TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  files_json TEXT NOT NULL
);

CREATE TABLE document_operations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES workflow_steps(id),
  operation TEXT NOT NULL,
  document_path TEXT NOT NULL,
  authority TEXT NOT NULL,
  status TEXT NOT NULL,
  before_version TEXT,
  after_version TEXT
);

CREATE TABLE lint_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES workflow_steps(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  error_count INTEGER NOT NULL
);

CREATE TABLE project_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  document_type TEXT NOT NULL,
  authority TEXT,
  status TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE(project_id,path)
);

CREATE TABLE role_documents (
  project_id TEXT NOT NULL REFERENCES projects(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  document_id TEXT NOT NULL REFERENCES project_documents(id),
  read_access INTEGER NOT NULL DEFAULT 1 CHECK (read_access IN (0,1)),
  write_access INTEGER NOT NULL DEFAULT 0 CHECK (write_access IN (0,1)),
  purpose TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id,role_id,document_id)
);

CREATE TABLE document_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  target TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','cancelled')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT REFERENCES workflow_runs(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
