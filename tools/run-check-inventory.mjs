import fs from "node:fs";
import path from "node:path";
import { openDb } from "../WorkflowPlatform/src/db.mjs";
import { resolveProjectChecks, runProjectGate } from "../WorkflowPlatform/src/gates.mjs";

function cliArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`UNKNOWN_ARGUMENT: ${item}`);
    const key = item.slice(2);
    if (!key) throw new Error("EMPTY_ARGUMENT");
    args[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? true : argv[++index];
  }
  return args;
}

function required(args, key) {
  if (typeof args[key] !== "string" || !args[key].trim()) throw new Error(`REQUIRED_ARGUMENT: --${key}`);
  return path.resolve(args[key]);
}

const args = cliArgs(process.argv);
const database = required(args, "db");
const projectId = typeof args["project-id"] === "string" && args["project-id"].trim() ? args["project-id"] : null;
const level = typeof args.level === "string" && args.level.trim() ? args.level : "security";
const output = typeof args.output === "string" && args.output.trim() ? path.resolve(args.output) : null;
if (!projectId) throw new Error("REQUIRED_ARGUMENT: --project-id");

const db = openDb(database);
let project;
let checks;
try {
  project = db.prepare("SELECT id,name,root_path FROM projects WHERE id=?").get(projectId);
  if (!project) throw new Error(`PROJECT_NOT_REGISTERED: ${projectId}`);
  checks = resolveProjectChecks(db, projectId, level, null);
} finally {
  db.close();
}

const startedAt = new Date().toISOString();
const results = [];
for (const check of checks) {
  const taskId = `check-inventory:${projectId}:${check.semantic_id}:${Date.now()}`;
  const gate = await runProjectGate(project.root_path, level, database, taskId, { checkIds: [check.semantic_id] });
  const observed = gate.checks.find(item => item.id === check.check_id) ?? gate.checks[0] ?? {
    id: check.check_id, status: "unavailable", failure: "check produced no result"
  };
  results.push({
    id: check.semantic_id,
    database_id: check.check_id,
    name: check.name,
    kind: check.kind,
    required: check.required,
    status: observed.status,
    reason: observed.failure ?? null,
    capability: observed.command_capability ?? null,
    execution_project_id: observed.execution_project_id ?? null,
    execution_root: observed.execution_root ?? null,
    gate_run_id: taskId,
    duration_ms: observed.duration_ms ?? null
  });
}

const report = {
  schema_version: 1,
  inventory: "registered_checks_outside_workflow",
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  project: { id: project.id, name: project.name, root_path: project.root_path },
  level,
  checks: results,
  summary: Object.fromEntries(["passed", "failed", "unavailable", "timed_out"].map(status => [status, results.filter(item => item.status === status).length])),
  required_blockers: results.filter(item => item.required && item.status !== "passed").map(item => ({ id: item.id, status: item.status, reason: item.reason }))
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, text, "utf8");
}
process.stdout.write(text);
