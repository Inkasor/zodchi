CREATE TABLE zodchi_chat_sessions (
  client TEXT NOT NULL CHECK (client IN ('codex','claude-code')),
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','ended')),
  pending_message TEXT,
  pending_profile_json TEXT,
  entered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY(client,session_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX zodchi_chat_sessions_project_state
  ON zodchi_chat_sessions(project_id,state,last_seen_at);

CREATE TABLE project_run_profile_defaults (
  project_id TEXT NOT NULL,
  quality_mode TEXT NOT NULL CHECK (quality_mode IN ('prototype','mvp','production','security-audit')),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('standard','goal')),
  verification_mode TEXT NOT NULL CHECK (verification_mode IN ('baseline','gauntlet')),
  planning_mode TEXT NOT NULL CHECK (planning_mode IN ('single','ensemble')),
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY(project_id,quality_mode),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE run_profiles (
  run_id TEXT PRIMARY KEY,
  quality_mode TEXT NOT NULL CHECK (quality_mode IN ('prototype','mvp','production','security-audit')),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('standard','goal')),
  verification_mode TEXT NOT NULL CHECK (verification_mode IN ('baseline','gauntlet')),
  planning_mode TEXT NOT NULL CHECK (planning_mode IN ('single','ensemble')),
  sources_json TEXT NOT NULL,
  planner_bindings_json TEXT NOT NULL DEFAULT '[]',
  profile_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','fixed','superseded')),
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE TABLE run_reflection_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  sequence INTEGER NOT NULL,
  trigger_role TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  since_previous_ms INTEGER NOT NULL CHECK (since_previous_ms >= 0),
  state_hash TEXT NOT NULL,
  result_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('presented','applied')),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE(run_id, sequence)
);
CREATE INDEX idx_run_reflection_checkpoints_run ON run_reflection_checkpoints(run_id, sequence);

CREATE UNIQUE INDEX run_profiles_hash ON run_profiles(run_id,profile_hash);

-- Existing projects already state the legacy verification strategy. Preserve that fact as a migration
-- default while separating it from execution and planning; onboarding can replace these rows after the
-- owner has chosen project defaults explicitly.
INSERT INTO project_run_profile_defaults(project_id,quality_mode,execution_mode,verification_mode,planning_mode,confirmed_by,confirmed_at)
SELECT p.id,q.quality_mode,'standard',
  CASE WHEN EXISTS (
    SELECT 1 FROM operational_level_policies policy
    WHERE policy.project_id=p.id AND policy.level=q.quality_mode AND policy.improvement_strategy='gauntlet'
  ) THEN 'gauntlet' ELSE 'baseline' END,
  'single','legacy_migration',CURRENT_TIMESTAMP
FROM projects p
CROSS JOIN (
  SELECT 'prototype' quality_mode UNION ALL SELECT 'mvp' UNION ALL SELECT 'production' UNION ALL SELECT 'security-audit'
) q;

UPDATE quality_contracts SET reviewer_policy='required' WHERE level='mvp';
