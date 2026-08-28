import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const GENERATED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv", "__pycache__", "vendor", "tmp", "temp"]);

function digestFile(file) {
  const hash = crypto.createHash("sha256"), descriptor = fs.openSync(file, "r"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, windowsHide: true, maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });
}

function gitBaseline(root) {
  const top = git(root, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const trackedDiff = git(root, ["diff", "--binary", "HEAD", "--"]);
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean).sort((a, b) => a.localeCompare(b, "en"));
  const hash = crypto.createHash("sha256").update("git-visible-v1\0").update(status).update("\0diff\0").update(trackedDiff);
  for (const relative of untracked) {
    const file = path.join(root, relative), stats = fs.lstatSync(file);
    hash.update("\0untracked\0").update(relative).update("\0");
    if (stats.isSymbolicLink()) hash.update(`link:${fs.readlinkSync(file)}`);
    else if (stats.isFile()) hash.update(digestFile(file));
    else hash.update(`other:${stats.mode}`);
  }
  return Object.freeze({
    boundary: "git-visible tracked and nonignored untracked files",
    root: path.resolve(root),
    git_root: path.resolve(top),
    head: git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty_entries: status.toString("utf8").split("\0").filter(Boolean).length,
    untracked_files: untracked.length,
    fingerprint: hash.digest("hex")
  });
}

function filesystemBaseline(root, maxFiles) {
  const entries = [], visit = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (GENERATED_DIRECTORIES.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isSymbolicLink()) entries.push({ path: relative, kind: "link", value: fs.readlinkSync(absolute) });
      else if (entry.isFile()) entries.push({ path: relative, kind: "file", value: digestFile(absolute) });
      if (entries.length > maxFiles) throw new Error(`PROJECT_BASELINE_TOO_LARGE: ${root}: ${maxFiles}`);
    }
  };
  visit(root, "");
  const hash = crypto.createHash("sha256").update("filesystem-source-v1\0");
  for (const entry of entries) hash.update(entry.path).update("\0").update(entry.kind).update("\0").update(entry.value).update("\0");
  return Object.freeze({
    boundary: "filesystem excluding generated dependency and build directories",
    root: path.resolve(root),
    files: entries.length,
    fingerprint: hash.digest("hex")
  });
}

export function captureProjectBaseline(root, { maxFiles = 100_000 } = {}) {
  const resolved = path.resolve(root);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`PROJECT_BASELINE_ROOT_INVALID: ${resolved}`);
  try { return gitBaseline(resolved); }
  catch (error) {
    if (String(error?.stderr ?? error?.message ?? "").includes("dubious ownership")) throw error;
    return filesystemBaseline(resolved, maxFiles);
  }
}

export function assertProjectBaselineUnchanged(before, after, label = "project") {
  if (before.boundary !== after.boundary || before.root !== after.root || before.fingerprint !== after.fingerprint) throw new Error(`PROJECT_CHANGED_DURING_EVIDENCE: ${label}`);
  return true;
}
