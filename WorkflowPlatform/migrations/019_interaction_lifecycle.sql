-- Two different waits. `clarification_required` means a person has to decide or tell us something only
-- they know. `external_evidence_required` means a fact is missing from a live information base, a
-- runtime, a device or a closed contour, and no amount of typing supplies it. Collapsing them made every
-- wait look answerable by the next message, which is how an unproven claim could reach a passed gate.
--
-- The interaction status set grows for the same reason. A pending interaction used to end in exactly two
-- ways: answered, or silently cancelled by whatever message arrived next. It now ends only by an explicit
-- answer, a cancellation, a supersede by the owner, or its own declared expiry.

CREATE TABLE tasks_next (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  goal_id TEXT REFERENCES goals(id),
  stage_id TEXT REFERENCES stages(id),
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('received','discovering','classifying','clarification_required','external_evidence_required','classified','classification_failed','planning','executing','documenting','verifying','review_required','changes_requested','approval_required','documented','completed','cancelled','rejected','failed','paused','blocked','retry_scheduled')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resume_state TEXT,
  UNIQUE(project_id, idempotency_key)
);
INSERT INTO tasks_next (id,project_id,goal_id,stage_id,title,state,idempotency_key,created_at,updated_at,resume_state)
SELECT id,project_id,goal_id,stage_id,title,state,idempotency_key,created_at,updated_at,resume_state FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_next RENAME TO tasks;
CREATE INDEX idx_tasks_project_state ON tasks(project_id, state);

CREATE TABLE workflow_runs_next (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  state TEXT NOT NULL CHECK (state IN ('received','discovering','classifying','clarification_required','external_evidence_required','classified','classification_failed','planning','executing','documenting','verifying','review_required','changes_requested','approval_required','documented','completed','cancelled','rejected','failed','paused','blocked','retry_scheduled')),
  operational_level TEXT NOT NULL DEFAULT 'mvp' CHECK (operational_level IN ('prototype','mvp','production','security-audit')),
  user_message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  resume_state TEXT,
  quality_contract_version TEXT,
  correction_cycles INTEGER NOT NULL DEFAULT 0 CHECK (correction_cycles >= 0),
  reviewer_policy TEXT,
  response_language TEXT CHECK (response_language IN ('en','ru')),
  client TEXT NOT NULL DEFAULT 'codex',
  improvement_strategy TEXT NOT NULL DEFAULT 'standard' CHECK (improvement_strategy IN ('standard','gauntlet')),
  cycle INTEGER NOT NULL DEFAULT 0 CHECK (cycle >= 0),
  pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0,1)),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1))
);
INSERT INTO workflow_runs_next (id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at,completed_at,resume_state,quality_contract_version,correction_cycles,reviewer_policy,response_language,client,improvement_strategy,cycle,pause_requested,cancel_requested)
SELECT id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at,completed_at,resume_state,quality_contract_version,correction_cycles,reviewer_policy,response_language,client,improvement_strategy,cycle,pause_requested,cancel_requested FROM workflow_runs;
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_next RENAME TO workflow_runs;
CREATE INDEX idx_runs_task_state ON workflow_runs(task_id, state);

CREATE TABLE approvals_next (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT REFERENCES workflow_runs(id),
  step_id TEXT REFERENCES workflow_steps(id),
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled','superseded','expired')),
  decision_id TEXT REFERENCES decisions(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  -- The typed payload of the wait: for a clarification the reason and what is structurally missing, for
  -- an external evidence request the evidence contract a delivered packet has to satisfy.
  detail_json TEXT,
  affected_steps_json TEXT,
  expires_at TEXT,
  superseded_by TEXT REFERENCES approvals_next(id),
  answered_run_id TEXT REFERENCES workflow_runs(id),
  answer_json TEXT
);
INSERT INTO approvals_next (id,task_id,run_id,step_id,kind,question,status,decision_id,created_at,resolved_at)
SELECT id,task_id,run_id,step_id,kind,question,status,decision_id,created_at,resolved_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_next RENAME TO approvals;

CREATE INDEX idx_approvals_task_status ON approvals(task_id, status);
CREATE INDEX idx_approvals_run_kind_status ON approvals(run_id, kind, status);
CREATE INDEX idx_approvals_pending_expiry ON approvals(status, expires_at);
