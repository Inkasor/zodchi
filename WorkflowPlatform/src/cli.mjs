import fs from "node:fs";
import path from "node:path";
import { buildPrompt } from "./prompt-builder.mjs";
import { lintFile } from "./lint.mjs";
import { processMessage } from "./workflow-app.mjs";
import { onboardProject, registerProject, registerProjectRoot } from "./onboarding.mjs";
import { exportWorkflowPackage, proposeWorkflowImport, applyWorkflowImport } from "./workflow-package.mjs";
import { inspectWorkflowBundle } from "./workflow-bundle.mjs";
import { recordExperienceObservation, createExperienceProposal, evaluateExperienceProposal, applyExperienceProposal } from "./experience.mjs";
import { resolveWorkflowSettings } from "./paths.mjs";
import { configureInstallation } from "./installation.mjs";
import { Runtime } from "./runtime.mjs";
import { ExecutionQueue } from "./execution-queue.mjs";
import { workflowRunStatistics } from "./statistics.mjs";
import { backupInstallation, restoreInstallation } from "./backup.mjs";
import { operationalPoliciesLint, qualityContractsLint } from "./quality-contracts.mjs";
import { configureOneCBslCheck, createOneCBslBaseline } from "./one-c-bsl-check.mjs";
import { readProjectContext } from "./document-context.mjs";
import { expandTerms, searchSources, sourceScope } from "./source-context.mjs";
import { buildCodeIntelligence, mergeGraphMatches } from "./code-intelligence.mjs";
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
else if (process.argv[2] === "run") { console.log(JSON.stringify(await processMessage({ message: args.message ?? "", project: args.project ?? settings.project, dbFile: args.db ?? settings.databasePath, workflow: args.workflow ?? settings.workflow, eventSource: args["event-source"] ?? "cli", eventKey: args["event-key"] ?? null, preferredLanguage: args.language ?? settings.responseLanguage, execute: args.execute === true }), null, 2)); }
else if (process.argv[2] === "workflow-export") { console.log(JSON.stringify(exportWorkflowPackage(args.db, args.out, args.project, args.workflow), null, 2)); }
else if (process.argv[2] === "workflow-import-propose") { console.log(JSON.stringify(proposeWorkflowImport(args.db, args.package, args.proposal, args.project), null, 2)); }
else if (process.argv[2] === "workflow-import-apply") { console.log(JSON.stringify(applyWorkflowImport(args.db, args.proposal, args.project, { confirmedBy: args["confirmed-by"] }), null, 2)); }
else if (process.argv[2] === "workflow-bundle-inspect") { const result = inspectWorkflowBundle(args.bundle); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "passed" ? 0 : 1; }
else if (process.argv[2] === "experience-record") { console.log(JSON.stringify(recordExperienceObservation(args.db, JSON.parse(fs.readFileSync(args.input, "utf8"))), null, 2)); }
else if (process.argv[2] === "experience-propose") { console.log(JSON.stringify(createExperienceProposal(args.db, JSON.parse(fs.readFileSync(args.input, "utf8"))), null, 2)); }
else if (process.argv[2] === "experience-evaluate") { const results = JSON.parse(fs.readFileSync(args.results, "utf8")); console.log(JSON.stringify(await evaluateExperienceProposal(args.db, args.proposal, request => results[request.scenario_key]?.[request.variant]), null, 2)); }
else if (process.argv[2] === "experience-apply") { console.log(JSON.stringify(applyExperienceProposal(args.db, args.proposal, { confirmedBy: args["confirmed-by"] }), null, 2)); }
else if (process.argv[2] === "run-statistics") { console.log(JSON.stringify(workflowRunStatistics(args.db ?? settings.databasePath, args.run), null, 2)); }
else if (process.argv[2] === "code-search") {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  try {
    const discovery = readProjectContext(args.project, runtime.db), scope = sourceScope(discovery.source_scope), query = args.query ?? "";
    const expanded = expandTerms(discovery.roots, scope, query), lexical = searchSources(discovery.roots, scope, expanded.terms);
    const intelligence = buildCodeIntelligence(discovery.roots, scope, expanded.terms, lexical, { primaryTerms: expanded.code, contextTerms: expanded.subject });
    console.log(JSON.stringify({ query, derived_from: { request_words: expanded.subject, identifiers: expanded.harvested, explicit_identifiers: expanded.code }, result: mergeGraphMatches(lexical, intelligence) }, null, 2));
  } finally { runtime.db.close(); }
}
else if (process.argv[2] === "backup") { console.log(JSON.stringify(await backupInstallation({ workflowDatabase: args.db ?? settings.databasePath, gatewayDatabase: args["gateway-db"] ?? settings.gatewayDatabasePath, outputDirectory: args.out }), null, 2)); }
else if (process.argv[2] === "restore") { console.log(JSON.stringify(restoreInstallation({ backupDirectory: args.backup, workflowDatabase: args.db ?? settings.databasePath, gatewayDatabase: args["gateway-db"] ?? settings.gatewayDatabasePath }), null, 2)); }
else if (["queue-recover", "run-pause", "run-resume", "run-cancel", "dead-letter-retry"].includes(process.argv[2])) {
  const runtime = new Runtime(args.db ?? settings.databasePath);
  const queue = new ExecutionQueue(runtime.db);
  try {
    if (process.argv[2] === "queue-recover") console.log(JSON.stringify(queue.recoverExpiredLeases(args.at ?? undefined), null, 2));
    else if (process.argv[2] === "run-pause") console.log(JSON.stringify({ state: queue.pauseRun(args.run, { reason: args.reason ?? "paused by CLI" }) }));
    else if (process.argv[2] === "run-resume") console.log(JSON.stringify({ state: queue.resumeRun(args.run) }));
    else if (process.argv[2] === "run-cancel") console.log(JSON.stringify({ state: queue.cancelRun(args.run, { reason: args.reason ?? "cancelled by CLI" }) }));
    else console.log(JSON.stringify(queue.retryDeadLetter(args["dead-letter"], { approved: args.approved === true, actor: args.actor ?? "CLI operator" }), null, 2));
  } finally { runtime.db.close(); }
}
else console.log("Usage: node src/cli.mjs configure --config <file> | register-project --id <id> --name <name> --root <absolute-path> | onboard | lint | quality-contracts-lint | quality-policy-lint [--project <id>] | one-c-bsl-baseline --db <db> --project <id> --executable <file> --source <directory> --platform-bin <directory> --accepted-revision <sha> --confirmed-by <owner> --temp-root <directory> | one-c-bsl-configure --db <db> --project <id> --executable <file> --platform-bin <directory> --runner <file> --temp-root <directory> | prompt | run [--event-key <id>] | code-search --db <db> --project <id> --query <text> | run-statistics --db <db> --run <id> | backup --db <workflow-db> --gateway-db <gateway-db> --out <directory> | restore --backup <directory> --db <new-workflow-db> --gateway-db <new-gateway-db> | queue-recover | run-pause --run <id> | run-resume --run <id> | run-cancel --run <id> | dead-letter-retry --dead-letter <id> [--approved] | workflow-export --db <db> --out <file> --project <id> | workflow-import-propose --db <db> --package <file> --proposal <file> --project <id> | workflow-import-apply --db <db> --proposal <file> --project <id> --confirmed-by <owner> | workflow-bundle-inspect --bundle <file> | experience-record|experience-propose --db <db> --input <json> | experience-evaluate --db <db> --proposal <id> --results <json> | experience-apply --db <db> --proposal <id> --confirmed-by <owner>");
