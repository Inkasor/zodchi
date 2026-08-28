import crypto from "node:crypto";
import { openDb, now, id } from "./db.mjs";
import { validateClassification } from "../contracts/schemas.mjs";
import { appendEvent, transitionRunAndTask } from "./state-machine.mjs";
import { CLARIFICATION_KINDS, settleInteraction } from "./interactions.mjs";

function roleForStage(stage) {
  if (stage === "planning") return "planner";
  if (stage === "execution") return "worker";
  if (stage === "review") return "reviewer";
  if (stage === "document" || stage === "documentation") return "documentator";
  return null;
}

export class Runtime {
  constructor(dbFile, options = {}) { this.dbFile = dbFile; this.db = openDb(dbFile, options); }

  create(message, context = {}) {
    this.lastCreateWasDuplicate = false;
    const projectId = context.project_id ?? context.project;
    const workflowId = context.workflow_id ?? context.workflow;
    if (!projectId || !workflowId) throw new Error("runtime: project_id and workflow_id are required");
    const project = this.db.prepare("SELECT id FROM projects WHERE id=? OR lower(root_path)=lower(?) LIMIT 1").get(projectId, projectId);
    if (!project) throw new Error(`runtime: project is not registered: ${projectId}`);
    const workflow = this.db.prepare("SELECT id FROM workflows WHERE id=? AND project_id=?").get(workflowId, project.id);
    if (!workflow) throw new Error(`runtime: workflow is not registered for project: ${workflowId}`);
    const source = String(context.event_source ?? context.source ?? "user");
    const eventKey = context.event_key ?? context.idempotency_key ?? null;
    const payloadHash = crypto.createHash("sha256").update(String(message)).digest("hex");
    const taskIdempotencyKey = eventKey ? `${source}:${eventKey}` : null;
    const taskId = id("task"), runId = id("run"), timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (eventKey) {
        const existing = this.db.prepare("SELECT task_id,run_id,payload_hash FROM inbox_events WHERE project_id=? AND source=? AND event_key=?").get(project.id, source, String(eventKey));
        if (existing) {
          if (existing.payload_hash !== payloadHash) {
            appendEvent(this.db, { entityType: "workflow_run", entityId: existing.run_id, kind: "contract_error", payload: { reason: "idempotency key reused with a different payload hash", source, event_key: String(eventKey) } });
            appendEvent(this.db, { entityType: "task", entityId: existing.task_id, kind: "contract_error", payload: { reason: "idempotency key reused with a different payload hash", source, event_key: String(eventKey) } });
            this.db.exec("COMMIT");
            throw new Error(`IDEMPOTENCY_CONFLICT: ${source}:${eventKey}`);
          }
          this.lastCreateWasDuplicate = true;
          this.db.exec("COMMIT");
          return existing.run_id;
        }
      }
      this.db.prepare("INSERT INTO tasks(id,project_id,goal_id,stage_id,title,state,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,'received',?,?,?)")
        .run(taskId, project.id, context.goal_id ?? null, context.stage_id ?? null, String(message), taskIdempotencyKey, timestamp, timestamp);
      this.db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,client,user_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(runId, taskId, project.id, workflow.id, "received", context.operational_level ?? "mvp", context.client ?? "codex", String(message), timestamp, timestamp);
      if (eventKey) this.db.prepare("INSERT INTO inbox_events(id,project_id,source,event_key,payload_hash,task_id,run_id,received_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id("inbox"), project.id, source, String(eventKey), payloadHash, taskId, runId, timestamp);
      appendEvent(this.db, { entityType: "task", entityId: taskId, kind: "created", payload: { source, event_key: eventKey } });
      appendEvent(this.db, { entityType: "workflow_run", entityId: runId, kind: "created", payload: { source, event_key: eventKey, ...(context.event_fields?.length ? { event_fields: context.event_fields } : {}) } });
      this.db.prepare("UPDATE tasks SET state='discovering',updated_at=? WHERE id=?").run(timestamp, taskId);
      this.db.prepare("UPDATE workflow_runs SET state='discovering',updated_at=? WHERE id=?").run(timestamp, runId);
      appendEvent(this.db, { entityType: "task", entityId: taskId, kind: "state_transition", fromState: "received", toState: "discovering", payload: { reason: "runtime created" } });
      appendEvent(this.db, { entityType: "workflow_run", entityId: runId, kind: "state_transition", fromState: "received", toState: "discovering", payload: { reason: "runtime created" } });
      this.db.exec("COMMIT");
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
    return runId;
  }

  accept(message, context = {}) {
    const runId = this.create(message, context);
    return { runId, duplicate: this.lastCreateWasDuplicate === true };
  }

  setState(runId, state, options = {}) { return transitionRunAndTask(this.db, runId, state, options); }

  classify(runId, classification) {
    const value = validateClassification(classification, this.db.prepare("SELECT id FROM work_types").all().map(row => row.id));
    const run = this.get(runId);
    if (run.state === "discovering") transitionRunAndTask(this.db, runId, "classifying", { reason: "discovery complete" });
    const taskId = this.get(runId).task_id;
    const decisionId = id("decision");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO decisions(id,task_id,run_id,kind,outcome,source,structured_json,active,created_at) VALUES(?,?,?,?,?,?,?,1,?)")
        .run(decisionId, taskId, runId, "classification", value.kind, "classifier", JSON.stringify(value), now());
      this.db.prepare("INSERT INTO classifications(run_id,decision_id,kind,domain_id,discipline_id,risk,planning_level_id,quality_mode_id,planning_required,human_required,document_required,artifact_type_id,reply_mode,needs_questions,pending_interaction_id,reason,questions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(runId, decisionId, value.kind, value.domain, value.discipline, value.risk, value.level, value.quality, value.planning_required ? 1 : 0, value.human_required ? 1 : 0, value.document_required ? 1 : 0, value.artifact_type ?? value.artifact ?? null, value.reply_mode ?? null, value.needs_questions ? 1 : 0, value.pending_interaction_id ?? null, value.reason ?? null, JSON.stringify(value.questions ?? []));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    transitionRunAndTask(this.db, runId, "classified", { reason: "classification decision stored" });
    this.settleAnsweredClarifications(runId, value.pending_interaction_ids ?? value.pending_interaction_id ?? null);
    return value;
  }

  // A clarification is a question, and a question stays open until it is answered, withdrawn or replaced.
  // It used to be settled by whatever message arrived next: naming one interaction approved it and every
  // other pending question in the project was cancelled, answered or not. That is how a question guarding
  // an unproven claim disappeared without anyone deciding it should.
  // One message routinely answers every question that was asked, so each named interaction is settled
  // rather than only the first, and the run that carried the answer is recorded on each of them.
  settleAnsweredClarifications(runId, answered = null) {
    const answeredIds = (answered === null ? [] : [answered].flat()).filter(Boolean);
    const settled = [];
    for (const answeredId of answeredIds) {
      const interaction = this.db.prepare("SELECT id,kind,status FROM approvals WHERE id=?").get(answeredId);
      if (!interaction || interaction.status !== "pending" || !CLARIFICATION_KINDS.has(interaction.kind)) continue;
      if (settleInteraction(this.db, answeredId, { status: "approved", answeredRunId: runId, answer: { answered_in_run: runId } }).settled) settled.push(answeredId);
    }
    return settled;
  }

  plan(runId, plan) {
    transitionRunAndTask(this.db, runId, "planning", { reason: "planning authorized" });
    const planId = id("plan"), timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A run stopped for the owner's decision already holds an empty plan: it was opened to record the
      // objective and then paused before anything was planned into it. Resuming plans into that same run,
      // so the placeholder gives way. A plan that already has steps is real history and is never replaced.
      const planned = this.db.prepare("SELECT COALESCE(MAX(ordinal),0) AS ordinal,COUNT(*) AS count FROM workflow_steps WHERE run_id=?").get(runId);
      if (!planned.count) this.db.prepare("DELETE FROM plans WHERE run_id=?").run(runId);
      // A run holds one plan. Replanning after an answer records the new objective on that plan and
      // appends its steps after the ones already run, rather than opening a second plan the run cannot
      // hold or reopening a step whose work is finished.
      const existingPlan = this.db.prepare("SELECT id FROM plans WHERE run_id=?").get(runId);
      const currentPlanId = existingPlan?.id ?? planId;
      if (existingPlan) this.db.prepare("UPDATE plans SET objective=?,authority=?,status='planned' WHERE id=?").run(plan.objective, plan.authority ?? null, currentPlanId);
      else this.db.prepare("INSERT INTO plans(id,run_id,objective,authority,status,created_at) VALUES(?,?,?,?,?,?)").run(currentPlanId, runId, plan.objective, plan.authority ?? null, "planned", timestamp);
      for (const [index, stageDefinition] of (plan.steps ?? []).entries()) {
        const stage = typeof stageDefinition === "string" ? { key: stageDefinition } : stageDefinition;
        const stepKey = stage.key ?? stage.stage ?? stage.role;
        if (!stepKey) throw new Error(`plan: step ${index + 1} has no key`);
        const roleKey = stage.role ?? roleForStage(stepKey);
        const role = roleKey ? this.db.prepare("SELECT id FROM roles WHERE id=?").get(roleKey)?.id ?? null : null;
        const ordinal = planned.ordinal + index + 1;
        this.db.prepare("INSERT INTO workflow_steps(id,run_id,step_key,ordinal,role_id,state,required,irreversible,idempotency_key,created_at,updated_at,max_attempts) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?)")
          .run(id("step"), runId, stepKey, ordinal, role, stage.required === false ? 0 : 1, stage.irreversible ? 1 : 0, `${runId}:${stepKey}:${ordinal}`, timestamp, timestamp, stage.max_attempts ?? 3);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return plan;
  }

  linkGateway(runId, receipt) {
    const usage = receipt.usage ?? (receipt.usage_json ? JSON.parse(receipt.usage_json) : {});
    const startedAt = receipt.startedAt ?? receipt.started_at ?? null, finishedAt = receipt.finishedAt ?? receipt.finished_at ?? null;
    const measuredDuration = startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null;
    this.db.prepare("INSERT INTO gateway_calls(id,run_id,step_id,attempt_id,provider,profile_id,role_id,receipt_id,gateway_task_id,status,exit_code,started_at,finished_at,input_tokens,cached_tokens,output_tokens,reasoning_tokens,duration_ms,contract_hash,result_hash,artifact_ref,decision_ref,model,reasoning_effort,correction_cycles,retries,service_tier,model_provider) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id("call"), runId, receipt.step_id ?? null, receipt.attempt_id ?? null, receipt.provider, receipt.profile ?? receipt.profile_id ?? null, receipt.role ?? null, receipt.receipt_id ?? receipt.receiptId, receipt.gateway_task_id ?? receipt.task_id ?? receipt.taskId, receipt.status ?? "unknown", receipt.exitCode ?? receipt.exit_code ?? null, startedAt, finishedAt, usage.input_tokens ?? null, usage.cached_input_tokens ?? null, usage.output_tokens ?? null, usage.reasoning_output_tokens ?? null, receipt.duration_ms ?? usage.duration_ms ?? measuredDuration, receipt.contract_hash ?? receipt.contractHash ?? null, receipt.result_hash ?? receipt.resultHash ?? null, receipt.artifact_ref ?? receipt.artifactRef ?? null, receipt.decision_ref ?? receipt.decisionRef ?? null, receipt.model ?? null, receipt.reasoningEffort ?? receipt.reasoning_effort ?? null, receipt.correctionCycles ?? receipt.correction_cycles ?? 0, receipt.retries ?? 0, usage.service_tier ?? null, receipt.modelProvider ?? receipt.model_provider ?? null);
  }

  recordGate(runId, gate, kind = "project", required = true) {
    this.db.prepare("INSERT INTO gates(id,run_id,step_id,kind,required,status,duration_ms,details_json) VALUES(?,?,?,?,?,?,?,?)")
      .run(id("gate"), runId, gate.step_id ?? null, kind, required ? 1 : 0, gate.status, gate.duration_ms ?? null, JSON.stringify(gate));
    return gate;
  }

  get(runId) { return this.db.prepare("SELECT * FROM workflow_runs WHERE id=?").get(runId); }
  getTask(runId) { return this.db.prepare("SELECT t.* FROM tasks t JOIN workflow_runs wr ON wr.task_id=t.id WHERE wr.id=?").get(runId); }
}

export function recordLint(db, runId, result) {
  db.prepare("INSERT INTO lint_results(id,run_id,step_id,kind,status,error_count) VALUES(?,?,?,?,?,?)").run(id("lint"), runId, result.step_id ?? null, result.kind, result.status, (result.errors ?? []).length);
  return result;
}
