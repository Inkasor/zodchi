ALTER TABLE operational_level_policies
ADD COLUMN improvement_strategy TEXT NOT NULL DEFAULT 'standard'
CHECK (improvement_strategy IN ('standard','gauntlet'));

ALTER TABLE workflow_runs
ADD COLUMN improvement_strategy TEXT NOT NULL DEFAULT 'standard'
CHECK (improvement_strategy IN ('standard','gauntlet'));
ALTER TABLE workflow_runs ADD COLUMN cycle INTEGER NOT NULL DEFAULT 0 CHECK (cycle >= 0);
ALTER TABLE workflow_runs ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0,1));
ALTER TABLE workflow_runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1));

CREATE TABLE run_root_baselines (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  root_key TEXT NOT NULL,
  root_path TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('git','inventory')),
  complete INTEGER NOT NULL DEFAULT 1 CHECK (complete IN (0,1)),
  baseline_head TEXT,
  baseline_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,root_key)
);

CREATE TABLE run_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES workflow_steps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_run_evidence_run_kind ON run_evidence(run_id,kind,created_at);

CREATE TABLE run_control_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('pause','cancel')),
  status TEXT NOT NULL CHECK (status IN ('pending','applied','superseded')),
  reason TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE UNIQUE INDEX idx_run_control_pending ON run_control_requests(run_id,action) WHERE status='pending';

CREATE TABLE progress_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  cycle INTEGER NOT NULL DEFAULT 0,
  gate_vector_json TEXT NOT NULL DEFAULT '[]',
  failure_fingerprints_json TEXT NOT NULL DEFAULT '[]',
  primary_gap_fingerprint TEXT,
  changed_scope_json TEXT NOT NULL DEFAULT '[]',
  unauthorized_changes_json TEXT NOT NULL DEFAULT '[]',
  calls_used REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  blast_radius INTEGER NOT NULL DEFAULT 0,
  verified_progress INTEGER NOT NULL DEFAULT 0 CHECK (verified_progress IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_progress_snapshots_run ON progress_snapshots(run_id,created_at);

ALTER TABLE quality_contract_budgets RENAME TO quality_contract_budgets_v1;
CREATE TABLE quality_contract_budgets (
  level TEXT NOT NULL REFERENCES quality_contracts(level) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('calls','duration_ms','correction_cycles','cost_usd')),
  limit_value REAL NOT NULL CHECK (limit_value >= 0),
  PRIMARY KEY(level,metric)
);
INSERT INTO quality_contract_budgets(level,metric,limit_value)
SELECT level,metric,limit_value FROM quality_contract_budgets_v1;
INSERT INTO quality_contract_budgets(level,metric,limit_value) VALUES
  ('prototype','cost_usd',0.5),
  ('mvp','cost_usd',2.0),
  ('production','cost_usd',8.0),
  ('security-audit','cost_usd',4.0);
DROP TABLE quality_contract_budgets_v1;

ALTER TABLE operational_level_budget_limits RENAME TO operational_level_budget_limits_v1;
CREATE TABLE operational_level_budget_limits (
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('prototype','mvp','production','security-audit')),
  metric TEXT NOT NULL CHECK (metric IN ('calls','duration_ms','correction_cycles','cost_usd')),
  limit_value REAL NOT NULL CHECK (limit_value >= 0),
  PRIMARY KEY(project_id,package_key,level,metric)
);
INSERT INTO operational_level_budget_limits(project_id,package_key,level,metric,limit_value)
SELECT project_id,package_key,level,metric,limit_value FROM operational_level_budget_limits_v1;
INSERT INTO operational_level_budget_limits(project_id,package_key,level,metric,limit_value)
SELECT p.project_id,p.package_key,p.level,'cost_usd',q.limit_value
FROM operational_level_policies p
JOIN quality_contract_budgets q ON q.level=p.level AND q.metric='cost_usd';
DROP TABLE operational_level_budget_limits_v1;
