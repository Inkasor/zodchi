#!/usr/bin/env node
// The gate facts of the zodchi workflows, from commands and files, not from a runner's retelling.
//
//   node gate.mjs <command> '<spec json>'
//
//   code-package   the gate of code-package: role table, account, Git state, dirty list, ignore rule, verify skill,
//                  REVIEW.md, owner config, the brief's Review boundary, the claims of the repository (and the stale ones
//                  of other packages closed, see below)
//   branch-review  the gate of branch-review: role table, account, head, merge base, changed files, dirty flag
//   ledger         the gate of asset-round: the state of an asset ledger
//   roles          the gate of incident-triage: the role table, the account, whether the repository ignores .agent-tmp/
//   plugin         nothing but the plugin copy this script runs from (incident-triage, ops-script, method-question, rubric-probe,
//                  unity-check name the copy that ran in their result)
//   claim          the claim step of code-package: compares the package's files with the other open claims and writes its claim
//   claim-more     the claim extensions of code-package: compares the files the work changed with the other open claims and adds them
//                  (both under the claims lock, see "The claim commands" below)
//
// It prints ONE line of compact JSON to stdout and nothing else. The workflow reads that line and decides; the exit
// code is 0 when the line is the answer, 2 for a bad call (no spec, a spec that is not JSON, a field missing), 3 when the
// workflow speaks another `api` than this script (the plugin copy it was found in is older or newer than the workflow).
// A command that cannot be run (no Git work tree, no zodchi) is a field in the line, never a reason to hide the rest.
//
// The workflow finds this file in the plugin copy the session loaded (never in a checkout) with the bootstrap it carries
// (see docs/parallel.md, "Which copy ran"); `plugin` in the answer names that copy.
//
// Claims. A package's claim is the file <label>.json in ~/.zodchi/packages/<repo key>/. Only a file of exactly that name,
// whose "label" field is its own name, is a claim: x.json.bak-1, x.bak.json and every other stray file are not read, and
// nothing here ever writes a backup into that folder. The gate closes an open claim of ANOTHER label when all of these hold:
//   0. the claim is not marked "awaiting": a package that stopped until a person decides (an unknown gateway outcome, an
//      infrastructure failure) says so in its claim, and that claim stays open however old it is;
//   1. none of its files has an uncommitted change;
//   2. the package has commits (a commit after its recorded base that touches its files) and every one is on the default
//      branch (refs/remotes/origin/HEAD, else main or master);
//   3. nothing was written to the claim file or to the package's tmp folder (claim.tmp) for staleHours (default 3,
//      ~/.zodchi/config.json "claimStaleHours"): a package between two rounds has clean files and committed work too,
//      and must not be closed under its own feet.
// The dirty list must be known: when `git status` fails, the answer has dirty null and a dirtyError, and no claim is closed.
// The answer says which claims were closed and why, and which open ones were kept and why not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const API = 1;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.now();

// Written synchronously, so process.exit never cuts the line off.
const print = (obj, code = 0) => {
  const buf = Buffer.from(JSON.stringify(obj) + "\n");
  for (let at = 0; at < buf.length;) {
    try { at += fs.writeSync(1, buf, at); } catch (e) { if (e.code !== "EAGAIN") throw e; }
  }
  process.exit(code);
};
const norm = (p) => String(p).replace(/\\/g, "/");
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const readJson = (f) => {
  const text = readText(f);
  if (text === null) return { missing: true };
  try { return { value: JSON.parse(text.replace(/^﻿/, "")) }; } catch (e) { return { error: `not JSON: ${e.message}` }; }
};

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) return { code: 127, out: "", err: String(r.error.message) };
  return { code: r.status ?? 1, out: r.stdout || "", err: (r.stderr || "").trim() };
}

