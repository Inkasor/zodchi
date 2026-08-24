CREATE INDEX idx_receipts_task_started ON receipts(task_id, started_at);
CREATE INDEX idx_receipts_provider_started ON receipts(provider, started_at);
CREATE INDEX idx_receipts_status ON receipts(status, failure_category);
CREATE INDEX idx_provider_snapshots_provider_checked ON provider_snapshots(provider, checked_at);

CREATE VIEW v_task_summary AS
SELECT task_id, project, level,
  MIN(started_at) AS started_at, MAX(finished_at) AS finished_at,
  COUNT(*) AS model_calls,
  MAX(correction_cycles) AS correction_cycles,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_calls,
  MAX(model) AS model, MAX(reasoning_effort) AS reasoning_effort,
  SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens,
  SUM(output_tokens) AS output_tokens, SUM(reasoning_output_tokens) AS reasoning_output_tokens,
  AVG(cache_hit_ratio) AS cache_hit_ratio
FROM receipts GROUP BY task_id, project, level;

CREATE VIEW v_provider_kpi AS
SELECT provider, model, reasoning_effort,
  COUNT(DISTINCT task_id) AS tasks,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_calls,
  AVG(duration_ms) AS avg_duration_ms,
  AVG(cache_hit_ratio) AS avg_cache_hit_ratio,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(reasoning_output_tokens) AS reasoning_output_tokens
FROM receipts GROUP BY provider, model, reasoning_effort;

CREATE TRIGGER receipts_no_update
BEFORE UPDATE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts are immutable');
END;

CREATE TRIGGER receipts_no_delete
BEFORE DELETE ON receipts
BEGIN
  SELECT RAISE(ABORT, 'receipts are immutable');
END;
