import { openDb } from "./db.mjs";

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function integer(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function duration(start, finish) {
  const value = Date.parse(finish ?? "") - Date.parse(start ?? "");
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function storageAudit(db) {
  const forbidden = new Set(["prompt", "raw_prompt", "output", "raw_output", "stdout", "stderr", "response"]);
  const gatewayColumns = db.prepare("PRAGMA table_info(gateway_calls)").all().map(row => row.name);
  const workflowResultColumns = db.prepare("PRAGMA table_info(workflow_steps)").all().map(row => row.name);
  const forbiddenGatewayColumns = gatewayColumns.filter(name => forbidden.has(name.toLowerCase()));
  return {
    raw_model_payloads_persisted: forbiddenGatewayColumns.length > 0,
    forbidden_gateway_columns: forbiddenGatewayColumns,
    gateway_storage: "receipt metadata, hashes and usage only",
    structured_role_results: workflowResultColumns.includes("result_json")
  };
}

export function workflowRunStatistics(dbFile, runId) {
  const db = openDb(dbFile);
  try {
    const run = db.prepare(`SELECT wr.*,w.name AS workflow_name,w.package_key,w.package_version,p.name AS project_name,p.root_path
      FROM workflow_runs wr JOIN workflows w ON w.id=wr.workflow_id JOIN projects p ON p.id=wr.project_id WHERE wr.id=?`).get(runId);
    if (!run) throw new Error(`WORKFLOW_RUN_NOT_FOUND: ${runId}`);
    const classificationRow = db.prepare(`SELECT c.*,d.structured_json FROM classifications c
      LEFT JOIN decisions d ON d.id=c.decision_id WHERE c.run_id=?`).get(runId);
    const classification = classificationRow ? parseJson(classificationRow.structured_json, {
      work_type: classificationRow.kind, artifact_type: classificationRow.artifact_type_id,
      domain: classificationRow.domain_id, discipline: classificationRow.discipline_id,
      risk: classificationRow.risk, level: classificationRow.planning_level_id,
      quality: classificationRow.quality_mode_id, reply_mode: classificationRow.reply_mode
    }) : null;
    const calls = db.prepare(`SELECT gc.*,a.ordinal AS attempt_no,s.step_key FROM gateway_calls gc
      LEFT JOIN attempts a ON a.id=gc.attempt_id LEFT JOIN workflow_steps s ON s.id=gc.step_id
      WHERE gc.run_id=? ORDER BY COALESCE(gc.started_at,''),gc.id`).all(runId).map(row => ({
      step: row.step_key ?? row.role_id ?? "unscoped", role: row.role_id, harness: row.provider, provider: row.provider,
      model_provider: row.model_provider,
      profile: row.profile_id, model: row.model, reasoning_effort: row.reasoning_effort,
      status: row.status, attempt_no: row.attempt_no, correction_cycles: row.correction_cycles,
      retries: row.retries, tokens: { input: row.input_tokens, cached: row.cached_tokens, output: row.output_tokens, reasoning: row.reasoning_tokens },
      duration_ms: row.duration_ms ?? duration(row.started_at, row.finished_at), receipt_id: row.receipt_id
    }));
    const attempts = db.prepare(`SELECT a.*,s.step_key FROM attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? ORDER BY s.ordinal,a.ordinal`).all(runId).map(row => ({
      step: row.step_key, attempt_no: row.ordinal, state: row.state, provider: row.provider, profile: row.profile,
      duration_ms: duration(row.started_at, row.finished_at), error_category: row.error_category
    }));
    const steps = db.prepare("SELECT step_key,role_id,state,created_at,updated_at FROM workflow_steps WHERE run_id=? ORDER BY ordinal").all(runId).map(row => ({
      key: row.step_key, role: row.role_id, state: row.state, duration_ms: duration(row.created_at, row.updated_at)
    }));
    const semanticCheck = checkId => db.prepare(`SELECT m.semantic_key FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id
      WHERE p.target_project_id=? AND p.status='applied' AND m.entity_type='check' AND m.local_id=? ORDER BY p.applied_at DESC LIMIT 1`).get(run.project_id, checkId)?.semantic_key ?? checkId;
    const gates = db.prepare("SELECT kind,required,status,duration_ms,details_json FROM gates WHERE run_id=? ORDER BY rowid").all(runId).map(row => {
      const details = parseJson(row.details_json, {});
      return { kind: row.kind, required: Boolean(row.required), status: row.status, duration_ms: row.duration_ms, checks: Array.isArray(details.checks) ? details.checks.map(check => ({ id: semanticCheck(check.id), local_id: check.id, name: check.name ?? null, required: Boolean(check.required), status: check.status, duration_ms: check.duration_ms ?? null, failure: check.failure ?? null })) : [] };
    });
    const artifacts = db.prepare("SELECT kind,uri,content_hash,status,provenance_json FROM artifacts WHERE run_id=? ORDER BY created_at,id").all(runId).map(row => ({
      kind: row.kind, uri: row.uri, content_hash: row.content_hash, status: row.status,
      provenance: parseJson(row.provenance_json, null)
    }));
    const tokenTotals = calls.reduce((total, call) => {
      total.input += integer(call.tokens.input); total.cached += integer(call.tokens.cached);
      total.output += integer(call.tokens.output); total.reasoning += integer(call.tokens.reasoning); return total;
    }, { input: 0, cached: 0, output: 0, reasoning: 0 });
    const correctionCycles = calls.reduce((sum, call) => sum + integer(call.correction_cycles), 0);
    const retryCount = calls.reduce((sum, call) => sum + integer(call.retries), 0) + attempts.filter(item => item.attempt_no > 1).length;
    const storage = storageAudit(db);
    return {
      schema_version: 1, run_id: run.id,
      project: { id: run.project_id, name: run.project_name },
      route: { workflow_id: run.workflow_id, workflow_name: run.workflow_name, package_key: run.package_key, package_version: run.package_version },
      classification, calls, tokens: tokenTotals, stages: steps, attempts: { count: attempts.length, correction_cycles: correctionCycles, retries: retryCount, items: attempts },
      gates, artifacts, total_duration_ms: duration(run.created_at, run.completed_at ?? run.updated_at), final_state: run.state, storage
    };
  } finally { db.close(); }
}
