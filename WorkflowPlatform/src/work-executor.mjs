import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { id, now } from "./db.mjs";
import { ExecutionQueue } from "./execution-queue.mjs";
import { BudgetManager, invokeWithinBudget } from "./budget.mjs";
import { applyRegisteredPatch, documentVersion } from "./documentator.mjs";
import { registeredProjectCheckKeys, runProjectGate } from "./gates.mjs";
import { selectProjectContext } from "./document-context.mjs";
import { loadRoleContract, parseRoleReceipt, rolePrompt, structuredHash } from "./role-contracts.mjs";
import { consumeCorrectionCycle, documentationOutcome, loadOperationalPolicy, loadQualityContract, operationalLevel, reviewerRequirement } from "./quality-contracts.mjs";

function hashFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }

function selectedWorkflowContract(db, projectId, workflowId) {
  const rows = db.prepare("SELECT * FROM workflow_step_templates WHERE project_id=? AND workflow_id=? ORDER BY ordinal").all(projectId, workflowId);
  if (!rows.length) return null;
  const productive = rows.filter(row => row.role_id && row.output_schema_key === "worker.v1" && !/(?:^|_)(?:test|tests|checks|verify|verification|preflight|review)(?:$|_)/.test(row.step_key));
  const approvalIndex = rows.findIndex(row => row.irreversible && !row.role_id);
  const productiveAfterApproval = approvalIndex < 0 ? [] : productive.filter(row => row.ordinal > rows[approvalIndex].ordinal);
  const workerRoles = [...new Set(productive.filter(row => approvalIndex < 0 || row.ordinal < rows[approvalIndex].ordinal).map(row => row.role_id))];
  const checks = [...new Set(rows.flatMap(row => parseJson(row.check_keys_json, [])))];
  return {
    workflow_id: workflowId,
    rows,
    worker_roles: workerRoles,
    check_keys: checks,
    planner_role: rows.find(row => row.output_schema_key === "planner.v1")?.role_id ?? "planner",
    reviewer_role: rows.find(row => row.output_schema_key === "reviewer.v1")?.role_id ?? "reviewer",
    documentator_role: rows.find(row => row.output_schema_key === "documentator.v1")?.role_id ?? "documentator",
    approval: approvalIndex < 0 ? null : { step_key: rows[approvalIndex].step_key, before_productive_work: productiveAfterApproval.length > 0 }
  };
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

function boundedContext(discovery, roleId, classification, limit, responseLanguage) {
  const selected = selectProjectContext(discovery, classification, [], null, discovery.project.id, roleId);
  const context = { project: { id: discovery.project.id, name: discovery.project.name }, role_id: roleId, response_language: responseLanguage, documents: [], decisions: discovery.decisions, pending_interactions: discovery.pending_interactions };
  let used = Buffer.byteLength(JSON.stringify(context));
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
  while (Buffer.byteLength(prompt) > contract.context_limit_bytes && Array.isArray(fitted.documents) && fitted.documents.length) {
    const overflow = Buffer.byteLength(prompt) - contract.context_limit_bytes;
    const document = fitted.documents.at(-1), text = String(document.text ?? "");
    if (Buffer.byteLength(text) > overflow + 512) document.text = text.slice(0, Math.max(0, text.length - overflow - 256));
    else fitted.documents.pop();
    prompt = rolePrompt({ contract, qualityContract, packageContract, context: fitted, resultSchema: schemaKey });
  }
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
  for (const required of plannerResult.artifacts.filter(item => item.required && artifactKeys.includes(item.key))) if (!workerResult.artifacts.some(item => item.key === required.key)) throw new Error(`WORKER_REQUIRED_ARTIFACT_MISSING: ${required.key}`);
  const taskId = runtime.get(runId).task_id;
  for (const artifact of workerResult.artifacts) {
    const file = path.resolve(projectRoot, artifact.path);
    if (!file.startsWith(`${path.resolve(projectRoot)}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`WORKER_ARTIFACT_FILE_MISSING: ${artifact.path}`);
    const actualHash = hashFile(file);
    if (artifact.content_hash && artifact.content_hash !== actualHash) throw new Error(`WORKER_ARTIFACT_HASH_MISMATCH: ${artifact.path}`);
    runtime.db.prepare("INSERT INTO artifacts(id,task_id,run_id,step_id,kind,uri,content_hash,status,provenance_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id("artifact"), taskId, runId, stepId, artifact.type, artifact.path, actualHash, "created", JSON.stringify({ source: "worker.v1", key: artifact.key }), now(), now());
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

export async function executeStructuredWork({ runtime, runId, classification, definition, discovery, message, responseLanguage = "en", taskRoot, gatewayCall, gateRunner = runProjectGate }) {
  const level = operationalLevel(classification.quality_mode);
  const projectId = runtime.get(runId).project_id;
  const projectRoot = discovery.project.root_path;
  const queue = new ExecutionQueue(runtime.db);
  const routeContract = selectedWorkflowContract(runtime.db, projectId, runtime.get(runId).workflow_id);
  const policy = loadOperationalPolicy(runtime.db, projectId, runtime.get(runId).workflow_id, level);
  if (routeContract?.approval?.before_productive_work) {
    runtime.plan(runId, { objective: message, authority: definition.authority ?? "registered project documents", steps: [] });
    return requireWorkflowApproval(runtime, runId, routeContract, responseLanguage);
  }
  const plannerRole = routeContract?.planner_role ?? "planner";
  const reviewerRole = routeContract?.reviewer_role ?? "reviewer";
  const documentatorRole = routeContract?.documentator_role ?? "documentator";
  const plannerContract = loadRoleContract(runtime.db, projectId, plannerRole, level);
  if (plannerContract.allowed_work_types.length && !plannerContract.allowed_work_types.includes(classification.work_type) && !plannerContract.allowed_work_types.includes("*")) throw new Error(`ROLE_WORK_TYPE_NOT_ALLOWED: planner:${classification.work_type}`);
  runtime.plan(runId, { objective: message, authority: definition.authority ?? "registered project documents", steps: [{ key: "planning", role: plannerRole, max_attempts: plannerContract.max_correction_cycles + 1 }] });
  queue.enqueueRun(runId);
  const allRegisteredRoles = runtime.db.prepare("SELECT id FROM roles ORDER BY id").all().map(row => row.id);
  const registeredRoles = routeContract ? routeContract.worker_roles.filter(role => allRegisteredRoles.includes(role)) : allRegisteredRoles;
  if (!registeredRoles.length) throw new Error(`WORKFLOW_ROUTE_HAS_NO_EXECUTABLE_ROLE: ${runtime.get(runId).workflow_id}`);
  const allRegisteredChecks = registeredProjectCheckKeys(runtime.db, projectId, level, classification.artifact_type);
  const registeredChecks = routeContract?.check_keys.length ? allRegisteredChecks.filter(check => routeContract.check_keys.includes(check)) : allRegisteredChecks;
  const registeredArtifactTypes = runtime.db.prepare("SELECT id FROM artifact_types ORDER BY id").all().map(row => row.id);
  const plannerPackage = { objective: message, classification: { work_type: classification.work_type, artifact_type: classification.artifact_type, risk: classification.risk, quality_mode: classification.quality_mode }, registered_checks: registeredChecks, registered_artifact_types: registeredArtifactTypes };
  const planner = await invokeRole({ runtime, queue, runId, roleId: plannerRole, level, taskRoot, packageContract: plannerPackage, context: boundedContext(discovery, plannerRole, classification, plannerContract.context_limit_bytes, responseLanguage), schemaKey: "planner.v1", parseOptions: { registeredRoles, registeredChecks, registeredArtifactTypes, maxStepAttempts: policy.limits.correction_cycles + 1 }, gatewayCall });
  applyPlannerToDatabase(runtime, runId, planner.result);
  planner.complete({ outcome: planner.result.outcome });
  if (planner.result.outcome === "questions") {
    const taskId = runtime.get(runId).task_id;
    for (const question of planner.result.questions) runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,'planner_clarification',?,'pending',?)").run(id("approval"), taskId, runId, question, now());
    runtime.setState(runId, "clarification_required", { reason: "planner needs clarification" });
    return { status: "clarification_required", questions: planner.result.questions };
  }
  if (classification.document_required && !planner.result.artifacts.some(item => item.type === "document" && item.required)) throw new Error("PLAN_REQUIRED_DOCUMENT_ARTIFACT_MISSING");
  appendExecutionSteps(runtime, runId, planner.result);
  queue.enqueueRun(runId);
  runtime.setState(runId, "executing", { reason: "structured plan authorized" });
  const workerResults = [];
  const executeWorkers = async (cycle = 0, priorGate = null) => {
    const cycleResults = [];
    for (const plannedStep of planner.result.steps) {
    const contract = loadRoleContract(runtime.db, projectId, plannedStep.role, level);
    const packageContract = { objective: plannedStep.objective, allowed_paths: plannedStep.allowed_paths, artifact_keys: plannedStep.artifact_keys, check_ids: plannedStep.check_ids, plan_hash: structuredHash(planner.result), correction_cycle: cycle, gate_failures: priorGate?.checks?.filter(check => check.required && check.status !== "passed") ?? [] };
    const worker = await invokeRole({ runtime, queue, runId, roleId: plannedStep.role, level, taskRoot, packageContract, context: boundedContext(discovery, plannedStep.role, classification, contract.context_limit_bytes, responseLanguage), schemaKey: "worker.v1", parseOptions: { packageContract }, gatewayCall });
    if (worker.result.status !== "completed") {
      worker.fail(`worker_${worker.result.status}`, worker.result.status === "failed");
      const targetState = worker.result.status === "blocked" ? "blocked" : "retry_scheduled";
      if (runtime.get(runId).state !== targetState) runtime.setState(runId, targetState, { reason: `worker returned ${worker.result.status}` });
      return { stopped: { status: worker.result.status, planner: planner.result, workers: [...workerResults, ...cycleResults, worker.result], gate: priorGate, reviewer: null } };
    }
    verifyWorkerArtifacts(runtime, runId, worker.step.id, projectRoot, planner.result, plannedStep.artifact_keys, worker.result);
    worker.complete({ status: worker.result.status });
    cycleResults.push({ ...worker.result, correction_cycle: cycle, plan_step: plannedStep.key });
    }
    workerResults.push(...cycleResults);
    return { stopped: null };
  };
  const firstWorkers = await executeWorkers();
  if (firstWorkers.stopped) return firstWorkers.stopped;

  let correctionCycles = 0;
  let gate = await executeGateStep({ runtime, queue, runId, stepKey: "verification", projectRoot, level, plannerResult: planner.result, classification, gateRunner, cycle: 0 });
  while (gate.status !== "passed" && correctionCycles < policy.limits.correction_cycles) {
    runtime.db.prepare("UPDATE gates SET required=0 WHERE run_id=? AND kind=?").run(runId, `project_cycle_${correctionCycles}`);
    runtime.setState(runId, "changes_requested", { reason: "required project gate not green; bounded correction authorized" });
    correctionCycles += 1;
    consumeCorrectionCycle(runtime, runId, correctionCycles);
    appendCorrectionSteps(runtime, runId, planner.result, correctionCycles);
    queue.enqueueRun(runId);
    runtime.setState(runId, "executing", { reason: `bounded correction ${correctionCycles} authorized by quality contract` });
    const corrected = await executeWorkers(correctionCycles, gate);
    if (corrected.stopped) return corrected.stopped;
    gate = await executeGateStep({ runtime, queue, runId, stepKey: `verification_${correctionCycles}`, projectRoot, level, plannerResult: planner.result, classification, gateRunner, cycle: correctionCycles });
  }
  if (gate.status !== "passed") {
    runtime.setState(runId, "changes_requested", { reason: "required project gate not green" });
    return { status: "changes_requested", planner: planner.result, workers: workerResults, gate, reviewer: null };
  }

  const reviewRequirement = reviewerRequirement(policy.contract, classification, correctionCycles, policy.project_escalations);
  let reviewerResult = null;
  if (reviewRequirement.required) {
    appendReviewerStep(runtime, runId, reviewerRole, reviewRequirement.reason);
    queue.enqueueRun(runId);
    runtime.setState(runId, "review_required", { reason: reviewRequirement.reason });
    const reviewerContract = loadRoleContract(runtime.db, projectId, reviewerRole, level);
    const reviewerPackage = { quality_contract: { level: policy.contract.level, version: policy.contract.version }, review_reason: reviewRequirement.reason, plan: planner.result, worker_results: workerResults, correction_cycles: correctionCycles, gate: { status: gate.status, checks: gate.checks }, completion_criteria: planner.result.completion_criteria };
    const reviewer = await invokeRole({ runtime, queue, runId, roleId: reviewerRole, level, taskRoot, packageContract: reviewerPackage, context: boundedContext(discovery, reviewerRole, classification, reviewerContract.context_limit_bytes, responseLanguage), schemaKey: "reviewer.v1", parseOptions: {}, gatewayCall });
    const decisionId = reviewerDecision(runtime, runId, reviewer.step.id, reviewer.result);
    runtime.db.prepare("UPDATE gateway_calls SET decision_ref=? WHERE run_id=? AND step_id=?").run(decisionId, runId, reviewer.step.id);
    reviewer.complete({ decision: reviewer.result.decision });
    reviewerResult = reviewer.result;
    if (reviewer.result.decision === "REJECT") {
      runtime.setState(runId, "rejected", { reason: "reviewer rejected result" });
      return { status: "rejected", planner: planner.result, workers: workerResults, gate, reviewer: reviewer.result };
    }
    if (reviewer.result.decision === "CHANGES_REQUESTED") {
      runtime.setState(runId, "changes_requested", { reason: "reviewer requested changes" });
      return { status: "changes_requested", planner: planner.result, workers: workerResults, gate, reviewer: reviewer.result };
    }
  }
  if (routeContract?.approval) return { ...requireWorkflowApproval(runtime, runId, routeContract, responseLanguage), planner: planner.result, workers: workerResults, gate, reviewer: reviewerResult };
  let documentation = null;
  if (classification.document_required) {
    const qualityOutcome = documentationOutcome(policy.contract, { gateStatus: gate.status, ownerAccepted: ownerAccepted(runtime, runId) });
    appendDocumentatorStep(runtime, runId, documentatorRole, qualityOutcome);
    queue.enqueueRun(runId);
    runtime.setState(runId, "documenting", { reason: reviewerResult ? "required documentation after reviewer PASS" : "required documentation after green deterministic gate" });
    const target = writableDocument(runtime, projectId, planner.result, documentatorRole);
    const documentatorContract = loadRoleContract(runtime.db, projectId, documentatorRole, level);
    const documentPackage = { document_id: target.id, path: target.path, authority: target.authority, expected_version: documentVersion(path.resolve(projectRoot, target.path)), plan_hash: structuredHash(planner.result), reviewer_decision: reviewerResult?.decision ?? "NOT_REQUIRED", quality_outcome: qualityOutcome };
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
  return { status: "completed", planner: planner.result, workers: workerResults, correction_cycles: correctionCycles, gate, reviewer: reviewerResult, review_requirement: reviewRequirement, documentation };
}
