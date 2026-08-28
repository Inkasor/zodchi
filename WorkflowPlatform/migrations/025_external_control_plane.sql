CREATE TABLE external_executors (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  purpose TEXT,
  public_key_pem TEXT NOT NULL,
  key_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,id),
  UNIQUE(project_id,key_id)
);

CREATE TABLE external_control_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL,
  interaction_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  executor_id TEXT NOT NULL,
  executor_key_id TEXT NOT NULL,
  action TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_ref TEXT,
  request_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','cancel_requested','completed','failed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancel_hash TEXT,
  UNIQUE(project_id,idempotency_key),
  FOREIGN KEY(project_id,executor_id) REFERENCES external_executors(project_id,id)
);

CREATE INDEX idx_external_control_requests_run ON external_control_requests(run_id,status,created_at);
CREATE INDEX idx_external_control_requests_interaction ON external_control_requests(interaction_id,status);

CREATE TABLE external_control_results (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES external_control_requests(id) ON DELETE CASCADE,
  executor_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed','failed','cancelled')),
  payload_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL UNIQUE,
  signature_base64 TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);