// Every path `git status --porcelain -z -uall` lists; a rename gives both paths. null when Git could not say (the caller must
// report that, never read it as a clean work tree). Returns { paths, error }: paths is null exactly when error is set.
function dirtyList(repo) {
  const r = git(repo, ["status", "--porcelain", "-z", "-uall"]);
  if (r.code !== 0) return { paths: null, error: `git status exited ${r.code}: ${r.err.slice(0, 300)}` };
  const parts = r.out.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && i + 1 < parts.length) paths.push(parts[++i]);
  }
  return { paths, error: "" };
}

function models(repo, want) {
  const home = path.join(os.homedir(), ".zodchi", "models.json");
  const own = repo ? path.join(repo, ".zodchi", "models.json") : "";
  const errors = [];
  const roles = {};
  for (const [name, f] of [["~/.zodchi/models.json", home], [".zodchi/models.json", own]]) {
    if (!f) continue;
    const r = readJson(f);
    if (r.error) errors.push(`${name}: ${r.error}`);
    else if (r.value && r.value.roles) Object.assign(roles, r.value.roles);
  }
  const picked = {};
  for (const w of want) if (roles[w]) picked[w] = roles[w];
  return { roles: picked, errors };
}

function accountFacts() {
  const exe = process.platform === "win32" ? "zodchi.exe" : "zodchi";
  const tries = [exe, path.join(os.homedir(), ".zodchi", "bin", exe)];
  let last = "zodchi was not found";
  for (const program of tries) {
    const r = spawnSync(program, ["account"], { encoding: "utf8", timeout: 90000, windowsHide: true });
    if (r.error) { last = String(r.error.message).slice(0, 300); continue; }
    if (r.status !== 0) { last = `zodchi account exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`; break; }
    try {
      const a = JSON.parse(r.stdout);
      const w = (x) => (x && typeof x.usedPercent === "number" ? { usedPercent: x.usedPercent } : null);
      return { account: { connected: a.connected === true, ordinaryUsageAllowed: a.ordinaryUsageAllowed, primary: w(a.primary), secondary: w(a.secondary) }, accountError: "" };
    } catch (e) { last = `zodchi account printed no JSON: ${e.message}`; break; }
  }
  return { account: null, accountError: last };
}

// The text of the section of the brief that starts at the heading line beginning with "## Review boundary" (any case),
// up to the next line that begins with "## " or the end of the file; "" when there is no such heading.
function boundaryOf(briefFile) {
  const text = readText(briefFile);
  if (text === null) return "";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## review boundary/i.test(l));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith("## ")) { end = i; break; }
  return lines.slice(start + 1, end).join("\n");
}

// The plugin copy this script runs from: its folder, and the commit it was made from when that is known.
function pluginCopy() {
  const root = path.resolve(HERE, "..");
  const copy = { root: norm(root), commit: "", version: "", via: process.env.ZODCHI_GATE_VIA || "" };
  const manifest = readJson(path.join(root, ".claude-plugin", "plugin.json"));
  if (manifest.value) { copy.version = String(manifest.value.version || ""); copy.name = String(manifest.value.name || ""); }
  // A copy the installer made lies in ~/.zodchi/plugins/<commit hash>/core.
  const parent = path.basename(path.dirname(root));
  if (/^[0-9a-f]{40}$/.test(parent)) copy.commit = parent;
  // A copy Claude Code cached: its registration records the commit.
  if (!copy.commit) {
    const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const reg = readJson(path.join(cfg, "plugins", "installed_plugins.json"));
    const list = reg.value && reg.value.plugins ? reg.value.plugins["zodchi-core@zodchi"] || [] : [];
    const mine = list.find((e) => e.installPath && norm(e.installPath).toLowerCase() === norm(root).toLowerCase());
    if (mine && mine.gitCommitSha) copy.commit = String(mine.gitCommitSha);
  }
  // A clone used as the marketplace (--dev): ask Git.
  if (!copy.commit) {
    const h = git(root, ["rev-parse", "HEAD"]);
    if (h.code === 0 && /^[0-9a-f]{40}$/.test(h.out.trim())) copy.commit = h.out.trim() + " (a clone: the working tree as it is)";
  }
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------
// Claims

const CLAIM_NAME = /^[\w.-]+\.json$/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The open claims of this repository: only <label>.json whose "label" is the file's own name. A label may begin with a dot, so a name
// beginning with one is a claim like any other (the lock folder .lock and other dot files match no claim name and are passed over).
function readClaims(dir) {
  const claims = [];
  const skipped = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { claims, skipped, exists: false }; }
  for (const name of names.sort()) {
    if (name.startsWith(".") && !CLAIM_NAME.test(name)) continue;
    if (!CLAIM_NAME.test(name)) { skipped.push(name); continue; }
    const r = readJson(path.join(dir, name));
    const label = name.slice(0, -5);
    if (!r.value || typeof r.value !== "object" || r.value.label !== label) { skipped.push(name); continue; }
    claims.push({ name, label, claim: r.value });
  }
  return { claims, skipped, exists: true };
}

