CREATE INDEX idx_tasks_project_state ON tasks(project_id, state);
CREATE INDEX idx_runs_task_state ON workflow_runs(task_id, state);
CREATE INDEX idx_steps_run_state ON workflow_steps(run_id, state, ordinal);
CREATE INDEX idx_attempts_step_ordinal ON attempts(step_id, ordinal);
CREATE INDEX idx_decisions_task_active ON decisions(task_id, active, kind);
CREATE INDEX idx_approvals_task_status ON approvals(task_id, status);
CREATE INDEX idx_artifacts_task_status ON artifacts(task_id, status);
CREATE INDEX idx_events_entity_sequence ON events(entity_type, entity_id, sequence);
CREATE INDEX idx_events_task_sequence ON events(task_id, sequence);
CREATE INDEX idx_budgets_scope ON budgets(scope_type, scope_id, status);
CREATE INDEX idx_leases_expiry ON leases(expires_at, released_at);

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;
