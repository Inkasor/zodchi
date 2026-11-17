#!/usr/bin/env node
// zodchi installer. install.ps1 and install.sh call this; it needs Node 20+ and Claude Code.
//
//   node install/install.mjs [--domains web-apps,gamedev-unity|all] [--project <repo>] [--no-build] [--no-plugins]
//                            [--gateway-cli <cli.mjs>] [--force] [--dry-run] [--uninstall]
//
// What it does:
//   1. Claude Code plugins from this repository (the marketplace "zodchi"): zodchi-core for you in every project
//      (user scope). --domains adds domain plugins: with --project <repo> only in that repository, for you alone
//      (local scope: .claude/settings.local.json, nothing to commit); without --project in every project.
//   2. The gateway: with cargo on PATH the Rust gateway is built from gateway/ and installed as ~/.zodchi/bin/zodchi.
//      --no-build skips that; --gateway-cli instead installs a small command that forwards to a Node gateway.
//   3. models.json and the gateway roles -> ~/.zodchi (or $ZODCHI_HOME).
// A file the installer did not put there, or that you changed since, is left alone (use --force to replace it).
// ~/.zodchi/models.json is yours once installed: a newer table is written beside it as models.json.new.
// Rerun it after `git pull` to update everything; --uninstall removes what it installed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8")).version;
const MARKETPLACE = JSON.parse(fs.readFileSync(path.join(SRC, ".claude-plugin", "marketplace.json"), "utf8")).name;

function parseArgs(argv) {
  const o = { force: false, dryRun: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") o.force = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--uninstall") o.uninstall = true;
    else if (a === "--no-build") o.noBuild = true;
    else if (a === "--no-plugins") o.noPlugins = true;
    else if (["--domains", "--project", "--gateway-cli"].includes(a) && argv[i + 1]) o[a.slice(2)] = argv[++i];
    else if (a === "--help" || a === "-h") { o.help = true; }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const domainsAvailable = () => fs.readdirSync(path.join(SRC, "domains"), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

function chooseDomains(given) {
  if (!given) return [];
  const all = domainsAvailable();
  const picked = given === "all" ? all : given.split(",").map(s => s.trim()).filter(Boolean);
  const unknown = picked.filter(d => !all.includes(d));
  if (unknown.length) throw new Error(`Unknown domain(s): ${unknown.join(", ")}. Available: ${all.join(", ")}`);
  return picked;
}

function plan(home, binary) {
  const items = []; // { src | content, dest, kind }
  const add = (src, dest, kind, mode) => items.push({ src, dest, kind, mode });
  for (const f of fs.readdirSync(path.join(SRC, "roles"))) add(path.join(SRC, "roles", f), path.join(home, "roles", f), "managed");
  add(path.join(SRC, "models.json"), path.join(home, "models.json"), "user-owned");
  if (binary) {
    // The Rust gateway. The forwarding command of an earlier install is no longer planned, so it is removed.
    add(binary, path.join(home, "bin", path.basename(binary)), "managed", 0o755);
    return items;
  }
  add(path.join(SRC, "install", "zodchi.mjs"), path.join(home, "bin", "zodchi.mjs"), "managed");
  const mjs = path.join(home, "bin", "zodchi.mjs");
  items.push({ content: `@echo off\r\nnode "${mjs}" %*\r\n`, dest: path.join(home, "bin", "zodchi.cmd"), kind: "managed" });
  items.push({ content: `#!/bin/sh\nexec node "${mjs.replace(/\\/g, "/")}" "$@"\n`, dest: path.join(home, "bin", "zodchi"), kind: "managed", mode: 0o755 });
  return items;
}

function readManifest(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, "installed.json"), "utf8")); } catch { return { files: {} }; }
}