function newestWrite(file, tmpDir) {
  let newest = 0;
  try { newest = fs.statSync(file).mtimeMs; } catch {}
  if (!tmpDir) return newest;
  const stack = [tmpDir];
  let seen = 0;
  while (stack.length && seen < 5000) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      const p = path.join(d, e.name);
      try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch {}
      if (e.isDirectory()) stack.push(p);
    }
  }
  return newest;
}

function defaultBranch(repo) {
  const head = git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.out.trim()) return head.out.trim();
  for (const b of ["refs/heads/main", "refs/heads/master"]) if (git(repo, ["rev-parse", "--verify", "--quiet", b]).code === 0) return b;
  return "";
}

// Why this open claim of another package may not be closed, or "" when it may be.
function whyKept(repo, entry, dirtyKeys, defBranch, staleMs) {
  const c = entry.claim;
  // A package that stopped on purpose until a person decides (an unknown gateway outcome, an infrastructure failure to fix) marks its
  // claim "awaiting"; its files are clean and committed work may be on the default branch, yet it is not finished: never closed here.
  if (c.awaiting) return `it awaits a decision (${String(c.awaiting).slice(0, 200)}): a person closes it`;
  const files = Array.isArray(c.files) ? c.files.map((f) => String(f)) : [];
  if (!files.length) return "it lists no files";
  const dirty = files.filter((f) => dirtyKeys.has(f.toLowerCase()));
  if (dirty.length) return `uncommitted changes in its files: ${dirty.slice(0, 5).join(", ")}`;
  if (!defBranch) return "the repository has no default branch to compare with";
  const base = String(c.base || "").trim();
  if (!/^[0-9a-f]{7,64}$/i.test(base) || git(repo, ["cat-file", "-e", `${base}^{commit}`]).code !== 0) return "its base commit is not in the repository";
  const own = git(repo, ["rev-list", "--all", "--not", base, "--", ...files]);
  if (own.code !== 0) return "its commits could not be listed";
  if (!own.out.trim()) return "it has no commit after its base: nothing shows that its work was finished";
  const off = git(repo, ["rev-list", "--all", "--not", base, defBranch, "--", ...files]);
  if (off.code !== 0) return "its commits could not be compared with the default branch";
  if (off.out.trim()) return `commits not on ${defBranch.replace(/^refs\/(remotes|heads)\//, "")}`;
  const idle = NOW - newestWrite(path.join(entry.dir, entry.name), c.tmp && fs.existsSync(String(c.tmp)) ? String(c.tmp) : "");
  if (idle < staleMs) return `written to ${Math.max(1, Math.round(idle / 60000))} minute(s) ago: it may be running`;
  return "";
}

