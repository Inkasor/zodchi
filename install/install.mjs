#!/usr/bin/env node
// zodchi installer. install.ps1 and install.sh call this; it needs Node 20+ and Claude Code.
//
//   node install/install.mjs [--domains web-apps,gamedev-unity|all] [--project <repo>] [--no-build] [--no-plugins]
//                            [--gateway-cli <cli.mjs>] [--no-codex-skill] [--dev] [--force] [--dry-run] [--uninstall]
//
// What it does:
//   1. Claude Code plugins (the marketplace "zodchi"): zodchi-core for you in every project (user scope). --domains
//      adds domain plugins: with --project <repo> only in that repository, for you alone (local scope:
//      .claude/settings.local.json, nothing to commit); without --project in every project.
//      The plugins are read from a copy of the plugin files (.claude-plugin, core, domains) of the commit HEAD points
//      at, ~/.zodchi/plugins/<full commit hash>/, made by git from the commit, never from the working tree: a branch
//      switch or an uncommitted edit in the clone changes nothing for other Claude sessions, and uncommitted changes
//      are left out of the copy (a note says so). The marketplace name and the domains come from that commit too.
//      The installer refuses a branch other than the default one (refs/heads/<name> for the target
//      refs/remotes/origin/<name> of refs/remotes/origin/HEAD), a detached HEAD, or a clone where that default is
//      unknown, unless --force; on the default branch the commit is read from that branch ref itself. A folder without
//      .git is refused unless --dev. A copy is staged beside its final name, every file is checked against the
//      commit's blob hash, it gets a .complete file last and is renamed into place; a copy is reused only with
//      .complete and every file of the commit present, otherwise it is moved aside and made again. A rerun after
//      `git pull` makes a new copy, moves the marketplace to it and refreshes zodchi-core and the domains named in that
//      run (a domain enabled in another project is refreshed by rerunning with --project <repo> --domains <name>).
//      A plugin that is already installed is uninstalled and installed again in the same scope, not `plugin update`d:
//      with one version in plugin.json Claude Code keeps the copy it cached at the first install. Afterwards the
//      registration (installed_plugins.json in the Claude config dir) is read back and one file of each plugin in
//      Claude Code's cache is compared with the copy's; a difference is an error. Claude Code sessions that are open
//      keep the plugins they started with (/reload-plugins in each, or a new session);
//      the registered copy, the one registered before it, the two newest complete ones and every copy made in the last
//      7 days (a running Claude Code session keeps reading the copy it started with) are kept, the rest are
//      removed. After the marketplace command the registration is read back and reported. One install at a time:
//      ~/.zodchi/plugins/.install.lock is held from reading the registration to the end of the cleanup.
//      --dev registers the clone itself as the marketplace instead (for working on zodchi: every session on this
//      machine then sees the clone's working tree as it is).
//   2. The gateway: with cargo on PATH the Rust gateway is built from gateway/ and installed as ~/.zodchi/bin/zodchi.
//      --no-build skips that; --gateway-cli instead installs a small command that forwards to a Node gateway.
//   3. models.json and the gateway roles -> ~/.zodchi (or $ZODCHI_HOME).
//   4. The Codex skill zodchi-flow (codex/skills/) -> $CODEX_HOME/skills, else ~/.codex/skills: it tells a Codex session how
//      to run `zodchi flow code-package`. It is managed like every other file here. --no-codex-skill leaves it (and an
//      earlier copy of it) alone, on install and on --uninstall. The Claude Code skill zodchi-flow is part of the
//      zodchi-core plugin (core/skills/), so it comes with step 1.
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
// The marketplace name. In a normal install it is the name in the commit that is copied; the working tree is read for it
// only with --dev and --no-plugins. --uninstall reads it from the registered copy, else HEAD's commit, else the tree.
let MARKETPLACE = null;
const treeName = () => JSON.parse(fs.readFileSync(path.join(SRC, ".claude-plugin", "marketplace.json"), "utf8")).name;

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
    else if (a === "--no-codex-skill") o.noCodexSkill = true;
    else if (["--domains", "--project", "--gateway-cli"].includes(a) && argv[i + 1]) o[a.slice(2)] = argv[++i];
    else if (a === "--help" || a === "-h") { o.help = true; }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// The domains of the working tree, read only with --dev and --no-plugins; a normal install takes them from the commit.
const treeDomains = () => fs.readdirSync(path.join(SRC, "domains"), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

function chooseDomains(given, all) {
  if (!given) return [];
  const picked = given === "all" ? all : given.split(",").map(s => s.trim()).filter(Boolean);
  const unknown = picked.filter(d => !all.includes(d));
  if (unknown.length) throw new Error(`Unknown domain(s): ${unknown.join(", ")}. Available: ${all.join(", ")}`);
  return picked;
}

// Every file under codex/skills/ of this repository, as its path below that folder with forward slashes.
function codexSkillFiles() {
  const base = path.join(SRC, "codex", "skills");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => path.relative(base, path.join(e.parentPath || e.path, e.name)).split(path.sep).join("/"))
    .sort();
}

