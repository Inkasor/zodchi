import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now, id } from "../src/db.mjs";
import { Runtime } from "../src/runtime.mjs";
import { applyWorkflowImport, proposeWorkflowImport, serializeWorkflowPackage } from "../src/workflow-package.mjs";
import { fileURLToPath } from "node:url";
import * as builders from "../packages/builders.mjs";
import defineExample from "../packages/example/definitions.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The example package is built here rather than read from disk, so these tests do not depend on
// which definition source the installation configured.
const examplePackageFile = directory => { const file = path.join(directory, "software.web-application.xml"); fs.writeFileSync(file, serializeWorkflowPackage(defineExample(builders).packages[0]), "utf8"); return file; };
function temporaryRoot(prefix) { const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, prefix)); }

function setup() {
  const root = temporaryRoot("workflow-asset-boundaries-"), project = path.join(root, "project"), dbFile = path.join(root, "workflow.sqlite"), packageFile = examplePackageFile(root), proposal = path.join(root, "proposal.json"); fs.mkdirSync(project);
  let db = openDb(dbFile); db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, now()); db.close();
  proposeWorkflowImport(dbFile, packageFile, proposal, "project"); applyWorkflowImport(dbFile, proposal, "project", { confirmedBy: "contract-test-local-import" }); return { root, project, dbFile };
}
function workflowId(db, key) { return db.prepare(`SELECT m.local_id FROM package_import_mappings m JOIN workflow_import_proposals p ON p.id=m.proposal_id WHERE p.target_project_id='project' AND p.status='applied' AND m.entity_type='workflow' AND m.semantic_key=?`).get(key).local_id; }

test("visual and audio proposals preserve provenance and block completion on separate human acceptance", () => {
  const env = setup(), scenarios = [
    { key: "visual", workflow: "software_web_application.content", kind: "content", artifact: "visual_asset", uri: "proposal://visual/checkpoint9", approval: "human_visual_acceptance", provenance: { origin: "anonymized_visual_proposal", generation: "not_run", rights_review: "pending", technical_review: "separate" } },
    { key: "audio", workflow: "software_web_application.content", kind: "asset", artifact: "content_asset", uri: "proposal://audio/checkpoint9", approval: "human_audio_acceptance", provenance: { origin: "anonymized_audio_brief", production: "not_run", integration: "contract_validated", rights_review: "pending" } }
  ];
  for (const scenario of scenarios) {
    let db = openDb(env.dbFile); const workflow = workflowId(db, scenario.workflow); db.close(); const runtime = new Runtime(env.dbFile), runId = runtime.create(`${scenario.key} bounded proposal`, { project_id: "project", workflow_id: workflow });
    runtime.classify(runId, { schema_version: 1, kind: scenario.kind, artifact_type: scenario.artifact, domain: "game-development", discipline: scenario.key === "visual" ? "art_direction" : "audio", risk: "low", level: "L2", quality: "mvp", planning_required: true, human_required: true, document_required: false, reply_mode: "work", needs_questions: false, questions: [], reason: "Owner acceptance remains separate", human_response: "" });
    runtime.setState(runId, "planning"); runtime.setState(runId, "executing"); const taskId = runtime.get(runId).task_id, timestamp = now();
    runtime.db.prepare("INSERT INTO artifacts(id,task_id,run_id,kind,uri,status,provenance_json,created_at,updated_at) VALUES(?,?,?,?,?,'proposed',?,?,?)").run(id("artifact"), taskId, runId, scenario.artifact, scenario.uri, JSON.stringify(scenario.provenance), timestamp, timestamp);
    if (scenario.key === "audio") runtime.recordGate(runId, { status: "passed", checks: [{ id: "audio_contract", required: true, status: "passed" }] }, "technical", true);
    runtime.db.prepare("INSERT INTO approvals(id,task_id,run_id,kind,question,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(id("approval"), taskId, runId, scenario.approval, "Petr must separately accept or reject the concrete asset.", timestamp);
    runtime.setState(runId, "approval_required", { reason: "human acceptance is independent" }); assert.throws(() => runtime.setState(runId, "completed"), /COMPLETION_BLOCKED/); runtime.db.close();
    db = openDb(env.dbFile); assert.equal(db.prepare("SELECT state FROM workflow_runs WHERE id=?").get(runId).state, "approval_required"); const artifact = db.prepare("SELECT provenance_json,status FROM artifacts WHERE run_id=?").get(runId); assert.equal(artifact.status, "proposed"); assert.equal(JSON.parse(artifact.provenance_json).rights_review, "pending"); assert.equal(db.prepare("SELECT COUNT(*) count FROM approvals WHERE run_id=? AND status='pending'").get(runId).count, 1); db.close();
  }
  fs.rmSync(env.root, { recursive: true, force: true });
});
