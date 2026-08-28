-- A step names a resource by an alias its project registered. The authority behind the alias — the path,
-- the host, the information base — is the installation's own material: it does not travel in a package,
-- and a model never writes it. A planner that could write authorities could name a resource that is not
-- the one it meant, and two spellings of one resource are two locks that never see each other, which is
-- the failure resource identity exists to prevent.
--
-- A row with no declaration is an alias a package asked for and this installation has not bound yet. That
-- is a usable state, not an error: a step naming it becomes `unavailable`, costs no attempt, and starts
-- working by itself once the owner binds the alias.
CREATE TABLE project_resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  kind TEXT NOT NULL,
  purpose TEXT,
  declaration_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_project_resources_alias ON project_resources(project_id, alias);

-- Existing installations already have projects. Registering the implicit working-tree resource only
-- from onboarding would make every one of those projects fail its first writing plan after upgrade.
INSERT INTO project_resources(id,project_id,alias,kind,purpose,declaration_json,created_at,updated_at)
SELECT 'resource_worktree_' || id,id,'project.worktree','project.worktree','The project working tree',
       json_object('path',root_path),created_at,created_at
FROM projects;

-- Portable workflow steps name resource aliases. Older templates have none, which is a valid empty
-- declaration; package migration can then add aliases without rebuilding the table again.
ALTER TABLE workflow_step_templates ADD COLUMN resources_json TEXT NOT NULL DEFAULT '[]';
