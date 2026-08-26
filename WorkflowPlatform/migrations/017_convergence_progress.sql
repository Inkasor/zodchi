ALTER TABLE progress_snapshots ADD COLUMN progress_kind TEXT NOT NULL DEFAULT 'legacy'
CHECK (progress_kind IN ('legacy','gate','semantic_review'));
ALTER TABLE progress_snapshots ADD COLUMN packet_hash TEXT;
ALTER TABLE progress_snapshots ADD COLUMN semantic_fingerprint TEXT;
ALTER TABLE progress_snapshots ADD COLUMN frontier_fingerprint TEXT;
CREATE INDEX idx_progress_snapshots_run_kind ON progress_snapshots(run_id,progress_kind,created_at);
