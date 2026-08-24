CREATE TABLE artifact_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL
);

INSERT OR IGNORE INTO work_types(id,name,category) VALUES
  ('conversation','Conversation','dialogue'),('continuation','Continuation','dialogue'),('clarification','Clarification','dialogue'),
  ('task','Task','work'),('decision','Decision','work'),('research','Research','work'),('implementation','Implementation','work'),
  ('documentation','Documentation','work'),('review','Review','verification'),('verification','Verification','verification'),
  ('testing','Testing','verification'),('planning','Planning','work'),('fix','Fix','work'),('content','Content','material'),
  ('marketing','Marketing','material'),('release','Release','work'),('game_design','Game design','game'),('narrative','Narrative','game'),
  ('map_design','Map design','game'),('technical_art','Technical art','material'),('art_direction','Art direction','material'),
  ('audio','Audio','material'),('asset','Asset','material'),('prototype','Prototype','work'),('producer','Producer','work');

INSERT OR IGNORE INTO domains(id,name) VALUES
  ('general','General'),('workflow','Workflow'),('software','Software'),('game-development','Game development'),('content','Content'),
  ('business','Business'),('education','Education'),('research','Research'),('other','Other');

INSERT OR IGNORE INTO disciplines(id,name) VALUES
  ('general','General'),('architecture','Architecture'),('producer','Producer'),('game_design','Game design'),('narrative','Narrative'),
  ('map_design','Map design'),('software','Software'),('technical_art','Technical art'),('art_direction','Art direction'),('audio','Audio'),
  ('content','Content'),('marketing','Marketing'),('documentation','Documentation'),('testing','Testing'),('release','Release'),('other','Other');

INSERT OR IGNORE INTO quality_modes(id,name,ordinal) VALUES
  ('prototype','Prototype',0),('mvp','MVP',1),('production','Production',2),('security','Security audit',3);

INSERT OR IGNORE INTO planning_levels(id,name,ordinal) VALUES
  ('L0','L0',0),('L1','L1',1),('L2','L2',2),('L3','L3',3),('L4','L4',4);

INSERT OR IGNORE INTO roles(id,name) VALUES
  ('classifier','Classifier'),('producer','Producer'),('researcher','Researcher'),('planner','Planner'),('worker','Worker'),
  ('reviewer','Reviewer'),('documentator','Documentator'),('tester','Tester'),('content_builder','Content builder'),
  ('art_director','Art director'),('technical_artist','Technical artist'),('audio_designer','Audio designer'),('release_manager','Release manager');

INSERT INTO artifact_types(id,name,category) VALUES
  ('none','None','none'),('document','Document','document'),('code','Code','code'),('prototype','Prototype','code'),
  ('visual_asset','Visual asset','material'),('audio_asset','Audio asset','material'),('content_asset','Content asset','material'),
  ('technical_art_spec','Technical art specification','document'),('test_report','Test report','document'),
  ('decision','Decision','document'),('release_package','Release package','package');

CREATE TABLE workflow_routes (
  project_id TEXT NOT NULL REFERENCES projects(id),
  work_type_id TEXT NOT NULL REFERENCES work_types(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id, work_type_id, workflow_id)
);
CREATE INDEX idx_workflow_routes_lookup ON workflow_routes(project_id, work_type_id, enabled, priority);

ALTER TABLE workflows ADD COLUMN discovery_json TEXT NOT NULL DEFAULT '{"git":false}';
ALTER TABLE workflows ADD COLUMN history_budget_bytes INTEGER NOT NULL DEFAULT 24000 CHECK (history_budget_bytes >= 1024);

ALTER TABLE classifications ADD COLUMN artifact_type_id TEXT;
ALTER TABLE classifications ADD COLUMN reply_mode TEXT;
ALTER TABLE classifications ADD COLUMN needs_questions INTEGER NOT NULL DEFAULT 0 CHECK (needs_questions IN (0,1));
ALTER TABLE classifications ADD COLUMN pending_interaction_id TEXT;
ALTER TABLE classifications ADD COLUMN reason TEXT;
ALTER TABLE classifications ADD COLUMN questions_json TEXT NOT NULL DEFAULT '[]';
