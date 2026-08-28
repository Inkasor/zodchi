-- Two steps that write the same thing must not run at once, and two steps that only read it must not
-- wait for each other. The platform had no notion of the thing at all: the only lock was the step lease,
-- which serialises a step against itself and says nothing about the git index, the information base or
-- the database two different steps are both about to write.
--
-- A resource is named, not guessed. `<kind>:<authority>`, computed from the resource itself — the real
-- path of the git directory, the directory holding 1Cv8.1CD, the server and infobase as written — so two
-- steps reaching the same thing by different spellings still collide, and a step that cannot compute its
-- identity says so instead of taking a lock on the whole project to be safe. That fallback is what makes
-- a project single-threaded for the sake of one step that touches one file in it.
--
-- `unavailable` is the state for exactly that: a step that declared a resource nobody can resolve. It is
-- not a failure of the work, so it does not consume an attempt, and it is not a completion, so a run
-- holding one cannot finish. The next checkout re-resolves it, which is how a repository that was not
-- mounted yet starts working on its own once it is.

CREATE TABLE workflow_steps_next (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  role_id TEXT REFERENCES roles(id),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','leased','running','verifying','review_required','changes_requested','approval_required','documented','completed','failed','cancelled','blocked','retry_scheduled','unavailable')),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  irreversible INTEGER NOT NULL DEFAULT 0 CHECK (irreversible IN (0,1)),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  next_attempt_at TEXT,
  dead_lettered_at TEXT,
  last_error_category TEXT,
  contract_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  result_schema_key TEXT,
  -- The declaration belongs to the step contract, not to whatever the runtime can infer at the moment it
  -- runs. Each entry names a kind, a mode and enough to compute the authority.
  resources_json TEXT NOT NULL DEFAULT '[]',
  unavailable_reason TEXT,
  UNIQUE(run_id, step_key),
  UNIQUE(run_id, idempotency_key)
);
INSERT INTO workflow_steps_next (id,run_id,step_key,ordinal,role_id,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts,next_attempt_at,dead_lettered_at,last_error_category,contract_json,result_json,result_schema_key)
SELECT id,run_id,step_key,ordinal,role_id,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts,next_attempt_at,dead_lettered_at,last_error_category,contract_json,result_json,result_schema_key FROM workflow_steps;
DROP TABLE workflow_steps;
ALTER TABLE workflow_steps_next RENAME TO workflow_steps;
CREATE INDEX idx_steps_run_state ON workflow_steps(run_id, state, ordinal);

-- The same discipline as the execution lease: an owner, a token hash, an expiry, a heartbeat and a
-- deterministic release reason. A held resource that outlives the process holding it is recovered by
-- expiry, not by anyone deciding it looks abandoned.
CREATE TABLE resource_leases (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shared','exclusive')),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES attempts(id),
  lease_id TEXT REFERENCES leases(id),
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);
CREATE INDEX idx_resource_leases_held ON resource_leases(identity, mode) WHERE released_at IS NULL;
CREATE INDEX idx_resource_leases_expiry ON resource_leases(expires_at) WHERE released_at IS NULL;
CREATE INDEX idx_resource_leases_lease ON resource_leases(lease_id) WHERE released_at IS NULL;
-- One step holds one lease per resource. Acquiring the same identity twice for the same step is a bug in
-- the declaration, not a second holder.
CREATE UNIQUE INDEX idx_resource_leases_step_identity ON resource_leases(step_id, identity) WHERE released_at IS NULL;
