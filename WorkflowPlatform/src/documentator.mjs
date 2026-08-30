import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { documentLint } from "./lint.mjs";
import { validateDocumentPatch } from "../contracts/schemas.mjs";
import { id, now } from "./db.mjs";
import { projectRoots, findRoot, resolveInRoot } from "./project-roots.mjs";

const esc = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const versionOf = text => text ? `sha256:${crypto.createHash("sha256").update(text).digest("hex")}` : null;

function assertInside(file, projectRoot) {
  if (!projectRoot) throw new Error("documentator: project root is required");
  const root = path.resolve(projectRoot), target = path.resolve(file);
  if (target !== root && !target.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) throw new Error(`documentator: file is outside project root: ${target}`);
}

function updateAttribute(text, tag, targetId, attribute, value) {
  const expression = targetId ? new RegExp(`(<${tag}\\b[^>]*\\bid=["']${esc(targetId)}["'][^>]*)(>)`, "i") : new RegExp(`(<${tag}\\b[^>]*)(>)`, "i");
  if (!expression.test(text)) throw new Error(`documentator: target ${targetId ?? tag} not found`);
  return text.replace(expression, (_, head, close) => {
    const existing = new RegExp(`\\s${attribute}=["'][^"']*["']`, "i");
    return `${head.replace(existing, "")} ${attribute}="${value}"${close}`;
  });
}

function appendInsideDocument(text, block) {
  if (/<\/document>\s*$/i.test(text)) return text.replace(/\s*<\/document>\s*$/i, `\n${block}\n</document>\n`);
  return `${text.trimEnd()}\n${block}\n`;
}

function qualityBlock(runId, outcome) {
  if (!outcome) return null;
  const safeId = String(runId ?? "run").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `<quality_result id="quality_${safeId}" status="${outcome.technical_status}" evidence="${outcome.evidence_type}" kind="${outcome.documentation_policy}" quality="${outcome.quality_level}" contract_version="${outcome.contract_version}" decision_status="${outcome.decision_status}">The ${outcome.quality_level} result was recorded from programmatic checks; owner decision: ${outcome.decision_status}.</quality_result>`;
}

function renderAfter(before, patch, { runId = null, qualityOutcome = null } = {}) {
  let rendered;
  switch (patch.operation) {
    case "create_document": if (before) throw new Error("documentator: document already exists"); rendered = patch.content; break;
    case "update_section": {
      const expression = new RegExp(`(<section\\b[^>]*\\bid=["']${esc(patch.section_id)}["'][^>]*>)[\\s\\S]*?(</section>)`, "i");
      if (!expression.test(before)) throw new Error(`documentator: section not found: ${patch.section_id}`);
      rendered = before.replace(expression, `$1\n${patch.content}\n$2`); break;
    }
    case "append_decision": rendered = appendInsideDocument(before, `<decision id="${patch.decision_id ?? `decision_${Date.now()}`}" status="${patch.status ?? qualityOutcome?.decision_status ?? "proposed"}" authority="${patch.authority}">${patch.content}</decision>`); break;
    case "append_evidence": rendered = appendInsideDocument(before, `<evidence id="${patch.evidence_id ?? `evidence_${Date.now()}`}" status="verified" evidence="${qualityOutcome?.evidence_type ?? "observation"}" authority="${patch.authority}">${patch.content}</evidence>`); break;
    case "change_status": rendered = updateAttribute(before, patch.target_tag ?? "document", patch.target_id, "status", patch.status); break;
    case "supersede_document": {
      if (!patch.replacement_id) throw new Error("documentator: replacement_id is required");
      const marked = updateAttribute(before, "document", undefined, "status", "superseded");
      rendered = appendInsideDocument(marked, `<superseded_by id="${patch.replacement_id}" authority="${patch.authority}" status="accepted">${patch.content}</superseded_by>`); break;
    }
    case "create_plan": if (!/<plan\b/i.test(patch.content)) throw new Error("documentator: create_plan requires a <plan> block"); rendered = appendInsideDocument(before, patch.content); break;
    case "create_package_record": if (!/<package\b/i.test(patch.content)) throw new Error("documentator: create_package_record requires a <package> block"); rendered = appendInsideDocument(before, patch.content); break;
    default: throw new Error(`documentator: unsupported operation ${patch.operation}`);
  }
  const record = qualityBlock(runId, qualityOutcome);
  return record ? appendInsideDocument(rendered, record) : rendered;
}

