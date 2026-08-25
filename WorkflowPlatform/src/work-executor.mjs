import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { id, now } from "./db.mjs";
import { ExecutionQueue } from "./execution-queue.mjs";
import { BudgetManager, invokeWithinBudget } from "./budget.mjs";
import { applyRegisteredPatch, documentVersion } from "./documentator.mjs";
import { registeredProjectCheckKeys, runProjectGate } from "./gates.mjs";
import { selectProjectContext } from "./document-context.mjs";
import { collectGitHistory, collectSourceFiles, expandTerms, inventorySummary, searchSources, sourceScope } from "./source-context.mjs";
import { projectRoots, writableRoots } from "./project-roots.mjs";
import { loadRoleContract, parseRoleReceipt, rolePrompt, structuredHash } from "./role-contracts.mjs";
import { consumeCorrectionCycle, documentationOutcome, loadOperationalPolicy, loadQualityContract, operationalLevel, reviewerRequirement } from "./quality-contracts.mjs";

function hashFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }

function selectedWorkflowContract(db, projectId, workflowId) {
  const rows = db.prepare("SELECT * FROM workflow_step_templates WHERE project_id=? AND workflow_id=? ORDER BY ordinal").all(projectId, workflowId);
  if (!rows.length) return null;
  const workerSteps = rows.filter(row => row.role_id && row.output_schema_key === "worker.v1");
  // A step named for testing is the verification phase's own work and must not become a worker step
  // as well. That is a refinement, not a way to empty a route: a workflow whose whole purpose is to
  // run the registered checks names every step that way, and filtering left it with nothing to run.
  const named = workerSteps.filter(row => !/(?:^|_)(?:test|tests|checks|verify|verification|preflight|review)(?:$|_)/.test(row.step_key));
  const productive = named.length ? named : workerSteps;
  const approvalIndex = rows.findIndex(row => row.irreversible && !row.role_id);
  const productiveAfterApproval = approvalIndex < 0 ? [] : productive.filter(row => row.ordinal > rows[approvalIndex].ordinal);
  const productiveBeforeApproval = productive.filter(row => approvalIndex < 0 || row.ordinal < rows[approvalIndex].ordinal);
  const workerRoles = [...new Set(productiveBeforeApproval.map(row => row.role_id))];
  const checks = [...new Set(rows.flatMap(row => parseJson(row.check_keys_json, [])))];
  return {
    workflow_id: workflowId,
    rows,
    worker_steps: productiveBeforeApproval,
    worker_roles: workerRoles,
    // The roles a route may execute depend on which side of the owner's decision the run is on. Only the
    // steps before it were ever named, so a granted approval used to leave the route with nothing to run.
    worker_steps_after_approval: productiveAfterApproval,
    worker_roles_after_approval: [...new Set(productiveAfterApproval.map(row => row.role_id))],
    check_keys: checks,
    // A workflow that declares no planning step has nothing to drive execution from: the plan is what
    // names the steps, their roles, paths and checks. Falling back to a literal role name hid that as a
    // missing-role error in whichever package happened to use different names.
    planner_role: rows.find(row => row.output_schema_key === "planner.v1")?.role_id ?? null,
    reviewer_role: rows.find(row => row.output_schema_key === "reviewer.v1")?.role_id ?? "reviewer",
    documentator_role: rows.find(row => row.output_schema_key === "documentator.v1")?.role_id ?? "documentator",
    approval: approvalIndex < 0 ? null : { step_key: rows[approvalIndex].step_key, before_productive_work: productiveAfterApproval.length > 0 }
  };
}

// A workflow that declares its steps has already been planned: its author named the roles, the order,
// the artifact types and the checks. Asking a model to invent that again is what let a plan name steps
// the route does not have. A declared planning step still runs, because a change needs paths and
// objectives that only the message can supply; a route without one is executed as it was declared.
// Nothing here can produce an allowed path, so a route whose workers may write must declare planning.
function derivePlanFromTemplates(runtime, projectId, contract, message, registeredChecks, level, documentRequired, documentatorRole, afterApproval) {
  const artifacts = [];
  const steps = (afterApproval && contract.worker_steps_after_approval.length ? contract.worker_steps_after_approval : contract.worker_steps).map(row => {
    const tools = loadRoleContract(runtime.db, projectId, row.role_id, level).allowed_tools;
    if (tools.length) throw new Error(`WORKFLOW_WRITING_STEP_REQUIRES_PLANNING: ${contract.workflow_id}:${row.step_key}`);
    const keys = parseJson(row.artifact_types_json, []).map(type => {
      const key = `${row.step_key}.${type}`;
      artifacts.push({ key, type, path: null, required: false });
      return key;
    });
    return { key: row.step_key, role: row.role_id, objective: message, allowed_paths: [], artifact_keys: keys, check_ids: parseJson(row.check_keys_json, []).filter(check => registeredChecks.includes(check)), required: row.required === 1, irreversible: row.irreversible === 1, max_attempts: (parseJson(row.correction_json, {}).max_cycles ?? 0) + 1 };
  });
  if (documentRequired) {
    // The documentation phase resolves its target from the plan, so a declared route still has to say
    // which registered document the run must change. One writable document is an answer; several are
    // the same ambiguity a planner would have had to settle, and it is reported as such.
    const writable = runtime.db.prepare(`SELECT pd.path FROM project_documents pd JOIN role_documents rd ON rd.document_id=pd.id AND rd.project_id=pd.project_id
      WHERE pd.project_id=? AND rd.role_id=? AND rd.write_access=1 AND pd.active=1 ORDER BY pd.path`).all(projectId, documentatorRole);
    if (writable.length !== 1) throw new Error(`WORKFLOW_REQUIRED_DOCUMENT_NEEDS_PLANNING: ${contract.workflow_id} must declare a planning step to choose among the ${writable.length} documents ${documentatorRole} may write`);
    artifacts.push({ key: "required_document", type: "document", path: writable[0].path, required: true });
  }
  return { schema_version: 1, outcome: "ready", scope: { included: [message], excluded: [] }, allowed_paths: [], inputs: [], checks: registeredChecks, risks: [], artifacts, completion_criteria: [], questions: [], steps };
}

function approvalQuestion(contract, responseLanguage) {
  return responseLanguage === "ru"
    ? `Этот маршрут содержит отдельное действие владельца «${contract.approval.step_key}». Подтверждение нужно получить до продолжения.`
    : `This workflow contains a separate owner action, "${contract.approval.step_key}". Confirmation is required before continuing.`;
}

