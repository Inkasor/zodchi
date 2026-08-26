import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Runtime } from "../src/runtime.mjs";
import { workflowRunStatistics } from "../src/statistics.mjs";

function root() { const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(); fs.mkdirSync(parent, { recursive: true }); return fs.mkdtempSync(path.join(parent, "workflow-statistics-")); }

test("run statistics expose route, receipts, tokens, attempts, gates and artifacts without raw model payloads", () => {
  const temp = root(), dbFile = path.join(temp, "runtime.sqlite"), runtime = new Runtime(dbFile), timestamp = new Date().toISOString();
  runtime.db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(temp, timestamp);
  runtime.db.prepare("INSERT INTO workflows(id,name,project_id,package_key,package_version,default_quality,default_level,status) VALUES('workflow','Workflow','project','package.demo','1.0.0','mvp','L2','active')").run();
  const runId = runtime.create("bounded scenario", { project_id: "project", workflow_id: "workflow" });
  runtime.classify(runId, { schema_version: 1, kind: "implementation", artifact_type: "code", domain: "software", discipline: "software", risk: "low", level: "L2", quality: "mvp", planning_required: true, human_required: false, document_required: false, reply_mode: "work", needs_questions: false, questions: [], reason: "registered route", human_response: "" });
  runtime.linkGateway(runId, { receiptId: "receipt-1", taskId: "gateway-task", provider: "codex", modelProvider: "openai", profile: "local-review", role: "reviewer", status: "completed", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", model: "gpt-test", reasoningEffort: "low", correctionCycles: 0, retries: 1, usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, service_tier: "test" }, output: "RAW_OUTPUT_MUST_NOT_PERSIST" });
  runtime.db.prepare("UPDATE workflow_runs SET correction_cycles=1 WHERE id=?").run(runId);
  runtime.recordGate(runId, { status: "passed", duration_ms: 25, checks: [{ id: "check.demo", required: true, status: "passed", duration_ms: 20 }] });
  const taskId = runtime.get(runId).task_id;
  runtime.db.prepare("INSERT INTO artifacts(id,task_id,run_id,kind,uri,content_hash,status,provenance_json,created_at,updated_at) VALUES('artifact',?,?, 'code','src/demo.mjs',NULL,'verified','{\"source\":\"worker\"}',?,?)").run(taskId, runId, timestamp, timestamp);
  runtime.setState(runId, "planning"); runtime.setState(runId, "executing"); runtime.setState(runId, "verifying"); runtime.setState(runId, "review_required"); runtime.setState(runId, "completed"); runtime.db.close();
  const report = workflowRunStatistics(dbFile, runId);
  assert.equal(report.route.package_key, "package.demo"); assert.equal(report.classification.kind, "implementation");
  assert.deepEqual(report.tokens, { input: 100, cached: 40, output: 20, reasoning: 5 });
  assert.equal(report.calls[0].model, "gpt-test"); assert.equal(report.calls[0].model_provider, "openai"); assert.equal(report.calls[0].provider, "codex"); assert.equal(report.calls[0].duration_ms, 1000);
  assert.equal(report.client, "codex"); assert.equal("harness" in report.calls[0], false);
  assert.equal(report.attempts.correction_cycles, 1); assert.equal(report.attempts.retries, 1);
  assert.equal(report.gates[0].checks[0].status, "passed"); assert.equal(report.artifacts[0].uri, "src/demo.mjs");
  assert.equal(report.final_state, "completed"); assert.equal(report.storage.raw_model_payloads_persisted, false);
  const databaseBytes = fs.readFileSync(dbFile).toString("utf8"); assert.equal(databaseBytes.includes("RAW_OUTPUT_MUST_NOT_PERSIST"), false);
  fs.rmSync(temp, { recursive: true, force: true });
});
