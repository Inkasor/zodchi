import { id, now } from "./db.mjs";
import { appendEvent, canTransition, transitionRunAndTask } from "./state-machine.mjs";

const SCOPE_TYPES = new Set(["project", "task", "workflow", "role", "attempt"]);
const METRICS = new Set(["calls", "input_tokens", "output_tokens", "total_tokens", "duration_ms", "correction_cycles", "cost_usd"]);

export class BudgetManager {
  constructor(db) { this.db = db; }

  define({ scopeType, scopeId, metric, limit, at = now() }) {
    if (!SCOPE_TYPES.has(scopeType)) throw new Error(`BUDGET_SCOPE_INVALID: ${scopeType}`);
    if (!scopeId) throw new Error("BUDGET_SCOPE_ID_REQUIRED");
    if (!METRICS.has(metric)) throw new Error(`BUDGET_METRIC_INVALID: ${metric}`);
    if (!Number.isFinite(Number(limit)) || Number(limit) < 0) throw new Error(`BUDGET_LIMIT_INVALID: ${limit}`);
    const existing = this.db.prepare("SELECT * FROM budgets WHERE scope_type=? AND scope_id=? AND metric=?").get(scopeType, scopeId, metric);
    if (existing) {
      const status = existing.used_value >= Number(limit) ? "exhausted" : "active";
      this.db.prepare("UPDATE budgets SET limit_value=?,status=?,updated_at=? WHERE id=?").run(Number(limit), status, at, existing.id);
      return this.db.prepare("SELECT * FROM budgets WHERE id=?").get(existing.id);
    }
    const budgetId = id("budget");
    this.db.prepare("INSERT INTO budgets(id,scope_type,scope_id,metric,limit_value,used_value,status,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?)")
      .run(budgetId, scopeType, scopeId, metric, Number(limit), Number(limit) === 0 ? "exhausted" : "active", at, at);
    return this.db.prepare("SELECT * FROM budgets WHERE id=?").get(budgetId);
  }

