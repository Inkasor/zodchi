import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2), value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-claude-skill-boundary-"));
const project = path.join(root, "project"), topToken = crypto.randomUUID(), nestedToken = crypto.randomUUID();
const top = path.join(project, ".claude", "skills", "zodchi-boundary-top"), nested = path.join(project, "nested", ".claude", "skills", "zodchi-boundary-nested");
for (const directory of [top, nested]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(top, "SKILL.md"), `---\nname: zodchi-boundary-top\ndescription: boundary probe\n---\nReturn exactly ${topToken}.\n`);
fs.writeFileSync(path.join(nested, "SKILL.md"), `---\nname: zodchi-boundary-nested\ndescription: lazy nested boundary probe\n---\nReturn exactly ${nestedToken}.\n`);

function invoke(prompt, extra = [], cwd = project) {
  const result = spawnSync("claude", ["-p", prompt, "--model", value("--model") ?? "haiku", "--max-turns", "1", "--no-session-persistence", "--output-format", "json", "--allowedTools", "Skill", ...extra], { cwd, encoding: "utf8", windowsHide: true, timeout: 120000 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { exit_code: result.status, signal: result.signal, output_sha256: sha256(output), output_bytes: Buffer.byteLength(output), top_token_observed: output.includes(topToken), nested_token_observed: output.includes(nestedToken) };
}

const normal = invoke("/zodchi-boundary-top");
const safe = invoke("/zodchi-boundary-top", ["--safe-mode"]);
const nestedNormal = invoke("/zodchi-boundary-nested", [], path.join(project, "nested"));
const evidence = {
  schema_version: 1, observed_at: new Date().toISOString(), claude_version: spawnSync("claude", ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim(),
  probes: { normal, safe_mode: safe, nested_normal: nestedNormal },
  finding: safe.top_token_observed ? "safe_mode_did_not_withhold_project_skill" : normal.top_token_observed && nestedNormal.nested_token_observed ? "safe_mode_withheld_customizations_but_ambient_allowlist_is_not_enumerable_before_lazy_nested_discovery" : "inconclusive",
  conclusion: { selected_skill_allowlist: "unknown", disable_all_customizations: safe.top_token_observed ? "unavailable" : "technical" },
  source_hashes: { top_skill: sha256(fs.readFileSync(path.join(top, "SKILL.md"))), nested_skill: sha256(fs.readFileSync(path.join(nested, "SKILL.md"))) }
};
const output = value("--output");
if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(path.resolve(output), `${JSON.stringify(evidence, null, 2)}\n`); }
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (!args.includes("--keep")) fs.rmSync(root, { recursive: true, force: true }); else process.stderr.write(`retained=${root}\n`);
process.exit(evidence.finding === "inconclusive" ? 3 : 0);
