#!/usr/bin/env node
// Repository checks, run before every commit and push: `npm run check`.
//   1. JavaScript is limited to tests and the Playwright browser adapter;
//   2. every agent has frontmatter with name and description, and names are unique per install;
//   3. every JSON file parses, every role's frame and schema exist;
//   4. publish guard: no machine paths, e-mail addresses, keys or tokens, and none of the words in the
//      private deny-list (one per line) at $ZODCHI_DENYLIST or ~/.zodchi/private-words.txt, which never enters the repo.
//      A private fork may list its own words in .zodchi/allowed-words.txt (docs/fork.md); the list counts only in a
//      checkout with a remote named `upstream`, and anywhere else the file itself is a problem.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const bad = (file, msg) => problems.push(`${path.relative(ROOT, file).replace(/\\/g, "/")}: ${msg}`);
// -z: NUL-separated and unquoted, so names with spaces or non-ASCII letters come through as they are.
const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", windowsHide: true })
  .split("\0").filter(Boolean).map(f => path.join(ROOT, f));
for (const f of tracked.filter(f => !fs.existsSync(f))) problems.push(`${path.relative(ROOT, f)}: listed by git but not on disk (commit or restore the deletion)`);
tracked.splice(0, tracked.length, ...tracked.filter(f => fs.existsSync(f)));

// 1. Keep the CLI and plugins free of JavaScript outside the Playwright adapter.
const browserDriver = "rust/crates/zodchi-flow-acceptance/src/acceptance/browser_driver.mjs";
for (const file of tracked.filter(file => /\.[cm]?js$/i.test(file))) {
  const relative = path.relative(ROOT, file).replace(/\\/g, "/");
  const test = relative.startsWith("scripts/e2e/") || [
    "scripts/check.mjs", "scripts/e2e.mjs", "scripts/e2e-release.mjs",
    "scripts/ci-select.mjs", "scripts/ci-select.test.mjs",
  ].includes(relative);
  if (relative !== browserDriver && !test) {
    bad(file, "JavaScript is limited to tests and the Playwright adapter");
  }
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

// 5. Every marketplace entry is a plugin folder with a matching manifest.
const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
for (const p of market.plugins || []) {
  const dir = path.join(ROOT, p.source);
  const manifestFile = path.join(dir, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifestFile)) { bad(path.join(ROOT, ".claude-plugin", "marketplace.json"), `plugin ${p.name}: no ${p.source}/.claude-plugin/plugin.json`); continue; }
  const own = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (own.name !== p.name) bad(manifestFile, `name "${own.name}" differs from the marketplace entry "${p.name}"`);
}

// 6. Skills have matching frontmatter. The two legacy installers still ship the same foreground instructions.
const legacyFlowSkills = ["plugins/codex/skills/zodchi-flow/SKILL.md", "plugins/claude-code/core/skills/zodchi-flow/SKILL.md"]
  .map(rel => path.join(ROOT, rel));
const skillBodies = new Map();
for (const f of tracked.filter(f => /[\\/]skills[\\/][^\\/]+[\\/]SKILL\.md$/.test(f))) {
  const m = fs.readFileSync(f, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) { bad(f, "no frontmatter"); continue; }
  const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
  if (!name || !/^description:\s*\S/m.test(m[1])) bad(f, "frontmatter needs name and description");
  if (name && name !== path.basename(path.dirname(f))) bad(f, `name "${name}" differs from the folder name`);
  if (legacyFlowSkills.includes(f)) skillBodies.set(f, m[2].replace(/\r\n/g, "\n"));
}
for (const file of legacyFlowSkills) {
  if (!skillBodies.has(file)) bad(file, "the legacy zodchi-flow skill is missing");
}
if (new Set(skillBodies.values()).size > 1) bad(legacyFlowSkills[1], "the legacy Codex and Claude Code skills share one body");

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
const words = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#")) : [];
const allowFile = path.join(ROOT, ".zodchi", "allowed-words.txt");
let allowed = [];
if (fs.existsSync(allowFile)) {
  let remotes = [];
  try { remotes = execFileSync("git", ["remote"], { cwd: ROOT, encoding: "utf8", windowsHide: true }).split(/\r?\n/).map(s => s.trim()); } catch { /* no git: not a fork */ }
  // Only a fork (a checkout that pulls from `upstream`) may name its own words; in the public repository or its CI
  // clone the file would silently switch the deny-list off, so there it is a problem of its own.
  if (remotes.includes("upstream")) allowed = words(allowFile).map(w => w.toLowerCase());
  else bad(allowFile, "an allow-list of private words outside a fork (no remote named upstream)");
}
const deny = words(denyFile).filter(w => !allowed.includes(w.toLowerCase()));
for (const f of tracked) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  if (ALLOW[1].test(rel) || rel === "LICENSE" || rel === ".zodchi/allowed-words.txt") continue;
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
if (allowed.length) console.log(`note: ${allowed.length} word(s) allowed by .zodchi/allowed-words.txt in this fork`);

if (problems.length) { console.error(problems.join("\n")); console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log(`ok: ${tracked.length} files checked`);
