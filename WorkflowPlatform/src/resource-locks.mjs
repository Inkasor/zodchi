import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { id } from "./db.mjs";
import { appendEvent } from "./state-machine.mjs";

// A lock is on a resource, and a resource is named by what it actually is. Locking the project root
// instead is the failure this exists to prevent: two worktrees of one repository are two indices and one
// set of refs, a project directory holding a file information base is one base whatever path was typed to
// reach it, and a database on a host is the same database for every project that connects to it. A root
// path answers none of those questions, so a root-scoped lock is at once too coarse — one step touching
// one file makes the whole project single-threaded — and too narrow, because two projects writing the
// same information base never collide at all.
//
// Identity is `<kind>:<authority>`. The authority is canonical: real paths for anything on disk, so case
// and symlinks and relative spellings converge; host, port, infobase and database written out in the
// form the connection actually uses, so a default port is stated rather than implied. DNS aliases are
// deliberately not resolved — a name that resolves today and elsewhere tomorrow would make identity
// depend on the network, and two steps could then agree to collide or not by accident.

export const RESOURCE_MODES = Object.freeze(["shared", "exclusive"]);
export const RESOURCE_KINDS = Object.freeze(["project.worktree", "repo.index", "repo.refs", "1c.file", "1c.server", "db", "db.clickhouse.cluster"]);

const RESOURCE_FIELDS = Object.freeze({
  "project.worktree": ["path"],
  "repo.index": ["path"],
  "repo.refs": ["path"],
  "1c.file": ["path"],
  "1c.server": ["server", "infobase"],
  db: ["engine", "host", "database"],
  "db.clickhouse.cluster": ["cluster"]
});

const ONE_C_FILE_MARKER = "1Cv8.1CD";
const ONE_C_DEFAULT_PORT = 1541;

function unresolved(kind, detail) {
  const error = new Error(`RESOURCE_IDENTITY_UNRESOLVED: ${kind}: ${detail}`);
  error.code = "RESOURCE_IDENTITY_UNRESOLVED";
  error.kind = kind;
  return error;
}

// `realpathSync.native` is what makes two spellings of one directory the same string on Windows, where
// the case a person types is not the case the filesystem holds.
function canonicalDirectory(kind, candidate) {
  if (!candidate) throw unresolved(kind, "no path was declared");
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) throw unresolved(kind, `${resolved} does not exist`);
  try { return (fs.realpathSync.native ?? fs.realpathSync)(resolved); }
  catch (error) { throw unresolved(kind, `${resolved} could not be resolved: ${error.message}`); }
}

