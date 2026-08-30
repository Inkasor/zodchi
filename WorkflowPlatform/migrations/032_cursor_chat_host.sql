DROP INDEX zodchi_chat_sessions_project_state;
DROP INDEX zodchi_chat_sessions_last_run;

ALTER TABLE zodchi_chat_sessions RENAME TO zodchi_chat_sessions_before_cursor;

CREATE TABLE zodchi_chat_sessions (
  client TEXT NOT NULL CHECK (client IN ('codex','claude-code','cursor')),
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','ended')),
  pending_message TEXT,
  pending_profile_json TEXT,
  entered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  last_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  last_result_at TEXT,
  active_turn_key TEXT,
  PRIMARY KEY(client,session_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO zodchi_chat_sessions(
  client,session_id,project_id,origin,state,pending_message,pending_profile_json,
  entered_at,last_seen_at,ended_at,last_run_id,last_result_at,active_turn_key
)
SELECT client,session_id,project_id,origin,state,pending_message,pending_profile_json,
  entered_at,last_seen_at,ended_at,last_run_id,last_result_at,active_turn_key
FROM zodchi_chat_sessions_before_cursor;

DROP TABLE zodchi_chat_sessions_before_cursor;

CREATE INDEX zodchi_chat_sessions_project_state
  ON zodchi_chat_sessions(project_id,state,last_seen_at);
CREATE INDEX zodchi_chat_sessions_last_run
  ON zodchi_chat_sessions(last_run_id);
