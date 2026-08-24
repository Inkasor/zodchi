CREATE TABLE check_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  accepted_revision TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  minimum_severity TEXT NOT NULL,
  error_count INTEGER NOT NULL CHECK(error_count >= 0),
  warning_count INTEGER NOT NULL CHECK(warning_count >= 0),
  information_count INTEGER NOT NULL CHECK(information_count >= 0),
  hint_count INTEGER NOT NULL CHECK(hint_count >= 0),
  considered_count INTEGER NOT NULL CHECK(considered_count >= 0),
  file_count INTEGER NOT NULL CHECK(file_count >= 0),
  status TEXT NOT NULL CHECK(status IN ('active','superseded')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(check_id) REFERENCES check_definitions(id)
);

CREATE UNIQUE INDEX one_active_check_baseline
  ON check_baselines(project_id, check_id)
  WHERE status = 'active';

CREATE TABLE check_baseline_diagnostics (
  baseline_id TEXT NOT NULL,
  path TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('Warning','Error')),
  diagnostic_code TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK(occurrence_count > 0),
  PRIMARY KEY(baseline_id, path, severity, diagnostic_code, message_hash),
  FOREIGN KEY(baseline_id) REFERENCES check_baselines(id) ON DELETE CASCADE
);

CREATE INDEX check_baseline_diagnostics_lookup
  ON check_baseline_diagnostics(baseline_id, path, severity, diagnostic_code);
