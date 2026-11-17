#!/usr/bin/env node
// zodchi installer. install.ps1 and install.sh call this; it needs Node 20+ and Claude Code.
//
//   node install/install.mjs [--domains web-apps,gamedev-unity|all] [--project <repo>] [--no-build] [--no-plugins]
//                            [--gateway-cli <cli.mjs>] [--dev] [--force] [--dry-run] [--uninstall]
//
// What it does:
//   1. Claude Code plugins (the marketplace "zodchi"): zodchi-core for you in every project (user scope). --domains
//      adds domain plugins: with --project <repo> only in that repository, for you alone (local scope:
//      .claude/settings.local.json, nothing to commit); without --project in every project.
//      The plugins are read from a copy of the plugin files (.claude-plugin, core, domains) of the commit HEAD points
//      at, ~/.zodchi/plugins/<full commit hash>/, made by git from the commit, never from the working tree: a branch
//      switch or an uncommitted edit in the clone changes nothing for other Claude sessions, and uncommitted changes
//      are left out of the copy (a note says so). The installer refuses a branch other than the default one (the
//      target of refs/remotes/origin/HEAD), a detached HEAD, or a clone where that default is unknown, unless
//      --force; a folder without .git is refused unless --dev. A copy is staged beside its final name, gets a
//      .complete file last and is renamed into place; a folder without .complete is made again. A rerun after
//      `git pull` makes a new copy, moves the marketplace to it and updates zodchi-core and the domains named in that
//      run; the registered copy and the two newest complete ones are kept, the rest are removed. When the marketplace
//      cannot be moved, its registration stays as it was and the new copy stays beside it.
//      --dev registers the clone itself as the marketplace instead (for working on zodchi: every session on this
//      machine then sees the clone's working tree as it is).
//   2. The gateway: with cargo on PATH the Rust gateway is built from gateway/ and installed as ~/.zodchi/bin/zodchi.
//      --no-build skips that; --gateway-cli instead installs a small command that forwards to a Node gateway.
//   3. models.json and the gateway roles -> ~/.zodchi (or $ZODCHI_HOME).
// A file the installer did not put there, or that you changed since, is left alone (use --force to replace it).
// ~/.zodchi/models.json is yours once installed: a newer table is written beside it as models.json.new.
// Rerun it after `git pull` to update everything. --uninstall removes what it installed, the plugin copies too: when the
// marketplace reads from a copy it is removed and the plugins go with it (zodchi-core and the domain plugins); a --dev
// marketplace (the clone) stays, and only zodchi-core is uninstalled. With --no-plugins Claude Code's plugins, the
// marketplace and the copies are all left alone.
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
    else if (a === "--dev") o.dev = true;
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

// ---- The plugin copy: what Claude Code reads is a folder of its own, made from a commit, never the working tree ----

// The folders of the repository a copy holds. Every plugin source in the manifest must be inside them.
const ROOTS = [".claude-plugin", "core", "domains"];
// A copy is named by the full hash of its commit (SHA-1 or SHA-256). Nothing else under <home>/plugins is touched,
// and a copy counts only with its .complete file, which is written last, before the folder gets this name.
const COPY_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMPLETE = ".complete";
const KEEP_COPIES = 2;

// One git call in this clone. Every call is checked: a failure stops the install with git's own message, except
// where the caller asks for the result (soft) to look at the exit status itself.
function git(args, { soft = false, env, input } = {}) {
  const r = spawnSync("git", args, { cwd: SRC, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 28, env, input });
  const res = { ok: r.status === 0 && !r.error, status: r.status, out: (r.stdout || "").trim(), raw: r.stdout || "", err: ((r.error && r.error.message) || r.stderr || "").trim() };
  if (!res.ok && !soft) throw gitFailed(args, res);
  return res;
}
const gitFailed = (args, r) => new Error(`git ${args.join(" ")} failed${r.status == null ? "" : ` (exit ${r.status})`}: ${r.err || "no message"}\nNothing was installed.`);

