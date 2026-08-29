CREATE TABLE owner_acceptance_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  preset_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  package_key TEXT NOT NULL,
  package_version TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256)=64),
  owner_identity TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('read','accepted','rejected')),
  domain_status TEXT NOT NULL CHECK (domain_status IN ('open','accepted','rejected')),
  note TEXT,
  source TEXT NOT NULL CHECK (source='owner_explicit'),
  supersedes_id TEXT REFERENCES owner_acceptance_records(id),
  content_hash TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_owner_acceptance_supersedes_once
  ON owner_acceptance_records(supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE INDEX idx_owner_acceptance_lookup
  ON owner_acceptance_records(project_id,preset_key,run_id,recorded_at);
