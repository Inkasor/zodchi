import crypto from "node:crypto";
import fs from "node:fs";

const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const policyFile = option("--policy"), reportFile = option("--report");
if (!policyFile || !reportFile || !args.includes("--apply")) { process.stderr.write("Refusing mutation. Use: node tools/profile-policy-prune.mjs --policy <policy.local.json> --report <audit.json> --apply\n"); process.exit(2); }
const bytes = fs.readFileSync(policyFile), report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
if (digest !== report.policy_sha256) { process.stderr.write("PROFILE_POLICY_CHANGED_SINCE_AUDIT\n"); process.exit(3); }
const policy = JSON.parse(bytes), targets = report.entries.filter(item => item.status === "orphaned");
for (const target of targets) {
  if (!Object.hasOwn(policy.providers?.[target.provider]?.profiles ?? {}, target.name)) { process.stderr.write(`PROFILE_POLICY_TARGET_MISSING: ${target.provider}:${target.name}\n`); process.exit(3); }
  delete policy.providers[target.provider].profiles[target.name];
}
const backup = `${policyFile}.before-prune-${new Date().toISOString().replaceAll(":", "-")}.json`;
fs.copyFileSync(policyFile, backup); fs.writeFileSync(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: "pruned", removed: targets.map(item => `${item.provider}:${item.name}`), backup })}\n`);