function plan(home, binary, codexSkills) {
  const items = []; // { src | content, dest, kind }
  const add = (src, dest, kind, mode, skill) => items.push({ src, dest, kind, mode, skill });
  for (const f of fs.readdirSync(path.join(SRC, "roles"))) add(path.join(SRC, "roles", f), path.join(home, "roles", f), "managed");
  add(path.join(SRC, "models.json"), path.join(home, "models.json"), "user-owned");
  // The Codex skill goes where Codex reads skills; a managed file like the roles: never over one the installer did not write.
  if (codexSkills) for (const f of codexSkillFiles()) add(path.join(SRC, "codex", "skills", f), path.join(codexSkills, ...f.split("/")), "managed", undefined, true);
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
// where the caller asks for the result (soft) to look at the exit status itself. GIT_OPTIONAL_LOCKS=0 on every call:
// a query such as `git status` then never refreshes or locks the clone's own index.
function git(args, { soft = false, env, input } = {}) {
  const r = spawnSync("git", args, { cwd: SRC, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 28, env: { ...(env || process.env), GIT_OPTIONAL_LOCKS: "0" }, input });
  const res = { ok: r.status === 0 && !r.error, status: r.status, out: (r.stdout || "").trim(), raw: r.stdout || "", err: ((r.error && r.error.message) || r.stderr || "").trim() };
  if (!res.ok && !soft) throw gitFailed(args, res);
  return res;
}
const gitFailed = (args, r) => new Error(`git ${args.join(" ")} failed${r.status == null ? "" : ` (exit ${r.status})`}: ${r.err || "no message"}\nNothing was installed.`);
const ORIGIN = "refs/remotes/origin/";

// What the plugin copy would be, and whether it may be made. Nothing is written. null for --dev and --no-plugins.
// The commit is resolved here, once, to a full hash; the copy is that commit whatever happens in the clone afterwards.
// On the default branch it is read from that exact local branch ref after the check, never from an earlier read of
// HEAD, so a HEAD that moves meanwhile cannot slip another branch's commit through.
function copyPlan(o, home) {
  if (o.dev || o.noPlugins) return null;
  if (!fs.existsSync(path.join(SRC, ".git"))) throw new Error(`${SRC} is not a git checkout, so there is no commit to copy the plugins from; nothing was installed. Clone the repository, or use --dev to read this folder itself.`);
  if (!samePath(git(["rev-parse", "--show-toplevel"]).out, SRC)) throw new Error(`${SRC} has a .git but is not the top of its repository; nothing was installed. Use --dev to read the folder itself.`);
  // Full ref names only: a short name can be ambiguous. Exit 1 of symbolic-ref -q is "not a symbolic ref".
  const head = git(["symbolic-ref", "-q", "HEAD"], { soft: true });
  if (!head.ok && head.status !== 1) throw gitFailed(["symbolic-ref", "-q", "HEAD"], head);
  const headRef = head.ok ? head.out : "";
  const why = [];
  let main = "", mainRef = "";
  const origin = git(["symbolic-ref", "-q", `${ORIGIN}HEAD`], { soft: true });
  if (origin.ok && origin.out.startsWith(ORIGIN) && origin.out.length > ORIGIN.length && origin.out !== `${ORIGIN}HEAD`) {
    main = origin.out.slice(ORIGIN.length);
    mainRef = `refs/heads/${main}`;
  } else if (origin.ok) why.push(`the default branch is unknown: ${ORIGIN}HEAD points at ${origin.out}, which is not under ${ORIGIN}`);
  else why.push(`the default branch is unknown: git symbolic-ref ${ORIGIN}HEAD failed (${origin.err || `exit ${origin.status}`}); \`git remote set-head origin --auto\` sets it`);
  if (!headRef) why.push("HEAD is detached, so the copy would be of a commit that no branch holds");
  else if (!headRef.startsWith("refs/heads/")) why.push(`HEAD points at ${headRef}, which is not a local branch`);
  else if (mainRef && headRef !== mainRef) why.push(`the branch is "${headRef.slice("refs/heads/".length)}", not the default "${main}"`);
  const from = why.length ? "HEAD" : mainRef;
  // The exact ref: show-ref --verify reads refs/heads/<name> itself, with no fallback to another ref of a similar name.
  const commit = from === "HEAD" ? git(["rev-parse", "--verify", "HEAD^{commit}"]).out : git(["show-ref", "--verify", "--hash", from]).out;
  if (git(["cat-file", "-t", commit]).out !== "commit") throw new Error(`${from} does not point at a commit; nothing was installed.`);
  const plan = { commit, forced: [], dir: path.join(home, "plugins", commit) };
  if (why.length && !o.force) {
    const refusal = `will not copy plugins from this clone: ${why.join("; ")}. Every Claude Code session on this machine would run what is in the copy, unreviewed. ` +
      `Switch to ${main ? `"${main}"` : "the default branch"} and rerun, or use --force to copy commit ${commit} anyway, or --dev to read the clone itself.`;
    // A dry run still shows the rest of the plan, with the refusal said up front; a real run stops here.
    if (!o.dryRun) throw new Error(refusal);
    plan.refusal = refusal;
  } else plan.forced = why;
  // The files of the commit under the roots: "<mode> <type> <object>\t<path>". A symlink or a submodule is refused.
  const entries = git(["ls-tree", "-r", "-z", commit, "--", ...ROOTS]).raw.split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    const [mode, type, object] = line.slice(0, tab).split(" ");
    return { mode, type, object, file: line.slice(tab + 1) };
  });
  const odd = entries.filter(e => e.mode === "120000" || e.mode === "160000" || e.type !== "blob");
  if (odd.length) throw new Error(`commit ${commit} has a symlink or a submodule among the plugin files, which the copy does not take: ${odd.map(e => e.file).join(", ")}. Nothing was installed.`);
  const newline = entries.find(e => /[\r\n]/.test(e.file));
  if (newline) throw new Error(`commit ${commit} has a plugin file with a line break in its name (${JSON.stringify(newline.file)}), which the copy does not take. Nothing was installed.`);
  plan.entries = entries;
  plan.files = entries.map(e => e.file);
  if (!plan.files.includes(".claude-plugin/marketplace.json")) throw new Error(`commit ${commit} has no .claude-plugin/marketplace.json; nothing was installed.`);
  // The marketplace name and the domains are the commit's, not the working tree's.
  const manifest = JSON.parse(git(["show", `${commit}:.claude-plugin/marketplace.json`]).raw);
  if (typeof manifest.name !== "string" || !manifest.name) throw new Error(`commit ${commit}: .claude-plugin/marketplace.json has no name; nothing was installed.`);
  plan.name = manifest.name;
  plan.domains = [...new Set(plan.files.map(f => (f.match(/^domains\/([^/]+)\//) || [])[1]).filter(Boolean))].sort();
  for (const p of manifest.plugins || []) {
    if (typeof p.source !== "string") continue;
    const first = path.posix.normalize(p.source.replace(/\\/g, "/")).split("/").filter(x => x && x !== ".")[0];
    if (!ROOTS.includes(first) || path.isAbsolute(p.source)) throw new Error(`plugin ${p.name}: source ${p.source} is outside ${ROOTS.join(", ")}, which is all the copy holds. Nothing was installed.`);
  }
  // Uncommitted changes are not in the commit, so they are not in the copy either: a note, not a refusal.
  if (git(["status", "--porcelain", "--", ...ROOTS]).out) plan.note = `uncommitted changes in ${ROOTS.join(", ")} are left out: the copy is commit ${commit}`;
  return plan;
}

// The commit's files in a folder must hash to their blobs exactly; a missing file, a folder or a changed byte fails.
function matchesCommit(dir, plan) {
  if (!plan.files.every(f => { try { return fs.lstatSync(path.join(dir, f)).isFile(); } catch { return false; } })) return false;
  const got = git(["-c", "core.longpaths=true", "hash-object", "--no-filters", "--stdin-paths"], { input: plan.files.map(f => path.join(dir, f).replace(/\\/g, "/")).join("\n") + "\n" }).out.split("\n");
  return plan.entries.every((e, i) => got[i] === e.object);
}
// A copy counts as reusable only with .complete and every file of the commit in it, byte for byte.
const intact = (plan) => fs.existsSync(path.join(plan.dir, COMPLETE)) && matchesCommit(plan.dir, plan);

// A copy folder leaves the reusable name first (renamed to <hash>.trash-<pid>), and only then is deleted: a deletion
// that stops half way never leaves a <hash> folder that looks complete. false when it could not be moved aside.
function discard(dir) {
  const trash = `${dir}.trash-${process.pid}`;
  try { fs.rmSync(trash, { recursive: true, force: true }); fs.renameSync(dir, trash); }
  catch (e) { if (e.code === "ENOENT") return true; console.log(`could not move ${dir} aside (${e.code || e.message}); it is probably in use and is left, the next run tries again`); return false; }
  try { fs.rmSync(trash, { recursive: true, force: true }); } catch (e) { console.log(`could not remove ${trash} (${e.code || e.message}); the next run tries again`); }
  return true;
}

// Makes the copy with git alone: a temporary index holds the commit, checkout-index writes its plugin files into
// <hash>.tmp-<pid> with every conversion off (no autocrlf, LF, no symlinks, no system attributes; long paths on
// Windows), each file's blob hash is checked against the commit, .complete is written last, and the folder is renamed
// to <hash>. An intact <hash> folder is reused; any other is moved aside and made again. Runs under the install lock.
function makeCopy(plan) {
  const { dir, commit } = plan;
  const now = new Date();
  if (intact(plan)) { fs.utimesSync(path.join(dir, COMPLETE), now, now); return { reused: true }; }
  if (fs.existsSync(dir) && !discard(dir)) throw new Error(`${dir} is an incomplete copy and could not be moved aside; remove it by hand and rerun. Nothing was installed.`);
  const tmp = `${dir}.tmp-${process.pid}`;
  const index = `${dir}.index-${process.pid}`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_ATTR_NOSYSTEM: "1" };
    git(["read-tree", commit], { env });
    git(["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.symlinks=false", "-c", "core.longpaths=true", "checkout-index", `--prefix=${tmp.replace(/\\/g, "/")}/`, "-z", "--stdin"], { env, input: plan.files.join("\0") + "\0" });
    const missing = plan.files.filter(f => !fs.existsSync(path.join(tmp, f)));
    if (missing.length) throw new Error(`git checkout-index did not write ${missing.length} file(s), first ${missing[0]}; nothing was installed.`);
    // The bytes on disk must be the commit's blobs exactly: a filter or an attribute that changed them fails the copy.
    const got = git(["-c", "core.longpaths=true", "hash-object", "--no-filters", "--stdin-paths"], { input: plan.files.map(f => path.join(tmp, f).replace(/\\/g, "/")).join("\n") + "\n" }).out.split("\n");
    const differ = plan.entries.filter((e, i) => got[i] !== e.object);
    if (differ.length) throw new Error(`the copy of commit ${commit} does not match the commit: ${differ.length} file(s) differ from their blobs, first ${differ[0].file} (a checkout filter or attribute changed the bytes); nothing was installed.`);
    fs.writeFileSync(path.join(tmp, COMPLETE), commit + "\n");
    fs.renameSync(tmp, dir);
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { console.log(`could not remove ${tmp} (${e2.code || e2.message}); the next run removes it`); }
    throw e;
  } finally {
    for (const f of [index, index + ".lock"]) try { fs.rmSync(f, { force: true }); } catch { /* the next run removes it */ }
  }
  return { reused: false, verified: plan.files.length };
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
  if (!dryRun) discard(c.dir);
}

// What an earlier run left half done beside the copies: <hash>.tmp-, .trash- and .index- entries. Only called under the
// install lock, when no other run can be using them.
function removeStrays(home) {
  const base = path.join(home, "plugins");
  let names = [];
  try { names = fs.readdirSync(base); } catch { return; }
  for (const n of names.filter(n => /^(?:[0-9a-f]{40}|[0-9a-f]{64})\.(?:tmp|trash|index)-\d+(?:\.lock)?$/.test(n))) {
    try { fs.rmSync(path.join(base, n), { recursive: true, force: true }); } catch (e) { console.log(`could not remove ${path.join(base, n)} (${e.code || e.message}); the next run tries again`); }
  }
}

// The registered copy and the one registered before it stay, whatever their age, and so do the two newest complete
// copies; every other copy folder goes.
const KEEP_DAYS = 7;
function pruneCopies(home, protect, say) {
  const all = listCopies(home);
  const kept = new Set(all.filter(c => protect.some(p => p && samePath(c.dir, p))));
  for (const c of all.filter(c => c.complete).slice(0, KEEP_COPIES)) kept.add(c);
  // A Claude Code session keeps reading the copy it started with until it reloads its plugins, and sessions live for
  // days: a copy published in the last KEEP_DAYS days stays even when it is not among the newest.
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  for (const c of all) if (c.complete && c.time >= cutoff) kept.add(c);
  for (const c of all) if (!kept.has(c)) removeCopy(c, say);
  removeStrays(home);
}

// ---- One install at a time: a lock file that holds the pid and start time of the run that took it ----

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

// Takes <home>/plugins/.install.lock (created new, never opened if it exists) and returns the function that releases it.
// A lock whose process is gone is taken over: it is renamed to a name of this run first and compared with what was
// judged stale, so two runs that both find it stale cannot both take it. A live holder stops this run.
function takeLock(home) {
  const base = path.join(home, "plugins");
  const file = path.join(base, ".install.lock");
  const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString() }) + "\n";
  fs.mkdirSync(base, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try { fs.writeSync(fd, mine); } finally { fs.closeSync(fd); }
      return () => { try { if (fs.readFileSync(file, "utf8") === mine) fs.rmSync(file); } catch { /* already gone */ } };
    } catch (e) { if (e.code !== "EEXIST") throw new Error(`could not create the install lock ${file} (${e.code || e.message}); nothing was changed.`); }
    let held = null, holder = null, age = 0;
    try { held = fs.readFileSync(file, "utf8"); age = Date.now() - fs.statSync(file).mtimeMs; holder = JSON.parse(held); } catch { /* gone, or still being written */ }
    if (held === null) continue;
    if (holder && pidAlive(holder.pid)) throw new Error(`another zodchi install (pid ${holder.pid}, started ${holder.started}) holds ${file}; rerun when it has finished. Nothing was changed.`);
    if (!holder && age < 30000) throw new Error(`another zodchi install is taking ${file} right now; rerun when it has finished. Nothing was changed.`);
    const aside = `${file}.stale-${process.pid}`;
    try { fs.renameSync(file, aside); } catch (e) { if (e.code === "ENOENT") continue; throw new Error(`could not take over the stale install lock ${file} (${e.code || e.message}); remove it by hand if no install is running. Nothing was changed.`); }
    let moved = null;
    try { moved = fs.readFileSync(aside, "utf8"); } catch { /* gone */ }
    if (moved !== held) {
      // Another run replaced the stale lock with its own in between: give it back and stop.
      try { fs.linkSync(aside, file); } catch { /* it made a new one already */ }
      fs.rmSync(aside, { force: true });
      throw new Error(`another zodchi install took ${file} at the same moment; rerun when it has finished. Nothing was changed.`);
    }
    fs.rmSync(aside, { force: true });
    console.log(`took over the install lock left by ${holder ? `pid ${holder.pid} (started ${holder.started})` : "a run that never wrote it"}, which is no longer running`);
  }
  throw new Error(`could not take the install lock ${file}; rerun. Nothing was changed.`);
}

