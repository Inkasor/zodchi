#!/usr/bin/env node
// zodchi installer. install.ps1 and install.sh call this; it needs Node 20+.
//
//   node install/install.mjs [--domains web-apps,gamedev-unity|all] [--project <repo>] [--gateway-cli <cli.mjs>]
//                            [--force] [--dry-run] [--uninstall]
//
// What goes where:
//   core + chosen domains: agents -> <claude>/agents, workflows -> <claude>/workflows
//     <claude> is ~/.claude (or $CLAUDE_CONFIG_DIR), or <repo>/.claude with --project
//   models.json, roles/, the zodchi command -> ~/.zodchi (or $ZODCHI_HOME)
// A file the installer did not put there, or that you changed since, is left alone (use --force to replace it).
// ~/.zodchi/models.json is yours once installed: a newer table is written beside it as models.json.new.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8")).version;

function parseArgs(argv) {
  const o = { force: false, dryRun: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") o.force = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--uninstall") o.uninstall = true;
    else if (["--domains", "--project", "--gateway-cli"].includes(a) && argv[i + 1]) o[a.slice(2)] = argv[++i];
    else if (a === "--help" || a === "-h") { o.help = true; }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const listDir = (dir, ext) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(ext)).map(f => path.join(dir, f)) : [];
const domainsAvailable = () => fs.readdirSync(path.join(SRC, "domains"), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

async function chooseDomains(given) {
  const all = domainsAvailable();
  if (given) {
    const picked = given === "all" ? all : given.split(",").map(s => s.trim()).filter(Boolean);
    const unknown = picked.filter(d => !all.includes(d));
    if (unknown.length) throw new Error(`Unknown domain(s): ${unknown.join(", ")}. Available: ${all.join(", ")}`);
    return picked;
  }
  if (!process.stdin.isTTY) throw new Error(`Pass --domains (available: ${all.join(", ")}, or all).`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("Domains (core is always installed):");
  all.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
  const answer = await rl.question("Numbers separated by commas, 'all', or empty for core only: ");
  rl.close();
  if (answer.trim() === "all") return all;
  return answer.split(",").map(s => s.trim()).filter(Boolean).map(s => {
    const d = all[Number(s) - 1];
    if (!d) throw new Error(`No domain number ${s}`);
    return d;
  });
}

function plan(domains, claudeDir, home) {
  const items = []; // { src | content, dest, kind }
  const seen = new Map();
  const add = (src, dest, kind, origin) => {
    const key = path.resolve(dest).toLowerCase();
    if (seen.has(key)) throw new Error(`${path.basename(dest)} comes from both ${seen.get(key)} and ${origin}; a domain may not reuse a name.`);
    seen.set(key, origin);
    items.push({ src, dest, kind });
  };
  for (const origin of ["core", ...domains.map(d => `domains/${d}`)]) {
    const base = path.join(SRC, origin);
    for (const f of listDir(path.join(base, "agents"), ".md")) add(f, path.join(claudeDir, "agents", path.basename(f)), "managed", origin);
    for (const f of listDir(path.join(base, "workflows"), ".js")) add(f, path.join(claudeDir, "workflows", path.basename(f)), "managed", origin);
  }
  for (const f of fs.readdirSync(path.join(SRC, "roles"))) add(path.join(SRC, "roles", f), path.join(home, "roles", f), "managed", "roles");
  add(path.join(SRC, "models.json"), path.join(home, "models.json"), "user-owned", "models.json");
  add(path.join(SRC, "install", "zodchi.mjs"), path.join(home, "bin", "zodchi.mjs"), "managed", "install");
  const mjs = path.join(home, "bin", "zodchi.mjs");
  items.push({ content: `@echo off\r\nnode "${mjs}" %*\r\n`, dest: path.join(home, "bin", "zodchi.cmd"), kind: "managed" });
  items.push({ content: `#!/bin/sh\nexec node "${mjs.replace(/\\/g, "/")}" "$@"\n`, dest: path.join(home, "bin", "zodchi"), kind: "managed", mode: 0o755 });
  return items;
}

function readManifest(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, "installed.json"), "utf8")); } catch { return { files: {} }; }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).map(l => l.replace(/^\/\/ ?/, "")).join("\n")); return; }
  const home = path.resolve(process.env.ZODCHI_HOME || path.join(os.homedir(), ".zodchi"));
  const claudeDir = o.project ? path.join(path.resolve(o.project), ".claude") : path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  const manifest = readManifest(home);
  const say = (s) => console.log((o.dryRun ? "[dry-run] " : "") + s);

  if (o.uninstall) {
    for (const [dest, hash] of Object.entries(manifest.files || {})) {
      if (!fs.existsSync(dest)) continue;
      if (sha(fs.readFileSync(dest)) !== hash && !o.force) { say(`keep (changed by you): ${dest}`); continue; }
      say(`remove ${dest}`);
      if (!o.dryRun) fs.rmSync(dest);
    }
    if (!o.dryRun) fs.rmSync(path.join(home, "installed.json"), { force: true });
    return;
  }

  const domains = await chooseDomains(o.domains);
  // Everything that can fail on a wrong argument is checked before the first write.
  let gatewayCli = null;
  if (o["gateway-cli"]) {
    gatewayCli = path.resolve(o["gateway-cli"]);
    if (!fs.existsSync(gatewayCli)) throw new Error(`No gateway CLI at ${gatewayCli}; nothing was installed.`);
  }
  const items = plan(domains, claudeDir, home);
  const owned = manifest.files || {};
  const isOwned = (dest, buf) => Object.prototype.hasOwnProperty.call(owned, dest) && owned[dest] === sha(buf);
  const next = { version: VERSION, domains, claudeDir, files: { ...owned } };
  let written = 0, skipped = 0;
  const put = (dest, body, mode) => {
    if (!o.dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      if (mode) fs.chmodSync(dest, mode);
    }
    next.files[dest] = sha(body); written++;
  };
  for (const it of items) {
    const body = it.content != null ? Buffer.from(it.content) : fs.readFileSync(it.src);
    const exists = fs.existsSync(it.dest);
    const current = exists ? fs.readFileSync(it.dest) : null;
    // Identical content is never adopted: only a file the installer itself wrote is ever removed later.
    if (current && sha(current) === sha(body)) continue;
    if (exists && it.kind === "user-owned" && !o.force) {
      // Your table stays as it is on every upgrade; the new one is offered beside it.
      const prop = it.dest + ".new";
      const propNow = fs.existsSync(prop) ? fs.readFileSync(prop) : null;
      if (propNow && sha(propNow) === sha(body)) continue;
      if (propNow && !isOwned(prop, propNow)) { say(`keep your ${it.dest} and your ${prop}; move ${prop} away to receive the new table`); skipped++; continue; }
      say(`keep your ${it.dest}; the new table is ${prop}`);
      put(prop, body);
      continue;
    }
    if (exists && !isOwned(it.dest, current) && !o.force) { say(`skip (not installed by zodchi or changed by you): ${it.dest}`); skipped++; continue; }
    say(`${exists ? "update" : "add"} ${it.dest}`);
    put(it.dest, body, it.mode);
  }

  // Files from an earlier install that this one no longer plans (a domain was dropped): remove them when unchanged.
  const planned = new Set(items.map(it => path.resolve(it.dest)));
  const inside = (f) => [claudeDir, home].some(d => path.resolve(f).toLowerCase().startsWith(path.resolve(d).toLowerCase() + path.sep));
  for (const [dest, hash] of Object.entries(manifest.files || {})) {
    if (planned.has(path.resolve(dest)) || dest.endsWith(".new") || !inside(dest)) continue;
    if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) !== hash) { say(`keep (changed by you, no longer installed): ${dest}`); delete next.files[dest]; continue; }
    if (fs.existsSync(dest)) { say(`remove ${dest}`); if (!o.dryRun) fs.rmSync(dest); }
    delete next.files[dest];
  }

  const cfgFile = path.join(home, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch { /* new */ }
  if (gatewayCli) {
    cfg.gatewayCli = gatewayCli;
    say(`gateway: ${gatewayCli}`);
  }
  if (!o.dryRun) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
    fs.writeFileSync(path.join(home, "installed.json"), JSON.stringify(next, null, 2) + "\n");
  }

  const codex = spawnSync("codex --version", { encoding: "utf8", shell: true, windowsHide: true });
  console.log(`\nzodchi ${VERSION}: ${written} file(s) written, ${skipped} skipped. Domains: core${domains.length ? ", " + domains.join(", ") : ""}.`);
  console.log(`Agents and workflows: ${claudeDir}`);
  console.log(`Codex CLI: ${codex.status === 0 ? codex.stdout.trim() : "not found - install it and run `codex login` for gateway roles"}`);
  if (!cfg.gatewayCli) console.log("Gateway: not configured yet - rerun with --gateway-cli <path to cli.mjs> (until the Rust gateway ships).");
  const bin = path.join(home, "bin");
  if (!(process.env.PATH || "").split(path.delimiter).some(p => path.resolve(p) === bin)) console.log(`Add ${bin} to PATH so agents can run \`zodchi\`.`);
}

main().catch(e => { console.error(`zodchi install: ${e.message}`); process.exit(1); });
