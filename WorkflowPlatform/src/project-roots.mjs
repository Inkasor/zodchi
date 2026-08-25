import path from "node:path";

// The primary root is always first: it is the directory the project is addressed by, the working
// directory of every model invocation, and the root a registered document belongs to unless it says
// otherwise. The rest follow in a stable order so prompts and receipts do not change between runs for
// no reason.
export function projectRoots(db, projectId) {
  const rows = db.prepare("SELECT root_key,path,access,is_primary FROM project_roots WHERE project_id=? ORDER BY is_primary DESC,root_key").all(projectId);
  if (!rows.length) throw new Error(`PROJECT_HAS_NO_ROOTS: ${projectId}`);
  if (rows[0].is_primary !== 1) throw new Error(`PROJECT_PRIMARY_ROOT_MISSING: ${projectId}`);
  return rows.map(row => Object.freeze({ key: row.root_key, path: row.path, access: row.access, primary: row.is_primary === 1 }));
}

export function primaryRoot(roots) { return roots.find(root => root.primary); }

export function findRoot(roots, rootKey) {
  const root = roots.find(item => item.key === (rootKey ?? "primary"));
  if (!root) throw new Error(`PROJECT_ROOT_NOT_REGISTERED: ${rootKey}`);
  return root;
}

export function inside(rootPath, candidate) {
  const base = path.resolve(rootPath);
  const resolved = path.resolve(candidate);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

// A path escaping its root is the one failure that must never be resolved leniently: the root is the
// whole boundary, and a document that resolves outside it is reaching into a directory the owner never
// registered. Naming the root in the error matters because with several of them the message would
// otherwise not say which boundary was crossed.
export function resolveInRoot(root, relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error(`DOCUMENT_PATH_MUST_BE_RELATIVE: ${relativePath}`);
  const file = path.resolve(root.path, relativePath);
  if (!inside(root.path, file)) throw new Error(`DOCUMENT_OUTSIDE_ROOT: ${root.key}:${relativePath}`);
  return file;
}

// Two roots can each hold a docs/README.md, so a bare relative path stops identifying a document as soon
// as a project has more than one. Everything a role reads or names uses this form; the primary root
// keeps the unprefixed path it always had, so single-root projects read exactly as before.
export function displayPath(root, relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return root.primary ? normalized : `${root.key}/${normalized}`;
}

export function writableRoots(roots) { return roots.filter(root => root.access === "write"); }
export function readOnlyRoots(roots) { return roots.filter(root => root.access === "read"); }
