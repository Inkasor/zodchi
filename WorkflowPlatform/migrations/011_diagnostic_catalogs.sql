CREATE TABLE diagnostic_rules (
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  diagnostic_code TEXT NOT NULL,
  name_ru TEXT NOT NULL,
  name_en TEXT NOT NULL,
  diagnostic_type TEXT NOT NULL CHECK(diagnostic_type IN ('ERROR','CODE_SMELL','VULNERABILITY','SECURITY_HOTSPOT')),
  diagnostic_severity TEXT NOT NULL CHECK(diagnostic_severity IN ('INFO','MINOR','MAJOR','CRITICAL','BLOCKER')),
  lsp_severity TEXT NOT NULL CHECK(lsp_severity IN ('Hint','Information','Warning','Error')),
  activated_by_default INTEGER NOT NULL CHECK(activated_by_default IN (0,1)),
  minutes_to_fix INTEGER NOT NULL CHECK(minutes_to_fix >= 0),
  source_revision TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_license TEXT NOT NULL,
  PRIMARY KEY(tool_name, tool_version, diagnostic_code)
);

CREATE TABLE diagnostic_rule_tags (
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  diagnostic_code TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY(tool_name, tool_version, diagnostic_code, tag),
  FOREIGN KEY(tool_name, tool_version, diagnostic_code)
    REFERENCES diagnostic_rules(tool_name, tool_version, diagnostic_code)
    ON DELETE CASCADE
);

CREATE TABLE project_diagnostic_policies (
  project_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  quality_mode_id TEXT NOT NULL,
  diagnostic_type TEXT NOT NULL CHECK(diagnostic_type IN ('ERROR','CODE_SMELL','VULNERABILITY','SECURITY_HOTSPOT')),
  minimum_severity TEXT NOT NULL CHECK(minimum_severity IN ('INFO','MINOR','MAJOR','CRITICAL','BLOCKER')),
  disposition TEXT NOT NULL CHECK(disposition IN ('block','report')),
  PRIMARY KEY(project_id, check_id, quality_mode_id, diagnostic_type),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(check_id) REFERENCES check_definitions(id) ON DELETE CASCADE,
  FOREIGN KEY(quality_mode_id) REFERENCES quality_modes(id)
);

CREATE INDEX diagnostic_rules_by_policy
  ON diagnostic_rules(tool_name, tool_version, diagnostic_type, diagnostic_severity);