// ---- The marketplace ----

// Every registered marketplace: { list } or { error }.
function marketplaces() {
  const listed = claude(["plugin", "marketplace", "list", "--json"]);
  if (!listed.ok) return { error: listed.out };
  try { return { list: JSON.parse(listed.out.slice(listed.out.indexOf("["))) }; }
  catch { return { error: `marketplace list did not return JSON:\n${listed.out}` }; }
}

// The registered marketplace of this name: { entry } (null when there is none) or { error }.
function marketplaceEntry() {
  const all = marketplaces();
  return all.error ? all : { entry: all.list.find(m => m.name === MARKETPLACE) || null };
}
const describeEntry = (found) => found.error ? `unknown, the list failed (${found.error})` : found.entry ? `registered from ${found.entry.path || found.entry.repo || found.entry.url || found.entry.source}` : "not registered";

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
// A real run holds the install lock from reading the registration to the end of the cleanup.
function plugins(o, domains, say, home, copy) {
  const project = o.project ? path.resolve(o.project) : null;
  if (project && !fs.existsSync(project)) throw new Error(`No repository at ${project}`);
  const target = copy ? copy.dir : SRC;
  if (copy) {
    if (copy.refusal) say(`a real run would stop: ${copy.refusal}`);
    else if (copy.forced.length) say(`--force: copying although ${copy.forced.join("; ")}`);
    if (copy.note) say(`note: ${copy.note}`);
    if (o.dryRun) say(intact(copy) ? `the plugin copy ${copy.dir} is already there; it is reused` : `copy ${copy.files.length} plugin file(s) of commit ${copy.commit} to ${copy.dir}, each checked against its blob hash`);
  } else say(`--dev: the clone ${SRC} is the marketplace; every Claude session on this machine reads its working tree as it is`);
  const present = claude(["--version"]).ok;
  if (!present && !o.dryRun) throw new Error("Claude Code (`claude`) does not run here; install it, or rerun with --no-plugins.");
  // A plugin that is already installed is uninstalled and installed again in the same scope (and the same folder for
  // local scope). `claude plugin update` is not used: while plugin.json keeps one version, it answers "already at the
  // latest version" and leaves the copy Claude Code cached at the first install, so sessions kept running old workflows.
  const install = (plugin, scope, cwd) => () => {
    const id = `${plugin}@${MARKETPLACE}`;
    const r = claude(["plugin", "install", id, "--scope", scope], { cwd });
    if (r.ok || !/already/i.test(r.out)) return { ...r, plugin, scope, cwd };
    const gone = claude(["plugin", "uninstall", id, "--scope", scope], { cwd });
    if (!gone.ok) return { ...gone, out: `${gone.out}\nThe plugin ${id} (${scope} scope) is still installed, with the copy Claude Code cached for it earlier.`, plugin, scope, cwd };
    const again = claude(["plugin", "install", id, "--scope", scope], { cwd });
    if (!again.ok) {
      return { ok: false, missing: again.missing, plugin, scope, cwd, out: `${again.out}\nThe plugin ${id} was uninstalled to refresh it and is now NOT installed (${scope} scope). ` +
        `Install it again with: claude plugin install ${id} --scope ${scope}${cwd ? ` (run it in ${cwd})` : ""}` };
    }
    return { ...again, refreshed: true, plugin, scope, cwd };
  };
  const steps = [{ what: "zodchi-core for you in every project (user scope)", run: install("zodchi-core", "user") }];
  for (const d of domains) {
    steps.push(project
      ? { what: `zodchi-${d} in ${project} only (local scope)`, run: install(`zodchi-${d}`, "local", project) }
      : { what: `zodchi-${d} for you in every project (user scope)`, run: install(`zodchi-${d}`, "user") });
  }
  if (o.dryRun) {
    // A dry run only reads and takes no lock: without Claude Code it can only assume that nothing is registered yet.
    let found = { entry: null };
    if (!present) say("Claude Code is not found; assuming no marketplace is registered yet");
    else { found = marketplaceEntry(); if (found.error) throw new Error(found.error); }
    const change = marketplaceChange(found.entry, target, home);
    if (change.action === "refuse") throw new Error(change.text);
    say(`plugin: ${change.text}`);
    for (const s of steps) say(`plugin: ${s.what}`);
    return;
  }
  const release = takeLock(home);
  try {
    // Read under the lock: what another run registered or published before is what this run starts from.
    const found = marketplaceEntry();
    if (found.error) throw new Error(found.error);
    const change = marketplaceChange(found.entry, target, home);
    if (change.action === "refuse") throw new Error(change.text);
    const previous = found.entry && found.entry.source === "directory" && isCopyPath(found.entry.path, home) ? found.entry.path : null;
    // The copy is made before the marketplace changes. When that step fails, the new copy stays: it is complete, and
    // nothing reads it.
    if (copy) {
      const made = makeCopy(copy);
      console.log(made.reused ? `plugin copy ${copy.dir}: already complete with every file of commit ${copy.commit}; reused`
        : `plugin copy ${copy.dir}: ${made.verified} file(s) of commit ${copy.commit} written, each matches its blob hash; .complete written`);
    }
    const r = claude(change.action === "update" ? ["plugin", "marketplace", "update", MARKETPLACE] : ["plugin", "marketplace", "add", target]);
    if (r.missing) throw new Error("Claude Code (`claude`) is not on PATH; install it, or rerun with --no-plugins.");
    // What is registered now is read back, not assumed.
    const after = marketplaceEntry();
    const now = describeEntry(after);
    if (!r.ok) throw new Error(`plugin step failed: ${change.text}\n${r.out}\nMarketplace ${MARKETPLACE} is now ${now}.${copy ? ` The copy ${copy.dir} stays.` : ""}`);
    if (after.error || !after.entry || after.entry.source !== "directory" || !samePath(after.entry.path || "", target)) {
      throw new Error(`the marketplace command succeeded, but marketplace ${MARKETPLACE} is ${now}, not ${target}; no plugin was installed or updated.`);
    }
    console.log(`plugin: ${change.text} - ok; marketplace ${MARKETPLACE} is ${now}`);
    const done = [];
    for (const s of steps) {
      const p = s.run();
      if (p.missing) throw new Error("Claude Code (`claude`) is not on PATH; install it, or rerun with --no-plugins.");
      if (!p.ok) throw new Error(`plugin step failed: ${s.what}\n${p.out}\nThe marketplace ${MARKETPLACE} already reads from ${target}; rerun the installer to finish the plugin steps.`);
      console.log(`plugin: ${s.what} - ok${p.refreshed ? " (uninstalled and installed again, so that Claude Code takes the files of this copy)" : ""}`);
      done.push(p);
    }
    // What Claude Code registered is read back and compared with the copy: a cache that still holds older files is an error.
    const problems = verifyCache(done, target, project);
    if (copy) pruneCopies(home, [copy.dir, previous], say);
    if (problems.length) throw new Error(`the plugins were installed, but what Claude Code cached is not what this install copied:\n${problems.join("\n")}`);
  } finally { release(); }
}