function requireWorkflowApproval(runtime, runId, contract, responseLanguage) {
  const taskId = runtime.get(runId).task_id;
  const question = approvalQuestion(contract, responseLanguage);
  runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'workflow_approval',?,'pending',?)")
    .run(id("approval"), taskId, runId, question, now());
  runtime.setState(runId, "approval_required", { reason: `workflow approval required: ${contract.approval.step_key}` });
  return { status: "approval_required", questions: [question], workflow_approval: contract.approval.step_key };
}

function promptBytes(value) { return Buffer.byteLength(JSON.stringify(value)); }

// Search results are already ranked best-first. When their independent collection caps add up to more
// than a role can receive, discard the least relevant evidence first and keep the highest-ranked path.
// The inventory is structural context, so counts per area replace hundreds of path/size records; paths
// proven relevant by the two-pass search remain in source_matches.
function fitSourceEvidence(context, limit, measure = promptBytes) {
  if (Array.isArray(context.source_inventory)) context.source_inventory = inventorySummary(context.source_inventory);
  const refresh = () => measure(context);
  while (refresh() > limit && Array.isArray(context.decisions) && context.decisions.length) context.decisions.shift();
  const result = context.source_matches;
  if (!result || !Array.isArray(result.files)) return context;
  const originalFiles = result.files.length;
  while (refresh() > limit && result.files.length > 1) {
    result.files.pop();
    result.truncated = true;
    result.budget_truncation = { retained_files: result.files.length, omitted_files: originalFiles - result.files.length };
  }
  // Keep the best path even under an unusually small envelope; matching lines are supporting detail and
  // can be reduced without losing where the proven hit lives.
  const best = result.files[0];
  while (refresh() > limit && Array.isArray(best?.matches) && best.matches.length > 1) best.matches.pop();
  return context;
}

function utf8Prefix(value, maxBytes) {
  const text = String(value ?? "");
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function fitWorkerSources(context, limit, measure) {
  const files = context.sources?.files;
  if (!Array.isArray(files)) return context;
  for (let index = files.length - 1; measure(context) > limit && index >= 0; index -= 1) {
    const file = files[index], text = String(file.text ?? "");
    if (!text) continue;
    const overflow = measure(context) - limit;
    file.text = utf8Prefix(text, Math.max(0, Buffer.byteLength(text) - overflow - 256));
    file.supplied_bytes = Buffer.byteLength(file.text);
    file.truncated = true;
    file.prompt_truncated = true;
  }
  context.sources.bytes = files.reduce((total, file) => total + Buffer.byteLength(String(file.text ?? "")), 0);
  return context;
}

function boundedContext(discovery, roleId, classification, limit, responseLanguage, supplied = {}) {
  const selected = selectProjectContext(discovery, classification, [], null, discovery.project.id, roleId);
  const context = {
    project: { id: discovery.project.id, name: discovery.project.name },
    // Where the roots are and what each one grants is the first thing a role needs and the cheapest
    // thing to send: without it the role knows a second directory exists only when a document happens
    // to name it, and cannot tell a directory it may change from one it may only read.
    roots: (discovery.roots ?? []).map(root => ({ key: root.key, path: root.path, access: root.access, primary: root.primary })),
    role_id: roleId, response_language: responseLanguage, documents: [], decisions: discovery.decisions, pending_interactions: discovery.pending_interactions,
    // Collection is what a role reads the project with. A planner is given the inventory so it can name
    // the paths the work needs; a worker is given the contents of the paths the plan allowed. Neither
    // opens a file itself, so the same plan against the same tree produces the same invocation.
    ...supplied
  };
  fitSourceEvidence(context, limit);
  let used = promptBytes(context);
  for (const document of selected.documents) {
    const remaining = limit - used;
    if (remaining <= 256) break;
    const item = { id: document.id, path: document.path, authority: document.authority, version: document.content_hash ?? null, text: String(document.text ?? "").slice(0, Math.max(0, remaining - 256)) };
    context.documents.push(item);
    used = Buffer.byteLength(JSON.stringify(context));
  }
  return context;
}

function storeStepPayload(db, stepId, contract, resultSchemaKey, result = null) {
  db.prepare("UPDATE workflow_steps SET contract_json=?,result_schema_key=?,result_json=?,updated_at=? WHERE id=?")
    .run(JSON.stringify(contract), resultSchemaKey, result ? JSON.stringify(result) : null, now(), stepId);
}

function promptWithinContract(contract, qualityContract, packageContract, context, schemaKey) {
  const fitted = structuredClone(context ?? {});
  let prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  // History gives way before authority. Registered documents are what a role reasons from, while
  // decisions accumulate with every run, so trimming documents first would drop the authority to keep
  // an ever-growing log and the role would fail on a project purely because it had been used a lot.
  while (Buffer.byteLength(prompt) > contract.context_limit_bytes && Array.isArray(fitted.decisions) && fitted.decisions.length) {
    fitted.decisions.shift();
    prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  }
  fitSourceEvidence(fitted, contract.context_limit_bytes, value => Buffer.byteLength(rolePrompt({ contract, qualityContract, packageContract, context: value, resultSchema: schemaKey })));
  prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  while (Buffer.byteLength(prompt) > contract.context_limit_bytes && Array.isArray(fitted.documents) && fitted.documents.length) {
    const overflow = Buffer.byteLength(prompt) - contract.context_limit_bytes;
    const document = fitted.documents.at(-1), text = String(document.text ?? "");
    if (Buffer.byteLength(text) > overflow + 512) document.text = text.slice(0, Math.max(0, text.length - overflow - 256));
    else fitted.documents.pop();
    prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  }
  fitWorkerSources(fitted, contract.context_limit_bytes, value => Buffer.byteLength(rolePrompt({ contract, qualityContract, packageContract, context: value, resultSchema: schemaKey })));
  prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  if (Buffer.byteLength(prompt) > contract.context_limit_bytes) throw new Error(`ROLE_CONTEXT_BUDGET_EXCEEDED: fixed contract envelope is ${Buffer.byteLength(prompt)}/${contract.context_limit_bytes} bytes`);
  return prompt;
}

function roleBudgetRequest(runtime, runId, roleId, attemptId, contract, callKey) {
  const task = runtime.getTask(runId);
  const manager = new BudgetManager(runtime.db);
  const roleScope = `${runId}:${roleId}`;
  manager.define({ scopeType: "role", scopeId: roleScope, metric: "calls", limit: contract.max_calls });
  manager.define({ scopeType: "attempt", scopeId: attemptId, metric: "calls", limit: 1 });
  return {
    manager,
    request: {
      scopes: [
        { type: "project", id: task.project_id }, { type: "task", id: task.id }, { type: "workflow", id: runId },
        { type: "role", id: roleScope }, { type: "attempt", id: attemptId }
      ],
      metric: "calls", amount: 1, idempotencyKey: callKey, taskId: task.id, runId, reason: `role:${roleId}`
    }
  };
}

async function invokeRole({ runtime, queue, runId, roleId, level, taskRoot, packageContract, context, schemaKey, parseOptions, gatewayCall }) {
  const contract = loadRoleContract(runtime.db, runtime.get(runId).project_id, roleId, level);
  const qualityContract = loadQualityContract(runtime.db, level);
  if (contract.result_schema_key !== schemaKey) throw new Error(`ROLE_SCHEMA_NOT_ALLOWED: ${roleId}:${schemaKey}`);
  const lease = queue.checkout({ ownerId: `workflow:${roleId}`, runId, leaseMs: contract.timeout_seconds * 1000 });
  if (!lease) throw new Error(`ROLE_STEP_NOT_READY: ${roleId}`);
  const step = runtime.db.prepare("SELECT * FROM workflow_steps WHERE id=?").get(lease.stepId);
  if (step.role_id !== roleId) throw new Error(`ROLE_STEP_MISMATCH: expected ${step.role_id}, got ${roleId}`);
  queue.start(lease.token);
  const promptContext = context ?? {};
  let prompt;
  try { prompt = promptWithinContract(contract, qualityContract, packageContract, promptContext, schemaKey); }
  catch (error) {
    const failure = queue.fail(lease.token, { category: "context_budget_exceeded", retryable: false });
    throw new Error(`${error.message}: ${JSON.stringify(failure)}`);
  }
  fs.mkdirSync(taskRoot, { recursive: true });
  const taskFile = path.join(taskRoot, `${step.ordinal}-${roleId}.md`);
  fs.writeFileSync(taskFile, prompt, "utf8");
  storeStepPayload(runtime.db, step.id, packageContract, schemaKey);
  const { manager, request } = roleBudgetRequest(runtime, runId, roleId, lease.attemptId, contract, `${step.id}:${lease.attemptNo}:call`);
  let receipt = null;
  try {
    receipt = await invokeWithinBudget(manager, request, () => gatewayCall({
      provider: contract.provider, profile: contract.profile, level, role: roleId, taskFile,
      project: runtime.db.prepare("SELECT root_path FROM projects WHERE id=?").get(runtime.get(runId).project_id).root_path,
      // Only the writable roots go to the provider, and the primary one is already there as --project.
      // A read-only root was collected into the prompt and is deliberately never handed to the sandbox.
      writeDirs: writableRoots(projectRoots(runtime.db, runtime.get(runId).project_id)).filter(root => !root.primary).map(root => root.path),
      taskId: `${runId}:${step.step_key}:${lease.attemptNo}`, workflowRunId: runId, attemptNo: lease.attemptNo
    }));
    const result = parseRoleReceipt(receipt, schemaKey, { contract, ...parseOptions });
    const usage = receipt.usage ?? {};
    const measured = {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
      duration_ms: receipt.duration_ms ?? (receipt.startedAt && receipt.finishedAt ? Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt) : null),
      correction_cycles: receipt.correctionCycles ?? receipt.correction_cycles,
      cost_usd: usage.cost_usd
    };
    for (const [metric, amount] of Object.entries(measured)) if (Number.isFinite(Number(amount)) && Number(amount) > 0) manager.consume({ ...request, metric, amount: Number(amount), idempotencyKey: `${request.idempotencyKey}:${metric}`, reason: `${request.reason}:${metric}` });
    const contractHash = structuredHash({ role_contract_id: contract.id, role_contract_version: contract.version, package: packageContract });
    const resultHash = structuredHash(result);
    runtime.linkGateway(runId, { ...receipt, step_id: step.id, attempt_id: lease.attemptId, contract_hash: contractHash, result_hash: resultHash });
    storeStepPayload(runtime.db, step.id, packageContract, schemaKey, result);
    return {
      contract, qualityContract, lease, step, receipt, result,
      complete: details => queue.complete(lease.token, { receiptId: receipt.receiptId ?? receipt.receipt_id, details }),
      fail: (category, retryable = true) => queue.fail(lease.token, { category, retryable })
    };
  } catch (error) {
    if (receipt) {
      try { runtime.linkGateway(runId, { ...receipt, step_id: step.id, attempt_id: lease.attemptId, contract_hash: structuredHash({ role_contract_id: contract.id, package: packageContract }) }); } catch {}
    }
    try { queue.fail(lease.token, { category: String(error.message).split(":")[0].slice(0, 120), retryable: true }); } catch {}
    throw error;
  }
}

