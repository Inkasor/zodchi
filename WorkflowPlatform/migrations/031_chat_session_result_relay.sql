ALTER TABLE zodchi_chat_sessions ADD COLUMN last_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL;
ALTER TABLE zodchi_chat_sessions ADD COLUMN last_result_at TEXT;
ALTER TABLE zodchi_chat_sessions ADD COLUMN active_turn_key TEXT;

CREATE INDEX zodchi_chat_sessions_last_run
  ON zodchi_chat_sessions(last_run_id);
