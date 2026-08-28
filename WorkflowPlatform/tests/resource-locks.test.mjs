import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { id, now, openDb } from "../src/db.mjs";
import { ExecutionQueue } from "../src/execution-queue.mjs";
import { resourceIdentity } from "../src/resource-locks.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A repository with one commit, so `git worktree add` has something to branch from.
function repository(root) {
  const directory = path.join(root, "repo");
  fs.mkdirSync(directory, { recursive: true });
  git(directory, "init", "--quiet");
  git(directory, "config", "user.email", "test@example.invalid");
  git(directory, "config", "user.name", "Test");
  fs.writeFileSync(path.join(directory, "README.md"), "x\n");
  git(directory, "add", "README.md");
  git(directory, "commit", "--quiet", "-m", "first");
  return directory;
}

function fixture(root, steps) {
  const dbFile = path.join(root, "workflow.sqlite");
  const db = openDb(dbFile);
  const timestamp = now();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(root, timestamp);
  db.prepare("INSERT INTO workflows(id,project_id,name,default_quality,default_level,status) VALUES('workflow','project','Workflow','mvp','L1','active')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','Task','executing',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,user_message,created_at,updated_at) VALUES('run','task','project','workflow','executing','work',?,?)").run(timestamp, timestamp);
  for (const [index, step] of steps.entries()) {
    db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,state,required,idempotency_key,created_at,updated_at,resources_json) VALUES(?,'run',?,?,'ready',1,?,?,?,?)")
      .run(step.key, step.key, step.ordinal ?? index + 1, `run:${step.key}`, timestamp, timestamp, JSON.stringify(step.resources ?? []));
  }
  return { db, dbFile };
}

const held = (db, stepKey) => db.prepare("SELECT identity,mode,release_reason,released_at FROM resource_leases WHERE step_id=? ORDER BY identity").all(stepKey);