// What the plugin copy would be, and whether it may be made. Nothing is written. null for --dev and --no-plugins.
// HEAD is resolved here, once, to a full hash; the copy is that commit whatever happens in the clone afterwards.
function copyPlan(o, home) {
  if (o.dev || o.noPlugins) return null;
  if (!fs.existsSync(path.join(SRC, ".git"))) throw new Error(`${SRC} is not a git checkout, so there is no commit to copy the plugins from; nothing was installed. Clone the repository, or use --dev to read this folder itself.`);
  if (!samePath(git(["rev-parse", "--show-toplevel"]).out, SRC)) throw new Error(`${SRC} has a .git but is not the top of its repository; nothing was installed. Use --dev to read the folder itself.`);
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).out;
  // Exit 1 of symbolic-ref -q is a detached HEAD; any other failure stops the install.
  const head = git(["symbolic-ref", "-q", "--short", "HEAD"], { soft: true });
  if (!head.ok && head.status !== 1) throw gitFailed(["symbolic-ref", "-q", "--short", "HEAD"], head);
  const branch = head.ok ? head.out : "";
  const why = [];
  let main = "";
  const origin = git(["symbolic-ref", "refs/remotes/origin/HEAD"], { soft: true });
  if (origin.ok) main = origin.out.replace(/^refs\/remotes\/origin\//, "");
  else why.push(`the default branch is unknown: git symbolic-ref refs/remotes/origin/HEAD failed (${origin.err || `exit ${origin.status}`}); \`git remote set-head origin --auto\` sets it`);
  if (!branch) why.push("HEAD is detached, so the copy would be of a commit that no branch holds");
  else if (main && branch !== main) why.push(`the branch is "${branch}", not the default "${main}"`);
  const plan = { commit, forced: [], dir: path.join(home, "plugins", commit) };
  if (why.length && !o.force) {
    const refusal = `will not copy plugins from this clone: ${why.join("; ")}. Every Claude Code session on this machine would run what is in the copy, unreviewed. ` +
      `Switch to ${main ? `"${main}"` : "the default branch"} and rerun, or use --force to copy commit ${commit} anyway, or --dev to read the clone itself.`;
    // A dry run still shows the rest of the plan, with the refusal said up front; a real run stops here.
    if (!o.dryRun) throw new Error(refusal);
    plan.refusal = refusal;
  } else plan.forced = why;
  // The files of the commit under the roots: "<mode> <type> <object>\t<path>". A symlink or a submodule is refused.
  const entries = git(["ls-tree", "-r", "-z", commit, "--", ...ROOTS]).raw.split("\0").filter(Boolean)
    .map(line => ({ mode: line.slice(0, 6), file: line.slice(line.indexOf("\t") + 1) }));
  const odd = entries.filter(e => e.mode === "120000" || e.mode === "160000");
  if (odd.length) throw new Error(`commit ${commit} has a symlink or a submodule among the plugin files, which the copy does not take: ${odd.map(e => e.file).join(", ")}. Nothing was installed.`);
  plan.files = entries.map(e => e.file);
  if (!plan.files.includes(".claude-plugin/marketplace.json")) throw new Error(`commit ${commit} has no .claude-plugin/marketplace.json; nothing was installed.`);
  for (const p of JSON.parse(git(["show", `${commit}:.claude-plugin/marketplace.json`]).raw).plugins || []) {
    if (typeof p.source !== "string") continue;
    const first = path.posix.normalize(p.source.replace(/\\/g, "/")).split("/").filter(x => x && x !== ".")[0];
    if (!ROOTS.includes(first) || path.isAbsolute(p.source)) throw new Error(`plugin ${p.name}: source ${p.source} is outside ${ROOTS.join(", ")}, which is all the copy holds. Nothing was installed.`);
  }
  // Uncommitted changes are not in the commit, so they are not in the copy either: a note, not a refusal.
  if (git(["status", "--porcelain", "--", ...ROOTS]).out) plan.note = `uncommitted changes in ${ROOTS.join(", ")} are left out: the copy is commit ${commit}`;
  return plan;
}

