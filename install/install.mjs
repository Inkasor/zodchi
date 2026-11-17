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
//      The plugins are read from a copy of this repository's plugin files, ~/.zodchi/plugins/<commit>/, not from the
//      clone, so a branch switch or a half-done edit in the clone changes nothing for other Claude sessions. The
//      installer refuses to copy from a branch other than the default one, or from a tree with tracked changes
//      (the copy would be named <commit>-dirty), unless --force. A rerun after `git pull` makes a new copy and moves
//      the marketplace to it; the last two copies are kept, older ones are removed.
//      --dev registers the clone itself as the marketplace instead (for working on zodchi: every session on this
//      machine then sees the clone's working tree as it is).
//   2. The gateway: with cargo on PATH the Rust gateway is built from gateway/ and installed as ~/.zodchi/bin/zodchi.
//      --no-build skips that; --gateway-cli instead installs a small command that forwards to a Node gateway.
//   3. models.json and the gateway roles -> ~/.zodchi (or $ZODCHI_HOME).
// A file the installer did not put there, or that you changed since, is left alone (use --force to replace it).
// ~/.zodchi/models.json is yours once installed: a newer table is written beside it as models.json.new.
// Rerun it after `git pull` to update everything. --uninstall removes what it installed, the plugin copies too: when the
// marketplace reads from a copy it is removed and the plugins go with it (zodchi-core and the domain plugins); a --dev
// marketplace (the clone) stays, and only zodchi-core is uninstalled.
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

// ---- The plugin copy: what Claude Code reads is a folder of its own, never the working clone ----

// Names of the folders the installer makes under <home>/plugins: a commit (short), or a hash of the files when the
// source is not a git checkout, with "-dirty" for a tree with tracked changes. Nothing else there is ever removed.
const COPY_NAME = /^(?:[0-9a-f]{7,40}|src-[0-9a-f]{12})(?:-dirty)?$/;
const KEEP_COPIES = 2;

