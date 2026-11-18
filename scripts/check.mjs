#!/usr/bin/env node
// Repository checks, run before every commit and push: `npm run check`.
//   1. every workflow parses as a Workflow script body and its meta has name and description;
//   2. every agent has frontmatter with name and description, and names are unique per install;
//   3. every JSON file parses, every role's frame and schema exist;
//   4. publish guard: no machine paths, e-mail addresses, keys or tokens, and none of the words in the
//      private deny-list (one per line) at $ZODCHI_DENYLIST or ~/.zodchi/private-words.txt, which never enters the repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const bad = (file, msg) => problems.push(`${path.relative(ROOT, file).replace(/\\/g, "/")}: ${msg}`);
// -z: NUL-separated and unquoted, so names with spaces or non-ASCII letters come through as they are.
const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter(Boolean).map(f => path.join(ROOT, f));
for (const f of tracked.filter(f => !fs.existsSync(f))) problems.push(`${path.relative(ROOT, f)}: listed by git but not on disk (commit or restore the deletion)`);
tracked.splice(0, tracked.length, ...tracked.filter(f => fs.existsSync(f)));

// 1. workflows
for (const f of tracked.filter(f => /[\\/]workflows[\\/][^\\/]+\.js$/.test(f))) {
  const src = fs.readFileSync(f, "utf8");
  const m = src.match(/^export const meta = (\{[\s\S]*?\n\})\n/);
  if (!m) { bad(f, "does not start with `export const meta = {...}`"); continue; }
  try {
    const meta = vm.runInNewContext(`(${m[1]})`);
    if (!meta.name || !meta.description) bad(f, "meta needs name and description");
    if (meta.name !== path.basename(f, ".js")) bad(f, `meta.name "${meta.name}" differs from the file name`);
  } catch (e) { bad(f, `meta is not a pure literal: ${e.message}`); }
  try { new vm.Script(`(async () => {\n${src.replace(/^export const meta/, "const meta")}\n})`, { filename: f }); }
  catch (e) { bad(f, `syntax: ${e.message}`); }
}

