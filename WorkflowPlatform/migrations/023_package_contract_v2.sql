-- Package schema v2 carries the domain vocabulary and portable resource aliases that its workflows use.
-- Authorities stay installation-local in project_resources; these release columns only remember which
-- catalog entries belonged to the package so export -> import -> export remains deterministic.
ALTER TABLE workflow_package_releases ADD COLUMN domain_keys_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workflow_package_releases ADD COLUMN discipline_keys_json TEXT NOT NULL DEFAULT '[]';

INSERT OR IGNORE INTO domains(id,name) VALUES('one-c','1C');
INSERT OR IGNORE INTO disciplines(id,name) VALUES('one-c-development','1C development');
INSERT OR IGNORE INTO work_types(id,name,category) VALUES
  ('one-c.resume','Resume 1C work','one-c'),
  ('one-c.diagnosis','Diagnose 1C behavior','one-c'),
  ('one-c.change','Change 1C source','one-c'),
  ('one-c.integration','Change a 1C integration','one-c'),
  ('one-c.module-build','Build a 1C module','one-c'),
  ('one-c.release','Release a 1C change','one-c'),
  ('one-c.functional-test','Run a 1C functional test','one-c');
