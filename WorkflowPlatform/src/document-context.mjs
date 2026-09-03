import fs from "node:fs";
import path from "node:path";
import { normalizeSemanticScope } from "./semantic-scope.mjs";
import { execFileSync } from "node:child_process";
import { documentLint } from "./lint.mjs";
import { projectRoots, primaryRoot, findRoot, resolveInRoot, displayPath } from "./project-roots.mjs";
import { sourceInventory, inventorySummary, sourceScope } from "./source-context.mjs";

const values = (text, pattern) => [...text.matchAll(pattern)].map(match => match[1]).filter(Boolean);

function summarize(file, text) {
  const statuses = {};
  for (const status of values(text, /status=["']([^"']+)["']/g)) statuses[status] = (statuses[status] ?? 0) + 1;
  const links = [];
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
    const target = match[1];
    if (!target.startsWith("http")) links.push({ target, exists: fs.existsSync(path.resolve(path.dirname(file), target)) });
  }
  return {
    bytes: Buffer.byteLength(text), statuses, ids: values(text, /\bid=["']([^"']+)["']/g).slice(0, 80),
    versions: values(text, /\bversion=["']([^"']+)["']/g), rules: values(text, /<rule\b[^>]*\bid=["']([^"']+)["']/g),
    headings: text.split(/\r?\n/).filter(line => /^#{1,4}\s/.test(line)).slice(0, 50).map(line => line.replace(/^#+\s*/, "")), links
  };
}

// A reference document is a manifest or an index its own tool owns and formats. Holding it to the
// semantic document format would report every one of them as failing forever, and the report is read
// by the roles, so the noise would be permanent and would mean nothing.
function registeredDocumentLint(documentType, exists, text, file, db, projectId) {
  if (documentType === "reference") return { kind: "document", file, status: "not_applicable", errors: [] };
  return exists ? documentLint(text, file, db, { projectId }) : { status: "missing", errors: [] };
}

function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }

function gitSnapshot(projectRoot, enabled) {
  if (!enabled) return { enabled: false, status: "not_requested" };
  const run = args => execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
  try {
    const top = run(["rev-parse", "--show-toplevel"]);
    if (path.resolve(top) !== path.resolve(projectRoot)) return { enabled: true, status: "root_mismatch" };
    return {
      enabled: true,
      status: "available",
      head: run(["rev-parse", "HEAD"]),
      worktree: run(["status", "--porcelain=v1", "-uno"]).split(/\r?\n/).filter(Boolean).slice(0, 200),
      history: run(["log", "-5", "--pretty=format:%H%x09%aI%x09%s"]).split(/\r?\n/).filter(Boolean)
    };
  } catch (error) {
    return { enabled: true, status: "unavailable", category: error.code === "ENOENT" ? "git_not_installed" : "git_not_repository" };
  }
}