// Git is asked in this clone. A failed call is never an answer: `git` (soft) lets the caller look at the exit status,
// gitMust stops the install with git's own diagnostic.
function git(args) {
  const r = spawnSync("git", args, { cwd: SRC, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 28 });
  return { ok: r.status === 0 && !r.error, status: r.status, out: (r.stdout || "").trim(), raw: r.stdout || "", err: ((r.error && r.error.message) || r.stderr || "").trim() };
}
function gitMust(args) {
  const r = git(args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed${r.status == null ? "" : ` (exit ${r.status})`}: ${r.err || "no message"}\nNothing was installed; fix the repository, or use --dev to read the clone itself.`);
  return r;
}

// The folders of the repository the plugins need: the manifest folder, core/, domains/ and every plugin source the
// manifest names (first path segment). A source that leaves the repository is refused.
function copyRoots(manifestText) {
  const roots = new Set([".claude-plugin", "core", "domains"]);
  const manifest = JSON.parse(manifestText ?? fs.readFileSync(path.join(SRC, ".claude-plugin", "marketplace.json"), "utf8"));
  for (const p of manifest.plugins || []) {
    if (typeof p.source !== "string") continue;
    const parts = path.posix.normalize(p.source.replace(/\\/g, "/")).split("/").filter(x => x && x !== ".");
    if (!parts.length || parts[0] === ".." || path.isAbsolute(p.source)) throw new Error(`plugin ${p.name}: source ${p.source} is outside this repository`);
    roots.add(parts[0]);
  }
  return [...roots].filter(r => manifestText != null || fs.existsSync(path.join(SRC, r))).sort();
}

// A folder with its own .git is a checkout: every git answer is then required, and a failure stops the install.
// Without one (a downloaded archive) the files are walked: everything under the roots except .git, node_modules, target.
function walkFiles(roots) {
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(SRC, rel), { withFileTypes: true })) {
      if ([".git", "node_modules", "target"].includes(d.name)) continue;
      const r = path.posix.join(rel, d.name);
      if (d.isDirectory()) walk(r);
      else if (d.isFile()) out.push(r);
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

// The files of a commit under the roots: [{ file, mode, sha }]. Symlinks and submodules cannot be copied faithfully.
function treeOf(commit, roots) {
  const entries = gitMust(["ls-tree", "-r", "-z", commit, "--", ...roots]).raw.split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    const [mode, type, sha] = line.slice(0, tab).split(" ");
    return { file: line.slice(tab + 1), mode, type, sha };
  });
  const odd = entries.filter(e => e.type !== "blob" || e.mode === "120000");
  if (odd.length) throw new Error(`the plugin files include a symlink or submodule, which the copy cannot hold: ${odd.map(e => e.file).join(", ")}`);
  return entries.sort((a, b) => (a.file < b.file ? -1 : 1));
}

// The bytes of those blobs, from the object database in one call: `<sha> blob <size>\n<bytes>\n` for each.
function readBlobs(shas) {
  const unique = [...new Set(shas)];
  const r = spawnSync("git", ["cat-file", "--batch"], { cwd: SRC, input: unique.join("\n") + "\n", windowsHide: true, maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) throw new Error(`git cat-file failed: ${(r.error && r.error.message) || String(r.stderr || "").trim()}`);
  const buf = r.stdout, blobs = new Map();
  let at = 0;
  for (const sha of unique) {
    const nl = buf.indexOf(10, at);
    const head = nl < 0 ? [] : buf.subarray(at, nl).toString("latin1").split(" ");
    if (head[0] !== sha || head[1] !== "blob") throw new Error(`git cat-file: no blob ${sha}`);
    const size = Number(head[2]);
    blobs.set(sha, buf.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return blobs;
}

// What the plugin copy would be, and whether it may be made. Nothing is written. null for --dev and --no-plugins.
// A clean checkout is copied from the objects of the recorded commit, never from the working tree, so an edit made
// while the installer runs (the gateway build takes a while) cannot get into a copy named for a clean commit. Only a
// forced copy of a tree with tracked changes reads the working tree (the tracked files, as they are now).
function copyPlan(o, home) {
  if (o.dev || o.noPlugins) return null;
  const plan = { dirty: false, forced: [] };
  if (fs.existsSync(path.join(SRC, ".git"))) {
    if (!samePath(gitMust(["rev-parse", "--show-toplevel"]).out, SRC)) throw new Error(`${SRC} has a .git but is not the top of its repository; nothing was installed. Use --dev to read the clone itself.`);
    const head = git(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    if (!head.ok) throw new Error(`This repository has no readable commit yet; commit first, or use --dev to work from the clone.${head.err ? `\n${head.err}` : ""}`);
    const commit = head.out;
    const short = gitMust(["rev-parse", "--short=12", commit]).out;
    // Exit 1 of symbolic-ref -q is a detached HEAD; any other failure is an error.
    const sym = git(["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!sym.ok && sym.status !== 1) gitMust(["symbolic-ref", "--short", "-q", "HEAD"]);
    const branch = sym.out;
    // origin/HEAD names the default branch of the remote; without it main, then master.
    let main = git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).out.replace(/^origin\//, "");
    if (!main) main = ["main", "master"].find(b => git(["rev-parse", "--verify", "-q", "refs/heads/" + b]).ok) || "main";
    plan.dirty = gitMust(["status", "--porcelain", "--untracked-files=no"]).out !== "";
    const why = [];
    if (!branch) why.push("HEAD is detached, so the copy would be of a state that no branch holds");
    else if (branch !== main) why.push(`the branch is "${branch}", not the default "${main}"`);
    if (plan.dirty) why.push("tracked files have uncommitted changes");
    if (why.length && !o.force) {
      const refusal = (`will not copy plugins from this clone: ${why.join("; ")}. Every Claude Code session on this machine would run what is in the copy, unreviewed. ` +
        `Switch to "${main}" with a clean tree and rerun, or use --force to copy it anyway${plan.dirty ? " (named <commit>-dirty)" : ""}, or --dev to read the clone itself.`);
      // A dry run still shows the rest of the plan, with the refusal said up front; a real run stops here.
      if (!o.dryRun) throw new Error(refusal);
      plan.refusal = refusal;
    }
    plan.forced = why;
    plan.name = short + (plan.dirty ? "-dirty" : "");
    if (plan.dirty) {
      const roots = copyRoots();
      plan.files = gitMust(["ls-files", "-z", "--cached", "--", ...roots]).raw.split("\0").filter(Boolean).filter(f => fs.existsSync(path.join(SRC, f))).sort();
    } else {
      // The roots come from the manifest of that commit too; a root that the commit does not hold has no files.
      plan.tree = treeOf(commit, copyRoots(gitMust(["show", `${commit}:.claude-plugin/marketplace.json`]).raw));
      plan.files = plan.tree.map(e => e.file);
    }
  } else {
    plan.files = walkFiles(copyRoots());
    const h = crypto.createHash("sha256");
    for (const f of plan.files) h.update(f + "\0").update(fs.readFileSync(path.join(SRC, f)));
    plan.name = "src-" + h.digest("hex").slice(0, 12);
  }
  plan.dir = path.join(home, "plugins", plan.name);
  return plan;
}

// Makes the copy: into a folder of its own that is renamed into place, so an interrupted run leaves no half copy.
// A copy of a clean commit that is already there is reused. A -dirty one (or a broken one) is made again, but the
// folder that is there stays, renamed aside, until finishCopy says the marketplace reads the new one: a failed run
// puts it back (undoCopy), because the registered marketplace may be reading it.
function makeCopy(plan) {
  const { dir } = plan;
  const now = new Date();
  if (!plan.dirty && fs.existsSync(path.join(dir, ".claude-plugin", "marketplace.json"))) {
    fs.utimesSync(dir, now, now);
    return { dir, reused: true };
  }
  const base = path.dirname(dir);
  const tmp = path.join(base, `.tmp-${plan.name}-${process.pid}`);
  const aside = path.join(base, `.old-${plan.name}-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const blobs = plan.tree ? readBlobs(plan.tree.map(e => e.sha)) : null;
    for (const [i, f] of plan.files.entries()) {
      const to = path.join(tmp, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (blobs) {
        fs.writeFileSync(to, blobs.get(plan.tree[i].sha));
        fs.chmodSync(to, plan.tree[i].mode === "100755" ? 0o755 : 0o644);
      } else {
        const from = path.join(SRC, f);
        fs.copyFileSync(from, to);
        fs.chmodSync(to, fs.statSync(from).mode & 0o777);
      }
    }
    fs.rmSync(aside, { recursive: true, force: true });
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  let hadOld = false;
  if (fs.existsSync(dir)) {
    try { fs.renameSync(dir, aside); hadOld = true; }
    catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`could not replace ${dir} (${e.code || e.message}); it is probably in use. Nothing was changed.`); }
  }
  try { fs.renameSync(tmp, dir); }
  catch (e) {
    if (hadOld) fs.renameSync(aside, dir);
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  fs.utimesSync(dir, now, now);
  return { dir, reused: false, aside: hadOld ? aside : null };
}
// The marketplace reads the new copy: the folder that was set aside is not needed any more.
function finishCopy(made) {
  if (made && made.aside) try { fs.rmSync(made.aside, { recursive: true, force: true }); } catch { /* its name is never a copy's, so a leftover bothers nobody */ }
}
// The run failed before the marketplace moved: the folder that was there before is put back.
function undoCopy(made) {
  if (!made || made.reused) return;
  fs.rmSync(made.dir, { recursive: true, force: true });
  if (made.aside) fs.renameSync(made.aside, made.dir);
}

function listCopies(home) {
  const base = path.join(home, "plugins");
  let names = [];
  try { names = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && COPY_NAME.test(d.name)).map(d => d.name); } catch { /* none */ }
  return names.map(n => ({ name: n, dir: path.join(base, n), time: fs.statSync(path.join(base, n)).mtimeMs }))
    .sort((a, b) => b.time - a.time || (a.name < b.name ? 1 : -1));
}

