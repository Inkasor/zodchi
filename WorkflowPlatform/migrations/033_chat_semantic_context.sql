-- A chat session was previously associated with a run only after execution, through
-- zodchi_chat_sessions.last_run_id. That is enough to relay a result, but too late to isolate the
-- history and pending interactions used by classification. Bind every run at intake instead.
CREATE TABLE zodchi_chat_session_runs (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  session_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  FOREIGN KEY(client,session_id) REFERENCES zodchi_chat_sessions(client,session_id) ON DELETE CASCADE
);

CREATE INDEX zodchi_chat_session_runs_session
  ON zodchi_chat_session_runs(client,session_id,bound_at,run_id);

-- The exact last run is the only historical association the previous schema proved. Preserve it only
-- when one session names it; a run named by several sessions is ambiguous and must not be guessed into
-- either. Older project-wide messages are deliberately not assigned to a session.
INSERT INTO zodchi_chat_session_runs(run_id,client,session_id,bound_at)
SELECT session.last_run_id,session.client,session.session_id,COALESCE(session.last_result_at,session.last_seen_at)
FROM zodchi_chat_sessions session
WHERE session.last_run_id IS NOT NULL
  AND 1=(SELECT COUNT(*) FROM zodchi_chat_sessions other WHERE other.last_run_id=session.last_run_id);

-- The current user message is provenance. Downstream roles need a standalone objective in which the
-- classifier has already resolved pronouns, numbered choices and answers against this chat's history.
ALTER TABLE workflow_runs ADD COLUMN resolved_objective TEXT;
