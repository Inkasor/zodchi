import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function assertSource(file, label) { if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`BACKUP_${label}_DATABASE_MISSING: ${file}`); }
function assertIntegrity(file, label) { const db = new DatabaseSync(file, { readOnly: true }); try { const result = db.prepare("PRAGMA integrity_check").get()?.integrity_check; if (result !== "ok") throw new Error(`RESTORE_${label}_INTEGRITY_FAILED: ${result}`); } finally { db.close(); } }
function targetVariants(file) { return [file, `${file}-wal`, `${file}-shm`]; }

export async function backupInstallation({ workflowDatabase, gatewayDatabase, outputDirectory }) {
  assertSource(workflowDatabase, "WORKFLOW"); assertSource(gatewayDatabase, "GATEWAY");
  const output = path.resolve(outputDirectory); if (fs.existsSync(output)) throw new Error(`BACKUP_OUTPUT_EXISTS: ${output}`);
  const parent = path.dirname(output), temporary = path.join(parent, `.${path.basename(output)}.${crypto.randomUUID()}.tmp`); fs.mkdirSync(parent, { recursive: true }); fs.mkdirSync(temporary);
  const workflowFile = path.join(temporary, "workflow.sqlite"), gatewayFile = path.join(temporary, "gateway.sqlite");
  try {
    const workflow = new DatabaseSync(path.resolve(workflowDatabase), { readOnly: true }), gateway = new DatabaseSync(path.resolve(gatewayDatabase), { readOnly: true });
    try { await backup(workflow, workflowFile); await backup(gateway, gatewayFile); } finally { workflow.close(); gateway.close(); }
    assertIntegrity(workflowFile, "WORKFLOW"); assertIntegrity(gatewayFile, "GATEWAY");
    const manifest = { schema_version: 1, created_at: new Date().toISOString(), contains_secrets: false, files: [{ name: "gateway.sqlite", sha256: hash(gatewayFile), size: fs.statSync(gatewayFile).size }, { name: "workflow.sqlite", sha256: hash(workflowFile), size: fs.statSync(workflowFile).size }] };
    fs.writeFileSync(path.join(temporary, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"); fs.renameSync(temporary, output);
    return { status: "backed_up", output, manifest: path.join(output, "backup-manifest.json"), files: manifest.files };
  } catch (error) { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); throw error; }
}
export function restoreInstallation({ backupDirectory, workflowDatabase, gatewayDatabase }) {
  const source = path.resolve(backupDirectory), manifestFile = path.join(source, "backup-manifest.json"); if (!fs.existsSync(manifestFile)) throw new Error(`RESTORE_MANIFEST_MISSING: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); if (manifest.schema_version !== 1 || manifest.contains_secrets !== false || !Array.isArray(manifest.files)) throw new Error("RESTORE_MANIFEST_INVALID");
  const expected = new Map(manifest.files.map(item => [item.name, item])); if (expected.size !== 2 || !expected.has("workflow.sqlite") || !expected.has("gateway.sqlite")) throw new Error("RESTORE_MANIFEST_FILES_INVALID");
  for (const name of ["workflow.sqlite", "gateway.sqlite"]) { const file = path.join(source, name), item = expected.get(name); assertSource(file, name.toUpperCase()); if (fs.statSync(file).size !== item.size || hash(file) !== item.sha256) throw new Error(`RESTORE_CHECKSUM_MISMATCH: ${name}`); assertIntegrity(file, name.toUpperCase().replace(".SQLITE", "")); }
  const targets = { workflow: path.resolve(workflowDatabase), gateway: path.resolve(gatewayDatabase) }; for (const target of Object.values(targets)) if (targetVariants(target).some(file => fs.existsSync(file))) throw new Error(`RESTORE_TARGET_EXISTS: ${target}`);
  const temporary = { workflow: `${targets.workflow}.${crypto.randomUUID()}.restore`, gateway: `${targets.gateway}.${crypto.randomUUID()}.restore` }; let workflowInstalled = false;
  try {
    fs.mkdirSync(path.dirname(targets.workflow), { recursive: true }); fs.mkdirSync(path.dirname(targets.gateway), { recursive: true }); fs.copyFileSync(path.join(source, "workflow.sqlite"), temporary.workflow, fs.constants.COPYFILE_EXCL); fs.copyFileSync(path.join(source, "gateway.sqlite"), temporary.gateway, fs.constants.COPYFILE_EXCL);
    assertIntegrity(temporary.workflow, "WORKFLOW"); assertIntegrity(temporary.gateway, "GATEWAY"); fs.renameSync(temporary.workflow, targets.workflow); workflowInstalled = true; fs.renameSync(temporary.gateway, targets.gateway);
    return { status: "restored", workflowDatabase: targets.workflow, gatewayDatabase: targets.gateway };
  } catch (error) {
    for (const file of Object.values(temporary)) fs.rmSync(file, { force: true }); if (workflowInstalled) fs.rmSync(targets.workflow, { force: true }); throw error;
  }
}