function applyPlannerToDatabase(runtime, runId, plannerResult) {
  const plan = runtime.db.prepare("SELECT id FROM plans WHERE run_id=?").get(runId);
  runtime.db.prepare(`UPDATE plans SET schema_version=1,outcome=?,scope_json=?,allowed_paths_json=?,inputs_json=?,checks_json=?,risks_json=?,artifacts_json=?,completion_criteria_json=?,questions_json=?,status=? WHERE id=?`)
    .run(plannerResult.outcome, JSON.stringify(plannerResult.scope), JSON.stringify(plannerResult.allowed_paths), JSON.stringify(plannerResult.inputs), JSON.stringify(plannerResult.checks), JSON.stringify(plannerResult.risks), JSON.stringify(plannerResult.artifacts), JSON.stringify(plannerResult.completion_criteria), JSON.stringify(plannerResult.questions), plannerResult.outcome === "ready" ? "authorized" : "clarification_required", plan.id);
}

function registerNewPlannedDocument(runtime, projectId, projectRoot, plannerResult, documentatorRole) {
  const required = plannerResult.artifacts.filter(item => item.required && item.type === "document" && item.path);
  if (required.length !== 1) return;
  const target = required[0];
  const existing = runtime.db.prepare("SELECT id FROM project_documents WHERE project_id=? AND path=? AND active=1").get(projectId, target.path);
  if (existing) return;
  if (!/^docs\/[A-Za-z0-9Ѐ-ӿ_. -]+\.md$/i.test(target.path)) throw new Error(`DOCUMENT_NEW_TARGET_NOT_ALLOWED: ${target.path}`);
  const file = path.resolve(projectRoot, target.path);
  if (!file.startsWith(`${path.resolve(projectRoot)}${path.sep}`) || fs.existsSync(file)) throw new Error(`DOCUMENT_UNREGISTERED_EXISTING_TARGET: ${target.path}`);
  const documentId = id("document");
  runtime.db.prepare("INSERT INTO project_documents(id,project_id,path,root_key,document_type,authority,status,active,version,updated_at) VALUES(?,?,?,'primary','report','workflow','active',1,0,?)")
    .run(documentId, projectId, target.path, now());
  runtime.db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES(?,?,?,1,1,'task-planned document output',100)")
    .run(projectId, documentatorRole, documentId);
}

