-- A project was one directory, which held for a repository and broke for an integration: the work of
-- reconciling two systems has to read the producing end and the consuming end, and neither is a
-- subdirectory of the other. A project now carries a set of roots. Exactly one is primary and writable;
-- it stays projects.root_path, so a project registered before this migration is unchanged and every
-- lookup by root path keeps resolving to the project that owns the directory. Additional roots are
-- registered explicitly, each with the access it grants, because widening what a run may read or write
-- is a decision the owner makes once and not a flag a run supplies for itself.

CREATE TABLE project_roots (
  project_id TEXT NOT NULL REFERENCES projects(id),
  root_key TEXT NOT NULL,
  path TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'write',
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, root_key),
  CHECK (access IN ('read', 'write')),
  CHECK (is_primary IN (0, 1)),
  CHECK (is_primary = 0 OR access = 'write')
);

CREATE UNIQUE INDEX project_roots_single_primary ON project_roots(project_id) WHERE is_primary = 1;
CREATE INDEX project_roots_path ON project_roots(path);

INSERT INTO project_roots (project_id, root_key, path, access, is_primary, created_at)
  SELECT id, 'primary', root_path, 'write', 1, created_at FROM projects;

-- A project without a primary root cannot be read, planned or written, so the primary root is not
-- something a caller may forget to register: the database maintains it. Every path that creates a
-- project gets one, including the ones that insert the row directly.
CREATE TRIGGER projects_primary_root AFTER INSERT ON projects
BEGIN
  INSERT OR IGNORE INTO project_roots (project_id, root_key, path, access, is_primary, created_at)
    VALUES (NEW.id, 'primary', NEW.root_path, 'write', 1, NEW.created_at);
END;

-- A registered document names the root it belongs to. Existing documents are relative to the primary
-- root, which is what they have always been. The identity of a document is its root and its path
-- together: two roots can each hold a docs/README.md, and they are two documents, not a collision. The
-- table is rebuilt because the old uniqueness lives in its definition and cannot be dropped in place.
ALTER TABLE project_documents ADD COLUMN root_key TEXT NOT NULL DEFAULT 'primary';

CREATE TABLE project_documents_rooted (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  root_key TEXT NOT NULL DEFAULT 'primary',
  document_type TEXT NOT NULL,
  authority TEXT,
  status TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  updated_at TEXT,
  UNIQUE(project_id,root_key,path)
);

INSERT INTO project_documents_rooted (id, project_id, path, root_key, document_type, authority, status, active, version, content_hash, updated_at)
  SELECT id, project_id, path, root_key, document_type, authority, status, active, version, content_hash, updated_at FROM project_documents;

DROP TABLE project_documents;
ALTER TABLE project_documents_rooted RENAME TO project_documents;
