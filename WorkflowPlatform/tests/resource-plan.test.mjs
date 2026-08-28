import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { onboardProject } from "../src/onboarding.mjs";
import { openDb } from "../src/db.mjs";
import { processMessage } from "../src/workflow-app.mjs";
import { validatePlannerResult } from "../src/role-contracts.mjs";
import { resourceIdentity } from "../src/resource-locks.mjs";
import { projectResources, registeredResources } from "../src/project-resources.mjs";

// The lock core is exercised in resource-locks.test.mjs by holding leases directly. These cases are
// about the other half: whether a resource declared by a real project reaches a real step through a real
// plan. It did not. The planner contract had no field for resources, so every model-planned step was
// stored with an empty list, the receipt guard saw nothing declared and let the step write with no lock
// at all, and a correction rebuilt the step without whatever the plan had said.

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function classification() {
  return {
    schema_version: 1, work_type: "implementation", artifact_type: "code", domain: "workflow", discipline: "software",
    risk: "high", planning_level: "L2", quality_mode: "mvp", planning_required: true, human_required: false,
    needs_questions: false, document_required: false, reply_mode: "work", pending_interaction_id: null,
    pending_interaction_response: null, reason: "Нужен ограниченный пакет кода.", questions: [], human_response: null
  };
}

function roleContract(roleId, schema) {
  return {
    id: `contract-${roleId}`, role_id: roleId, version: "1.0.0", purpose: `${roleId} test contract`, boundaries: { writes: roleId === "worker" },
    allowed_work_types: ["*"], allowed_artifact_types: ["code"], allowed_tools: [], allowed_skills: [], required_checks: ["check-ok"],
    allowed_transitions: [], allowed_profiles: ["*"], context_limit_bytes: 65536, max_calls: 2,
    max_correction_cycles: roleId === "worker" || roleId === "planner" ? 1 : 0,
    timeout_seconds: 60, result_schema_key: schema, prompt_template_version: "1.0.0", escalation: { on_invalid: "blocked" }
  };
}

function fixture(prefix) {
  const root = temporaryRoot(prefix);
  const project = path.join(root, "project");
  const infobase = path.join(root, "erp-infobase");
  const dbFile = path.join(root, "workflow.sqlite");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(infobase, { recursive: true });
  fs.writeFileSync(path.join(infobase, "1Cv8.1CD"), "file information base");
  fs.writeFileSync(path.join(project, "src", "context.mjs"), "export function inspect(value) { return value; }\n");
  const roles = [["planner", "planner.v1"], ["worker", "worker.v1"], ["reviewer", "reviewer.v1"]];
  onboardProject(dbFile, {
    project: { id: "project", name: "Project", root_path: project },
    workflow: { id: "workflow", name: "Workflow", discovery: { git: false }, history_budget_bytes: 8192 },
    profiles: roles.map(([role]) => ({ id: `profile-${role}`, provider: "codex", name: `local-${role}`, role_id: role })),
    routes: [{ work_type_id: "implementation" }],
    checks: [{ id: "check-ok", name: "Test check", runner: "fixture", kind: "fixture", config: { status: "passed" } }],
    project_checks: [{ check_id: "check-ok", quality_mode_id: "mvp", required: true }],
    resources: [{ alias: "erp", kind: "1c.file", purpose: "The trade information base", declaration: { path: infobase } }],
    role_contracts: roles.map(([role, schema]) => roleContract(role, schema)),
    role_assignments: roles.map(([role]) => ({ role_id: role, profile_id: `profile-${role}`, operational_level: "mvp" }))
  });
  return { root, project, infobase, dbFile };
}

function plan(resources) {
  return {
    schema_version: 1, outcome: "ready", scope: { included: ["bounded result"], excluded: [] },
    allowed_paths: ["src/output.txt"], inputs: ["registered context"], checks: ["check-ok"], risks: [],
    artifacts: [{ key: "code-output", type: "code", path: "src/output.txt", required: true }],
    completion_criteria: ["registered gate passes"], questions: [],
    steps: [{ key: "worker", role: "worker", objective: "Create the bounded output", allowed_paths: ["src/output.txt"], artifact_keys: ["code-output"], check_ids: ["check-ok"], resources, required: true, irreversible: false, max_attempts: 1 }]
  };
}

function receipt(role, result) {
  const timestamp = new Date().toISOString();
  return {
    receiptId: `${role}-receipt`, taskId: `${role}-task`, provider: "codex", profile: `local-${role}`, role,
    status: "completed", exitCode: 0, startedAt: timestamp, finishedAt: timestamp, usage: { input_tokens: 10, output_tokens: 5 },
    output: JSON.stringify({ item: { text: JSON.stringify(result) } })
  };
}