function appendSteps(runtime, runId, steps) {
  const timestamp = now();
  const existing = runtime.db.prepare("SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM workflow_steps WHERE run_id=?").get(runId).ordinal;
  const keys = new Set(runtime.db.prepare("SELECT step_key FROM workflow_steps WHERE run_id=?").all(runId).map(row => row.step_key));
  for (const [index, step] of steps.entries()) {
    if (keys.has(step.key)) throw new Error(`PLAN_STEP_DUPLICATE: ${step.key}`);
    keys.add(step.key);
    runtime.db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,role_id,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts,contract_json,result_schema_key) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?,?,?)")
      .run(id("step"), runId, step.key, existing + index + 1, step.role, step.required ? 1 : 0, step.irreversible ? 1 : 0, `${runId}:${step.key}:${existing + index + 1}`, timestamp, timestamp, step.max_attempts, JSON.stringify(step.contract), step.schema);
  }
}

function appendExecutionSteps(runtime, runId, plannerResult) {
  appendSteps(runtime, runId, [
    ...plannerResult.steps.map(step => ({ ...step, schema: "worker.v1", contract: { objective: step.objective, allowed_paths: step.allowed_paths, artifact_keys: step.artifact_keys, check_ids: step.check_ids } })),
    { key: "verification", role: null, required: true, irreversible: false, max_attempts: 1, schema: "gate.v1", contract: { allowed_paths: plannerResult.allowed_paths, check_ids: plannerResult.checks } }
  ]);
}

function appendCorrectionSteps(runtime, runId, plannerResult, cycle) {
  appendSteps(runtime, runId, [
    ...plannerResult.steps.map(step => ({ key: `correction_${cycle}_${step.key}`, role: step.role, required: true, irreversible: false, max_attempts: 1, schema: "worker.v1", contract: { objective: step.objective, allowed_paths: step.allowed_paths, artifact_keys: step.artifact_keys, check_ids: step.check_ids, correction_cycle: cycle } })),
    { key: `verification_${cycle}`, role: null, required: true, irreversible: false, max_attempts: 1, schema: "gate.v1", contract: { allowed_paths: plannerResult.allowed_paths, check_ids: plannerResult.checks, correction_cycle: cycle } }
  ]);
}

function appendReviewerStep(runtime, runId, roleId, reason) {
  appendSteps(runtime, runId, [{ key: "review", role: roleId, required: true, irreversible: false, max_attempts: 1, schema: "reviewer.v1", contract: { reason } }]);
}

function appendDocumentatorStep(runtime, runId, roleId, outcome) {
  appendSteps(runtime, runId, [{ key: "documentation", role: roleId, required: true, irreversible: false, max_attempts: 1, schema: "documentator.v1", contract: { quality_outcome: outcome } }]);
}

