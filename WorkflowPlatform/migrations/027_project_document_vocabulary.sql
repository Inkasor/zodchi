CREATE TABLE project_semantic_statuses (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,status_id)
);

CREATE TABLE project_evidence_types (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  evidence_type_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,evidence_type_id)
);