// The claims lock: the folder <dir>/.lock (mkdir is atomic). Tried every 500 ms for waitMs; a lock older than staleMs is removed
// (the gate's stale-claim cleanup), and with staleMs null it is never removed: the claim commands report it busy instead. The lock is
// removed after fn whatever fn did.
function withLock(dir, fn, { waitMs = 120000, staleMs = 600000 } = {}) {
  const lock = path.join(dir, ".lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") return { locked: false, busy: false, why: `lock: ${e.message}` };
      if (staleMs !== null) try { if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > deadline) return { locked: false, busy: true, why: `lock busy (${norm(lock)})` };
      sleep(500);
    }
  }
  try { return { locked: true, value: fn() }; } finally { try { fs.rmdirSync(lock); } catch {} }
}

function claimFacts(spec, repo, dirtyKeys) {
  const dir = path.join(claimsHome(), ".zodchi", "packages", String(spec.claimsKey || ""));
  const answer = { dir: norm(dir), open: [], closed: [], kept: [], skipped: [], notes: [] };
  if (!spec.claimsKey) { answer.notes.push("no claims key given"); return answer; }
  const first = readClaims(dir);
  answer.skipped = first.skipped;
  const cfg = readJson(path.join(os.homedir(), ".zodchi", "config.json")).value || {};
  const staleHours = Number(spec.staleHours ?? cfg.claimStaleHours ?? 3);
  const staleMs = (Number.isFinite(staleHours) && staleHours >= 0 ? staleHours : 3) * 3600000;
  const defBranch = defaultBranch(repo);
  const others = first.claims.filter((e) => e.claim.status === "open" && e.label !== spec.label).map((e) => ({ ...e, dir }));
  const stale = [];
  // Without a dirty list nothing is known about anybody's files: no claim is closed, and the answer says so.
  if (!dirtyKeys && others.length) answer.notes.push("open claims were not examined for closing: the dirty list of the repository is unknown");
  for (const e of dirtyKeys ? others : []) {
    const why = whyKept(repo, e, dirtyKeys, defBranch, staleMs);
    if (why) answer.kept.push(`${e.label}: ${why}`); else stale.push(e);
  }
  if (stale.length) {
    const done = withLock(dir, () => {
      const closed = [];
      for (const e of stale) {
        // Read it again under the lock: it may have changed since, and only an open claim is touched.
        const file = path.join(dir, e.name);
        const r = readJson(file);
        if (!r.value || r.value.status !== "open" || r.value.label !== e.label) continue;
        const reason = `its files have no uncommitted changes, its commits are all on ${defBranch.replace(/^refs\/(remotes|heads)\//, "")}, and nothing was written to it for ${staleHours} hour(s)`;
        const next = { ...r.value, status: "closed", closedAt: new Date(NOW).toISOString().replace(/\.\d+Z$/, "Z"), closedBy: `the gate of ${spec.label}`, closedReason: reason };
        // Written beside it under a name that is no claim, then moved into place: no backup is left in the folder.
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(next) + "\n");
        fs.renameSync(tmp, file);
        closed.push({ label: e.label, reason });
      }
      return closed;
    });
    if (done.locked) answer.closed = done.value;
    else answer.notes.push(`stale claims were not closed: ${done.why}`);
  }
  const closedLabels = new Set(answer.closed.map((c) => c.label));
  answer.open = first.claims
    .filter((e) => e.claim.status === "open" && !closedLabels.has(e.label))
    .map((e) => ({ label: e.label, branch: e.claim.branch || "", files: Array.isArray(e.claim.files) ? e.claim.files.length : 0 }));
  return answer;
}