export function readProjectContext(projectSelector, db, _workingDocuments = [], options = {}) {
  if (!db) throw new Error("DISCOVERY_DATABASE_REQUIRED");
  const project = db.prepare("SELECT * FROM projects WHERE id=? OR lower(root_path)=lower(?) LIMIT 1").get(projectSelector, path.resolve(projectSelector));
  if (!project) throw new Error(`DISCOVERY_PROJECT_NOT_REGISTERED: ${projectSelector}`);
  const workflows = db.prepare("SELECT * FROM workflows WHERE project_id=? AND status='active' ORDER BY id").all(project.id)
    .filter(item => !options.workflowId || item.id === options.workflowId);
  if (options.workflowId && !workflows.length) throw new Error(`DISCOVERY_WORKFLOW_NOT_REGISTERED: ${options.workflowId}`);
  const discoveryConfig = parseJson(workflows[0]?.discovery_json ?? "{}", {});
  const documentRows = db.prepare(`SELECT pd.*,
      COALESCE(GROUP_CONCAT(CASE WHEN rd.read_access=1 THEN rd.role_id END, ','),'') AS read_roles,
      COALESCE(GROUP_CONCAT(CASE WHEN rd.write_access=1 THEN rd.role_id END, ','),'') AS write_roles
    FROM project_documents pd LEFT JOIN role_documents rd ON rd.document_id=pd.id AND rd.project_id=pd.project_id
    WHERE pd.project_id=? AND pd.active=1 GROUP BY pd.id ORDER BY pd.path`).all(project.id);
  const roots = projectRoots(db, project.id);
  const documents = documentRows.map(row => {
    if (path.isAbsolute(row.path)) throw new Error(`DISCOVERY_DOCUMENT_PATH_MUST_BE_RELATIVE: ${row.path}`);
    const root = findRoot(roots, row.root_key);
    const file = resolveInRoot(root, row.path);
    const exists = fs.existsSync(file) && fs.statSync(file).isFile();
    const text = exists ? fs.readFileSync(file, "utf8") : "";
    return {
      id: row.id, path: displayPath(root, row.path), root: root.key, relative_path: row.path.replaceAll("\\", "/"),
      document_type: row.document_type, authority: row.authority,
      read_roles: row.read_roles.split(",").filter(Boolean).sort(),
      // A document on a read-only root cannot be written whatever the role bindings say, and the write
      // is refused when it is attempted. Advertising it here would send a role to spend its one call
      // producing a patch that is rejected on arrival, so the binding is dropped where it cannot hold.
      write_roles: root.access === "write" ? row.write_roles.split(",").filter(Boolean).sort() : [],
      exists, text, ...summarize(file, text), lint: registeredDocumentLint(row.document_type, exists, text, file, db, project.id)
    };
  });
  const broken_links = documents.flatMap(document => document.links.filter(link => !link.exists).map(link => ({ from: document.path, target: link.target })));
  const open_points = documents.flatMap(document => Object.entries(document.statuses).filter(([status]) => status === "open").map(([, count]) => ({ path: document.path, count })));
  const goals = db.prepare("SELECT id,title,status FROM goals WHERE project_id=? ORDER BY created_at,id").all(project.id);
  const stages = db.prepare("SELECT id,goal_id,stage_key,title,status,ordinal FROM stages WHERE project_id=? ORDER BY ordinal,id").all(project.id);
  const checks = db.prepare(`SELECT cd.id,cd.name,cd.runner,pc.quality_mode_id,pc.required
    FROM project_checks pc JOIN check_definitions cd ON cd.id=pc.check_id
    WHERE pc.project_id=? ORDER BY pc.quality_mode_id,cd.id`).all(project.id);
  const roles = db.prepare("SELECT DISTINCT r.id,r.name FROM roles r JOIN role_documents rd ON rd.role_id=r.id WHERE rd.project_id=? ORDER BY r.id").all(project.id);
  const profiles = db.prepare(`SELECT DISTINCT p.id,p.provider,p.name,p.role_id FROM profiles p
    JOIN role_documents rd ON rd.role_id=p.role_id WHERE rd.project_id=? ORDER BY p.id`).all(project.id);
  // Every run records a decision, so an unbounded history grows into every role prompt until nothing
  // fits. Artifacts are already bounded the same way; the most recent decisions are the ones a role can
  // still act on, and they are returned oldest-first so the reading order stays chronological.
  const decisions = db.prepare("SELECT id,kind,outcome,source,structured_json,created_at FROM decisions WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND active=1 ORDER BY created_at DESC,id DESC LIMIT 50").all(project.id)
    .map(row => ({ ...row, structured: parseJson(row.structured_json, null), structured_json: undefined })).reverse();
  const pending = db.prepare("SELECT id,kind,question,status,created_at FROM approvals WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND status='pending' ORDER BY created_at,id").all(project.id);
  const artifacts = db.prepare("SELECT id,kind,uri,content_hash,status,provenance_json FROM artifacts WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND status NOT IN ('rejected','superseded') ORDER BY created_at,id LIMIT 200").all(project.id)
    .map(row => ({ ...row, provenance: parseJson(row.provenance_json, null), provenance_json: undefined }));
  return {
    project: { id: project.id, name: project.name, root_path: project.root_path }, workflows, goals, stages, checks, roles, profiles,
    // Each root carries its own history, so one snapshot of the primary would describe only half of an
    // integration. `git` stays the primary root's snapshot because that is what it has always meant.
    roots: roots.map(root => ({ ...root, git: gitSnapshot(root.path, discoveryConfig.git === true) })),
    // Collection reads the project so the roles do not have to. The inventory is what lets a plan name a
    // path it has not been shown the contents of; the contents follow, for the paths the plan allowed.
    sources: sourceInventory(roots, sourceScope(discoveryConfig.sources), { maxFilesPerRoot: discoveryConfig.max_files_per_root ?? 400 }),
    source_scope: discoveryConfig.sources ?? [],
    documents, missing: documents.filter(document => !document.exists).map(document => document.path), open_points, broken_links,
    decisions, pending_interactions: pending, artifacts, git: gitSnapshot(primaryRoot(roots).path, discoveryConfig.git === true)
  };
}

export function compactProjectSnapshot(discovery) {
  return {
    project: { id: discovery.project.id, name: discovery.project.name },
    // A role that is not told where the other end lives cannot look at it, and a role that is not told
    // the other end is read-only will plan to change it.
    roots: (discovery.roots ?? []).map(root => ({ key: root.key, path: root.path, access: root.access, primary: root.primary })),
    sources: inventorySummary(discovery.sources ?? []),
    workflows: discovery.workflows.map(workflow => ({ id: workflow.id, name: workflow.name, default_quality: workflow.default_quality, default_level: workflow.default_level })),
    goals: discovery.goals, stages: discovery.stages, checks: discovery.checks, roles: discovery.roles,
    documents: discovery.documents.map(document => ({ id: document.id, path: document.path, document_type: document.document_type, authority: document.authority, exists: document.exists, bytes: document.bytes, headings: document.headings, statuses: document.statuses, lint_status: document.lint.status })),
    missing: discovery.missing, open_points: discovery.open_points, broken_links: discovery.broken_links, artifacts: discovery.artifacts,
    git: discovery.git
  };
}