test("a resource the project registered reaches the step, the lock and the receipt as one identity", async () => {
  const env = fixture("zodchi-resource-plan-");
  const worktreeIdentity = resourceIdentity({ kind: "project.worktree", mode: "exclusive", path: env.project });
  const infobaseIdentity = resourceIdentity({ kind: "1c.file", mode: "exclusive", path: env.infobase });
  const expected = [infobaseIdentity, worktreeIdentity].sort();

  const gatewayCall = async request => {
    if (request.role === "planner") return receipt("planner", plan([{ alias: "erp", mode: "exclusive" }]));
    if (request.role === "worker") {
      const file = path.join(env.project, "src", "output.txt");
      fs.writeFileSync(file, "bounded output");
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      return receipt("worker", { schema_version: 1, status: "completed", summary: "Готово.", changed_paths: ["src/output.txt"], artifacts: [{ key: "code-output", type: "code", path: "src/output.txt", content_hash: hash, status: "created" }], evidence: ["file written"], questions: [], external_evidence_request: null });
    }
    return receipt("reviewer", { schema_version: 1, decision: "PASS", summary: "Всё сходится.", blockers: [], required_actions: [], evidence_refs: ["gate:passed"] });
  };
  // A failing registered check is what routes a targeted correction back to the step bound to it, which
  // is the cheapest way to make the run rebuild a planned step from the plan.
  let gates = 0;
  const gateRunner = async () => {
    gates += 1;
    return gates === 1
      ? { status: "failed", checks: [{ id: "check-ok", required: true, status: "failed", failure_path: "src/output.txt" }] }
      : { status: "passed", checks: [{ id: "check-ok", required: true, status: "passed" }] };
  };

  const result = await processMessage({ message: "Собери ограниченный вывод", project: env.project, dbFile: env.dbFile, execute: true, classificationResult: classification(), gatewayCall, gateRunner });
  assert.equal(result.execution.status, "completed");

  const db = openDb(env.dbFile);
  // The plan named one alias; the platform added the working tree, because the role writes and two
  // workers editing one checkout is the conflict nobody remembers to declare.
  const workerSteps = db.prepare("SELECT step_key,role_id,resources_json FROM workflow_steps WHERE run_id=? AND role_id='worker' ORDER BY ordinal").all(result.run_id)
    .map(row => ({ ...row, resources: JSON.parse(row.resources_json) }));
  assert.equal(workerSteps.length, 2, "one planned worker step and one correction step");
  for (const step of workerSteps) {
    assert.deepEqual(step.resources.map(item => resourceIdentity(item)).sort(), expected);
    assert.deepEqual(step.resources.map(item => item.mode), ["exclusive", "exclusive"]);
  }
  // A correction reuses the planned step, so it holds what the plan said that step touches. Rebuilding
  // it without them let a corrected worker write with no lock while the plan still declared one.
  assert.equal(workerSteps[1].step_key.includes("correction"), true);

  // The attempt receipt names the identities the attempt actually held, not the declaration it started
  // from: that is the only record that says what was locked while the work ran.
  const receipts = db.prepare("SELECT a.details_json FROM attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE s.run_id=? AND s.role_id='worker' AND a.state='succeeded'").all(result.run_id).map(row => JSON.parse(row.details_json));
  assert.equal(receipts.length, 2);
  for (const detail of receipts) assert.deepEqual(detail.resources.map(item => item.identity).sort(), expected);

  // Nothing is still held, and each resource was held under one canonical name.
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM resource_leases WHERE released_at IS NULL").get().count, 0);
  assert.deepEqual(db.prepare("SELECT DISTINCT identity FROM resource_leases ORDER BY identity").all().map(row => row.identity), expected);
  assert.deepEqual([...new Set(db.prepare("SELECT release_reason FROM resource_leases").all().map(row => row.release_reason))], ["completed"]);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});

test("a plan chooses among registered aliases and cannot name an authority of its own", () => {
  const env = fixture("zodchi-resource-alias-");
  const db = openDb(env.dbFile);
  const registered = registeredResources(db, "project");
  // The working tree is registered for every project whether or not anyone declared it.
  assert.deepEqual(registered.map(item => item.alias), ["erp", "project.worktree"]);
  assert.equal(registered.every(item => !Object.hasOwn(item, "declaration")), true, "authorities are not shown to a planner");
  assert.equal(projectResources(db, "project").find(item => item.alias === "erp").declaration.path, env.infobase);

  const options = { contract: { allowed_artifact_types: ["code"] }, registeredRoles: ["worker"], registeredChecks: ["check-ok"], registeredArtifactTypes: ["code"], registeredResources: registered, maxStepAttempts: 1 };
  assert.doesNotThrow(() => validatePlannerResult(structuredClone(plan([{ alias: "erp", mode: "shared" }])), options));
  // An alias nobody registered, an authority written out by the model, and a mode that is neither of the
  // two the lock knows: each would be a resource the owner never declared.
  assert.throws(() => validatePlannerResult(structuredClone(plan([{ alias: "erp-test", mode: "shared" }])), options), /unregistered alias erp-test/);
  assert.throws(() => validatePlannerResult(structuredClone(plan([{ kind: "1c.file", path: "erp", mode: "exclusive" }])), options), /planner\.v1\.step\.resource: fields mismatch/);
  assert.throws(() => validatePlannerResult(structuredClone(plan([{ alias: "erp", mode: "write" }])), options), /invalid mode write/);
  db.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});