// The claim commands. Lists of paths are compared here, never by a model: a path is keyed as the workflow keys it (slashes forward, lower
// case, relative to the repository; "." segments and repeated slashes dropped, a ".." segment taking the one before it, so stored claims are
// keyed the same way). Both commands run under the claims lock, never break it (a lock still held after lockWaitSec, default 120, at most
// 600, is reported as the conflict "lock busy"), and write a claim file atomically: the new text goes to
// <file>.tmp-<pid>, which is no claim, and is renamed over the claim.
const pathKey = (f) => {
  const s = norm(f);
  const lead = /^[A-Za-z]:\//.test(s) ? s.slice(0, 3) : s.startsWith("/") ? "/" : "";
  const parts = [];
  for (const seg of s.slice(lead.length).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop(); else parts.push(seg);
  }
  return (lead + parts.join("/")).toLowerCase();
};
const keysOf = (list) => [...new Set((Array.isArray(list) ? list : []).map(pathKey).filter(Boolean))];
const underHome = (spec, home) => {
  const d = norm(spec.dir);
  return path.resolve(/^(~|\$HOME)(\/|$)/.test(d) ? path.join(home, d.replace(/^(~|\$HOME)\/?/, "")) : d);
};
// The claims folder is the one the shell's $HOME names, as every version of the workflow named it for its runners (they read, write and lock
// claims there), so that one folder and one lock serve all versions; on Windows the Git Bash form /c/... is read with its drive letter. Without HOME it
// is Node's home folder.
function claimsHome() {
  if (!process.env.HOME) return os.homedir();
  const home = norm(process.env.HOME);
  return process.platform === "win32" ? home.replace(/^\/([A-Za-z])(\/|$)/, (_, l) => `${l.toUpperCase()}:/`) : home;
}
const claimsDirOf = (spec) => underHome(spec, claimsHome());
// The claims folder under Node's home folder, which a build of this helper used for a while: on Windows Node reads USERPROFILE, and Git Bash
// may set HOME elsewhere. "" when it is the claims folder itself or the spec names no home-relative folder. Open claims there are read too
// (see claimCmd and claimMoreCmd), so that none written there is lost; they are moved or closed by a person.
const legacyDirOf = (spec) => {
  if (!/^(~|\$HOME)(\/|$)/.test(norm(spec.dir))) return "";
  const legacy = underHome(spec, os.homedir());
  const now = claimsDirOf(spec);
  return (process.platform === "linux" ? legacy === now : legacy.toLowerCase() === now.toLowerCase()) ? "" : legacy;
};
const lockWait = (spec) => {
  const s = Number(spec.lockWaitSec ?? 120);
  return (Number.isFinite(s) ? Math.min(Math.max(s, 0), 600) : 120) * 1000;
};
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
function writeClaim(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n");
  fs.renameSync(tmp, file);
}
// The open claims of other labels, each with its files keyed.
const othersOpen = (dir, label) => readClaims(dir).claims
  .filter((e) => e.claim.status === "open" && e.label !== label)
  .map((e) => ({ label: e.label, branch: typeof e.claim.branch === "string" ? e.claim.branch : "", files: keysOf(e.claim.files) }));
function needFields(spec, strings, lists) {
  for (const k of strings) if (typeof spec[k] !== "string" || (["dir", "label"].includes(k) && !spec[k])) print({ ok: false, api: API, error: `spec.${k} is missing or not a string` }, 2);
  for (const k of lists) if (!Array.isArray(spec[k])) print({ ok: false, api: API, error: `spec.${k} is missing or not a list` }, 2);
  if (!/^[\w.-]+$/.test(spec.label)) print({ ok: false, api: API, error: "spec.label may hold letters, digits, \".\", \"_\" and \"-\" only" }, 2);
}

