import { id, now } from "./db.mjs";
import { RESOURCE_KINDS, RESOURCE_MODES, normalizeResourceDeclaration } from "./resource-locks.mjs";

// The alias is the only thing a plan may say about a resource. It is the project's own name for
// something the installation bound to a real authority, so a planner chooses between resources the owner
// registered instead of writing paths and hostnames of its own: an authority a model composes names
// whatever that string happens to resolve to, and a second spelling of one resource is a second lock.
const ALIAS = /^[a-z0-9][a-z0-9._-]*$/;

export function registerProjectResource(db, { projectId, alias, kind, purpose = null, declaration = null }) {
  if (typeof alias !== "string" || !ALIAS.test(alias)) throw new Error(`RESOURCE_ALIAS_INVALID: ${alias}`);
  if (!RESOURCE_KINDS.includes(kind)) throw new Error(`RESOURCE_KIND_UNKNOWN: ${kind}`);
  // The mode belongs to the step that takes the resource, not to the resource, so a declaration is stored
  // without one and normalized against the weaker of the two.
  const stored = declaration ? (({ mode, ...rest }) => rest)(normalizeResourceDeclaration({ ...declaration, kind, mode: "shared" })) : null;
  const timestamp = now();
  const existing = db.prepare("SELECT id,kind,declaration_json FROM project_resources WHERE project_id=? AND alias=?").get(projectId, alias);
  if (existing) {
    if (existing.kind !== kind) throw new Error(`RESOURCE_ALIAS_KIND_MISMATCH: ${alias}: ${existing.kind} != ${kind}`);
    db.prepare("UPDATE project_resources SET kind=?,purpose=?,declaration_json=?,updated_at=? WHERE id=?")
      .run(kind, purpose, stored ? JSON.stringify(stored) : existing.declaration_json, timestamp, existing.id);
    return existing.id;
  }
  const resourceId = id("resource");
  db.prepare("INSERT INTO project_resources(id,project_id,alias,kind,purpose,declaration_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(resourceId, projectId, alias, kind, purpose, stored ? JSON.stringify(stored) : null, timestamp, timestamp);
  return resourceId;
}

// A package may require an alias and its kind, but never carries the machine authority behind it. On an
// existing installation this preserves the binding; on a new one it creates an explicit unbound
// requirement whose steps remain `unavailable` until the owner supplies the authority.
export function declareProjectResourceRequirement(db, { projectId, alias, kind, purpose = null }) {
  return registerProjectResource(db, { projectId, alias, kind, purpose, declaration: null });
}

export function projectResources(db, projectId) {
  return db.prepare("SELECT alias,kind,purpose,declaration_json FROM project_resources WHERE project_id=? ORDER BY alias").all(projectId)
    .map(row => Object.freeze({ alias: row.alias, kind: row.kind, purpose: row.purpose, declaration: row.declaration_json ? JSON.parse(row.declaration_json) : null }));
}

// What a planner is shown and validated against: the aliases it may choose from, without the authorities
// behind them, which are neither the model's business nor safe to put in a prompt.
export function registeredResources(db, projectId) {
  return projectResources(db, projectId).map(item => ({ alias: item.alias, kind: item.kind, purpose: item.purpose, modes: RESOURCE_MODES }));
}

// An alias with no declaration resolves to a declaration that cannot produce an identity, which is
// exactly what `unavailable` is for: the step is not attempted, nothing is locked, and the next checkout
// tries again once the owner binds it.
export function aliasDeclarations(db, projectId, declared = []) {
  if (!Array.isArray(declared)) throw new Error("RESOURCE_DECLARATION_INVALID: expected a list");
  const registered = new Map(projectResources(db, projectId).map(item => [item.alias, item]));
  return declared.map(item => {
    const alias = String(item?.alias ?? "");
    const mode = item?.mode;
    if (!registered.has(alias)) throw new Error(`RESOURCE_ALIAS_UNKNOWN: ${alias}`);
    if (!RESOURCE_MODES.includes(mode)) throw new Error(`RESOURCE_MODE_INVALID: ${alias} declared ${mode}`);
    const found = registered.get(alias);
    return { ...(found.declaration ?? {}), kind: found.kind, mode, alias };
  });
}

// Every project has a working tree, whether or not it is a repository and whether or not anyone declared
// it. Registering it during onboarding is what makes the implicit resource of a write-capable step
// resolvable, so a plan that names no resource at all still cannot have two workers writing one checkout.
export const WORKTREE_ALIAS = "project.worktree";

export function registerImplicitResources(db, { projectId, rootPath }) {
  registerProjectResource(db, { projectId, alias: WORKTREE_ALIAS, kind: "project.worktree", purpose: "The project working tree", declaration: { path: rootPath } });
}
