import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db.mjs";
import { normalizeRunProfile, resolveRunProfile, setProjectRunProfileDefault, storeRunProfile } from "../src/run-profile.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-run-profile-"));
  const db = openDb(path.join(root, "workflow.sqlite")), timestamp = new Date().toISOString();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(root, timestamp);
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status) VALUES('workflow','Workflow','project','prototype','L1','active')").run();
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at) VALUES('task','project','Task','received',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO workflow_runs(id,task_id,project_id,workflow_id,state,operational_level,user_message,created_at,updated_at) VALUES('run','task','project','workflow','received','prototype','Task',?,?)").run(timestamp, timestamp);
  return { root, db };
}

test("missing project defaults require an explicit owner choice", () => {
  const value = fixture();
  try { assert.deepEqual(resolveRunProfile(value.db, { projectId: "project", qualityMode: "prototype" }).missing, ["execution_mode", "verification_mode", "planning_mode"]); }
  finally { value.db.close(); fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("project defaults resolve all four independent axes", () => {
  const value = fixture();
  try {
    setProjectRunProfileDefault(value.db, { projectId: "project", qualityMode: "prototype", executionMode: "goal", verificationMode: "gauntlet", planningMode: "single", confirmedBy: "owner" });
    const resolved = resolveRunProfile(value.db, { projectId: "project", qualityMode: "prototype" });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.execution_mode, "goal");
    assert.equal(resolved.verification_mode, "gauntlet");
    assert.equal(resolved.planning_mode, "single");
    assert.equal(resolved.sources.execution_mode, "project_default");
  } finally { value.db.close(); fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("ensemble is never simulated with fewer than two independent planners", () => {
  const profile = normalizeRunProfile({ quality_mode: "mvp", execution_mode: "standard", verification_mode: "baseline", planning_mode: "ensemble" }, {
    plannerBindings: [{ provider: "codex", profile: "planner" }, { provider: "codex", profile: "planner" }]
  });
  assert.equal(profile.planning_mode, "single");
  assert.match(profile.warnings[0], /ensemble_unavailable/);
  const ensemble = normalizeRunProfile({ quality_mode: "mvp", execution_mode: "standard", verification_mode: "baseline", planning_mode: "ensemble" }, {
    plannerBindings: [{ provider: "codex", profile: "planner" }, { provider: "claude-code", profile: "planner" }]
  });
  assert.equal(ensemble.planning_mode, "ensemble");
});

test("a fixed run profile is hash-bound to the run", () => {
  const value = fixture();
  try {
    const resolved = { status: "resolved", ...normalizeRunProfile({ quality_mode: "prototype", execution_mode: "goal", verification_mode: "gauntlet", planning_mode: "single" }), sources: { quality_mode: "classification" } };
    const stored = storeRunProfile(value.db, "run", resolved, { confirmedBy: "owner" });
    assert.equal(stored.status, "fixed");
    assert.equal(stored.confirmed_by, "owner");
    assert.equal(stored.profile_hash.length, 64);
  } finally { value.db.close(); fs.rmSync(value.root, { recursive: true, force: true }); }
});