function verifyWorkerArtifacts(runtime, runId, stepId, projectRoot, plannerResult, artifactKeys, workerResult) {
  const taskId = runtime.get(runId).task_id;
  const assigned = plannerResult.artifacts.filter(item => artifactKeys.includes(item.key));
  for (const required of assigned.filter(item => item.required && item.path !== null)) if (!workerResult.artifacts.some(item => item.key === required.key)) throw new Error(`WORKER_REQUIRED_ARTIFACT_MISSING: ${required.key}`);
  for (const artifact of workerResult.artifacts) {
    const file = path.resolve(projectRoot, artifact.path);
    if (!file.startsWith(`${path.resolve(projectRoot)}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`WORKER_ARTIFACT_FILE_MISSING: ${artifact.path}`);
    const actualHash = hashFile(file);
    if (artifact.content_hash && artifact.content_hash !== actualHash) throw new Error(`WORKER_ARTIFACT_HASH_MISMATCH: ${artifact.path}`);
    runtime.db.prepare("INSERT INTO artifacts(id,task_id,run_id,step_id,kind,uri,content_hash,status,provenance_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id("artifact"), taskId, runId, stepId, artifact.type, artifact.path, actualHash, "created", JSON.stringify({ source: "worker.v1", key: artifact.key }), now(), now());
  }
  // A planner may ask an analytical worker for a decision rather than a file. worker.v1 already
  // carries that result as a validated summary plus evidence, so requiring it to invent a file-shaped
  // artifact makes the contract impossible to satisfy. Materialize the receipt in the native decisions
  // table and keep its planner key for auditability and later context selection.
  for (const artifact of assigned.filter(item => item.path === null)) {
    const decisionId = id("decision");
    runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,step_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,?,?,'COMPLETED','worker',?,1,?)")
      .run(decisionId, taskId, runId, stepId, `artifact:${artifact.key}`, JSON.stringify({ artifact_key: artifact.key, artifact_type: artifact.type, summary: workerResult.summary, evidence: workerResult.evidence }), now());
    runtime.db.prepare("UPDATE gateway_calls SET decision_ref=? WHERE run_id=? AND step_id=?").run(decisionId, runId, stepId);
  }
}

function reviewerDecision(runtime, runId, stepId, result) {
  const taskId = runtime.get(runId).task_id;
  const decisionId = id("decision");
  runtime.db.prepare("UPDATE decisions SET active=0 WHERE task_id=? AND kind='review'").run(taskId);
  runtime.db.prepare("INSERT INTO decisions(id,task_id,run_id,step_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,?, 'review',?,'reviewer',?,1,?)")
    .run(decisionId, taskId, runId, stepId, result.decision, JSON.stringify(result), now());
  return decisionId;
}

function writableDocument(runtime, projectId, plannerResult, documentatorRole = "documentator") {
  const paths = plannerResult.artifacts.filter(item => item.type === "document" && item.path).map(item => item.path);
  const rows = runtime.db.prepare(`SELECT pd.* FROM project_documents pd JOIN role_documents rd ON rd.document_id=pd.id AND rd.project_id=pd.project_id
    WHERE pd.project_id=? AND rd.role_id=? AND rd.write_access=1 AND pd.active=1 ORDER BY pd.path`).all(projectId, documentatorRole).filter(row => paths.includes(row.path));
  if (rows.length !== 1) throw new Error(`DOCUMENT_TARGET_AMBIGUOUS: expected one registered writable document, found ${rows.length}`);
  return rows[0];
}

function ownerAccepted(runtime, runId) {
  const taskId = runtime.get(runId).task_id;
  return Boolean(runtime.db.prepare(`SELECT 1 FROM decisions d LEFT JOIN approvals a ON a.decision_id=d.id
    WHERE d.task_id=? AND d.active=1 AND upper(d.outcome) IN ('APPROVE','ACCEPTED')
      AND (lower(d.source) IN ('owner','petr','user') OR a.status='approved') LIMIT 1`).get(taskId));
}

async function executeGateStep({ runtime, queue, runId, stepKey, projectRoot, level, plannerResult, classification, gateRunner, cycle }) {
  const gateLease = queue.checkout({ ownerId: "workflow:project-gate", runId, leaseMs: 900_000 });
  if (!gateLease || gateLease.stepKey !== stepKey) throw new Error(`GATE_STEP_NOT_READY: expected ${stepKey}`);
  queue.start(gateLease.token);
  let gate;
  try {
    gate = await gateRunner(projectRoot, level, runtime.dbFile ?? undefined, `${runId}:gate:${cycle}`, {
      runId, allowedPaths: plannerResult.allowed_paths, artifactType: classification.artifact_type
    });
  } catch (error) {
    queue.fail(gateLease.token, { category: "gate_runner_error", retryable: false });
    runtime.setState(runId, "failed", { reason: "project gate runner failed" });
    throw error;
  }
  runtime.recordGate(runId, { ...gate, step_id: gateLease.stepId }, `project_cycle_${cycle}`, true);
  storeStepPayload(runtime.db, gateLease.stepId, { allowed_paths: plannerResult.allowed_paths, checks: plannerResult.checks, correction_cycle: cycle }, "gate.v1", gate);
  queue.complete(gateLease.token, { details: { status: gate.status, correction_cycle: cycle } });
  runtime.setState(runId, "verifying", { reason: cycle ? `program checks completed after correction ${cycle}` : "program checks completed" });
  return gate;
}

// A run stopped for the owner's decision holds everything needed to continue: the classification it was
// given and the message it was started from. The confirming message classifies as a conversation, so
// resuming means re-entering the paused run with its own objective, not the objective of the "yes".
export function pausedRunObjective(db, runId) {
  const row = db.prepare("SELECT * FROM classifications WHERE run_id=?").get(runId);
  if (!row) throw new Error(`RUN_HAS_NO_CLASSIFICATION: ${runId}`);
  const message = db.prepare("SELECT content FROM conversation_messages WHERE run_id=? AND role='user' ORDER BY created_at,id LIMIT 1").get(runId);
  if (!message) throw new Error(`RUN_HAS_NO_MESSAGE: ${runId}`);
  const classification = Object.freeze({
    schema_version: 1, work_type: row.kind, kind: row.kind, artifact_type: row.artifact_type_id, artifact: row.artifact_type_id,
    domain: row.domain_id, discipline: row.discipline_id, risk: row.risk, planning_level: row.planning_level_id, level: row.planning_level_id,
    quality_mode: row.quality_mode_id, quality: row.quality_mode_id, planning_required: row.planning_required === 1, human_required: row.human_required === 1,
    needs_questions: false, document_required: row.document_required === 1, reply_mode: row.reply_mode, pending_interaction_id: null,
    pending_interaction_response: null, reason: row.reason ?? "", questions: [], human_response: null
  });
  return { classification, message: message.content };
}

export async function executeStructuredWork({ runtime, runId, classification, definition, discovery, message, responseLanguage = "en", taskRoot, gatewayCall, gateRunner = runProjectGate, approvalGranted = false }) {
  const level = operationalLevel(classification.quality_mode);
  const projectId = runtime.get(runId).project_id;
  const projectRoot = discovery.project.root_path;
  const queue = new ExecutionQueue(runtime.db);
  const routeContract = selectedWorkflowContract(runtime.db, projectId, runtime.get(runId).workflow_id);
  const policy = loadOperationalPolicy(runtime.db, projectId, runtime.get(runId).workflow_id, level);
  if (routeContract?.approval?.before_productive_work && !approvalGranted) {
    runtime.plan(runId, { objective: message, authority: definition.authority ?? "registered project documents", steps: [] });
    return requireWorkflowApproval(runtime, runId, routeContract, responseLanguage);
  }
  // A workflow with no declared shape at all falls back to the platform roles. One that declares its
  // shape and omits planning is a different thing: the plan is what names the steps to execute, so
  // there is nothing to run, and the literal fallback used to report that as a missing role instead.
  const plannerRole = routeContract ? routeContract.planner_role : "planner";
  const reviewerRole = routeContract?.reviewer_role ?? "reviewer";
  const documentatorRole = routeContract?.documentator_role ?? "documentator";
  const plannerContract = plannerRole ? loadRoleContract(runtime.db, projectId, plannerRole, level) : null;
  if (plannerContract?.allowed_work_types.length && !plannerContract.allowed_work_types.includes(classification.work_type) && !plannerContract.allowed_work_types.includes("*")) throw new Error(`ROLE_WORK_TYPE_NOT_ALLOWED: planner:${classification.work_type}`);
  runtime.plan(runId, { objective: message, authority: definition.authority ?? "registered project documents", steps: plannerContract ? [{ key: "planning", role: plannerRole, max_attempts: plannerContract.max_correction_cycles + 1 }] : [] });
  queue.enqueueRun(runId);
  const allRegisteredRoles = runtime.db.prepare("SELECT id FROM roles ORDER BY id").all().map(row => row.id);
  const routeRoles = approvalGranted && routeContract?.worker_roles_after_approval.length ? routeContract.worker_roles_after_approval : routeContract?.worker_roles;
  const registeredRoles = routeContract ? routeRoles.filter(role => allRegisteredRoles.includes(role)) : allRegisteredRoles;
  if (!registeredRoles.length) throw new Error(`WORKFLOW_ROUTE_HAS_NO_EXECUTABLE_ROLE: ${runtime.get(runId).workflow_id}`);
  const allRegisteredChecks = registeredProjectCheckKeys(runtime.db, projectId, level, classification.artifact_type);
  const registeredChecks = routeContract?.check_keys.length ? allRegisteredChecks.filter(check => routeContract.check_keys.includes(check)) : allRegisteredChecks;
  const registeredArtifactTypes = runtime.db.prepare("SELECT id FROM artifact_types ORDER BY id").all().map(row => row.id);
  // Naming the roles is not enough: a role that may not edit will refuse an editing step, and the plan
  // is then unsatisfiable from the moment it is written. The planner needs each role's purpose and its
  // boundaries so it can put the work where the work is permitted.
  // A role the planner may name but whose contract this project does not carry still has to appear, or
  // the planner would be validated against a role it was never shown.
  const roleCapabilities = registeredRoles.map(role => {
    let contract; try { contract = loadRoleContract(runtime.db, projectId, role, level); } catch { return { id: role }; }
    return { id: role, purpose: contract.purpose, boundaries: contract.boundaries, allowed_work_types: contract.allowed_work_types, allowed_artifact_types: contract.allowed_artifact_types, allowed_tools: contract.allowed_tools };
  });
  // Review and documentation run as their own phases after the worker steps, so a plan that assigns
  // a document write to a worker step asks a role to do work the route never gave it. The planner has
  // to know what happens after its steps in order to stop at the right place.
  const followingPhases = [
    { phase: "verification", runs: "runs every registered check listed below and records the gate", role: null, checks: registeredChecks },
    { phase: "review", runs: "independent review when the quality contract requires it", role: reviewerRole },
    { phase: "documentation", runs: classification.document_required ? "applies the required registered document change" : "applies a registered document change when one is required", role: documentatorRole }
  ];
  // Naming the later phases was not enough on its own: a plan still spent a worker step on defining the
  // verification gates, which is the verification phase's own work given to a role that may not do it.
  // The boundary has to be stated, not left to be inferred from the list.
  const planBoundary = {
    covers: "only the steps the worker roles below execute before verification",
    excludes: followingPhases.map(item => `${item.phase}: ${item.runs}`),
    rule: "Do not plan a step for work a following phase already performs, and assign every step to a role whose allowed_work_types and boundaries permit that step."
  };
  // A plan step is rejected when its role is not one the route may execute, so the planner has to be
  // told which roles those are. Checks and artifact types were already named here; the roles were
  // validated against a list the planner never saw, and it filled the gap by naming itself.
  const plannerPackage = { objective: message, classification: { work_type: classification.work_type, artifact_type: classification.artifact_type, risk: classification.risk, quality_mode: classification.quality_mode }, registered_roles: roleCapabilities, plan_boundary: planBoundary, following_phases: followingPhases, registered_checks: registeredChecks, registered_artifact_types: registeredArtifactTypes };
  const planner = plannerContract && await invokeRole({ runtime, queue, runId, roleId: plannerRole, level, taskRoot, packageContract: plannerPackage, context: boundedContext(discovery, plannerRole, classification, Math.floor(plannerContract.context_limit_bytes / 2), responseLanguage, {
      source_inventory: inventorySummary(discovery.sources ?? []),
      // An inventory says what exists; it does not say where the thing the owner asked about lives, and
      // in a project of a thousand files choosing paths by name is guessing. The identifiers are already
      // in the message, so the platform searches the declared scope for them before the planner is called
      // and hands over the files that actually mention them.
      source_matches: (() => {
        const scope = sourceScope(discovery.source_scope);
        const expanded = expandTerms(discovery.roots ?? [], scope, message);
        return { ...searchSources(discovery.roots ?? [], scope, expanded.terms), derived_from: { request_words: expanded.subject, identifiers: expanded.harvested } };
      })()
    }), schemaKey: "planner.v1", parseOptions: { registeredRoles, registeredChecks, registeredArtifactTypes, maxStepAttempts: policy.limits.correction_cycles + 1 }, gatewayCall });
  const plan = planner ? planner.result : derivePlanFromTemplates(runtime, projectId, routeContract, message, registeredChecks, level, classification.document_required, documentatorRole, approvalGranted);
  if (classification.document_required) registerNewPlannedDocument(runtime, projectId, projectRoot, plan, documentatorRole);
  applyPlannerToDatabase(runtime, runId, plan);
  if (planner) {
    planner.complete({ outcome: plan.outcome });
    if (plan.outcome === "questions") {
      const taskId = runtime.get(runId).task_id;
      for (const question of plan.questions) runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'planner_clarification',?,'pending',?)").run(id("approval"), taskId, runId, question, now());
      runtime.setState(runId, "clarification_required", { reason: "planner needs clarification" });
      return { status: "clarification_required", questions: plan.questions };
    }
  }
  if (classification.document_required && !plan.artifacts.some(item => item.type === "document" && item.required)) throw new Error("PLAN_REQUIRED_DOCUMENT_ARTIFACT_MISSING");
  appendExecutionSteps(runtime, runId, plan);
  queue.enqueueRun(runId);
  runtime.setState(runId, "executing", { reason: "structured plan authorized" });
  const workerResults = [];
  const executeWorkers = async (cycle = 0, priorGate = null) => {
    const cycleResults = [];
    for (const plannedStep of plan.steps) {
    const contract = loadRoleContract(runtime.db, projectId, plannedStep.role, level);
    const packageContract = { objective: plannedStep.objective, allowed_paths: plannedStep.allowed_paths, artifact_keys: plannedStep.artifact_keys, check_ids: plannedStep.check_ids, plan_hash: structuredHash(plan), correction_cycle: cycle, gate_failures: priorGate?.checks?.filter(check => check.required && check.status !== "passed") ?? [] };
    // A planner commonly shortens the worker objective and leaves exact paths, identifiers or line
    // ranges in the original request and its evidence inputs. Source selection needs that complete
    // search intent even though the worker's authority remains the narrower package contract.
    const supplementalSourceQuery = [message, ...(plan.inputs ?? [])].filter(Boolean).join("\n");
    const taskEvidence = { plan_inputs: plan.inputs ?? [], git_history: collectGitHistory(discovery.roots ?? [], plannedStep.allowed_paths, sourceScope(discovery.source_scope), { enabled: discovery.git?.enabled === true }) };
    const qualityContract = loadQualityContract(runtime.db, level);
    const makeContext = (sourceBudget, contextBudget) => boundedContext(discovery, plannedStep.role, classification, contextBudget, responseLanguage, {
      task_evidence: taskEvidence,
      sources: collectSourceFiles(discovery.roots ?? [], plannedStep.allowed_paths, sourceScope(discovery.source_scope), sourceBudget, { query: plannedStep.objective, supplementalQuery: supplementalSourceQuery })
    });
    // Source collection used to spend 80% of the role limit before the role contract, package contract,
    // path-bound history and JSON envelope were measured. Final prompt fitting then removed the overflow
    // with a raw prefix cut, which could discard a complete requested range that the collector had already
    // selected. Measure the real fixed envelope and recollect against the actual remainder instead. The
    // small reserve covers per-file and per-segment metadata, and the loop makes that estimate exact.
    let sourceBudget = Math.floor(contract.context_limit_bytes * 0.8);
    let probeContext;
    for (let pass = 0; pass < 4; pass += 1) {
      probeContext = makeContext(sourceBudget, 0);
      const measured = Buffer.byteLength(rolePrompt({ contract, qualityContract, packageContract, context: probeContext, resultSchema: "worker.v1" }));
      if (measured <= contract.context_limit_bytes) break;
      sourceBudget = Math.max(0, sourceBudget - (measured - contract.context_limit_bytes) - 512);
    }
    const workerContext = makeContext(sourceBudget, contract.context_limit_bytes);
    const worker = await invokeRole({ runtime, queue, runId, roleId: plannedStep.role, level, taskRoot, packageContract, context: workerContext, schemaKey: "worker.v1", parseOptions: { packageContract }, gatewayCall });
    if (worker.result.status !== "completed") {
      worker.fail(`worker_${worker.result.status}`, worker.result.status === "failed");
      const targetState = worker.result.status === "blocked" ? "blocked" : "retry_scheduled";
      if (runtime.get(runId).state !== targetState) runtime.setState(runId, targetState, { reason: `worker returned ${worker.result.status}` });
      return { stopped: { status: worker.result.status, planner: plan, workers: [...workerResults, ...cycleResults, worker.result], gate: priorGate, reviewer: null } };
    }
    try { verifyWorkerArtifacts(runtime, runId, worker.step.id, projectRoot, plan, plannedStep.artifact_keys, worker.result); }
    catch (error) {
      worker.fail(String(error.message).split(":")[0].slice(0, 120), false);
      throw error;
    }
    worker.complete({ status: worker.result.status });
    cycleResults.push({ ...worker.result, correction_cycle: cycle, plan_step: plannedStep.key });
    }
    workerResults.push(...cycleResults);
    return { stopped: null };
  };
  const firstWorkers = await executeWorkers();
  if (firstWorkers.stopped) return firstWorkers.stopped;

  let correctionCycles = 0;
  let gate = await executeGateStep({ runtime, queue, runId, stepKey: "verification", projectRoot, level, plannerResult: plan, classification, gateRunner, cycle: 0 });
  while (gate.status !== "passed" && correctionCycles < policy.limits.correction_cycles) {
    runtime.db.prepare("UPDATE gates SET required=0 WHERE run_id=? AND kind=?").run(runId, `project_cycle_${correctionCycles}`);
    runtime.setState(runId, "changes_requested", { reason: "required project gate not green; bounded correction authorized" });
    correctionCycles += 1;
    consumeCorrectionCycle(runtime, runId, correctionCycles);
    appendCorrectionSteps(runtime, runId, plan, correctionCycles);
    queue.enqueueRun(runId);
    runtime.setState(runId, "executing", { reason: `bounded correction ${correctionCycles} authorized by quality contract` });
    const corrected = await executeWorkers(correctionCycles, gate);
    if (corrected.stopped) return corrected.stopped;
    gate = await executeGateStep({ runtime, queue, runId, stepKey: `verification_${correctionCycles}`, projectRoot, level, plannerResult: plan, classification, gateRunner, cycle: correctionCycles });
  }
  if (gate.status !== "passed") {
    runtime.setState(runId, "changes_requested", { reason: "required project gate not green" });
    return { status: "changes_requested", planner: plan, workers: workerResults, gate, reviewer: null };
  }

  const reviewRequirement = reviewerRequirement(policy.contract, classification, correctionCycles, policy.project_escalations);
  let reviewerResult = null;
  if (reviewRequirement.required) {
    appendReviewerStep(runtime, runId, reviewerRole, reviewRequirement.reason);
    queue.enqueueRun(runId);
    runtime.setState(runId, "review_required", { reason: reviewRequirement.reason });
    const reviewerContract = loadRoleContract(runtime.db, projectId, reviewerRole, level);
    const reviewerPackage = { quality_contract: { level: policy.contract.level, version: policy.contract.version }, review_reason: reviewRequirement.reason, plan, worker_results: workerResults, correction_cycles: correctionCycles, gate: { status: gate.status, checks: gate.checks }, completion_criteria: plan.completion_criteria };
    const reviewer = await invokeRole({ runtime, queue, runId, roleId: reviewerRole, level, taskRoot, packageContract: reviewerPackage, context: boundedContext(discovery, reviewerRole, classification, reviewerContract.context_limit_bytes, responseLanguage), schemaKey: "reviewer.v1", parseOptions: {}, gatewayCall });
    const decisionId = reviewerDecision(runtime, runId, reviewer.step.id, reviewer.result);
    runtime.db.prepare("UPDATE gateway_calls SET decision_ref=? WHERE run_id=? AND step_id=?").run(decisionId, runId, reviewer.step.id);
    reviewer.complete({ decision: reviewer.result.decision });
    reviewerResult = reviewer.result;
    if (reviewer.result.decision === "REJECT") {
      runtime.setState(runId, "rejected", { reason: "reviewer rejected result" });
      return { status: "rejected", planner: plan, workers: workerResults, gate, reviewer: reviewer.result };
    }
    if (reviewer.result.decision === "CHANGES_REQUESTED") {
      runtime.setState(runId, "changes_requested", { reason: "reviewer requested changes" });
      return { status: "changes_requested", planner: plan, workers: workerResults, gate, reviewer: reviewer.result };
    }
  }
  if (routeContract?.approval && !approvalGranted) return { ...requireWorkflowApproval(runtime, runId, routeContract, responseLanguage), planner: plan, workers: workerResults, gate, reviewer: reviewerResult };
  return documentAndComplete({ runtime, queue, runId, projectId, projectRoot, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, policy, plan, gate, reviewerResult, documentatorRole, correctionCycles, workerResults, reviewRequirement });
}

// Documentation and completion are the phases that follow the owner's decision. A run that stopped for a
// decision after its work re-enters here with its recorded plan, gate and review, so continuing costs
// only the phases that never ran.
async function documentAndComplete({ runtime, queue, runId, projectId, projectRoot, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, policy, plan, gate, reviewerResult, documentatorRole, correctionCycles, workerResults, reviewRequirement }) {
  let documentation = null;
  if (classification.document_required) {
    const qualityOutcome = documentationOutcome(policy.contract, { gateStatus: gate.status, ownerAccepted: ownerAccepted(runtime, runId) });
    appendDocumentatorStep(runtime, runId, documentatorRole, qualityOutcome);
    queue.enqueueRun(runId);
    runtime.setState(runId, "documenting", { reason: reviewerResult ? "required documentation after reviewer PASS" : "required documentation after green deterministic gate" });
    const target = writableDocument(runtime, projectId, plan, documentatorRole);
    const documentatorContract = loadRoleContract(runtime.db, projectId, documentatorRole, level);
    const documentPackage = { document_id: target.id, path: target.path, authority: target.authority, expected_version: documentVersion(path.resolve(projectRoot, target.path)), plan_hash: structuredHash(plan), reviewer_decision: reviewerResult?.decision ?? "NOT_REQUIRED", quality_outcome: qualityOutcome };
    const documentator = await invokeRole({ runtime, queue, runId, roleId: documentatorRole, level, taskRoot, packageContract: documentPackage, context: boundedContext(discovery, documentatorRole, classification, documentatorContract.context_limit_bytes, responseLanguage), schemaKey: "documentator.v1", parseOptions: { allowedDocumentIds: [target.id] }, gatewayCall });
    try { documentation = applyRegisteredPatch({ db: runtime.db, runId, projectId, projectRoot, roleId: documentatorRole, proposal: documentator.result, qualityOutcome }); }
    catch (error) {
      documentator.fail("document_patch_failed", false);
      throw error;
    }
    runtime.db.prepare("INSERT INTO artifacts(id,task_id,run_id,step_id,kind,uri,content_hash,status,provenance_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id("artifact"), runtime.get(runId).task_id, runId, documentator.step.id, "document", target.path, documentation.afterVersion.replace(/^sha256:/, ""), "verified", JSON.stringify({ source: "documentator.v1", document_id: target.id }), now(), now());
    runtime.db.prepare("UPDATE gateway_calls SET artifact_ref=? WHERE run_id=? AND step_id=?").run(target.id, runId, documentator.step.id);
    documentator.complete({ document_id: target.id, after_version: documentation.afterVersion });
    runtime.setState(runId, "documented", { reason: "required document patch applied and linted" });
  }
  runtime.setState(runId, "completed", { reason: "all structured role contracts and required gates completed" });
  return { status: "completed", planner: plan, workers: workerResults, correction_cycles: correctionCycles, gate, reviewer: reviewerResult, review_requirement: reviewRequirement, documentation };
}

// A run stopped for a decision that follows its work already holds every result the remaining phases
// need: the plan in `plans` and `workflow_steps`, the verification in `gates`, the review in `decisions`.
// Reading that history back is what makes continuing possible without repeating, and paying for, the
// work that was already done.
export function recordedRunResults(db, runId) {
  const row = db.prepare("SELECT * FROM plans WHERE run_id=?").get(runId);
  if (!row) throw new Error(`RUN_HAS_NO_PLAN: ${runId}`);
  const steps = db.prepare("SELECT * FROM workflow_steps WHERE run_id=? AND result_schema_key='worker.v1' ORDER BY ordinal").all(runId);
  const planned = steps.filter(step => !step.step_key.startsWith("correction_"));
  if (!planned.length) throw new Error(`RUN_HAS_NO_EXECUTED_STEPS: ${runId}`);
  const plan = {
    schema_version: row.schema_version ?? 1,
    outcome: row.outcome,
    scope: parseJson(row.scope_json, { included: [], excluded: [] }),
    allowed_paths: parseJson(row.allowed_paths_json, []),
    inputs: parseJson(row.inputs_json, []),
    checks: parseJson(row.checks_json, []),
    risks: parseJson(row.risks_json, []),
    artifacts: parseJson(row.artifacts_json, []),
    completion_criteria: parseJson(row.completion_criteria_json, []),
    questions: parseJson(row.questions_json, []),
    steps: planned.map(step => {
      const contract = parseJson(step.contract_json, {});
      return { key: step.step_key, role: step.role_id, objective: contract.objective ?? row.objective, allowed_paths: contract.allowed_paths ?? [], artifact_keys: contract.artifact_keys ?? [], check_ids: contract.check_ids ?? [], required: step.required === 1, irreversible: step.irreversible === 1, max_attempts: step.max_attempts };
    })
  };
  const gateRow = db.prepare("SELECT * FROM gates WHERE run_id=? AND kind LIKE 'project_cycle_' || '%' ORDER BY rowid DESC LIMIT 1").get(runId);
  if (!gateRow) throw new Error(`RUN_HAS_NO_GATE: ${runId}`);
  const review = db.prepare("SELECT structured_json FROM decisions WHERE run_id=? AND kind='review' AND active=1 ORDER BY created_at DESC LIMIT 1").get(runId);
  return {
    plan,
    gate: parseJson(gateRow.details_json, { status: gateRow.status, checks: [] }),
    reviewer: review ? parseJson(review.structured_json, null) : null,
    workers: steps.map(step => parseJson(step.result_json, null)).filter(Boolean),
    correction_cycles: Number(String(gateRow.kind).replace("project_cycle_", "")) || 0
  };
}

// Continuing a run whose decision followed its work runs only what the decision was blocking. The
// alternative was to re-enter the run from its objective, which would repeat every completed step, so
// this path deliberately never touches the worker, verification or review phases again.
export async function continueApprovedRun({ runtime, runId, discovery, responseLanguage = "en", taskRoot, gatewayCall }) {
  const { classification } = pausedRunObjective(runtime.db, runId);
  const recorded = recordedRunResults(runtime.db, runId);
  const level = operationalLevel(classification.quality_mode);
  const projectId = runtime.get(runId).project_id;
  const routeContract = selectedWorkflowContract(runtime.db, projectId, runtime.get(runId).workflow_id);
  const policy = loadOperationalPolicy(runtime.db, projectId, runtime.get(runId).workflow_id, level);
  return documentAndComplete({
    runtime, queue: new ExecutionQueue(runtime.db), runId, projectId, projectRoot: discovery.project.root_path, level, classification, discovery, responseLanguage, taskRoot, gatewayCall, policy,
    plan: recorded.plan, gate: recorded.gate, reviewerResult: recorded.reviewer, documentatorRole: routeContract?.documentator_role ?? "documentator",
    correctionCycles: recorded.correction_cycles, workerResults: recorded.workers,
    reviewRequirement: { required: Boolean(recorded.reviewer), reason: recorded.reviewer ? "review recorded before the owner decision" : "not required" }
  });
}