export function selectProjectContext(discovery, classification = {}, _workingDocuments = [], _db = null, _projectId = null, roleId = null) {
  const selectedRole = roleId ?? classification.role_id ?? classification.discipline ?? null;
  const documents = discovery.documents.filter(document => selectedRole && document.read_roles.includes(selectedRole));
  return {
    ...discovery,
    documents,
    selected_for: { role_id: selectedRole, discipline: classification.discipline ?? null, artifact_type: classification.artifact_type ?? classification.artifact ?? null },
    authority_files: documents.map(document => document.path),
    materials: discovery.artifacts
  };
}

export function classifierStateContext(db, projectId, contextBudgetBytes, semanticScope = null, { excludeRunId = null } = {}) {
  if (!Number.isInteger(contextBudgetBytes) || contextBudgetBytes < 1) throw new Error("CLASSIFIER_STATE_CONTEXT_BUDGET_REQUIRED");
  // Accepted owner decisions are project truth and intentionally cross chat boundaries. The chat itself
  // contributes one current semantic snapshot, not a trailing message window. Older wording remains in
  // conversation_messages for audit and can be retrieved by exact run or interaction id.
  const scope = normalizeSemanticScope(semanticScope);
  const sessionBound = scope.mode === "session";
  const acceptedDecisions = db.prepare("SELECT id,kind,outcome,source,structured_json FROM decisions WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND active=1 AND outcome='APPROVE' ORDER BY created_at DESC,id DESC LIMIT 50").all(projectId)
    .map(row => ({ id: row.id, kind: row.kind, outcome: row.outcome, source: row.source, structured: parseJson(row.structured_json, null) })).reverse();
  const previous = sessionBound ? db.prepare(`SELECT wr.id AS run_id,wr.task_id,wr.workflow_id,wr.state AS run_state,wr.user_message,
      wr.resolved_objective,wr.response_language,t.state AS task_state,t.goal_id,t.stage_id,g.title AS goal_title,s.stage_key,s.title AS stage_title
    FROM zodchi_chat_session_runs csr JOIN workflow_runs wr ON wr.id=csr.run_id JOIN tasks t ON t.id=wr.task_id
    LEFT JOIN goals g ON g.id=t.goal_id LEFT JOIN stages s ON s.id=t.stage_id
    WHERE csr.client=? AND csr.session_id=? AND wr.project_id=? AND (? IS NULL OR wr.id<>?)
    ORDER BY csr.bound_at DESC,wr.created_at DESC,wr.id DESC LIMIT 1`).get(scope.client, scope.session_id, projectId, excludeRunId, excludeRunId) : null;
  const currentSessionState = previous ? {
    run_id: previous.run_id, task_id: previous.task_id, workflow_id: previous.workflow_id,
    current_state: { task: previous.task_state, run: previous.run_state },
    owner_objective: { verbatim: previous.user_message }, resolved_objective: previous.resolved_objective ?? previous.user_message,
    strategic_binding: previous.goal_id ? { goal_id: previous.goal_id, goal_title: previous.goal_title, stage_id: previous.stage_id, stage_key: previous.stage_key, stage_title: previous.stage_title } : null,
    last_response: db.prepare("SELECT content FROM conversation_messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 1").get(previous.run_id)?.content ?? null,
    open_interactions: db.prepare("SELECT id,kind,question,status FROM approvals WHERE task_id=? AND status='pending' ORDER BY created_at,id").all(previous.task_id),
    artifacts: db.prepare("SELECT id,kind,uri,content_hash,status FROM artifacts WHERE run_id=? AND status NOT IN ('rejected','superseded') ORDER BY created_at DESC,id DESC LIMIT 50").all(previous.run_id).reverse(),
    checks: db.prepare("SELECT id,kind,required,status FROM gates WHERE run_id=? ORDER BY rowid DESC LIMIT 50").all(previous.run_id).reverse().map(row => ({ ...row, required: Boolean(row.required) })),
    evidence: db.prepare("SELECT id,kind,evidence_hash FROM run_evidence WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 20").all(previous.run_id).reverse()
  } : null;
  const result = { accepted_decisions: acceptedDecisions, current_session_state: currentSessionState, budget_bytes: contextBudgetBytes };
  const bytes = () => Buffer.byteLength(JSON.stringify(result));
  while (bytes() > contextBudgetBytes && result.current_session_state?.evidence.length) result.current_session_state.evidence.shift();
  while (bytes() > contextBudgetBytes && result.current_session_state?.artifacts.length) result.current_session_state.artifacts.shift();
  while (bytes() > contextBudgetBytes && result.accepted_decisions.length) result.accepted_decisions.shift();
  if (bytes() > contextBudgetBytes && result.current_session_state?.last_response) result.current_session_state.last_response = null;
  if (bytes() > contextBudgetBytes) {
    throw new Error(`CLASSIFIER_STATE_CONTEXT_OVERFLOW: ${bytes()}/${contextBudgetBytes}`);
  }
  return { ...result, bytes: bytes() };
}
