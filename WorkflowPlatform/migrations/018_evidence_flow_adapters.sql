CREATE TABLE evidence_flow_adapters (
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_key TEXT NOT NULL,
  flow_key TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  target TEXT NOT NULL,
  workflow_keys_json TEXT NOT NULL,
  nodes_json TEXT NOT NULL,
  required_edges_json TEXT NOT NULL,
  material_symbols_json TEXT NOT NULL DEFAULT '[]',
  transition_adapter TEXT,
  transition_method TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  PRIMARY KEY(project_id, package_key, flow_key)
);

CREATE INDEX idx_evidence_flow_adapters_project_package
ON evidence_flow_adapters(project_id, package_key, status);