// Makes the copy with git alone: a temporary index holds the commit, checkout-index writes its plugin files into
// <hash>.tmp-<pid>, .complete is written last, and the folder is renamed to <hash>. A <hash> folder with .complete is
// reused; one without it is a broken copy and is made again.
function makeCopy(plan) {
  const { dir, commit } = plan;
  const done = path.join(dir, COMPLETE);
  const now = new Date();
  if (fs.existsSync(done)) { fs.utimesSync(done, now, now); return { reused: true }; }
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { throw new Error(`${dir} is an incomplete copy and could not be removed (${e.code || e.message}); remove it by hand and rerun. Nothing was installed.`); }
  }
  const tmp = `${dir}.tmp-${process.pid}`;
  const index = `${dir}.index-${process.pid}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(["read-tree", commit], { env });
    git(["checkout-index", `--prefix=${tmp.replace(/\\/g, "/")}/`, "-z", "--stdin"], { env, input: plan.files.join("\0") + "\0" });
    const missing = plan.files.filter(f => !fs.existsSync(path.join(tmp, f)));
    if (missing.length) throw new Error(`git checkout-index did not write ${missing.length} file(s), first ${missing[0]}; nothing was installed.`);
    fs.writeFileSync(path.join(tmp, COMPLETE), commit + "\n");
    fs.renameSync(tmp, dir);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { console.log(`could not remove ${tmp} (${e2.code || e2.message}); remove it by hand`); }
    // Another run that made the same commit at the same time: its folder is as good as this one.
    if (e.code && fs.existsSync(done)) return { reused: true };
    throw e;
  } finally {
    for (const f of [index, index + ".lock"]) try { fs.rmSync(f, { force: true }); } catch { /* a stray index file beside the copies is harmless */ }
  }
  return { reused: false };
}

// The copy folders under <home>/plugins, newest first by the time of .complete (made or reused); incomplete ones last.
function listCopies(home) {
  const base = path.join(home, "plugins");
  let names = [];
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && COPY_NAME.test(d.name)).map(d => d.name); } catch { /* none */ }
  return names.map(n => {
    const dir = path.join(base, n);
    let time = -1;
    try { time = fs.statSync(path.join(dir, COMPLETE)).mtimeMs; } catch { /* incomplete */ }
    return { name: n, dir, complete: time >= 0, time };
  }).sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));
}

const isCopyPath = (p, home) => Boolean(p) && samePath(path.dirname(p), path.join(home, "plugins")) && COPY_NAME.test(path.basename(p));

function removeCopy(c, say, dryRun = false) {
  say(`remove plugin copy ${c.dir}`);
  if (dryRun) return;
  try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch (e) { console.log(`could not remove ${c.dir} (${e.code || e.message}); it is probably in use and is left, the next run tries again`); }
}

// The registered copy and the two newest complete ones stay; every other copy folder goes.
function pruneCopies(home, registered, say) {
  const all = listCopies(home);
  const kept = all.filter(c => c.complete).slice(0, KEEP_COPIES);
  for (const c of all) if (!kept.includes(c) && !samePath(c.dir, registered)) removeCopy(c, say);
}

// The registered marketplace of this name: { entry } (null when there is none) or { error }.
function marketplaceEntry() {
  const listed = claude(["plugin", "marketplace", "list", "--json"]);
  if (!listed.ok) return { error: listed.out };
  try { return { entry: JSON.parse(listed.out.slice(listed.out.indexOf("["))).find(m => m.name === MARKETPLACE) || null }; }
  catch { return { error: `marketplace list did not return JSON:\n${listed.out}` }; }
}

// What to do with the marketplace so that it reads from target: add, update, or move (from a copy or the clone).
// A marketplace of this name that comes from anywhere else is somebody else's: never touched.
function marketplaceChange(entry, target, home) {
  if (!entry) return { action: "add", text: `register marketplace ${MARKETPLACE} at ${target}` };
  const at = entry.path;
  if (entry.source === "directory" && at) {
    if (samePath(at, target)) return { action: "update", text: `marketplace ${MARKETPLACE} already reads from ${target}; refresh it` };
    if (samePath(at, SRC) || isCopyPath(at, home)) {
      const was = samePath(at, SRC) ? "the clone, as an earlier install registered it; moved to a copy now" : samePath(target, SRC) ? "a copy; moved to the clone (--dev)" : "an older copy";
      return { action: "move", from: at, text: `move marketplace ${MARKETPLACE} from ${at} (${was}) to ${target}` };
    }
  }
  return { action: "refuse", text: `A marketplace named "${MARKETPLACE}" is already registered from ${at || entry.repo || entry.url || entry.source}. ` +
    `To use this repository instead: claude plugin marketplace remove ${MARKETPLACE}, then rerun the installer.` };
}

// The plugins: the copy (or the clone with --dev) becomes the marketplace, then the plugins are installed or updated.
function plugins(o, domains, say, home, copy) {
  const project = o.project ? path.resolve(o.project) : null;
  if (project && !fs.existsSync(project)) throw new Error(`No repository at ${project}`);
  const target = copy ? copy.dir : SRC;
  if (copy) {
    if (copy.refusal) say(`a real run would stop: ${copy.refusal}`);
    else if (copy.forced.length) say(`--force: copying although ${copy.forced.join("; ")}`);
    if (copy.note) say(`note: ${copy.note}`);
    if (fs.existsSync(path.join(copy.dir, COMPLETE))) say(`the plugin copy ${copy.dir} is already there; it is reused`);
    else say(`copy ${copy.files.length} plugin file(s) of commit ${copy.commit} to ${copy.dir}`);
  } else say(`--dev: the clone ${SRC} is the marketplace; every Claude session on this machine reads its working tree as it is`);
  const steps = [];
  const present = claude(["--version"]).ok;
  if (!present && !o.dryRun) throw new Error("Claude Code (`claude`) does not run here; install it, or rerun with --no-plugins.");
  if (!present) {
    // A dry run only reads: without Claude Code it can only assume that nothing is registered yet.
    say("Claude Code is not found; assuming no marketplace is registered yet");
    steps.push({ what: marketplaceChange(null, target, home).text });
  } else {
    const found = marketplaceEntry();
    if (found.error) throw new Error(found.error);
    const change = marketplaceChange(found.entry, target, home);
    if (change.action === "refuse") throw new Error(change.text);
    steps.push({ what: change.text, run: () => claude(change.action === "update" ? ["plugin", "marketplace", "update", MARKETPLACE] : ["plugin", "marketplace", "add", target]) });
  }
  const install = (plugin, scope, cwd) => () => {
    const r = claude(["plugin", "install", `${plugin}@${MARKETPLACE}`, "--scope", scope], { cwd });
    if (r.ok || !/already/i.test(r.out)) return r;
    // Installed before: bring it to the version in the marketplace as it reads now.
    return claude(["plugin", "update", `${plugin}@${MARKETPLACE}`, "--scope", scope], { cwd });
  };
  steps.push({ what: "zodchi-core for you in every project (user scope)", run: install("zodchi-core", "user") });
  for (const d of domains) {
    steps.push(project
      ? { what: `zodchi-${d} in ${project} only (local scope)`, run: install(`zodchi-${d}`, "local", project) }
      : { what: `zodchi-${d} for you in every project (user scope)`, run: install(`zodchi-${d}`, "user") });
  }
  if (o.dryRun) {
    for (const s of steps) say(`plugin: ${s.what}`);
    return;
  }
  // The copy is made before the first step. When the marketplace step fails, the registration stays as it was and
  // the new copy stays too: it is complete, and nothing reads it.
  if (copy) makeCopy(copy);
  for (const [i, s] of steps.entries()) {
    const r = s.run();
    if (r.missing) throw new Error("Claude Code (`claude`) is not on PATH; install it, or rerun with --no-plugins.");
    if (!r.ok) throw new Error(`plugin step failed: ${s.what}\n${r.out}${i === 0 && copy ? `\nThe marketplace registration was left as it was; the copy ${copy.dir} stays.` : ""}`);
    console.log(`plugin: ${s.what} - ok`);
  }
  if (copy) pruneCopies(home, copy.dir, say);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, all) => all.slice(0, i + 1).every(x => x.startsWith("//"))).map(l => l.replace(/^\/\/ ?/, "")).join("\n")); return; }
  const home = path.resolve(process.env.ZODCHI_HOME || path.join(os.homedir(), ".zodchi"));
  // Agents and workflows of an earlier 1.0 install were copied here; they are removed now that plugins carry them.
  const claudeDir = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
  const manifest = readManifest(home);
  const say = (s) => console.log((o.dryRun ? "[dry-run] " : "") + s);

  if (o.uninstall) {
    // The marketplace is looked up before anything is removed: when Claude Code cannot answer, nothing has changed.
    // A marketplace that reads from one of the plugin copies would dangle once they are gone, so removing it is the
    // first change; Claude Code removes the plugins installed from it with it, zodchi-core and the domain plugins.
    // Any other install (--dev, the clone itself) keeps its marketplace: only zodchi-core is uninstalled.
    let marketplaceGone = false;
    const copies = listCopies(home);
    if (!o.noPlugins) {
      const present = claude(["--version"]).ok;
      if (!present && !o.dryRun) throw new Error("Claude Code (`claude`) is not on PATH; install it, or rerun with --no-plugins. Nothing was removed.");
      const found = present ? marketplaceEntry() : { entry: null };
      if (found.error) throw new Error(`could not read the marketplaces; nothing was removed.\n${found.error}`);
      if (found.entry && found.entry.source === "directory" && isCopyPath(found.entry.path, home)) {
        say(`remove marketplace ${MARKETPLACE} (it read from ${found.entry.path}); zodchi-core and the domain plugins installed from it go with it`);
        if (!o.dryRun) {
          const r = claude(["plugin", "marketplace", "remove", MARKETPLACE]);
          if (!r.ok) throw new Error(`marketplace ${MARKETPLACE} could not be removed; nothing was removed.\n${r.out}`);
        }
        marketplaceGone = true;
      } else if (o.dryRun) say(`plugin: uninstall zodchi-core@${MARKETPLACE} (user scope); the marketplace stays`);
      else {
        const r = claude(["plugin", "uninstall", `zodchi-core@${MARKETPLACE}`, "--scope", "user"]);
        if (r.ok) console.log("plugin zodchi-core: uninstalled");
        else if (/not found in installed plugins/i.test(r.out)) console.log("plugin zodchi-core: was not installed");
        else throw new Error(`plugin zodchi-core could not be uninstalled; nothing else was removed.\n${r.out}`);
      }
    }
    if (o.noPlugins) { if (copies.length) console.log(`Plugin copies kept in ${path.join(home, "plugins")} (--no-plugins leaves Claude Code's plugins alone).`); }
    else {
      for (const c of copies) removeCopy(c, say, o.dryRun);
      if (!o.dryRun) try { fs.rmdirSync(path.join(home, "plugins")); } catch { /* not empty or not there */ }
    }
    for (const [dest, hash] of Object.entries(manifest.files || {})) {
      if (!fs.existsSync(dest)) continue;
      if (sha(fs.readFileSync(dest)) !== hash && !o.force) { say(`keep (changed by you): ${dest}`); continue; }
      say(`remove ${dest}`);
      if (!o.dryRun) fs.rmSync(dest);
    }
    if (!o.dryRun) fs.rmSync(path.join(home, "installed.json"), { force: true });
    if (!marketplaceGone) console.log(`The marketplace ${MARKETPLACE} stays registered${o.noPlugins ? " (--no-plugins)" : ""}, and so do the domain plugins you enabled; to remove them: claude plugin uninstall zodchi-<domain>@${MARKETPLACE} --scope local (in each project), then claude plugin marketplace remove ${MARKETPLACE}.`);
    return;
  }

  const domains = chooseDomains(o.domains);
  // Everything that can fail on a wrong argument is checked before the first write.
  if (o.project && !domains.length) throw new Error("--project needs --domains: the domains to enable in that repository.");
  // The plugin copy: whether it may be made (branch, tree) is known before anything is built or written.
  const copy = copyPlan(o, home);
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
  if (!o.noPlugins) plugins(o, domains, say, home, copy);

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
  else console.log(`Plugins (${copy ? `from the copy ${copy.dir}` : `--dev: from the clone ${SRC}`}): zodchi-core everywhere${domains.length ? `; ${domains.map(d => `zodchi-${d}`).join(", ")} ${o.project ? `in ${path.resolve(o.project)}` : "everywhere"}` : ""}. A domain for one project: rerun with --project <repo> --domains <name>.`);
  console.log(`Codex CLI: ${codex.status === 0 ? codex.stdout.trim() : "not found - install it and run `codex login` for gateway roles"}`);
  if (binary && nativeInPlace) console.log(`Gateway: the Rust gateway, ${path.join(home, "bin", path.basename(binary))}. Subscriptions: ~/.zodchi/accounts.json (see gateway/README.md).`);
  else if (cfg.gatewayCli) console.log(`Gateway: forwarding to ${cfg.gatewayCli}.`);
  else console.log("Gateway: not installed - install Rust (https://rustup.rs) and rerun, or pass --gateway-cli <path to a Node gateway cli.mjs>.");
  const bin = path.join(home, "bin");
  if (!(process.env.PATH || "").split(path.delimiter).some(p => path.resolve(p) === bin)) console.log(`Add ${bin} to PATH so agents can run \`zodchi\`.`);
}

main().catch(e => { console.error(`zodchi install: ${e.message}`); process.exit(1); });
