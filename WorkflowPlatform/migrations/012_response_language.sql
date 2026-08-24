ALTER TABLE workflow_runs ADD COLUMN response_language TEXT CHECK(response_language IN ('en','ru'));
ALTER TABLE conversation_messages ADD COLUMN language TEXT CHECK(language IN ('en','ru'));

CREATE INDEX idx_conversation_messages_language
  ON conversation_messages(project_id, language, created_at);