test("canonical identities name the resource, not the path that reached it", () => {
  const root = temporaryRoot("zodchi-resource-identity-");
  const repo = repository(root);
  const gitDirectory = fs.realpathSync.native(path.join(repo, ".git"));

  assert.equal(resourceIdentity({ kind: "repo.index", mode: "exclusive", path: repo }), `repo.index:${gitDirectory}`);
  // The same repository reached through a relative spelling and a subdirectory is the same resource.
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  assert.equal(resourceIdentity({ kind: "repo.index", mode: "shared", path: path.join(repo, "src") }), `repo.index:${gitDirectory}`);

  // A default port is written out, so `srvr=host` and `srvr=host:1541` cannot become two resources, and
  // the case a person typed never makes a third.
  assert.equal(resourceIdentity({ kind: "1c.server", mode: "exclusive", server: "SRV-01", infobase: "Trade" }), "1c.server:srvr=srv-01:1541;ref=trade");
  assert.equal(resourceIdentity({ kind: "1c.server", mode: "shared", server: "srv-01:1541", infobase: "trade" }), "1c.server:srvr=srv-01:1541;ref=trade");
  assert.equal(resourceIdentity({ kind: "db", mode: "exclusive", engine: "PostgreSQL", host: "Analytics:5432", database: "Reports" }), "db:postgresql:analytics:5432/reports");
  assert.equal(resourceIdentity({ kind: "db.clickhouse.cluster", mode: "exclusive", cluster: "Main" }), "db.clickhouse.cluster:main");

  const base = path.join(root, "infobase");
  fs.mkdirSync(base, { recursive: true });
  assert.throws(() => resourceIdentity({ kind: "1c.file", mode: "exclusive", path: base }), /RESOURCE_IDENTITY_UNRESOLVED/);
  fs.writeFileSync(path.join(base, "1Cv8.1CD"), "");
  assert.equal(resourceIdentity({ kind: "1c.file", mode: "exclusive", path: base }), `1c.file:${fs.realpathSync.native(base)}`);
  // Naming the file itself and naming its directory are the same information base.
  assert.equal(resourceIdentity({ kind: "1c.file", mode: "shared", path: path.join(base, "1Cv8.1CD") }), `1c.file:${fs.realpathSync.native(base)}`);

  assert.throws(() => resourceIdentity({ kind: "repo.index", mode: "exclusive", path: root }), /RESOURCE_IDENTITY_UNRESOLVED/);
  assert.throws(() => resourceIdentity({ kind: "unknown", mode: "shared" }), /RESOURCE_KIND_UNKNOWN/);
  assert.throws(() => resourceIdentity({ kind: "repo.index", mode: "write", path: repo }), /RESOURCE_MODE_INVALID/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("two worktrees write their own indices in parallel", () => {
  const root = temporaryRoot("zodchi-resource-index-");
  const repo = repository(root);
  const second = path.join(root, "worktree");
  git(repo, "worktree", "add", "--quiet", "-b", "side", second);

  // Two worktrees of one repository have two indices. Locking "the repository" would serialize these two
  // steps for no reason; the earlier version of this case declared the shared refs as well, so the second
  // step waited and the parallel index work it was named for was never actually demonstrated.
  const { db } = fixture(root, [
    { key: "main-tree", ordinal: 1, resources: [{ kind: "repo.index", mode: "exclusive", path: repo }] },
    { key: "side-tree", ordinal: 1, resources: [{ kind: "repo.index", mode: "exclusive", path: second }] }
  ]);
  const queue = new ExecutionQueue(db);

  const first = queue.checkout({ ownerId: "worker-a" });
  const parallel = queue.checkout({ ownerId: "worker-b" });
  assert.equal(first.stepId, "main-tree");
  assert.equal(parallel.stepId, "side-tree", "an index in another worktree is another resource");
  assert.notEqual(first.resources[0].identity, parallel.resources[0].identity);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM resource_leases WHERE released_at IS NULL").get().count, 2);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("every worktree of a repository shares one set of refs, so ref updates serialize", () => {
  const root = temporaryRoot("zodchi-resource-refs-");
  const repo = repository(root);
  const second = path.join(root, "worktree");
  git(repo, "worktree", "add", "--quiet", "-b", "side", second);

  assert.equal(resourceIdentity({ kind: "repo.refs", mode: "exclusive", path: repo }), resourceIdentity({ kind: "repo.refs", mode: "exclusive", path: second }));
  const { db } = fixture(root, [
    { key: "main-tree", ordinal: 1, resources: [{ kind: "repo.refs", mode: "exclusive", path: repo }] },
    { key: "side-tree", ordinal: 1, resources: [{ kind: "repo.refs", mode: "exclusive", path: second }] }
  ]);
  const queue = new ExecutionQueue(db);

  const first = queue.checkout({ ownerId: "worker-a" });
  assert.equal(first.stepId, "main-tree");
  // The other worktree is a different checkout and the same refs. Nothing blocks: the step is skipped and
  // the worker is told which resource it waited on.
  const blocked = queue.checkout({ ownerId: "worker-b" });
  assert.equal(blocked, null);
  queue.start(first.token);
  queue.complete(first.token);
  assert.equal(queue.checkout({ ownerId: "worker-b" }).stepId, "side-tree");
  assert.equal(held(db, "main-tree").every(row => row.release_reason === "completed"), true);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("shared readers of one information base do not block each other and an exclusive writer waits", () => {
  const root = temporaryRoot("zodchi-resource-shared-");
  const base = path.join(root, "infobase");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "1Cv8.1CD"), "");
  const read = { kind: "1c.file", mode: "shared", path: base };
  const write = { kind: "1c.file", mode: "exclusive", path: base };
  const { db } = fixture(root, [
    { key: "scan-a", ordinal: 1, resources: [read] },
    { key: "scan-b", ordinal: 1, resources: [read] },
    { key: "load", ordinal: 1, resources: [write] }
  ]);
  const queue = new ExecutionQueue(db);

  const readerA = queue.checkout({ ownerId: "reader-a" });
  const readerB = queue.checkout({ ownerId: "reader-b" });
  assert.deepEqual([readerA.stepId, readerB.stepId], ["scan-a", "scan-b"]);
  assert.equal(readerA.resources[0].mode, "shared");

  // The writer is the only remaining candidate and it cannot have the base while two readers hold it.
  assert.equal(queue.checkout({ ownerId: "writer" }), null);
  queue.start(readerA.token); queue.complete(readerA.token);
  assert.equal(queue.checkout({ ownerId: "writer" }), null, "one remaining reader still excludes the writer");
  queue.start(readerB.token); queue.complete(readerB.token);
  const writer = queue.checkout({ ownerId: "writer" });
  assert.equal(writer.stepId, "load");
  assert.equal(writer.resources[0].mode, "exclusive");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a step taking a repository and an information base together takes both or neither", () => {
  const root = temporaryRoot("zodchi-resource-gitsync-");
  const repo = repository(root);
  const base = path.join(root, "infobase");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "1Cv8.1CD"), "");
  const both = [
    { kind: "1c.file", mode: "exclusive", path: base },
    { kind: "repo.index", mode: "exclusive", path: repo }
  ];
  const { db } = fixture(root, [
    { key: "gitsync", ordinal: 1, resources: both },
    { key: "reload", ordinal: 1, resources: [{ kind: "1c.file", mode: "exclusive", path: base }] },
    { key: "commit", ordinal: 1, resources: [{ kind: "repo.index", mode: "exclusive", path: repo }] }
  ]);
  const queue = new ExecutionQueue(db);

  const sync = queue.checkout({ ownerId: "sync" });
  assert.equal(sync.stepId, "gitsync");
  // Acquisition is ordered by identity string, so two steps taking the same pair can never take them in
  // opposite orders and wait on each other.
  assert.deepEqual(sync.resources.map(item => item.identity), [...sync.resources.map(item => item.identity)].sort());
  assert.equal(queue.checkout({ ownerId: "other" }), null, "both followers need one of the two resources");

  queue.start(sync.token);
  // A failed attempt releases everything it took, in the reverse of the order it took them; nothing stays
  // held because the work went wrong. The retry is scheduled far enough out that the two followers, each
  // needing one of the two resources, are the candidates that remain.
  queue.fail(sync.token, { retryDelayMs: 60_000 });
  assert.equal(held(db, "gitsync").every(row => row.release_reason === "failed"), true);
  const reload = queue.checkout({ ownerId: "other" });
  assert.equal(reload.stepId, "reload");
  const commit = queue.checkout({ ownerId: "third" });
  assert.equal(commit.stepId, "commit");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a resource nobody can name makes the step unavailable instead of locking the project", () => {
  const root = temporaryRoot("zodchi-resource-unresolved-");
  const base = path.join(root, "infobase");
  fs.mkdirSync(base, { recursive: true });
  const { db } = fixture(root, [
    { key: "needs-base", ordinal: 1, resources: [{ kind: "1c.file", mode: "exclusive", path: base }] },
    { key: "unrelated", ordinal: 1, resources: [] }
  ]);
  const queue = new ExecutionQueue(db);

  // The directory holds no information base, so the identity cannot be computed. The step says so, and
  // the step that needs nothing runs: an unnamed resource never becomes a lock on everything.
  const other = queue.checkout({ ownerId: "worker" });
  assert.equal(other.stepId, "unrelated");
  const unavailable = db.prepare("SELECT state,unavailable_reason FROM workflow_steps WHERE id='needs-base'").get();
  assert.equal(unavailable.state, "unavailable");
  assert.match(unavailable.unavailable_reason, /RESOURCE_IDENTITY_UNRESOLVED: 1c\.file/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM resource_leases").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE step_id='needs-base'").get().count, 0, "an unresolvable resource costs no attempt");

  queue.start(other.token); queue.complete(other.token);
  assert.equal(queue.checkout({ ownerId: "worker" }), null);

  // Once the base exists the identity resolves and the step runs, with nothing else needed to revive it.
  fs.writeFileSync(path.join(base, "1Cv8.1CD"), "");
  const revived = queue.checkout({ ownerId: "worker" });
  assert.equal(revived.stepId, "needs-base");
  assert.equal(db.prepare("SELECT unavailable_reason FROM workflow_steps WHERE id='needs-base'").get().unavailable_reason, null);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an expired holder releases its resources by the same bounded recovery as its execution lease", () => {
  const root = temporaryRoot("zodchi-resource-expiry-");
  const base = path.join(root, "infobase");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "1Cv8.1CD"), "");
  const write = { kind: "1c.file", mode: "exclusive", path: base };
  const { db } = fixture(root, [
    { key: "crashed", ordinal: 1, resources: [write] },
    { key: "waiting", ordinal: 1, resources: [write] }
  ]);
  const queue = new ExecutionQueue(db);
  const start = Date.parse("2026-01-01T00:00:00.000Z");

  const crashed = queue.checkout({ ownerId: "crashing", leaseMs: 1000, at: start });
  queue.start(crashed.token, start + 100);
  assert.equal(queue.checkout({ ownerId: "waiting", at: start + 200 }), null);

  // A heartbeat extends the resource with the attempt; without that a live attempt would lose its lock.
  queue.heartbeat(crashed.token, { leaseMs: 1000, at: start + 500 });
  assert.equal(db.prepare("SELECT expires_at FROM resource_leases WHERE step_id='crashed' AND released_at IS NULL").get().expires_at, new Date(start + 1500).toISOString());
  assert.equal(queue.checkout({ ownerId: "waiting", at: start + 1200 }), null);

  // Recovery is bounded by the expiry the lease was given, not by anything inferred about the holder.
  queue.recoverExpiredLeases(start + 2000);
  assert.equal(held(db, "crashed")[0].release_reason, "expired");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM resource_leases WHERE released_at IS NULL").get().count, 0);
  const next = queue.checkout({ ownerId: "waiting", at: start + 2100 });
  assert.equal(next.resources[0].identity, `1c.file:${fs.realpathSync.native(base)}`);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a step that declared a write cannot start without holding it", () => {
  const root = temporaryRoot("zodchi-resource-receipt-");
  const base = path.join(root, "infobase");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "1Cv8.1CD"), "");
  const { db } = fixture(root, [{ key: "write", ordinal: 1, resources: [{ kind: "1c.file", mode: "exclusive", path: base }] }]);
  const queue = new ExecutionQueue(db);
  const checkout = queue.checkout({ ownerId: "worker" });

  // Releasing the lock behind the queue's back is the only way to reach this, and it is exactly what the
  // guard is for: without it the record would still claim the write was serialized.
  db.prepare("UPDATE resource_leases SET released_at=?,release_reason='test' WHERE step_id='write'").run(now());
  assert.throws(() => queue.start(checkout.token), /RESOURCE_RECEIPT_MISSING/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
