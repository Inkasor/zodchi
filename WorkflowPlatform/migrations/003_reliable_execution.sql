ALTER TABLE tasks ADD COLUMN resume_state TEXT;
ALTER TABLE workflow_runs ADD COLUMN resume_state TEXT;

ALTER TABLE workflow_steps ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0);
ALTER TABLE workflow_steps ADD COLUMN next_attempt_at TEXT;
ALTER TABLE workflow_steps ADD COLUMN dead_lettered_at TEXT;
ALTER TABLE workflow_steps ADD COLUMN last_error_category TEXT;

ALTER TABLE attempts ADD COLUMN idempotency_key TEXT;
ALTER TABLE attempts ADD COLUMN lease_id TEXT;
ALTER TABLE attempts ADD COLUMN receipt_id TEXT;
ALTER TABLE attempts ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX idx_attempts_idempotency ON attempts(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE leases RENAME TO leases_v1;
CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);
INSERT INTO leases(id,step_id,owner_id,token_hash,acquired_at,expires_at,heartbeat_at,released_at)
SELECT id,step_id,owner_id,token_hash,acquired_at,expires_at,heartbeat_at,released_at FROM leases_v1;
DROP TABLE leases_v1;
CREATE UNIQUE INDEX idx_leases_active_step ON leases(step_id) WHERE released_at IS NULL;
CREATE INDEX idx_leases_active_expiry ON leases(expires_at) WHERE released_at IS NULL;

CREATE TABLE inbox_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  received_at TEXT NOT NULL,
  UNIQUE(project_id, source, event_key)
);

CREATE TABLE dead_letters (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id TEXT NOT NULL REFERENCES workflow_steps(id),
  attempt_id TEXT REFERENCES attempts(id),
  category TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  replay_requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (replay_requires_approval IN (0,1)),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX idx_dead_letters_open ON dead_letters(run_id, resolved_at);

CREATE TABLE budget_entries (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets(id),
  task_id TEXT REFERENCES tasks(id),
  run_id TEXT REFERENCES workflow_runs(id),
  amount REAL NOT NULL CHECK (amount >= 0),
  idempotency_key TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(budget_id, idempotency_key)
);
CREATE INDEX idx_budget_entries_run ON budget_entries(run_id, created_at);
