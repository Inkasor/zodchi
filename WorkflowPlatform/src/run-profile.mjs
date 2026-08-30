import { now } from "./db.mjs";
import { stableJson, structuredHash } from "./role-contracts.mjs";

export const RUN_PROFILE_AXES = Object.freeze({
  quality_mode: Object.freeze(["prototype", "mvp", "production", "security-audit"]),
  execution_mode: Object.freeze(["standard", "goal"]),
  verification_mode: Object.freeze(["baseline", "gauntlet"]),
  planning_mode: Object.freeze(["single", "ensemble"])
});

const AXES = Object.freeze(Object.keys(RUN_PROFILE_AXES));

function validateAxis(axis, value) {
  if (!RUN_PROFILE_AXES[axis].includes(value)) throw new Error(`RUN_PROFILE_${axis.toUpperCase()}_INVALID: ${value ?? "missing"}`);
  return value;
}

function independentPlannerKeys(bindings = []) {
  return [...new Set(bindings.map(binding => [binding.provider, binding.profile ?? binding.profile_id, binding.model].filter(Boolean).join(":"))
    .filter(Boolean))].sort();
}

export function normalizeRunProfile(input = {}, { plannerBindings = [] } = {}) {
  const profile = Object.fromEntries(AXES.map(axis => [axis, validateAxis(axis, input[axis])]));
  const plannerKeys = independentPlannerKeys(plannerBindings);
  const warnings = [];
  if (profile.planning_mode === "ensemble" && plannerKeys.length < 2) {
    profile.planning_mode = "single";
    warnings.push("ensemble_unavailable: fewer than two independent planner bindings");
  }
  const normalizedBindings = plannerBindings.map(binding => ({
    role: binding.role ?? binding.role_id ?? null,
    provider: binding.provider ?? null,
    profile: binding.profile ?? binding.profile_id ?? null,
    model: binding.model ?? null
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  return Object.freeze({ ...profile, planner_bindings: normalizedBindings, warnings: Object.freeze(warnings) });
}

export function projectRunProfileDefault(db, projectId, qualityMode) {
  return db.prepare("SELECT * FROM project_run_profile_defaults WHERE project_id=? AND quality_mode=?").get(projectId, qualityMode) ?? null;
}

export function listProjectRunProfileDefaults(db, projectId) {
  return db.prepare("SELECT project_id,quality_mode,execution_mode,verification_mode,planning_mode,confirmed_by,confirmed_at FROM project_run_profile_defaults WHERE project_id=? ORDER BY CASE quality_mode WHEN 'prototype' THEN 0 WHEN 'mvp' THEN 1 WHEN 'production' THEN 2 ELSE 3 END").all(projectId);
}

export function setProjectRunProfileDefault(db, { projectId, qualityMode, executionMode, verificationMode, planningMode, confirmedBy }) {
  const normalized = normalizeRunProfile({ quality_mode: qualityMode, execution_mode: executionMode, verification_mode: verificationMode, planning_mode: planningMode });
  const timestamp = now();
  db.prepare(`INSERT INTO project_run_profile_defaults(project_id,quality_mode,execution_mode,verification_mode,planning_mode,confirmed_by,confirmed_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,quality_mode) DO UPDATE SET
      execution_mode=excluded.execution_mode,verification_mode=excluded.verification_mode,planning_mode=excluded.planning_mode,
      confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at`)
    .run(projectId, normalized.quality_mode, normalized.execution_mode, normalized.verification_mode, normalized.planning_mode, String(confirmedBy), timestamp);
  return projectRunProfileDefault(db, projectId, normalized.quality_mode);
}

export function resolveRunProfile(db, { projectId, qualityMode, overrides = {}, plannerBindings = [] }) {
  validateAxis("quality_mode", qualityMode);
  const defaults = projectRunProfileDefault(db, projectId, qualityMode);
  const sources = { quality_mode: "classification" };
  const candidate = { quality_mode: qualityMode };
  for (const axis of AXES.filter(axis => axis !== "quality_mode")) {
    if (overrides[axis] !== undefined) {
      candidate[axis] = overrides[axis]; sources[axis] = "task";
    } else if (defaults) {
      candidate[axis] = defaults[axis]; sources[axis] = "project_default";
    }
  }
  const missing = AXES.filter(axis => candidate[axis] === undefined);
  if (missing.length) return Object.freeze({ status: "needs_owner_choice", quality_mode: qualityMode, missing: Object.freeze(missing), sources: Object.freeze(sources) });
  const profile = normalizeRunProfile(candidate, { plannerBindings });
  if (profile.planning_mode !== candidate.planning_mode) sources.planning_mode = "capability_fallback";
  return Object.freeze({ status: "resolved", ...profile, sources: Object.freeze(sources) });
}

export function storeRunProfile(db, runId, resolved, { status = "fixed", confirmedBy = null } = {}) {
  if (resolved.status && resolved.status !== "resolved") throw new Error(`RUN_PROFILE_NOT_RESOLVED: ${resolved.status}`);
  if (!["proposed", "fixed", "superseded"].includes(status)) throw new Error(`RUN_PROFILE_STATUS_INVALID: ${status}`);
  const core = Object.fromEntries(AXES.map(axis => [axis, resolved[axis]]));
  const profileHash = structuredHash({ ...core, planner_bindings: resolved.planner_bindings ?? [] });
  const timestamp = now();
  db.prepare(`INSERT INTO run_profiles(run_id,quality_mode,execution_mode,verification_mode,planning_mode,sources_json,planner_bindings_json,profile_hash,status,confirmed_by,confirmed_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      quality_mode=excluded.quality_mode,execution_mode=excluded.execution_mode,verification_mode=excluded.verification_mode,
      planning_mode=excluded.planning_mode,sources_json=excluded.sources_json,planner_bindings_json=excluded.planner_bindings_json,
      profile_hash=excluded.profile_hash,status=excluded.status,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at`)
    .run(runId, core.quality_mode, core.execution_mode, core.verification_mode, core.planning_mode, stableJson(resolved.sources ?? {}),
      stableJson(resolved.planner_bindings ?? []), profileHash, status, confirmedBy, confirmedBy ? timestamp : null, timestamp);
  return db.prepare("SELECT * FROM run_profiles WHERE run_id=?").get(runId);
}
