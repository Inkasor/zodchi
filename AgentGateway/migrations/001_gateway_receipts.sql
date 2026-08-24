CREATE TABLE providers (
  provider_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO providers(provider_key,name,adapter_version,enabled,created_at,updated_at) VALUES
  ('codex','Codex CLI',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('claude','Claude Code CLI',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('kimi','Kimi CLI',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

CREATE TABLE receipts (
  receipt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  workflow_run_id TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  project TEXT,
  provider TEXT NOT NULL REFERENCES providers(provider_key),
  profile TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('prototype','mvp','production','security-audit')),
  role TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  idle_ms INTEGER,
  calls INTEGER NOT NULL CHECK (calls = 1),
  correction_cycles INTEGER NOT NULL DEFAULT 0 CHECK (correction_cycles >= 0),
  retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0),
  timed_out INTEGER NOT NULL CHECK (timed_out IN (0,1)),
  exit_code INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','failed','timed_out')),
  failure_category TEXT,
  error_summary TEXT,
  usage_json TEXT,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  cache_write_input_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cost_usd REAL,
  output_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  total_tokens INTEGER,
  duration_ms INTEGER NOT NULL,
  num_turns INTEGER,
  session_id TEXT,
  service_tier TEXT,
  speed TEXT,
  context_bytes INTEGER NOT NULL,
  diff_files INTEGER,
  diff_added_lines INTEGER,
  diff_deleted_lines INTEGER,
  cache_hit_ratio REAL,
  model TEXT,
  reasoning_effort TEXT,
  contract_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  artifact_ref TEXT,
  decision_ref TEXT
);

CREATE TABLE provider_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL REFERENCES providers(provider_key),
  checked_at TEXT NOT NULL,
  authenticated INTEGER CHECK (authenticated IN (0,1) OR authenticated IS NULL),
  subscription_type TEXT,
  status TEXT NOT NULL CHECK (status IN ('available','unavailable','error')),
  failure_category TEXT
);