// One `claude plugin ...` call. Arguments go as an array; on Windows the npm `claude` is a .cmd, so it runs through
// the shell with every argument quoted.
// No shell is involved, so a path is passed exactly as it is (a cmd.exe line would expand %VARS%). The native
// `claude` (claude.exe on Windows) is run directly; an npm-only install is run as `node <its cli.js>`.
function claudeCommand() {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8", windowsHide: true });
  if (!(probe.error && probe.error.code === "ENOENT")) return ["claude", []];
  if (process.platform === "win32") {
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      if (!dir || !fs.existsSync(path.join(dir, "claude.cmd"))) continue;
      const cli = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (fs.existsSync(cli)) return [process.execPath, [cli]];
    }
  }
  return null;
}
let CLAUDE;
function claude(args, { cwd } = {}) {
  if (CLAUDE === undefined) CLAUDE = claudeCommand();
  if (!CLAUDE) return { ok: false, missing: true, out: "Claude Code (`claude`) is not on PATH." };
  const r = spawnSync(CLAUDE[0], [...CLAUDE[1], ...args], { cwd, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

const samePath = (a, b) => {
  const n = (p) => path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

// Registers this checkout as the marketplace, or refreshes it when it is already there.
function plugins(o, domains, say) {
  if (!o.dryRun && !claude(["--version"]).ok) throw new Error("Claude Code (`claude`) does not run here; install it, or rerun with --no-plugins.");
  const steps = [];
  const project = o.project ? path.resolve(o.project) : null;
  if (project && !fs.existsSync(project)) throw new Error(`No repository at ${project}`);
  // A marketplace of this name that comes from anywhere but this checkout is somebody else's: never touched.
  steps.push({ what: `marketplace ${MARKETPLACE} from ${SRC}`, run: () => {
    const listed = claude(["plugin", "marketplace", "list", "--json"]);
    if (!listed.ok) return listed;
    let known = [];
    try { known = JSON.parse(listed.out.slice(listed.out.indexOf("["))); } catch { return { ok: false, out: `marketplace list did not return JSON:\n${listed.out}` }; }
    const mine = known.find(m => m.name === MARKETPLACE);
    if (!mine) return claude(["plugin", "marketplace", "add", SRC]);
    if (mine.source === "directory" && mine.path && samePath(mine.path, SRC)) return claude(["plugin", "marketplace", "update", MARKETPLACE]);
    return { ok: false, out: `A marketplace named "${MARKETPLACE}" is already registered from ${mine.path || mine.repo || mine.url || mine.source}. ` +
      `To use this checkout instead: claude plugin marketplace remove ${MARKETPLACE}, then rerun the installer.` };
  } });
  const install = (plugin, scope, cwd) => () => {
    const r = claude(["plugin", "install", `${plugin}@${MARKETPLACE}`, "--scope", scope], { cwd });
    if (r.ok || !/already/i.test(r.out)) return r;
    // Installed before: bring it to the version in this checkout.
    return claude(["plugin", "update", `${plugin}@${MARKETPLACE}`, "--scope", scope], { cwd });
  };
  steps.push({ what: "zodchi-core for you in every project (user scope)", run: install("zodchi-core", "user") });
  for (const d of domains) {
    steps.push(project
      ? { what: `zodchi-${d} in ${project} only (local scope)`, run: install(`zodchi-${d}`, "local", project) }
      : { what: `zodchi-${d} for you in every project (user scope)`, run: install(`zodchi-${d}`, "user") });
  }
  for (const s of steps) {
    if (o.dryRun) { say(`plugin: ${s.what}`); continue; }
    const r = s.run();
    if (r.missing) throw new Error("Claude Code (`claude`) is not on PATH; install it, or rerun with --no-plugins.");
    if (!r.ok) throw new Error(`plugin step failed: ${s.what}\n${r.out}`);
    console.log(`plugin: ${s.what} - ok`);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17).map(l => l.replace(/^\/\/ ?/, "")).join("\n")); return; }
  const home = path.resolve(process.env.ZODCHI_HOME || path.join(os.homedir(), ".zodchi"));
  // Agents and workflows of an earlier 1.0 install were copied here; they are removed now that plugins carry them.
  const claudeDir = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  const manifest = readManifest(home);
  const say = (s) => console.log((o.dryRun ? "[dry-run] " : "") + s);

  if (o.uninstall) {
    // The plugin goes first: when Claude Code refuses, nothing has been removed yet.
    if (!o.noPlugins && !o.dryRun) {
      const r = claude(["plugin", "uninstall", `zodchi-core@${MARKETPLACE}`, "--scope", "user"]);
      if (r.ok) console.log("plugin zodchi-core: uninstalled");
      else if (/not found in installed plugins/i.test(r.out)) console.log("plugin zodchi-core: was not installed");
      else throw new Error(`plugin zodchi-core could not be uninstalled; nothing else was removed.\n${r.out}`);
    }
    for (const [dest, hash] of Object.entries(manifest.files || {})) {
      if (!fs.existsSync(dest)) continue;
      if (sha(fs.readFileSync(dest)) !== hash && !o.force) { say(`keep (changed by you): ${dest}`); continue; }
      say(`remove ${dest}`);
      if (!o.dryRun) fs.rmSync(dest);
    }
    if (!o.dryRun) fs.rmSync(path.join(home, "installed.json"), { force: true });
    console.log(`Domain plugins stay where you enabled them: claude plugin uninstall zodchi-<domain>@${MARKETPLACE} --scope local (in each project).`);
    return;
  }

  const domains = chooseDomains(o.domains);
  // Everything that can fail on a wrong argument is checked before the first write.
  if (o.project && !domains.length) throw new Error("--project needs --domains: the domains to enable in that repository.");
  let gatewayCli = null;
  if (o["gateway-cli"]) {
    gatewayCli = path.resolve(o["gateway-cli"]);
    if (!fs.existsSync(gatewayCli)) throw new Error(`No gateway CLI at ${gatewayCli}; nothing was installed.`);
  }
  // The Rust gateway is built before anything is written: a failed build installs nothing.
  // cargo that is not found means no Rust gateway; cargo that is found and fails stops the install before any write.
  let binary = null;
  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8", windowsHide: true });
  const cargoFound = !(cargo.error && cargo.error.code === "ENOENT");
  if (!o.noBuild && !gatewayCli && cargoFound) {
    if (cargo.status !== 0) throw new Error(`cargo is installed but does not run (${(cargo.error && cargo.error.message) || (cargo.stderr || "").trim() || `exit ${cargo.status}`}); nothing was installed. Fix it, or rerun with --no-build.`);
    binary = path.join(SRC, "gateway", "target", "release", process.platform === "win32" ? "zodchi.exe" : "zodchi");
    if (o.dryRun) say("would build the gateway (cargo build --release)");
    else {
      console.log("Building the gateway (cargo build --release)...");
      const built = spawnSync("cargo", ["build", "--release", "--manifest-path", path.join(SRC, "gateway", "Cargo.toml")], { stdio: "inherit", windowsHide: true });
      if (built.status !== 0 || !fs.existsSync(binary)) throw new Error("The gateway did not build; nothing was installed. Rerun with --no-build to install the rest.");
    }
  }
  // --no-build keeps a Rust gateway an earlier install put there, unchanged, instead of falling back.
  if (o.noBuild && !gatewayCli) {
    const installed = path.join(home, "bin", process.platform === "win32" ? "zodchi.exe" : "zodchi");
    const known = (manifest.files || {})[installed];
    if (fs.existsSync(installed) && known && sha(fs.readFileSync(installed)) === known && !fs.readFileSync(installed).subarray(0, 2).equals(Buffer.from("#!"))) binary = installed;
  }

  // Plugins first: when Claude Code refuses, nothing else has been changed yet.
  if (!o.noPlugins) plugins(o, domains, say);

  const items = plan(home, binary);
  const nativeDest = binary ? path.join(home, "bin", path.basename(binary)) : null;
  const FORWARDING = ["zodchi.mjs", "zodchi.cmd", "zodchi"].map(f => path.resolve(home, "bin", f));
  const owned = manifest.files || {};
  const isOwned = (dest, buf) => Object.prototype.hasOwnProperty.call(owned, dest) && owned[dest] === sha(buf);
  const next = { version: VERSION, files: { ...owned } };
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
    // A dry run of a fresh checkout has no built gateway yet: the plan names it without reading it.
    if (it.src && o.dryRun && !fs.existsSync(it.src)) { say(`${fs.existsSync(it.dest) ? "update" : "add"} ${it.dest} (after the build)`); continue; }
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

  // Files from an earlier install that this one no longer plans: removed when unchanged.
  const planned = new Set(items.map(it => path.resolve(it.dest)));
  const inside = (f) => [claudeDir, home].some(d => path.resolve(f).toLowerCase().startsWith(path.resolve(d).toLowerCase() + path.sep));
  // The forwarding command goes only once the Rust gateway is really in place; a skipped binary keeps it.
  const nativeInPlace = Boolean(nativeDest) && (o.dryRun
    ? !fs.existsSync(nativeDest) || isOwned(nativeDest, fs.readFileSync(nativeDest)) || o.force
    : fs.existsSync(nativeDest) && fs.existsSync(binary) && sha(fs.readFileSync(nativeDest)) === sha(fs.readFileSync(binary)));
  if (nativeDest && !nativeInPlace) say(`the Rust gateway was not installed at ${nativeDest} (a file of yours is there); the forwarding command stays`);
  for (const [dest, hash] of Object.entries(manifest.files || {})) {
    if (planned.has(path.resolve(dest)) || dest.endsWith(".new") || !inside(dest)) continue;
    if (FORWARDING.includes(path.resolve(dest)) && !nativeInPlace) continue;
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
  console.log(`\nzodchi ${VERSION}: ${written} file(s) written, ${skipped} skipped.`);
  if (o.noPlugins) console.log("Plugins: skipped (--no-plugins).");
  else console.log(`Plugins: zodchi-core everywhere${domains.length ? `; ${domains.map(d => `zodchi-${d}`).join(", ")} ${o.project ? `in ${path.resolve(o.project)}` : "everywhere"}` : ""}. A domain for one project: rerun with --project <repo> --domains <name>.`);
  console.log(`Codex CLI: ${codex.status === 0 ? codex.stdout.trim() : "not found - install it and run `codex login` for gateway roles"}`);
  if (binary && nativeInPlace) console.log(`Gateway: the Rust gateway, ${path.join(home, "bin", path.basename(binary))}. Subscriptions: ~/.zodchi/accounts.json (see gateway/README.md).`);
  else if (cfg.gatewayCli) console.log(`Gateway: forwarding to ${cfg.gatewayCli}.`);
  else console.log("Gateway: not installed - install Rust (https://rustup.rs) and rerun, or pass --gateway-cli <path to a Node gateway cli.mjs>.");
  const bin = path.join(home, "bin");
  if (!(process.env.PATH || "").split(path.delimiter).some(p => path.resolve(p) === bin)) console.log(`Add ${bin} to PATH so agents can run \`zodchi\`.`);
}

main().catch(e => { console.error(`zodchi install: ${e.message}`); process.exit(1); });