  consume({ scopes, metric, amount = 1, idempotencyKey, taskId = null, runId = null, reason = null, at = now() }) {
    if (!Array.isArray(scopes) || !scopes.length) throw new Error("BUDGET_SCOPES_REQUIRED");
    if (!METRICS.has(metric)) throw new Error(`BUDGET_METRIC_INVALID: ${metric}`);
    if (!Number.isFinite(Number(amount)) || Number(amount) < 0) throw new Error(`BUDGET_AMOUNT_INVALID: ${amount}`);
    if (!idempotencyKey) throw new Error("BUDGET_IDEMPOTENCY_KEY_REQUIRED");
    const uniqueScopes = [...new Map(scopes.map(scope => [`${scope.type}:${scope.id}`, scope])).values()];
    for (const scope of uniqueScopes) if (!SCOPE_TYPES.has(scope.type) || !scope.id) throw new Error(`BUDGET_SCOPE_INVALID: ${scope.type ?? "missing"}`);
    this.db.exec("BEGIN IMMEDIATE");
    let blockers = [];
    try {
      const budgets = uniqueScopes.map(scope => this.db.prepare("SELECT * FROM budgets WHERE scope_type=? AND scope_id=? AND metric=?").get(scope.type, scope.id, metric)).filter(Boolean);
      const existingEntries = budgets.filter(budget => this.db.prepare("SELECT 1 FROM budget_entries WHERE budget_id=? AND idempotency_key=?").get(budget.id, String(idempotencyKey)));
      if (existingEntries.length) {
        this.db.exec("COMMIT");
        return { applied: false, idempotent: true, chargedBudgets: existingEntries.map(item => item.id) };
      }
      blockers = budgets.filter(budget => budget.status !== "active" || budget.used_value + Number(amount) > budget.limit_value)
        .map(budget => ({ budgetId: budget.id, scopeType: budget.scope_type, scopeId: budget.scope_id, used: budget.used_value, limit: budget.limit_value, requested: Number(amount) }));
      if (blockers.length) {
        for (const blocker of blockers) this.db.prepare("UPDATE budgets SET status='exhausted',updated_at=? WHERE id=?").run(at, blocker.budgetId);
        const payload = { metric, amount: Number(amount), idempotency_key: String(idempotencyKey), blockers };
        if (runId) appendEvent(this.db, { entityType: "workflow_run", entityId: runId, kind: "budget_hard_stop", payload });
        if (taskId) appendEvent(this.db, { entityType: "task", entityId: taskId, kind: "budget_hard_stop", payload });
        this.db.exec("COMMIT");
      } else {
        for (const budget of budgets) {
          const used = budget.used_value + Number(amount);
          this.db.prepare("UPDATE budgets SET used_value=?,status=?,updated_at=? WHERE id=?").run(used, used >= budget.limit_value ? "exhausted" : "active", at, budget.id);
          this.db.prepare("INSERT INTO budget_entries(id,budget_id,task_id,run_id,amount,idempotency_key,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
            .run(id("budget_entry"), budget.id, taskId, runId, Number(amount), String(idempotencyKey), reason, at);
        }
        this.db.exec("COMMIT");
        return { applied: true, idempotent: false, chargedBudgets: budgets.map(item => item.id), remaining: budgets.map(item => ({ budgetId: item.id, remaining: Math.max(0, item.limit_value - item.used_value - Number(amount)) })) };
      }
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    if (runId) {
      const run = this.db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId);
      if (run && canTransition("workflow_run", run.state, "blocked")) transitionRunAndTask(this.db, runId, "blocked", { reason: "budget hard stop" });
    }
    const error = new Error(`BUDGET_EXHAUSTED: ${JSON.stringify(blockers)}`);
    error.blockers = blockers;
    throw error;
  }

  // Actual provider cost is known only after a receipt exists. Settlement therefore records the full
  // amount even when it crosses the nominal limit; the exhausted status prevents the next admission.
  // Parallel callers may all have been admitted before any settlement, so lifecycle blocking belongs to
  // the phase supervisor after every in-flight receipt has been preserved, not inside this transaction.
  settleActual({ scopes, metric = "cost_usd", amount, idempotencyKey, taskId = null, runId = null, reason = null, at = now() }) {
    if (metric !== "cost_usd") throw new Error(`BUDGET_POST_FACTUM_METRIC_INVALID: ${metric}`);
    if (!Array.isArray(scopes) || !scopes.length) throw new Error("BUDGET_SCOPES_REQUIRED");
    if (!Number.isFinite(Number(amount)) || Number(amount) < 0) throw new Error(`BUDGET_AMOUNT_INVALID: ${amount}`);
    if (!idempotencyKey) throw new Error("BUDGET_IDEMPOTENCY_KEY_REQUIRED");
    const uniqueScopes = [...new Map(scopes.map(scope => [`${scope.type}:${scope.id}`, scope])).values()];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const budgets = uniqueScopes.map(scope => this.db.prepare("SELECT * FROM budgets WHERE scope_type=? AND scope_id=? AND metric=?").get(scope.type, scope.id, metric)).filter(Boolean);
      const existing = budgets.filter(budget => this.db.prepare("SELECT 1 FROM budget_entries WHERE budget_id=? AND idempotency_key=?").get(budget.id, String(idempotencyKey)));
      if (existing.length) { this.db.exec("COMMIT"); return { applied: false, idempotent: true, exhausted: existing.some(item => item.status === "exhausted") }; }
      let exhausted = false, maximumOvershoot = 0;
      for (const budget of budgets) {
        const used = budget.used_value + Number(amount), overshoot = Math.max(0, used - budget.limit_value);
        exhausted ||= used >= budget.limit_value; maximumOvershoot = Math.max(maximumOvershoot, overshoot);
        this.db.prepare("UPDATE budgets SET used_value=?,status=?,updated_at=? WHERE id=?").run(used, used >= budget.limit_value ? "exhausted" : "active", at, budget.id);
        this.db.prepare("INSERT INTO budget_entries(id,budget_id,task_id,run_id,amount,idempotency_key,reason,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(id("budget_entry"), budget.id, taskId, runId, Number(amount), String(idempotencyKey), reason, at);
      }
      if (runId && exhausted) appendEvent(this.db, { entityType: "workflow_run", entityId: runId, kind: "budget_post_factum_exhausted", payload: { metric, amount: Number(amount), overshoot: maximumOvershoot, semantics: "no subsequent model call may start" } });
      this.db.exec("COMMIT");
      return { applied: true, idempotent: false, exhausted, overshoot: maximumOvershoot };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  remaining(scopeType, scopeId, metric) {
    const budget = this.db.prepare("SELECT * FROM budgets WHERE scope_type=? AND scope_id=? AND metric=?").get(scopeType, scopeId, metric);
    return budget ? Math.max(0, budget.limit_value - budget.used_value) : null;
  }

  assertModelAdmission({ scopes, taskId = null, runId = null, at = now() }) {
    const blockers = [...new Map(scopes.map(scope => [`${scope.type}:${scope.id}`, scope])).values()]
      .map(scope => this.db.prepare("SELECT * FROM budgets WHERE scope_type=? AND scope_id=? AND metric='cost_usd'").get(scope.type, scope.id))
      .filter(budget => budget && (budget.status !== "active" || budget.used_value >= budget.limit_value))
      .map(budget => ({ budgetId: budget.id, scopeType: budget.scope_type, scopeId: budget.scope_id, used: budget.used_value, limit: budget.limit_value }));
    if (!blockers.length) return { admitted: true };
    const payload = { metric: "cost_usd", semantics: "post_factum_stop", blockers };
    if (runId) appendEvent(this.db, { entityType: "workflow_run", entityId: runId, kind: "budget_admission_denied", payload });
    if (taskId) appendEvent(this.db, { entityType: "task", entityId: taskId, kind: "budget_admission_denied", payload });
    if (runId) {
      const run = this.db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId);
      if (run && canTransition("workflow_run", run.state, "blocked")) transitionRunAndTask(this.db, runId, "blocked", { reason: "post-factum cost budget exhausted" });
    }
    const error = new Error(`BUDGET_EXHAUSTED: ${JSON.stringify(blockers)}`); error.blockers = blockers; throw error;
  }
}

export async function invokeWithinBudget(manager, budgetRequest, invocation) {
  manager.assertModelAdmission(budgetRequest);
  manager.consume(budgetRequest);
  return invocation();
}