// claim: { dir, label, files, branch, brief, tmp, base }. An open claim of another label that lists one of files is a conflict
// "<label>: <file>"; an open claim of another label whose "branch" is set and differs is a branch conflict "<label>: <branch>". Without
// either, <dir>/<label>.json is written: { label, status "open", files, branch, brief, tmp, base, openedAt }. An open claim of the same
// label (a resumed package) is kept as it is, with files it lacks added and its branch set to the requested one (checked against the
// others above; branchWas names the one it had); it is no conflict. Open claims in the folder under Node's home folder, when that is another
// folder (legacyDirOf), stop the claim (legacyDir, legacyClaims "<label>: <n> file(s)"): they must be closed or moved first.
function claimCmd(spec) {
  needFields(spec, ["dir", "label", "branch", "brief", "tmp", "base"], ["files"]);
  const dir = claimsDirOf(spec);
  const files = keysOf(spec.files);
  const file = path.join(dir, `${spec.label}.json`);
  const base = { ok: false, api: API, plugin: pluginCopy(), conflicts: [], branchConflicts: [], file: norm(file), reused: false, files: [] };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ...base, error: `the claims folder: ${e.message}` }; }
  const legacyDir = legacyDirOf(spec);
  const done = withLock(dir, () => {
    const legacy = legacyDir ? readClaims(legacyDir).claims.filter((e) => e.claim.status === "open") : [];
    if (legacy.length) {
      return { ...base, legacyDir: norm(legacyDir), legacyClaims: legacy.map((e) => `${e.label}: ${Array.isArray(e.claim.files) ? e.claim.files.length : 0} file(s)`),
        error: `open claims lie in ${norm(legacyDir)}, under Node's home folder, which is not the folder of the shell's $HOME the claims are kept in` };
    }
    const mine = new Set(files);
    const conflicts = [], branchConflicts = [];
    for (const o of othersOpen(dir, spec.label)) {
      for (const f of o.files) if (mine.has(f)) conflicts.push(`${o.label}: ${f}`);
      if (o.branch && o.branch !== spec.branch) branchConflicts.push(`${o.label}: ${o.branch}`);
    }
    if (conflicts.length || branchConflicts.length) return { ...base, conflicts, branchConflicts };
    const own = readJson(file).value;
    if (own && typeof own === "object" && own.label === spec.label && own.status === "open") {
      const have = Array.isArray(own.files) ? own.files.map(String) : [];
      const haveKeys = new Set(have.map(pathKey));
      const add = files.filter((f) => !haveKeys.has(f));
      const moved = own.branch !== spec.branch;
      if (add.length || moved) writeClaim(file, { ...own, files: [...have, ...add], branch: spec.branch });
      return { ...base, ok: true, reused: true, files: [...have, ...add], ...(moved ? { branchWas: typeof own.branch === "string" ? own.branch : "" } : {}) };
    }
    writeClaim(file, { label: spec.label, status: "open", files, branch: spec.branch, brief: spec.brief, tmp: spec.tmp, base: spec.base, openedAt: stamp() });
    return { ...base, ok: true, files };
  }, { waitMs: lockWait(spec), staleMs: null });
  if (done.locked) return done.value;
  return { ...base, conflicts: done.busy ? ["lock busy"] : [], error: done.why };
}

