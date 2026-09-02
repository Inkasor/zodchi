ALTER TABLE external_operation_executions
ADD COLUMN verification_checks_json TEXT NOT NULL DEFAULT '[]';
