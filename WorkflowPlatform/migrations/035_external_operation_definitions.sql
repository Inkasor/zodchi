CREATE TABLE external_operation_definitions (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  executor_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('release','access')),
  action TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,id),
  FOREIGN KEY(project_id,executor_id) REFERENCES external_executors(project_id,id)
);

CREATE INDEX idx_external_operation_definitions_executor ON external_operation_definitions(project_id,executor_id,active);

CREATE TABLE external_operation_executions (
  request_id TEXT PRIMARY KEY REFERENCES external_control_requests(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('release','access')),
  definition_hash TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','result_received','verified','verification_failed','failed','cancelled')),
  result_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id,operation_id) REFERENCES external_operation_definitions(project_id,id)
);

CREATE INDEX idx_external_operation_executions_run ON external_operation_executions(run_id,status,updated_at);