const claudeConfigDir = () => path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));

// The file of a plugin that is compared with Claude Code's cached copy of it: code-package.js for zodchi-core, else the
// first workflow of the plugin (in name order), else its plugin.json. Paths are relative to the plugin folder.
function probeFile(dir, plugin) {
  const wf = path.join(dir, "workflows");
  const names = (() => { try { return fs.readdirSync(wf).filter(n => n.endsWith(".js")).sort(); } catch { return []; } })();
  const found = plugin === "zodchi-core" ? ["workflows/code-package.js"] : [...names.slice(0, 1).map(n => `workflows/${n}`), ".claude-plugin/plugin.json"];
  return found.find(f => fs.existsSync(path.join(dir, ...f.split("/")))) || null;
}

// Reads installed_plugins.json of Claude Code back and compares, for every plugin the run installed, one file of the
// folder Claude Code says it installed from with the same file in the marketplace's copy, byte for byte. Returns the
// problems found, one line each; a Claude Code that keeps no such file is a note, not a failure.
function verifyCache(done, target, project) {
  const file = path.join(claudeConfigDir(), "plugins", "installed_plugins.json");
  if (!fs.existsSync(file)) { console.log(`note: ${file} does not exist, so what Claude Code cached for the plugins was not compared with the copy`); return []; }
  let registered;
  try { registered = JSON.parse(fs.readFileSync(file, "utf8")).plugins; } catch (e) { return [`${file} could not be read (${e.message}); what Claude Code cached was not compared with ${target}.`]; }
  if (!registered || typeof registered !== "object") return [`${file} has no "plugins" list; what Claude Code cached was not compared with ${target}.`];
  const manifest = JSON.parse(fs.readFileSync(path.join(target, ".claude-plugin", "marketplace.json"), "utf8"));
  const problems = [];
  for (const p of done) {
    const id = `${p.plugin}@${MARKETPLACE}`;
    const entries = Array.isArray(registered[id]) ? registered[id] : [];
    const mine = entries.find(e => e && e.scope === p.scope && (p.scope !== "local" || (e.projectPath && project && samePath(e.projectPath, project))));
    const fix = `claude plugin uninstall ${id} --scope ${p.scope}, then claude plugin install ${id} --scope ${p.scope}${p.cwd ? ` (in ${p.cwd})` : ""}`;
    if (!mine || !mine.installPath) { problems.push(`${id} (${p.scope} scope) is not registered in ${file} after its install.`); continue; }
    const source = (manifest.plugins || []).find(x => x.name === p.plugin);
    const dir = source && typeof source.source === "string" ? path.resolve(target, source.source) : null;
    const rel = dir && probeFile(dir, p.plugin);
    if (!rel) { problems.push(`${id}: the copy ${dir || target} has no file to compare with what Claude Code cached.`); continue; }
    const ours = path.join(dir, ...rel.split("/"));
    const cached = path.join(mine.installPath, ...rel.split("/"));
    let same = false;
    try { same = fs.readFileSync(ours).equals(fs.readFileSync(cached)); } catch { /* a missing cached file is a difference */ }
    if (same) console.log(`plugin: ${id} (${p.scope} scope): ${rel} in Claude Code's cache ${mine.installPath} is the copy's`);
    else problems.push(`${id} (${p.scope} scope): ${cached} (Claude Code's cache) differs from ${ours} (the copy); sessions would run the cached, older file. Refresh it by hand: ${fix}.`);
  }
  return problems;
}