function atomicReplace(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function applyPatch({ file, patch, runId, db, projectRoot, projectId = null, documentId = null, roleId = null, qualityOutcome = null }) {
  validateDocumentPatch(patch);
  assertInside(file, projectRoot);
  if (!patch.authority || typeof patch.authority !== "string") throw new Error("documentator: authority is required");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const beforeVersion = versionOf(before);
  if (patch.expected_version !== undefined && patch.expected_version !== beforeVersion) throw new Error(`DOCUMENT_VERSION_CONFLICT: expected ${patch.expected_version}, current ${beforeVersion}`);
  if (qualityOutcome) {
    if (!db?.prepare("SELECT 1 FROM semantic_statuses WHERE id=?").get(qualityOutcome.technical_status)) throw new Error(`documentator: unknown quality status ${qualityOutcome.technical_status}`);
    if (!db.prepare("SELECT 1 FROM semantic_statuses WHERE id=?").get(qualityOutcome.decision_status)) throw new Error(`documentator: unknown decision status ${qualityOutcome.decision_status}`);
    if (!db.prepare("SELECT 1 FROM evidence_types WHERE id=?").get(qualityOutcome.evidence_type)) throw new Error(`documentator: unknown evidence type ${qualityOutcome.evidence_type}`);
    if ((patch.status === "accepted" || patch.operation === "supersede_document") && qualityOutcome.decision_status !== "accepted") throw new Error("DOCUMENT_OWNER_ACCEPTANCE_REQUIRED");
  }
  const after = renderAfter(before, patch, { runId, qualityOutcome });
  const lint = documentLint(after, file, db, { projectId });
  if (lint.status !== "passed") throw new Error(`documentator: document lint failed: ${lint.errors.join("; ")}`);
  const afterVersion = versionOf(after);
  try {
    atomicReplace(file, after);
    if (db) {
      db.prepare("INSERT INTO document_operations(id,run_id,operation,document_path,authority,status,before_version,after_version,document_id,expected_version,rollback_status,quality_level,quality_contract_version,evidence_type,decision_status) VALUES(?,?,?,?,?,'applied',?,?,?,?, 'not_required',?,?,?,?)")
        .run(id("document_operation"), runId, patch.operation, file, patch.authority, beforeVersion, afterVersion, documentId, patch.expected_version ?? null, qualityOutcome?.quality_level ?? null, qualityOutcome?.contract_version ?? null, qualityOutcome?.evidence_type ?? null, qualityOutcome?.decision_status ?? null);
      db.prepare("INSERT INTO lint_results(id,run_id,kind,status,error_count) VALUES(?,?, 'document',?,?)")
        .run(id("lint"), runId, lint.status, (lint.errors ?? []).length);
    }
  } catch (error) {
    try { if (before) atomicReplace(file, before); else fs.rmSync(file, { force: true }); } catch {}
    throw error;
  }
  return { runId, file, documentId, roleId, authority: patch.authority, operation: patch.operation, beforeVersion, afterVersion, diff: { beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) }, lint, status: "applied" };
}

export function applyRegisteredPatch({ db, runId, projectId, projectRoot, roleId, proposal, qualityOutcome = null }) {
  const document = db.prepare(`SELECT pd.*,rd.write_access FROM project_documents pd
    JOIN role_documents rd ON rd.document_id=pd.id AND rd.project_id=pd.project_id
    WHERE pd.id=? AND pd.project_id=? AND pd.active=1 AND rd.role_id=?`).get(proposal.document_id, projectId, roleId);
  if (!document || document.write_access !== 1) throw new Error(`DOCUMENT_WRITE_NOT_AUTHORIZED: ${proposal.document_id}`);
  if (proposal.authority !== document.authority) throw new Error(`DOCUMENT_AUTHORITY_MISMATCH: ${proposal.authority}`);
  // The root decides what may happen to the document, and it decides before the role bindings do. A read
  // root is registered so a run can see the other end of an integration; a document living there belongs
  // to the project that owns that directory, and a write from here would edit another project's files
  // outside its own workflow, its own checks and its own review.
  const roots = projectRoots(db, projectId);
  const root = findRoot(roots, document.root_key);
  if (root.access !== "write") throw new Error(`DOCUMENT_ROOT_IS_READ_ONLY: ${root.key}:${document.path}`);
  const file = resolveInRoot(root, document.path);
  assertInside(file, root.path);
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const currentVersion = versionOf(before);
  if (before && proposal.expected_version !== currentVersion) throw new Error(`DOCUMENT_VERSION_CONFLICT: expected ${proposal.expected_version}, current ${currentVersion}`);
  if (!before && proposal.expected_version !== null) throw new Error(`DOCUMENT_VERSION_CONFLICT: new document expects null, got ${proposal.expected_version}`);
  const patch = {
    operation: proposal.operation, authority: proposal.authority, expected_version: proposal.expected_version,
    ...(proposal.content !== null ? { content: proposal.content } : {}),
    ...(proposal.section_id !== null ? { section_id: proposal.section_id } : {}),
    ...(proposal.decision_id !== null ? { decision_id: proposal.decision_id } : {}),
    ...(proposal.evidence_id !== null ? { evidence_id: proposal.evidence_id } : {}),
    ...(proposal.status_value !== null ? { status: proposal.status_value } : {}),
    ...(proposal.target_tag !== null ? { target_tag: proposal.target_tag } : {}),
    ...(proposal.target_id !== null ? { target_id: proposal.target_id } : {}),
    ...(proposal.replacement_id !== null ? { replacement_id: proposal.replacement_id } : {})
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = applyPatch({ file, patch, runId, db, projectRoot: root.path, projectId, documentId: document.id, roleId, qualityOutcome });
    db.prepare("UPDATE project_documents SET version=version+1,content_hash=?,updated_at=? WHERE id=?").run(result.afterVersion, now(), document.id);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    try { if (before) atomicReplace(file, before); else fs.rmSync(file, { force: true }); } catch {}
    throw error;
  }
}

export function documentVersion(file) { return fs.existsSync(file) ? versionOf(fs.readFileSync(file, "utf8")) : null; }