// 2. agents
const agentNames = new Map();
for (const f of tracked.filter(f => /[\\/]agents[\\/][^\\/]+\.md$/.test(f))) {
  const fm = fs.readFileSync(f, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) { bad(f, "no frontmatter"); continue; }
  const name = (fm[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
  if (!name || !/^description:\s*\S/m.test(fm[1])) bad(f, "frontmatter needs name and description");
  if (name && name !== path.basename(f, ".md")) bad(f, `name "${name}" differs from the file name`);
  if (agentNames.has(name)) bad(f, `agent name also used by ${path.relative(ROOT, agentNames.get(name))}`);
  agentNames.set(name, f);
}

// 3. JSON and roles
for (const f of tracked.filter(f => f.endsWith(".json"))) {
  try { JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { bad(f, `JSON: ${e.message}`); }
}
const rolesDir = path.join(ROOT, "roles");
for (const f of fs.readdirSync(rolesDir).filter(n => n.endsWith(".json") && !/\.(schema|questions)\.json$/.test(n))) {
  const role = JSON.parse(fs.readFileSync(path.join(rolesDir, f), "utf8"));
  for (const k of ["frame", "schema", "questions"]) if (role[k] && !fs.existsSync(path.join(rolesDir, role[k]))) bad(path.join(rolesDir, f), `${k} ${role[k]} is missing`);
}
const models = JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8"));
for (const [name, r] of Object.entries(models.roles || {})) {
  if (!Array.isArray(r.candidates) || !r.candidates.length) bad(path.join(ROOT, "models.json"), `role ${name} has no candidates`);
  for (const c of r.candidates || []) if (!["claude", "codex"].includes(c.provider) || !c.model) bad(path.join(ROOT, "models.json"), `role ${name}: bad candidate ${JSON.stringify(c)}`);
}

// 5. plugins: every marketplace entry is a plugin folder with a matching plugin.json, and every agentType a workflow
//    names is "<plugin>:<agent>" of an agent that exists (plugin agents answer only to the namespaced name).
const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
const pluginAgents = new Set();
for (const p of market.plugins || []) {
  const dir = path.join(ROOT, p.source);
  const manifestFile = path.join(dir, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifestFile)) { bad(path.join(ROOT, ".claude-plugin", "marketplace.json"), `plugin ${p.name}: no ${p.source}/.claude-plugin/plugin.json`); continue; }
  const own = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (own.name !== p.name) bad(manifestFile, `name "${own.name}" differs from the marketplace entry "${p.name}"`);
  const agentsDir = path.join(dir, "agents");
  if (fs.existsSync(agentsDir)) for (const f of fs.readdirSync(agentsDir).filter(n => n.endsWith(".md"))) pluginAgents.add(`${p.name}:${f.slice(0, -3)}`);
}
for (const f of tracked.filter(f => /[\\/]workflows[\\/][^\\/]+\.js$/.test(f))) {
  // Every mention of agentType, quoted or not, must be a key with a string literal value: anything computed cannot
  // be checked here and is refused.
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(/(["'`]?)agentType\1\s*:\s*(?:(["'])([^"'\n]*)\2(?=\s*[,}])|(.{0,40}))/g)) {
    if (m[3] === undefined) { bad(f, `agentType must be a plain string literal, found: ${(m[4] || "").trim()}`); continue; }
    if (!pluginAgents.has(m[3])) bad(f, `agentType '${m[3]}' is not "<plugin>:<agent>" of an agent in this marketplace`);
  }
  const mentions = (text.match(/agentType/g) || []).length;
  const keyed = [...text.matchAll(/(["'`]?)agentType\1\s*:/g)].length;
  if (mentions !== keyed) bad(f, "agentType appears other than as an object key with a literal value; keep it checkable");
}

// 6. skills: every SKILL.md has frontmatter whose name is its folder's and a description; the two zodchi-flow skills (Codex
//    and Claude Code) carry one shared body, so they cannot drift apart.
const skillBodies = new Map();
for (const f of tracked.filter(f => /[\\/]skills[\\/][^\\/]+[\\/]SKILL\.md$/.test(f))) {
  const m = fs.readFileSync(f, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) { bad(f, "no frontmatter"); continue; }
  const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
  if (!name || !/^description:\s*\S/m.test(m[1])) bad(f, "frontmatter needs name and description");
  if (name && name !== path.basename(path.dirname(f))) bad(f, `name "${name}" differs from the folder name`);
  if (name === "zodchi-flow") skillBodies.set(f, m[2].replace(/\r\n/g, "\n"));
}
for (const rel of ["codex/skills/zodchi-flow/SKILL.md", "core/skills/zodchi-flow/SKILL.md"]) {
  if (!skillBodies.has(path.join(ROOT, rel))) bad(path.join(ROOT, rel), "the zodchi-flow skill is missing");
}
if (new Set(skillBodies.values()).size > 1) bad(path.join(ROOT, "core", "skills", "zodchi-flow", "SKILL.md"), "the body differs from the other zodchi-flow skill's: they share one body");

// 4. publish guard
const PATTERNS = [
  [/\b[A-Za-z]:[\\/](?!\/)[^\s"'`]*/g, "a Windows path"],
  [/(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+/g, "a home directory path"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "an e-mail address"],
  [/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "a key or token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "a private key"],
  [/"(?:access_token|refresh_token|id_token|api_key)"\s*:\s*"[^"]{8,}"/g, "a stored credential"],
];
// Allowed on purpose: the placeholder addresses of git attribution and the guard's own patterns.
const ALLOW = [/noreply@anthropic\.com/, /^scripts\/check\.mjs$/];
const denyFile = process.env.ZODCHI_DENYLIST || path.join(os.homedir(), ".zodchi", "private-words.txt");
const deny = fs.existsSync(denyFile) ? fs.readFileSync(denyFile, "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#")) : [];
for (const f of tracked) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  if (ALLOW[1].test(rel) || rel === "LICENSE") continue;
  const buf = fs.readFileSync(f);
  if (buf.includes(0)) continue;
  const text = buf.toString("utf8");
  for (const [re, what] of PATTERNS) for (const m of text.matchAll(re)) {
    if (ALLOW[0].test(m[0])) continue;
    if (what === "a Windows path" && /^[A-Za-z]:[\\/]$/.test(m[0])) continue;
    bad(f, `${what}: ${m[0].slice(0, 60)}`);
  }
  const lower = text.toLowerCase();
  for (const w of deny) if (lower.includes(w.toLowerCase())) bad(f, "a word from the private deny-list");
}
if (!deny.length) console.log(`note: no private deny-list at ${denyFile}; only generic patterns were checked`);

if (problems.length) { console.error(problems.join("\n")); console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log(`ok: ${tracked.length} files checked`);
