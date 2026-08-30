import crypto from "node:crypto";
import path from "node:path";
import { now } from "./db.mjs";
import { projectRoots, findRoot, resolveInRoot } from "./project-roots.mjs";

const semanticKey = (value, label) => {
  const normalized = String(value ?? "").trim();
  if (!/^[a-z][a-z0-9._-]*$/i.test(normalized)) throw new Error(`DOCUMENT_${label}_INVALID: ${value}`);
  return normalized;
};

const roleList = value => [...new Set(String(value ?? "").split(",").map(item => item.trim()).filter(Boolean))];
const documentId = (projectId, rootKey, relativePath) => `local_document_${crypto.createHash("sha256").update(`${projectId}:${rootKey}:${relativePath}`).digest("hex").slice(0, 20)}`;

function project(db, projectId) {
  const row = db.prepare("SELECT id FROM projects WHERE id=?").get(projectId);
  if (!row) throw new Error(`DOCUMENT_PROJECT_NOT_REGISTERED: ${projectId}`);
  return row;
}

function assertRoles(db, projectId, roles) {
  const available = new Set(db.prepare("SELECT role_id FROM role_contracts WHERE project_id=? AND status='active'").all(projectId).map(row => row.role_id));
  for (const role of roles) if (!available.has(role)) throw new Error(`DOCUMENT_ROLE_NOT_REGISTERED: ${projectId}:${role}`);
}

export function listControlledDocuments(db, projectId) {
  project(db, projectId);
  return db.prepare(`SELECT pd.id,pd.root_key,pd.path,pd.document_type,pd.authority,pd.status,pd.active,
      COALESCE(GROUP_CONCAT(CASE WHEN rd.read_access=1 THEN rd.role_id END, ','),'') AS read_roles,
      COALESCE(GROUP_CONCAT(CASE WHEN rd.write_access=1 THEN rd.role_id END, ','),'') AS write_roles
    FROM project_documents pd LEFT JOIN role_documents rd ON rd.project_id=pd.project_id AND rd.document_id=pd.id
    WHERE pd.project_id=? GROUP BY pd.id ORDER BY pd.active DESC,pd.root_key,pd.path`).all(projectId).map(row => ({
      ...row,
      read_roles: roleList(row.read_roles).sort(),
      write_roles: roleList(row.write_roles).sort()
    }));
}

export function registerControlledDocument(db, input) {
  const projectId = semanticKey(input.projectId, "PROJECT"), rootKey = semanticKey(input.rootKey ?? "primary", "ROOT");
  project(db, projectId);
  const root = findRoot(projectRoots(db, projectId), rootKey);
  const relativePath = String(input.path ?? "").trim().replaceAll("\\", "/");
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`DOCUMENT_PATH_INVALID: ${input.path}`);
  resolveInRoot(root, relativePath);
  const readRoles = roleList(input.readRoles), writeRoles = roleList(input.writeRoles);
  assertRoles(db, projectId, [...readRoles, ...writeRoles]);
  if (writeRoles.length && root.access !== "write") throw new Error(`DOCUMENT_ROOT_IS_READ_ONLY: ${rootKey}:${relativePath}`);
  const id = documentId(projectId, rootKey, relativePath), timestamp = now();
  const collision = db.prepare("SELECT id FROM project_documents WHERE project_id=? AND root_key=? AND path=?").get(projectId, rootKey, relativePath);
  const selectedId = collision?.id ?? id;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO project_documents(id,project_id,path,root_key,document_type,authority,status,active,version,updated_at)
      VALUES(?,?,?,?,?,?,?,1,0,?) ON CONFLICT(id) DO UPDATE SET document_type=excluded.document_type,authority=excluded.authority,status=excluded.status,active=1,updated_at=excluded.updated_at`)
      .run(selectedId, projectId, relativePath, rootKey, input.documentType ?? "reference", input.authority ?? "owner", input.status ?? "active", timestamp);
    db.prepare("DELETE FROM role_documents WHERE project_id=? AND document_id=?").run(projectId, selectedId);
    const binding = db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES(?,?,?,?,?,?,?)");
    for (const role of [...new Set([...readRoles, ...writeRoles])]) binding.run(projectId, role, selectedId, 1, Number(writeRoles.includes(role)), input.purpose ?? "owner-controlled project document", Number(input.priority ?? 0));
    db.exec("COMMIT");
    return { status: collision ? "updated" : "registered", project_id: projectId, document_id: selectedId, root: rootKey, path: relativePath, read_roles: readRoles, write_roles: writeRoles };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function unregisterControlledDocument(db, { projectId, rootKey = "primary", path: relativePath }) {
  project(db, projectId);
  const document = db.prepare("SELECT id,active FROM project_documents WHERE project_id=? AND root_key=? AND path=?").get(projectId, rootKey, String(relativePath).replaceAll("\\", "/"));
  if (!document) return { status: "not_registered", project_id: projectId, root: rootKey, path: relativePath };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM role_documents WHERE project_id=? AND document_id=?").run(projectId, document.id);
    db.prepare("UPDATE project_documents SET active=0,updated_at=? WHERE project_id=? AND id=?").run(now(), projectId, document.id);
    db.exec("COMMIT");
    return { status: document.active ? "unregistered" : "already_inactive", project_id: projectId, root: rootKey, path: relativePath };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function registerProjectDocumentVocabulary(db, { projectId, kind, key, name = null, category = "project" }) {
  project(db, projectId);
  const normalized = semanticKey(key, kind === "status" ? "STATUS" : "EVIDENCE_TYPE"), timestamp = now();
  if (kind === "status") db.prepare(`INSERT INTO project_semantic_statuses(project_id,status_id,name,category,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(project_id,status_id) DO UPDATE SET name=excluded.name,category=excluded.category`).run(projectId, normalized, name ?? normalized, category, timestamp);
  else if (kind === "evidence") db.prepare(`INSERT INTO project_evidence_types(project_id,evidence_type_id,name,created_at) VALUES(?,?,?,?)
    ON CONFLICT(project_id,evidence_type_id) DO UPDATE SET name=excluded.name`).run(projectId, normalized, name ?? normalized, timestamp);
  else throw new Error(`DOCUMENT_VOCABULARY_KIND_INVALID: ${kind}`);
  return { status: "registered", project_id: projectId, kind, key: normalized, name: name ?? normalized, ...(kind === "status" ? { category } : {}) };
}
