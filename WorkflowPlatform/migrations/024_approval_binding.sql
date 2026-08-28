-- An irreversible action is approved only for the exact objective, plan, checkpoint and action the owner
-- was shown. The plan's structured steps are persisted separately so a pre-action approval can resume
-- without asking the planner to produce a different plan after consent was granted.
ALTER TABLE plans ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE approvals ADD COLUMN binding_hash TEXT;
ALTER TABLE approvals ADD COLUMN binding_json TEXT;

CREATE INDEX idx_approvals_binding ON approvals(binding_hash) WHERE binding_hash IS NOT NULL;
