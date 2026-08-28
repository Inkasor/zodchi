import fs from "node:fs";
import path from "node:path";
import { buildPrompt } from "./prompt-builder.mjs";
import { lintFile } from "./lint.mjs";
import { deliverExternalControlResult, deliverExternalEvidencePacket, processMessage } from "./workflow-app.mjs";
import { onboardProject, registerProject, registerProjectRoot } from "./onboarding.mjs";
import { exportWorkflowPackage, proposeWorkflowImport, proposeWorkflowMigration, applyWorkflowImport } from "./workflow-package.mjs";
import { inspectWorkflowBundle } from "./workflow-bundle.mjs";
import { recordExperienceObservation, createExperienceProposal, evaluateExperienceProposal, applyExperienceProposal } from "./experience.mjs";
import { resolveWorkflowSettings } from "./paths.mjs";
import { configureInstallation } from "./installation.mjs";
import { applyHookInstallation, hookInstallationStatus, planHookInstallation } from "./hook-installation.mjs";
import { Runtime } from "./runtime.mjs";
import { ExecutionQueue } from "./execution-queue.mjs";
import { workflowRunStatistics } from "./statistics.mjs";
import { backupInstallation, restoreInstallation } from "./backup.mjs";
import { operationalPoliciesLint, qualityContractsLint } from "./quality-contracts.mjs";
import { configureOneCBslCheck, createOneCBslBaseline } from "./one-c-bsl-check.mjs";
import { readProjectContext } from "./document-context.mjs";
import { cancelInteraction, pendingInteractions } from "./interactions.mjs";
import { expandTerms, searchSources, sourceScope } from "./source-context.mjs";
import { buildCodeIntelligence, mergeGraphMatches } from "./code-intelligence.mjs";
import { runCSharpProvider } from "./csharp-provider.mjs";
import { applyIdleRunControl, requestRunControl, resumeRunControl, runControlStatus } from "./progress-supervisor.mjs";
import { createExternalControlRequest, pendingExternalControlRequests, registerExternalExecutor, requestExternalControlCancellation } from "./external-control-plane.mjs";
import { loadDefaultProjectPresetCatalog } from "./project-presets.mjs";
const args = Object.fromEntries(process.argv.slice(3).reduce((a, v, i, x) => { if (v.startsWith("--")) { const next = x[i + 1]; a.push([v.slice(2), next === undefined || next.startsWith("--") ? true : next]); } return a; }, []));
const settings = resolveWorkflowSettings();
if (process.argv[2] === "configure") { console.log(JSON.stringify(configureInstallation(JSON.parse(fs.readFileSync(args.config, "utf8"))), null, 2)); }
else if (process.argv[2] === "onboard") { console.log(JSON.stringify(onboardProject(args.db ?? settings.databasePath, JSON.parse(fs.readFileSync(args.config, "utf8"))), null, 2)); }
else if (process.argv[2] === "register-project") { console.log(JSON.stringify(registerProject(args.db ?? settings.databasePath, { id: args.id, name: args.name, root_path: args.root }), null, 2)); }
else if (process.argv[2] === "register-root") { console.log(JSON.stringify(registerProjectRoot(args.db ?? settings.databasePath, { project: args.project, key: args.key, path: args.path, access: args.access ?? "read" }), null, 2)); }
else if (process.argv[2] === "lint") { const r = lintFile(args.file ?? path.resolve("docs/WorkflowPlatform.md")); console.log(JSON.stringify(r)); process.exitCode = r.status === "passed" ? 0 : 1; }
else if (process.argv[2] === "quality-contracts-lint") { const file = args.file ?? path.resolve("contracts/quality-contracts.xml"); const r = qualityContractsLint(fs.readFileSync(file, "utf8")); console.log(JSON.stringify(r)); process.exitCode = r.status === "passed" ? 0 : 1; }
else if (process.argv[2] === "quality-policy-lint") { const runtime = new Runtime(args.db ?? settings.databasePath); try { const r = operationalPoliciesLint(runtime.db, args.project ?? null); console.log(JSON.stringify(r, null, 2)); process.exitCode = r.status === "passed" ? 0 : 1; } finally { runtime.db.close(); } }
else if (process.argv[2] === "one-c-bsl-baseline") { console.log(JSON.stringify(createOneCBslBaseline({ dbFile: args.db ?? settings.databasePath, projectId: args.project, executable: args.executable, source: args.source, workspace: args.workspace, platformBin: args["platform-bin"], tempRoot: args["temp-root"], acceptedRevision: args["accepted-revision"], confirmedBy: args["confirmed-by"], minimumSeverity: args["minimum-severity"], timeoutSeconds: args["timeout-seconds"], catalogFile: args.catalog }), null, 2)); }
else if (process.argv[2] === "one-c-bsl-configure") { console.log(JSON.stringify(configureOneCBslCheck(args.db ?? settings.databasePath, { projectId: args.project, executable: args.executable, platformBin: args["platform-bin"], runner: args.runner, tempRoot: args["temp-root"], catalogFile: args.catalog }), null, 2)); }
else if (process.argv[2] === "prompt") { console.log(buildPrompt({ role: "planner", stage: "planning", intent: args.intent ?? "", classification: { kind: "task", domain: "workflow", risk: "low", level: "L1", quality: "prototype" }, quality: "prototype", format: "JSON" })); }
else if (process.argv[2] === "run") { console.log(JSON.stringify(await processMessage({ message: args.message ?? "", project: args.project ?? null, origin: args.origin ?? null, dbFile: args.db ?? settings.databasePath, workflow: args.workflow ?? settings.workflow, eventSource: args["event-source"] ?? "cli", eventKey: args["event-key"] ?? null, preferredLanguage: args.language ?? settings.responseLanguage, execute: args.execute === true }), null, 2)); }
// The owner's side of the two waits. A question is answered in chat; an external evidence request is not,
// because the fact it asks for exists only outside anything the platform can read. These commands are how
// a packet reaches it, and how the owner withdraws a wait they have decided not to satisfy.
else if (process.argv[2] === "interactions") {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  try { console.log(JSON.stringify(pendingInteractions(runtime.db, args.project ?? settings.project), null, 2)); } finally { runtime.db.close(); }
}
else if (process.argv[2] === "interaction-cancel") {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  try { console.log(JSON.stringify(cancelInteraction(runtime.db, args.interaction, args.reason ?? "cancelled by the owner"), null, 2)); } finally { runtime.db.close(); }
}
else if (process.argv[2] === "evidence-deliver") {
  const result = await deliverExternalEvidencePacket({
    interactionId: args.interaction, packet: JSON.parse(fs.readFileSync(args.packet, "utf8")),
    project: args.project ?? settings.project, dbFile: args.db ?? settings.databasePath,
    preferredLanguage: args.language ?? settings.responseLanguage, execute: args.execute !== false
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.delivered ? 0 : 1;
}
else if (process.argv[2] === "external-executor-register") {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  try { console.log(JSON.stringify(registerExternalExecutor(runtime.db, { projectId: args.project, executorId: args.executor, purpose: args.purpose ?? null, publicKeyPem: fs.readFileSync(args["public-key"], "utf8"), keyId: args["key-id"] }), null, 2)); } finally { runtime.db.close(); }
}
else if (process.argv[2] === "external-control-create") {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  try { console.log(JSON.stringify(createExternalControlRequest(runtime.db, JSON.parse(fs.readFileSync(args.input, "utf8"))), null, 2)); } finally { runtime.db.close(); }
}
else if (process.argv[2] === "external-control-pending") {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  try { console.log(JSON.stringify(pendingExternalControlRequests(runtime.db, args.project), null, 2)); } finally { runtime.db.close(); }
}
else if (process.argv[2] === "external-control-cancel") {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  try { console.log(JSON.stringify(requestExternalControlCancellation(runtime.db, args.request, { actor: args.actor ?? "owner", reason: args.reason ?? "cancelled" }), null, 2)); } finally { runtime.db.close(); }
}
else if (process.argv[2] === "external-control-deliver") {
  const result = await deliverExternalControlResult({ packet: JSON.parse(fs.readFileSync(args.packet, "utf8")), project: args.project ?? settings.project, dbFile: args.db ?? settings.databasePath, preferredLanguage: args.language ?? settings.responseLanguage, execute: args.execute !== false });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.control?.status === "completed" && result.evidence?.delivered ? 0 : 1;
}
else if (process.argv[2] === "preset-lint" || process.argv[2] === "preset-inspect") {
  const catalog = loadDefaultProjectPresetCatalog({ presetFile: args.presets, packageFile: args.packages });
  if (process.argv[2] === "preset-lint") console.log(JSON.stringify({ status: "passed", presets: catalog.presets.length }, null, 2));
  else {
    const preset = catalog.presets.find(item => item.key === args.preset);
    if (!preset) throw new Error(`PRESET_NOT_FOUND: ${args.preset}`);
    console.log(JSON.stringify(preset, null, 2));
  }
}
// A hook configuration is shared with whatever else the project has configured, so installing one is a
// planned change rather than a file the onboarding agent writes from a template.
else if (process.argv[2] === "hook-plan" || process.argv[2] === "hook-install") {
  const plan = planHookInstallation({ projectRoot: args.project ?? settings.project, harness: args.harness ?? "claude-code", deliveryMode: args["delivery-mode"] ?? settings.deliveryMode ?? null, mode: args.mode ?? null });
  const result = process.argv[2] === "hook-plan" ? { ...plan, document: undefined } : applyHookInstallation(plan);
  console.log(JSON.stringify(result, null, 2));
}
else if (process.argv[2] === "hook-status") { console.log(JSON.stringify(hookInstallationStatus({ projectRoot: args.project ?? settings.project, harness: args.harness ?? "claude-code" }), null, 2)); }
else if (process.argv[2] === "workflow-export") { console.log(JSON.stringify(exportWorkflowPackage(args.db, args.out, args.project, args.workflow), null, 2)); }
else if (process.argv[2] === "workflow-import-propose") { console.log(JSON.stringify(proposeWorkflowImport(args.db, args.package, args.proposal, args.project), null, 2)); }
else if (process.argv[2] === "workflow-migration-propose") { console.log(JSON.stringify(proposeWorkflowMigration(args.db, args.package, args.proposal, args.project, args.from), null, 2)); }
else if (process.argv[2] === "workflow-import-apply") { console.log(JSON.stringify(applyWorkflowImport(args.db, args.proposal, args.project, { confirmedBy: args["confirmed-by"] }), null, 2)); }
else if (process.argv[2] === "workflow-bundle-inspect") { const result = inspectWorkflowBundle(args.bundle); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "passed" ? 0 : 1; }
else if (process.argv[2] === "experience-record") { console.log(JSON.stringify(recordExperienceObservation(args.db, JSON.parse(fs.readFileSync(args.input, "utf8"))), null, 2)); }
else if (process.argv[2] === "experience-propose") { console.log(JSON.stringify(createExperienceProposal(args.db, JSON.parse(fs.readFileSync(args.input, "utf8"))), null, 2)); }
else if (process.argv[2] === "experience-evaluate") { const results = JSON.parse(fs.readFileSync(args.results, "utf8")); console.log(JSON.stringify(await evaluateExperienceProposal(args.db, args.proposal, request => results[request.scenario_key]?.[request.variant]), null, 2)); }
else if (process.argv[2] === "experience-apply") { console.log(JSON.stringify(applyExperienceProposal(args.db, args.proposal, { confirmedBy: args["confirmed-by"] }), null, 2)); }
else if (process.argv[2] === "run-statistics") { console.log(JSON.stringify(workflowRunStatistics(args.db ?? settings.databasePath, args.run), null, 2)); }
else if (process.argv[2] === "run-status") {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  try { console.log(JSON.stringify(runControlStatus(runtime.db, args.run), null, 2)); } finally { runtime.db.close(); }
}
else if (process.argv[2] === "run-watch") {
  const terminal = new Set(["completed", "rejected", "failed", "cancelled", "blocked"]), interval = Math.max(250, Number(args["interval-ms"] ?? 1000));
  let previous = "";
  while (true) {
    const runtime = new Runtime(args.db ?? settings.databasePath);
    let status;
    try { status = runControlStatus(runtime.db, args.run); } finally { runtime.db.close(); }
    const serialized = JSON.stringify(status);
    if (serialized !== previous) process.stdout.write(`${serialized}\n`);
    previous = serialized;
    if (terminal.has(status.state) || args.once === true) break;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
else if (process.argv[2] === "code-search") {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  try {
    const discovery = readProjectContext(args.project, runtime.db), scope = sourceScope(discovery.source_scope), query = args.query ?? "";
    const expanded = expandTerms(discovery.roots, scope, query), lexical = searchSources(discovery.roots, scope, expanded.terms, { indexedTerms: expanded.code });
    const intelligence = buildCodeIntelligence(discovery.roots, scope, expanded.terms, lexical, { primaryTerms: expanded.code, contextTerms: expanded.subject });
    console.log(JSON.stringify({ query, derived_from: { request_words: expanded.subject, identifiers: expanded.harvested, explicit_identifiers: expanded.code }, result: mergeGraphMatches(lexical, intelligence) }, null, 2));
  } finally { runtime.db.close(); }
}
else if (process.argv[2] === "csharp-provider") { console.log(JSON.stringify(await runCSharpProvider(JSON.parse(fs.readFileSync(args.config, "utf8"))), null, 2)); }
else if (process.argv[2] === "backup") { console.log(JSON.stringify(await backupInstallation({ workflowDatabase: args.db ?? settings.databasePath, gatewayDatabase: args["gateway-db"] ?? settings.gatewayDatabasePath, outputDirectory: args.out }), null, 2)); }
else if (process.argv[2] === "restore") { console.log(JSON.stringify(restoreInstallation({ backupDirectory: args.backup, workflowDatabase: args.db ?? settings.databasePath, gatewayDatabase: args["gateway-db"] ?? settings.gatewayDatabasePath }), null, 2)); }
else if (["queue-recover", "run-pause", "run-resume", "run-cancel", "dead-letter-retry"].includes(process.argv[2])) {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  const queue = new ExecutionQueue(runtime.db);
  try {
    if (process.argv[2] === "queue-recover") console.log(JSON.stringify(queue.recoverExpiredLeases(args.at ?? undefined), null, 2));
    else if (process.argv[2] === "run-pause") { const request = requestRunControl(runtime.db, args.run, "pause", args.reason ?? "paused by CLI"); console.log(JSON.stringify({ ...request, applied: applyIdleRunControl(runtime.db, queue, args.run) }, null, 2)); }
    else if (process.argv[2] === "run-resume") console.log(JSON.stringify({ run_id: args.run, state: resumeRunControl(runtime.db, queue, args.run) }, null, 2));
    else if (process.argv[2] === "run-cancel") { const request = requestRunControl(runtime.db, args.run, "cancel", args.reason ?? "cancelled by CLI"); console.log(JSON.stringify({ ...request, applied: applyIdleRunControl(runtime.db, queue, args.run) }, null, 2)); }
    else console.log(JSON.stringify(queue.retryDeadLetter(args["dead-letter"], { approved: args.approved === true, actor: args.actor ?? "CLI operator" }), null, 2));
  } finally { runtime.db.close(); }
}
else console.log("Usage: node src/cli.mjs configure --config <file> | register-project --id <id> --name <name> --root <absolute-path> | onboard | lint | quality-contracts-lint | quality-policy-lint [--project <id>] | one-c-bsl-baseline --db <db> --project <id> --executable <file> --source <directory> --platform-bin <directory> --accepted-revision <sha> --confirmed-by <owner> --temp-root <directory> | one-c-bsl-configure --db <db> --project <id> --executable <file> --platform-bin <directory> --runner <file> --temp-root <directory> | prompt | run [--event-key <id>] | code-search --db <db> --project <id> --query <text> | csharp-provider --config <json> | external-executor-register | external-control-create|pending|cancel|deliver | preset-lint | preset-inspect --preset <key> | run-statistics|run-status|run-watch --db <db> --run <id> | backup --db <workflow-db> --gateway-db <gateway-db> --out <directory> | restore --backup <directory> --db <new-workflow-db> --gateway-db <new-gateway-db> | queue-recover | run-pause --run <id> | run-resume --run <id> | run-cancel --run <id> | dead-letter-retry --dead-letter <id> [--approved] | workflow-export --db <db> --out <file> --project <id> | workflow-import-propose --db <db> --package <file> --proposal <file> --project <id> | workflow-migration-propose --db <db> --package <file> --proposal <file> --project <id> --from <package-key> | workflow-import-apply --db <db> --proposal <file> --project <id> --confirmed-by <owner> | workflow-bundle-inspect --bundle <file> | experience-record|experience-propose --db <db> --input <json> | experience-evaluate --db <db> --proposal <id> --results <json> | experience-apply --db <db> --proposal <id> --confirmed-by <owner>");