const isCopyPath = (p, home) => Boolean(p) && samePath(path.dirname(p), path.join(home, "plugins")) && COPY_NAME.test(path.basename(p));

function removeCopy(c, say, dryRun = false) {
  say(`remove plugin copy ${c.dir}`);
  if (dryRun) return;
  try { fs.rmSync(c.dir, { recursive: true, force: true }); } catch (e) { console.log(`could not remove ${c.dir} (${e.code || e.message}); it is probably in use, the next run tries again`); }
}

// The newest two copies stay, and the one the marketplace pointed at before this run (a session may still use it);
// the rest go. Only folders with a copy's name are looked at.
function pruneCopies(home, keep, say) {
  const all = listCopies(home);
  const key = (p) => path.resolve(p).toLowerCase();
  const kept = new Set(all.slice(0, KEEP_COPIES).map(c => key(c.dir)));
  for (const k of keep) if (k) kept.add(key(k));
  for (const c of all) if (!kept.has(key(c.dir))) removeCopy(c, say);
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
    if (!copy.dirty && fs.existsSync(path.join(copy.dir, ".claude-plugin", "marketplace.json"))) say(`the plugin copy ${copy.dir} is already there; it is reused`);
    else say(`copy ${copy.files.length} plugin file(s) from ${SRC} to ${copy.dir}`);
  } else say(`--dev: the clone ${SRC} is the marketplace; every Claude session on this machine reads its working tree as it is`);
  const steps = [];
  let previous = null;
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
    if (change.action === "move" && isCopyPath(change.from, home)) previous = change.from;
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
  // The copy is made before the first step; when the marketplace step fails, the folder that was there is put back.
  const made = copy ? makeCopy(copy) : null;
  for (const [i, s] of steps.entries()) {
    const r = s.run();
    if (r.missing) throw new Error("Claude Code (`claude`) is not on PATH; install it, or rerun with --no-plugins.");
    if (!r.ok) {
      if (i === 0) undoCopy(made);
      throw new Error(`plugin step failed: ${s.what}\n${r.out}`);
    }
    if (i === 0) finishCopy(made);
    console.log(`plugin: ${s.what} - ok`);
  }
  if (copy) pruneCopies(home, [copy.dir, previous], say);
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
    if (o.noPlugins && copies.length) console.log(`Plugin copies kept in ${path.join(home, "plugins")} (--no-plugins leaves Claude Code's plugins alone).`);
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