function git(kind, cwd, argument) {
  const result = spawnSync("git", ["rev-parse", argument], { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw unresolved(kind, `git is not available: ${result.error.message}`);
  if (result.status !== 0) throw unresolved(kind, `${cwd} is not a git working tree`);
  const value = String(result.stdout).trim();
  if (!value) throw unresolved(kind, `git returned no ${argument} for ${cwd}`);
  return canonicalDirectory(kind, path.resolve(cwd, value));
}

// A host is compared, never contacted. Lowercasing is the whole normalization; an explicit port is
// written even when it is the default, so `srvr=host` and `srvr=host:1541` are one resource and not two.
function hostAndPort(kind, value, defaultPort) {
  if (!value) throw unresolved(kind, "no server was declared");
  const text = String(value).trim().toLowerCase();
  const separator = text.lastIndexOf(":");
  const bracketed = text.endsWith("]");
  const host = separator > 0 && !bracketed ? text.slice(0, separator) : text;
  const port = separator > 0 && !bracketed ? Number(text.slice(separator + 1)) : defaultPort;
  if (!host) throw unresolved(kind, `${value} has no host`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw unresolved(kind, `${value} has no usable port`);
  return { host, port };
}

function lower(kind, value, field) {
  if (value === undefined || value === null || String(value).trim() === "") throw unresolved(kind, `no ${field} was declared`);
  return String(value).trim().toLowerCase();
}

const RESOLVERS = Object.freeze({
  // The working tree a step writes into. Every write-capable step holds this one whether or not a plan
  // mentioned it: two workers editing one checkout at the same time is the commonest conflict there is,
  // and it needs no git — a project that is not a repository has a working tree all the same.
  "project.worktree": declaration => `project.worktree:${canonicalDirectory("project.worktree", declaration.path)}`,
  // Two worktrees of one repository have two indices and share one set of refs, which is why these are
  // separate resources rather than one lock on "the repository". Locking them together would serialise
  // work that never conflicts; locking neither loses the ref update that does.
  "repo.index": declaration => `repo.index:${git("repo.index", canonicalDirectory("repo.index", declaration.path), "--absolute-git-dir")}`,
  "repo.refs": declaration => `repo.refs:${git("repo.refs", canonicalDirectory("repo.refs", declaration.path), "--git-common-dir")}`,
  "1c.file": declaration => {
    const candidate = canonicalDirectory("1c.file", declaration.path);
    const directory = path.basename(candidate) === ONE_C_FILE_MARKER ? path.dirname(candidate) : candidate;
    if (!fs.existsSync(path.join(directory, ONE_C_FILE_MARKER))) throw unresolved("1c.file", `${directory} holds no ${ONE_C_FILE_MARKER}`);
    return `1c.file:${directory}`;
  },
  "1c.server": declaration => {
    const { host, port } = hostAndPort("1c.server", declaration.server, ONE_C_DEFAULT_PORT);
    return `1c.server:srvr=${host}:${port};ref=${lower("1c.server", declaration.infobase, "infobase")}`;
  },
  db: declaration => {
    const engine = lower("db", declaration.engine, "engine");
    // A database port has no single default across engines, so guessing one would make two spellings of
    // the same connection into two resources. The declaration states it.
    const { host, port } = hostAndPort("db", declaration.host, null);
    return `db:${engine}:${host}:${port}/${lower("db", declaration.database, "database")}`;
  },
  // A statement running ON CLUSTER changes every replica, so it conflicts with work on any of them. The
  // cluster is a resource of its own, declared alongside the node the statement is sent to.
  "db.clickhouse.cluster": declaration => `db.clickhouse.cluster:${lower("db.clickhouse.cluster", declaration.cluster, "cluster")}`
});

export function normalizeResourceDeclaration(declaration) {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) throw new Error("RESOURCE_DECLARATION_INVALID: expected an object");
  const kind = declaration.kind;
  if (!RESOURCE_KINDS.includes(kind)) throw new Error(`RESOURCE_KIND_UNKNOWN: ${kind}`);
  const mode = declaration.mode;
  if (!RESOURCE_MODES.includes(mode)) throw new Error(`RESOURCE_MODE_INVALID: ${kind} declared ${mode}`);
  const permitted = new Set(["kind", "mode", "alias", ...RESOURCE_FIELDS[kind]]);
  const unexpected = Object.keys(declaration).filter(field => !permitted.has(field));
  if (unexpected.length) throw new Error(`RESOURCE_DECLARATION_FIELDS_INVALID: ${kind}: ${unexpected.sort().join(",")}`);
  const normalized = { kind, mode };
  if (declaration.alias !== undefined) normalized.alias = String(declaration.alias);
  for (const field of RESOURCE_FIELDS[kind]) if (declaration[field] !== undefined) normalized[field] = declaration[field];
  return Object.freeze(normalized);
}

// An identity is always computed from the authority, never taken from the declaration. Accepting a
// stated one let the same resource be named two ways — one canonical, one as typed — and two names are
// two locks that do not see each other, which is the exact failure this whole file exists to prevent.
// A declaration that cannot be resolved on this machine is `unavailable`, which is honest and recovers
// by itself; a declaration allowed to name its own identity is wrong quietly and forever.
export function resourceIdentity(declaration) {
  const normalized = normalizeResourceDeclaration(declaration);
  return RESOLVERS[normalized.kind](normalized);
}

// Acquisition is ordered by identity string and release runs in reverse. Inside one transaction that
// ordering changes nothing, but the order is the contract: the moment acquisition spans anything that can
// wait, two steps taking the same pair in opposite orders is a deadlock, and an ordering nobody wrote
// down is one refactor away from being lost.
export function resolveStepResources(step) {
  const declared = JSON.parse(step.resources_json ?? "[]");
  if (!Array.isArray(declared)) throw new Error(`RESOURCE_DECLARATION_INVALID: ${step.step_key} declared a non-list`);
  const resolved = declared.map(declaration => ({ declaration: normalizeResourceDeclaration(declaration), identity: resourceIdentity(declaration) }));
  const seen = new Map();
  for (const item of resolved) {
    // One step declaring the same resource twice takes the stronger mode rather than two leases, which the
    // schema would refuse anyway.
    const previous = seen.get(item.identity);
    if (!previous || item.declaration.mode === "exclusive") seen.set(item.identity, item);
  }
  return [...seen.values()].sort((left, right) => left.identity.localeCompare(right.identity));
}

export function heldBy(db, identity, exceptStepId = null) {
  return db.prepare("SELECT * FROM resource_leases WHERE identity=? AND released_at IS NULL AND (? IS NULL OR step_id<>?) ORDER BY acquired_at,id").all(identity, exceptStepId, exceptStepId);
}

// Shared readers coexist. An exclusive writer waits for every reader and every other writer, and a reader
// waits for a writer. Nothing here blocks: the caller is told which identity is held by whom and moves on
// to another step, because a worker sleeping on a lock is a worker not doing the other work in the queue.
export function conflictFor(db, identity, mode, stepId) {
  const held = heldBy(db, identity, stepId);
  const blocking = mode === "exclusive" ? held : held.filter(lease => lease.mode === "exclusive");
  if (!blocking.length) return null;
  return Object.freeze({ identity, mode, held_by: blocking[0].step_id, held_mode: blocking[0].mode, holders: blocking.length });
}

export function acquireStepResources(db, { step, resources, runId, ownerId, tokenHash, leaseId, attemptId = null, acquiredAt, expiresAt }) {
  const acquired = [];
  for (const resource of resources) {
    const conflict = conflictFor(db, resource.identity, resource.declaration.mode, step.id);
    if (conflict) {
      // Reverse order on the way out, so a partial acquisition unwinds exactly as it was taken.
      releaseResourceLeases(db, acquired.map(item => item.id), "conflict", acquiredAt);
      return { acquired: null, conflict };
    }
    const resourceLeaseId = id("reslease");
    db.prepare("INSERT INTO resource_leases(id,identity,kind,mode,run_id,step_id,attempt_id,lease_id,owner_id,token_hash,acquired_at,expires_at,heartbeat_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(resourceLeaseId, resource.identity, resource.declaration.kind, resource.declaration.mode, runId, step.id, attemptId, leaseId, ownerId, tokenHash, acquiredAt, expiresAt, acquiredAt);
    acquired.push({ id: resourceLeaseId, identity: resource.identity, kind: resource.declaration.kind, mode: resource.declaration.mode });
  }
  if (acquired.length) appendEvent(db, { entityType: "workflow_step", entityId: step.id, kind: "resources_acquired", payload: { lease_id: leaseId, resources: acquired.map(item => ({ identity: item.identity, mode: item.mode })) } });
  return { acquired, conflict: null };
}

export function releaseResourceLeases(db, resourceLeaseIds, reason, at) {
  const ids = [...new Set(resourceLeaseIds ?? [])];
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id,identity FROM resource_leases WHERE released_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  const ordered = rows.sort((left, right) => right.identity.localeCompare(left.identity));
  const update = db.prepare("UPDATE resource_leases SET released_at=?,release_reason=? WHERE id=? AND released_at IS NULL");
  for (const row of ordered) update.run(at, reason, row.id);
  return ordered.map(row => row.id);
}

export function releaseResourcesOfLease(db, leaseId, reason, at) {
  const rows = db.prepare("SELECT id FROM resource_leases WHERE lease_id=? AND released_at IS NULL").all(leaseId);
  return releaseResourceLeases(db, rows.map(row => row.id), reason, at);
}

export function heldResources(db, stepId) {
  return db.prepare("SELECT identity,kind,mode FROM resource_leases WHERE step_id=? AND released_at IS NULL ORDER BY identity").all(stepId);
}