// The name of the marketplace to uninstall: the one a registered plugin copy carries, else the name in HEAD's commit,
// else the working tree's.
function uninstallName(home, list) {
  for (const m of list || []) {
    if (m.source !== "directory" || !isCopyPath(m.path, home)) continue;
    try { const n = JSON.parse(fs.readFileSync(path.join(m.path, ".claude-plugin", "marketplace.json"), "utf8")).name; if (n && n === m.name) return n; } catch { /* not readable: look further */ }
  }
  if (fs.existsSync(path.join(SRC, ".git"))) {
    const c = git(["show", "HEAD:.claude-plugin/marketplace.json"], { soft: true });
    if (c.ok) try { const n = JSON.parse(c.raw).name; if (n) return n; } catch { /* fall back to the working tree */ }
  }
  return treeName();
}

// Removes dir and each parent below stop while it is empty; a folder with anything in it, and stop itself, stay.
function removeEmptyFolders(dir, stop) {
  const inside = (d) => path.resolve(d).toLowerCase().startsWith(path.resolve(stop).toLowerCase() + path.sep);
  for (let d = path.resolve(dir); inside(d); d = path.dirname(d)) {
    try { if (fs.readdirSync(d).length) return; fs.rmdirSync(d); } catch { return; }
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, all) => all.slice(0, i + 1).every(x => x.startsWith("//"))).map(l => l.replace(/^\/\/ ?/, "")).join("\n")); return; }
  const home = path.resolve(process.env.ZODCHI_HOME || path.join(os.homedir(), ".zodchi"));
  // Agents and workflows of an earlier 1.0 install were copied here; they are removed now that plugins carry them.
  const claudeDir = claudeConfigDir();
  // Where Codex reads skills: $CODEX_HOME/skills, else ~/.codex/skills.
  const codexSkillsDir = path.join(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), "skills");
  const underCodexSkills = (f) => path.resolve(f).toLowerCase().startsWith(codexSkillsDir.toLowerCase() + path.sep);
  const manifest = readManifest(home);
  // The manifest records which of its files are Codex skill files (`codexSkills`), so --no-codex-skill knows them
  // whatever $CODEX_HOME is now; a manifest without the record falls back to the current skills folder.
  const recordedSkills = new Set(Array.isArray(manifest.codexSkills) ? manifest.codexSkills : []);
  const isSkillFile = (f) => recordedSkills.has(f) || underCodexSkills(f);
  const say = (s) => console.log((o.dryRun ? "[dry-run] " : "") + s);

  if (o.uninstall) {
    // The marketplace is looked up before anything is removed: when Claude Code cannot answer, nothing has changed.
    // A marketplace that reads from one of the plugin copies would dangle once they are gone, so removing it is the
    // first change; Claude Code removes the plugins installed from it with it, zodchi-core and the domain plugins.
    // Any other install (--dev, the clone itself) keeps its marketplace: only zodchi-core is uninstalled.
    // The install lock is held from reading the registration until the copies are gone.
    let marketplaceGone = false;
    let release = () => {};
    if (o.noPlugins) MARKETPLACE = uninstallName(home, null);
    else {
      const present = claude(["--version"]).ok;
      if (!present && !o.dryRun) throw new Error("Claude Code (`claude`) is not on PATH; install it, or rerun with --no-plugins. Nothing was removed.");
      if (!o.dryRun) release = takeLock(home);
    }
    try {
      const copies = listCopies(home);
      if (!o.noPlugins) {
        const all = claude(["--version"]).ok ? marketplaces() : { list: [] };
        if (all.error) throw new Error(`could not read the marketplaces; nothing was removed.\n${all.error}`);
        MARKETPLACE = uninstallName(home, all.list);
        const found = { entry: all.list.find(m => m.name === MARKETPLACE) || null };
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
        if (!o.dryRun) removeStrays(home);
      }
    } finally { release(); }
    if (!o.dryRun && !o.noPlugins) try { fs.rmdirSync(path.join(home, "plugins")); } catch { /* not empty or not there */ }
    const kept = {};
    for (const [dest, hash] of Object.entries(manifest.files || {})) {
      // --no-codex-skill leaves the Codex skill, and the record of it, alone.
      if (o.noCodexSkill && isSkillFile(dest)) { kept[dest] = hash; continue; }
      if (!fs.existsSync(dest)) continue;
      if (sha(fs.readFileSync(dest)) !== hash && !o.force) { say(`keep (changed by you): ${dest}`); continue; }
      say(`remove ${dest}`);
      if (!o.dryRun) { fs.rmSync(dest); if (underCodexSkills(dest)) removeEmptyFolders(path.dirname(dest), codexSkillsDir); }
    }
    if (!o.dryRun) {
      const keptSkills = [...recordedSkills].filter((f) => f in kept);
      if (Object.keys(kept).length) fs.writeFileSync(path.join(home, "installed.json"), JSON.stringify({ version: manifest.version, files: kept, ...(keptSkills.length ? { codexSkills: keptSkills } : {}) }, null, 2) + "\n");
      else fs.rmSync(path.join(home, "installed.json"), { force: true });
    }
    if (!marketplaceGone) console.log(`The marketplace ${MARKETPLACE} stays registered${o.noPlugins ? " (--no-plugins)" : ""}, and so do the domain plugins you enabled; to remove them: claude plugin uninstall zodchi-<domain>@${MARKETPLACE} --scope local (in each project), then claude plugin marketplace remove ${MARKETPLACE}.`);
    return;
  }

  // The plugin copy: whether it may be made (branch, tree) is known before anything is built or written. Its commit
  // names the marketplace and the domains; the working tree does only with --dev and --no-plugins.
  const copy = copyPlan(o, home);
  MARKETPLACE = copy ? copy.name : treeName();
  const domains = chooseDomains(o.domains, copy ? copy.domains : treeDomains());
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
  if (!o.noPlugins) plugins(o, domains, say, home, copy);

  const items = plan(home, binary, o.noCodexSkill ? null : codexSkillsDir);
  const nativeDest = binary ? path.join(home, "bin", path.basename(binary)) : null;
  const FORWARDING = ["zodchi.mjs", "zodchi.cmd", "zodchi"].map(f => path.resolve(home, "bin", f));
  const owned = manifest.files || {};
  const isOwned = (dest, buf) => Object.prototype.hasOwnProperty.call(owned, dest) && owned[dest] === sha(buf);
  const next = { version: VERSION, files: { ...owned } };
  const nextSkills = new Set(recordedSkills);
  let written = 0, skipped = 0, skillSkipped = 0;
  const put = (dest, body, mode, skill) => {
    if (!o.dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      if (mode) fs.chmodSync(dest, mode);
    }
    next.files[dest] = sha(body); written++;
    if (skill) nextSkills.add(dest);
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
    if (exists && !isOwned(it.dest, current) && !o.force) { say(`skip (not installed by zodchi or changed by you): ${it.dest}`); skipped++; if (underCodexSkills(it.dest)) skillSkipped++; continue; }
    say(`${exists ? "update" : "add"} ${it.dest}`);
    put(it.dest, body, it.mode, it.skill);
  }

  // Files from an earlier install that this one no longer plans: removed when unchanged.
  const planned = new Set(items.map(it => path.resolve(it.dest)));
  const inside = (f) => [claudeDir, home, codexSkillsDir].some(d => path.resolve(f).toLowerCase().startsWith(path.resolve(d).toLowerCase() + path.sep));
  // The forwarding command goes only once the Rust gateway is really in place; a skipped binary keeps it.
  const nativeInPlace = Boolean(nativeDest) && (o.dryRun
    ? !fs.existsSync(nativeDest) || isOwned(nativeDest, fs.readFileSync(nativeDest)) || o.force
    : fs.existsSync(nativeDest) && fs.existsSync(binary) && sha(fs.readFileSync(nativeDest)) === sha(fs.readFileSync(binary)));
  if (nativeDest && !nativeInPlace) say(`the Rust gateway was not installed at ${nativeDest} (a file of yours is there); the forwarding command stays`);
  for (const [dest, hash] of Object.entries(manifest.files || {})) {
    if (planned.has(path.resolve(dest)) || dest.endsWith(".new") || !inside(dest)) continue;
    if (FORWARDING.includes(path.resolve(dest)) && !nativeInPlace) continue;
    if (o.noCodexSkill && isSkillFile(dest)) continue; // left alone, and still recorded
    if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) !== hash) { say(`keep (changed by you, no longer installed): ${dest}`); delete next.files[dest]; continue; }
    if (fs.existsSync(dest)) { say(`remove ${dest}`); if (!o.dryRun) { fs.rmSync(dest); if (underCodexSkills(dest)) removeEmptyFolders(path.dirname(dest), codexSkillsDir); } }
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
    const skillList = [...nextSkills].filter((f) => f in next.files);
    fs.writeFileSync(path.join(home, "installed.json"), JSON.stringify(skillList.length ? { ...next, codexSkills: skillList } : next, null, 2) + "\n");
  }

  const codex = spawnSync("codex --version", { encoding: "utf8", shell: true, windowsHide: true });
  console.log(`\nzodchi ${VERSION}: ${written} file(s) written, ${skipped} skipped.`);
  if (o.noPlugins) console.log("Plugins: skipped (--no-plugins).");
  else console.log(`Plugins (${copy ? `from the copy ${copy.dir}` : `--dev: from the clone ${SRC}`}): zodchi-core everywhere${domains.length ? `; ${domains.map(d => `zodchi-${d}`).join(", ")} ${o.project ? `in ${path.resolve(o.project)}` : "everywhere"}` : ""}. A domain for one project, or to update one enabled earlier in another project: rerun with --project <repo> --domains <name>.`);
  console.log(o.noCodexSkill ? "Codex skill: skipped (--no-codex-skill)." : skillSkipped ? `Codex skill zodchi-flow: ${skillSkipped} file(s) of yours are in ${codexSkillsDir}; left as they are (--force replaces them).` : `Codex skill zodchi-flow: ${path.join(codexSkillsDir, "zodchi-flow", "SKILL.md")}`);
  console.log(`Codex CLI: ${codex.status === 0 ? codex.stdout.trim() : "not found - install it and run `codex login` for gateway roles"}`);
  if (binary && nativeInPlace) console.log(`Gateway: the Rust gateway, ${path.join(home, "bin", path.basename(binary))}. Subscriptions: ~/.zodchi/accounts.json (see gateway/README.md).`);
  else if (cfg.gatewayCli) console.log(`Gateway: forwarding to ${cfg.gatewayCli}.`);
  else console.log("Gateway: not installed - install Rust (https://rustup.rs) and rerun, or pass --gateway-cli <path to a Node gateway cli.mjs>.");
  const bin = path.join(home, "bin");
  if (!(process.env.PATH || "").split(path.delimiter).some(p => path.resolve(p) === bin)) console.log(`Add ${bin} to PATH so agents can run \`zodchi\`.`);
  if (!o.noPlugins && !o.dryRun) console.log("Open Claude Code sessions keep the plugins they started with: run /reload-plugins in each, or start a new session.");
}

main().catch(e => { console.error(`zodchi install: ${e.message}`); process.exit(1); });