// claim-more: { dir, label, hard, soft }. Every hard file (the writer reported it) that another open claim lists is a conflict
// "<label>: <file>"; every soft file (only Git shows it changed) that another open claim lists is that package's work and goes to others.
// Without conflicts, every hard file and every soft file not in others that this label's open claim lacks is added to it (added).
// The open claims of other labels in the folder under Node's home folder (legacyDirOf) count as other claims here too.
function claimMoreCmd(spec) {
  needFields(spec, ["dir", "label"], ["hard", "soft"]);
  const dir = claimsDirOf(spec);
  const hard = keysOf(spec.hard), soft = keysOf(spec.soft);
  const file = path.join(dir, `${spec.label}.json`);
  const base = { ok: false, api: API, plugin: pluginCopy(), conflicts: [], others: [], added: [], file: norm(file) };
  const done = withLock(dir, () => {
    const owner = new Map();
    const legacyDir = legacyDirOf(spec);
    for (const o of [...othersOpen(dir, spec.label), ...(legacyDir ? othersOpen(legacyDir, spec.label) : [])]) for (const f of o.files) if (!owner.has(f)) owner.set(f, o.label);
    const conflicts = hard.filter((f) => owner.has(f)).map((f) => `${owner.get(f)}: ${f}`);
    const others = soft.filter((f) => owner.has(f));
    if (conflicts.length) return { ...base, conflicts, others };
    const own = readJson(file).value;
    if (!own || typeof own !== "object" || own.label !== spec.label || own.status !== "open") return { ...base, others, error: `${spec.label} has no open claim at ${norm(file)}` };
    const have = Array.isArray(own.files) ? own.files.map(String) : [];
    const haveKeys = new Set(have.map(pathKey));
    const added = [...new Set([...hard, ...soft.filter((f) => !others.includes(f))])].filter((f) => !haveKeys.has(f));
    if (added.length) writeClaim(file, { ...own, files: [...have, ...added] });
    return { ...base, ok: true, others, added };
  }, { waitMs: lockWait(spec), staleMs: null });
  if (done.locked) return done.value;
  return { ...base, conflicts: done.busy ? ["lock busy"] : [], error: done.why };
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

function codePackage(spec) {
  for (const k of ["repo", "brief", "label", "claimsKey"]) if (!spec[k]) print({ ok: false, api: API, error: `spec.${k} is missing` }, 2);
  const repo = String(spec.repo);
  const want = Array.isArray(spec.want) ? spec.want.map(String) : [];
  const m = models(repo, want);
  const acc = accountFacts();
  const inside = git(repo, ["rev-parse", "--is-inside-work-tree"]).out.trim() === "true";
  const head = inside ? git(repo, ["rev-parse", "HEAD"]) : { code: 1, out: "" };
  const branch = inside ? git(repo, ["branch", "--show-current"]).out.trim() : "";
  // Outside a work tree there is nothing to list; inside one, a failed `git status` is no list at all (dirty null, dirtyError says
  // why), never a clean tree: the workflow stops on it and no claim is closed from it.
  const status = inside ? dirtyList(repo) : { paths: [], error: "" };
  const dirty = status.paths;
  const ignore = git(repo, ["check-ignore", "-v", ".agent-tmp/gateway/x"]);
  const exists = (p) => inside && git(repo, ["cat-file", "-e", `HEAD:${p}`]).code === 0;
  const cfgFile = path.join(os.homedir(), ".zodchi", "config.json");
  const cfg = readJson(cfgFile);
  const dirtyKeys = inside && dirty ? new Set(dirty.map((f) => norm(f).toLowerCase())) : null;
  return {
    ok: true, api: API, plugin: pluginCopy(),
    roles: m.roles, modelsErrors: m.errors, account: acc.account, accountError: acc.accountError,
    git: inside, head: head.code === 0 ? head.out.trim() : "", branch, dirty, dirtyError: status.error,
    ignoreExit: ignore.code, ignoreLine: ignore.out.trim(),
    verifySkill: exists(".claude/skills/verify/SKILL.md"), reviewMd: exists("REVIEW.md"),
    config: cfg.value && typeof cfg.value === "object" ? cfg.value : {}, configError: cfg.error || "",
    boundary: boundaryOf(String(spec.brief)),
    claims: claimFacts(spec, repo, dirtyKeys),
  };
}

function branchReview(spec) {
  for (const k of ["repo", "base"]) if (!spec[k]) print({ ok: false, api: API, error: `spec.${k} is missing` }, 2);
  const repo = String(spec.repo);
  const m = models(repo, Array.isArray(spec.want) ? spec.want.map(String) : []);
  const acc = accountFacts();
  const head = git(repo, ["rev-parse", "HEAD"]);
  const mb = git(repo, ["merge-base", String(spec.base), "HEAD"]);
  const baseSha = mb.code === 0 ? mb.out.trim() : "";
  let files = [];
  if (head.code === 0 && baseSha) {
    const d = git(repo, ["diff", "--name-only", "-z", baseSha, head.out.trim()]);
    files = d.out.split("\0").filter(Boolean);
  }
  const dirty = dirtyList(repo).paths;
  return {
    ok: true, api: API, plugin: pluginCopy(),
    roles: m.roles, modelsErrors: m.errors, account: acc.account, accountError: acc.accountError,
    head: head.code === 0 ? head.out.trim() : "", baseSha, baseError: mb.code === 0 ? "" : mb.err.slice(0, 300), files,
    dirty: Boolean(dirty && dirty.length),
  };
}

// The asset ledger: wherever the gate says "method", stage 2 reads "lookMethod".
function ledger(spec) {
  if (!spec.file) print({ ok: false, api: API, error: "spec.file is missing" }, 2);
  const r = readJson(String(spec.file));
  if (!r.value) return { ok: false, api: API, plugin: pluginCopy(), error: r.missing ? `the ledger ${spec.file} does not exist` : `the ledger ${spec.file} is ${r.error}` };
  const l = r.value;
  const method = Number(spec.stage) === 2 ? l.lookMethod : l.method;
  const rounds = Array.isArray(l.rounds) ? l.rounds : [];
  const last = rounds[rounds.length - 1];
  const accepted = String(spec.accepted || "accepted");
  const owner = (x) => (typeof x.owner === "string" ? x.owner.trim() : "");
  const hasMethod = Boolean(method && (typeof method === "string" ? method.trim() : Object.keys(method).length));
  const after = method && typeof method === "object" && typeof method.afterRound === "number" ? method.afterRound : null;
  // The rounds played under the selected method: one list for the count and for the acceptance, so a round accepted under an
  // earlier method (a blockout) never counts for the look method that follows it.
  const since = rounds.filter((x) => after === null || (typeof x.n === "number" && x.n > after));
  return {
    ok: true, api: API, plugin: pluginCopy(),
    hasMethod, lastRound: last && typeof last.n === "number" ? last.n : 0, lastVerdict: last ? owner(last) : "",
    roundsSinceMethod: since.length,
    accepted: since.some((x) => owner(x).startsWith(accepted)),
    startedAt: new Date(NOW).toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

// Only which plugin copy this is: for the workflows that need no other fact and still name the copy that ran.
const plugin = () => ({ ok: true, api: API, plugin: pluginCopy() });

// The classifier gate of incident-triage: the role table, the account and whether the repository ignores .agent-tmp/ (repo is optional).
function roles(spec) {
  const repo = spec.repo ? String(spec.repo) : "";
  const m = models(repo, Array.isArray(spec.want) ? spec.want.map(String) : []);
  const acc = accountFacts();
  const ignore = repo ? git(repo, ["check-ignore", "-q", ".agent-tmp/gateway/x"]).code : null;
  return { ok: true, api: API, plugin: pluginCopy(), roles: m.roles, modelsErrors: m.errors, account: acc.account, accountError: acc.accountError, ignoreExit: ignore };
}

const COMMANDS = { "code-package": codePackage, "branch-review": branchReview, ledger, plugin, roles, claim: claimCmd, "claim-more": claimMoreCmd };
const [command, specText] = process.argv.slice(2);
if (!COMMANDS[command]) print({ ok: false, api: API, error: `unknown command ${JSON.stringify(command)}; one of ${Object.keys(COMMANDS).join(", ")}` }, 2);
let spec;
try { spec = JSON.parse(specText); } catch (e) { print({ ok: false, api: API, error: `the spec is not JSON: ${e.message}` }, 2); }
if (!spec || typeof spec !== "object") print({ ok: false, api: API, error: "the spec is not an object" }, 2);
if (spec.api !== API) print({ ok: false, api: API, plugin: pluginCopy(), error: `the workflow speaks api ${spec.api} and this script ${API}: the plugin copy at ${norm(path.resolve(HERE, ".."))} does not match the workflow that was loaded; reinstall the plugin` }, 3);
try { print(COMMANDS[command](spec)); } catch (e) { print({ ok: false, api: API, error: String((e && e.message) || e).slice(0, 500) }, 2); }
