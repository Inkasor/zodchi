import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const databaseFile = option("--workflow-db"), policyFile = option("--policy");
if (!databaseFile || !policyFile) { process.stderr.write("Usage: node tools/profile-policy-audit.mjs --workflow-db <workflow.sqlite> --policy <policy.local.json> [--output report.json]\n"); process.exit(2); }
const policyBytes = fs.readFileSync(policyFile), policy = JSON.parse(policyBytes);
const db = new DatabaseSync(databaseFile, { readOnly: true });
const catalog = db.prepare("SELECT id,provider,name FROM profiles").all(), assignments = db.prepare("SELECT DISTINCT profile_id FROM role_profile_assignments WHERE enabled=1").all();
db.close();
const assignedIds = new Set(assignments.map(item => item.profile_id)), byIdentity = new Map(catalog.map(item => [`${item.provider}:${item.name}`, item]));
const entries = [];
for (const [provider, providerConfig] of Object.entries(policy.providers ?? {})) for (const name of Object.keys(providerConfig.profiles ?? {}).sort()) {
  const identity = `${provider}:${name}`, profile = byIdentity.get(identity);
  entries.push({ provider, name, status: profile ? assignedIds.has(profile.id) ? "assigned" : "reserved_catalog" : "orphaned", profile_id: profile?.id ?? null });
}
const counts = Object.fromEntries(["assigned", "reserved_catalog", "orphaned"].map(status => [status, entries.filter(item => item.status === status).length]));
const report = { schema_version: 1, generated_at: new Date().toISOString(), workflow_db: databaseFile, policy_file: policyFile, policy_sha256: crypto.createHash("sha256").update(policyBytes).digest("hex"), counts, entries };
const output = option("--output"); if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
