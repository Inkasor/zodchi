CREATE TABLE project_strategy_overrides (
  project_id TEXT NOT NULL,
  package_key TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('prototype','mvp','production','security-audit')),
  improvement_strategy TEXT NOT NULL CHECK (improvement_strategy IN ('standard','gauntlet')),
  confirmed_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,package_key,level),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
