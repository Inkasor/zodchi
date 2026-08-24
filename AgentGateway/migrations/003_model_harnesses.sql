INSERT INTO providers(provider_key,name,adapter_version,enabled,created_at,updated_at) VALUES
  ('opencode','OpenCode CLI',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('cursor','Cursor Agent CLI',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
  ('openai-compatible','OpenAI-compatible HTTP API',1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

ALTER TABLE receipts ADD COLUMN model_provider TEXT;

CREATE INDEX idx_receipts_model_provider_started ON receipts(model_provider, started_at);

CREATE VIEW v_model_provider_kpi AS
SELECT provider AS harness, model_provider, model, reasoning_effort,
  COUNT(DISTINCT task_id) AS tasks,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_calls,
  AVG(duration_ms) AS avg_duration_ms,
  AVG(cache_hit_ratio) AS avg_cache_hit_ratio,
  SUM(input_tokens) AS input_tokens,
  SUM(cached_input_tokens) AS cached_input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(reasoning_output_tokens) AS reasoning_output_tokens
FROM receipts GROUP BY provider, model_provider, model, reasoning_effort;
