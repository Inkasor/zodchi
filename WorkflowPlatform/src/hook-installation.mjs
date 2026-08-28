import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workflowPlatformRoot } from "./paths.mjs";

// The hook configuration is a shared file. Other tools write to it, `rulesync` and its kin generate it
// from a source of their own, and a person edits it by hand. Installing by overwriting the file, which is
// what an agent following prose instructions does, silently removes whatever else was there: the project
// keeps working, and the tool that lost its hook simply stops running with nothing to say why.
//
// So the installer owns exactly one entry and proves it owns it. Ownership is recorded beside the hook
// configuration rather than inside it, because neither harness promises to accept an unknown key in a
// hook object, and a marker that breaks the file it marks is worse than no marker. The record holds what
// was written and the hash of the file it was written into, which is what separates "still ours" from
// "someone has changed this since".

const OWNER = "zodchi";
const EVENT = "UserPromptSubmit";
const HOOK_SCRIPT = path.join("hooks", "user-prompt-submit.mjs");
const PLACEHOLDER = "__WORKFLOW_PLATFORM_ROOT__";

export const HOOK_TARGETS = Object.freeze({
  codex: Object.freeze({ directory: ".codex", file: "hooks.json", template: "codex-hooks.template.json" }),
  "claude-code": Object.freeze({ directory: ".claude", file: "settings.local.json", template: "claude-settings-local.template.json" })
});

export const INSTALLATION_MODES = Object.freeze(["write", "merge", "proxy"]);

const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function target(harness) {
  const found = HOOK_TARGETS[harness];
  if (!found) throw new Error(`HOOK_HARNESS_UNKNOWN: ${harness}`);
  return found;
}

// A hook belongs to Zodchi when it runs Zodchi's own entry script. That is a fact about the command, not
// a claim in a file, so it survives the record being deleted and cannot be asserted by anything else.
function samePath(left, right) {
  try {
    const a = path.resolve(left), b = path.resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}

function commandTokens(command) {
  if (typeof command !== "string") return [];
  return [...command.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
}

function isOurs(hook, script) {
  const tokens = [
    ...commandTokens(hook?.command),
    ...commandTokens(hook?.commandWindows),
    ...(Array.isArray(hook?.args) ? hook.args.filter(item => typeof item === "string") : [])
  ];
  return tokens.some(token => samePath(token, script));
}

function ourEntry(entries, script, recordedEntry = null) {
  return entries.findIndex(entry => (recordedEntry && JSON.stringify(entry) === JSON.stringify(recordedEntry)) || (entry?.hooks ?? []).some(hook => isOurs(hook, script)));
}

function applyRoot(value, root, deliveryMode) {
  // The root is substituted through the serialized form so a Windows path is escaped once, by JSON itself,
  // rather than by hand in every field that happens to hold one.
  const replaced = JSON.parse(JSON.stringify(value).replaceAll(PLACEHOLDER, JSON.stringify(root).slice(1, -1)));
  for (const hook of replaced.hooks?.[EVENT]?.flatMap(entry => entry.hooks ?? []) ?? []) {
    if (!deliveryMode) continue;
    const flag = `--delivery-mode=${deliveryMode}`;
    if (Array.isArray(hook.args)) hook.args.push(flag);
    else if (typeof hook.command === "string") hook.command = `${hook.command} ${flag}`;
    if (typeof hook.commandWindows === "string") hook.commandWindows = `${hook.commandWindows} ${flag}`;
  }
  return replaced;
}

function ownershipFile(projectRoot, harness) {
  return path.join(projectRoot, target(harness).directory, ".zodchi-hook.json");
}

function fileSnapshot(file) {
  return fs.existsSync(file) ? Object.freeze({ exists: true, content: fs.readFileSync(file), hash: hash(fs.readFileSync(file)) }) : Object.freeze({ exists: false, content: null, hash: null });
}

function restoreFile(file, snapshot) {
  if (!snapshot.exists) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.rollback`);
  try { fs.writeFileSync(temporary, snapshot.content, { mode: 0o600 }); fs.renameSync(temporary, file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

// Installation swaps program files and then rewrites every hook that points at that program. These two
// mutations are one transaction: a failed health check must restore both the release and the exact bytes
// of every project file. The snapshot deliberately contains no project content beyond the two owned hook
// files, and restoration can be guarded by the hashes observed immediately after our own write.
export function snapshotHookInstallation({ projectRoot, harness }) {
  const spec = target(harness);
  const file = path.join(projectRoot, spec.directory, spec.file);
  const marker = ownershipFile(projectRoot, harness);
  return Object.freeze({ projectRoot: path.resolve(projectRoot), harness, file, marker, hook: fileSnapshot(file), ownership: fileSnapshot(marker) });
}

export function restoreHookInstallation(snapshot, expectedCurrent = null) {
  for (const [file, expected] of [[snapshot.file, expectedCurrent?.hook_hash], [snapshot.marker, expectedCurrent?.ownership_hash]]) {
    if (expected === undefined || expected === null) continue;
    const actual = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
    if (actual !== expected) throw new Error(`HOOK_ROLLBACK_CONFLICT: ${file}`);
  }
  restoreFile(snapshot.file, snapshot.hook);
  restoreFile(snapshot.marker, snapshot.ownership);
  return Object.freeze({ status: "restored", harness: snapshot.harness, file: snapshot.file, ownershipFile: snapshot.marker });
}

export function hookSnapshotHashes(snapshot) {
  return Object.freeze({
    hook_hash: fs.existsSync(snapshot.file) ? hash(fs.readFileSync(snapshot.file)) : null,
    ownership_hash: fs.existsSync(snapshot.marker) ? hash(fs.readFileSync(snapshot.marker)) : null
  });
}

// A file some other tool generates is not a file to write into: the next generation run silently removes
// whatever was added, and the hook stops firing without anyone touching it. Proxy mode is the honest
// answer there — the entry is handed over for the source of truth instead of written into the output.
function generatedElsewhere(projectRoot, existing) {
  const reasons = [];
  if (fs.existsSync(path.join(projectRoot, ".rulesync"))) reasons.push("rulesync generates this file from .rulesync");
  if (existing && typeof existing === "object" && (existing.generatedBy || existing.generated_by)) reasons.push(`the file states it is generated by ${existing.generatedBy ?? existing.generated_by}`);
  return reasons;
}

export function planHookInstallation({ projectRoot, harness, root = workflowPlatformRoot, deliveryMode = null, configsRoot = path.join(path.dirname(root), "configs"), mode = null }) {
  if (!projectRoot || !fs.existsSync(projectRoot)) throw new Error(`HOOK_PROJECT_REQUIRED: ${projectRoot ?? "projectRoot"}`);
  if (mode && !INSTALLATION_MODES.includes(mode)) throw new Error(`HOOK_MODE_UNKNOWN: ${mode}`);
  const spec = target(harness);
  const file = path.join(projectRoot, spec.directory, spec.file);
  const script = path.join(root, HOOK_SCRIPT);
  const templateFile = path.join(configsRoot, spec.template);
  if (!fs.existsSync(templateFile)) throw new Error(`HOOK_TEMPLATE_MISSING: ${templateFile}`);
  const desired = applyRoot(JSON.parse(fs.readFileSync(templateFile, "utf8")), root, deliveryMode);
  const entry = desired.hooks[EVENT][0];

  const existing = readJson(file);
  const record = readJson(ownershipFile(projectRoot, harness));
  const entries = existing?.hooks?.[EVENT] ?? [];
  const ours = ourEntry(entries, script, record?.entry ?? null);
  const foreign = entries.filter((_, index) => index !== ours).length;

  const generated = generatedElsewhere(projectRoot, existing);
  const conflicts = [];
  if (generated.length) for (const reason of generated) conflicts.push({ kind: "generated_file", reason });
  if (foreign) conflicts.push({ kind: "foreign_hooks", reason: `${foreign} ${EVENT} ${foreign === 1 ? "entry belongs" : "entries belong"} to something else`, count: foreign });
  // Two different situations, and confusing them is how someone else's configuration gets overwritten: a
  // file Zodchi never wrote, and a file Zodchi wrote that has been changed since.
  if (existing && !record) conflicts.push({ kind: "unowned_file", reason: "the file exists and Zodchi did not write it" });
  else if (existing && record.file_hash !== hash(fs.readFileSync(file, "utf8"))) conflicts.push({ kind: "edited_since_install", reason: "the file has changed since Zodchi last wrote it" });

  // Merging is the safe default whenever anything else is present: our entry is added or replaced and
  // nothing else in the file is touched. A generated file is the one case merging cannot fix, because the
  // merge itself is what gets thrown away.
  const resolved = mode ?? (generated.length ? "proxy" : conflicts.length ? "merge" : "write");
  const current = ours >= 0 && JSON.stringify(entries[ours]) === JSON.stringify(entry);
  return Object.freeze({
    harness, file, script, mode: resolved,
    status: resolved === "proxy" ? "proxy" : current && !conflicts.some(item => item.kind === "generated_file") ? "current" : ours >= 0 ? "update" : "install",
    conflicts: Object.freeze(conflicts),
    entry,
    document: desired,
    ownershipFile: ownershipFile(projectRoot, harness),
    projectRoot
  });
}

export function applyHookInstallation(plan) {
  if (plan.mode === "proxy") {
    // Nothing is written. The caller is told what to add and where, because the file that actually decides
    // the hook is one Zodchi does not own.
    return Object.freeze({ status: "proxy", harness: plan.harness, file: plan.file, entry: plan.entry, event: EVENT, reasons: plan.conflicts.map(item => item.reason) });
  }
  const existing = readJson(plan.file);
  // An absent file is written from the template, which carries the description and the other fields the
  // harness expects. An existing file keeps everything it already has: only the one entry Zodchi owns is
  // added or replaced, and every other key, every other event and every foreign entry survives untouched.
  let document;
  if (!existing) document = plan.document;
  else {
    const entries = [...(existing.hooks?.[EVENT] ?? [])];
    const record = readJson(plan.ownershipFile);
    const ours = ourEntry(entries, plan.script, record?.entry ?? null);
    if (ours >= 0) entries[ours] = plan.entry;
    else entries.push(plan.entry);
    document = { ...existing, hooks: { ...(existing.hooks ?? {}), [EVENT]: entries } };
  }
  atomicJson(plan.file, document);
  const record = {
    owner: OWNER,
    harness: plan.harness,
    event: EVENT,
    installation_root: path.dirname(plan.script),
    entry: plan.entry,
    file: plan.file,
    file_hash: hash(fs.readFileSync(plan.file, "utf8")),
    installed_at: new Date().toISOString()
  };
  atomicJson(plan.ownershipFile, record);
  return Object.freeze({ status: plan.status === "current" ? "current" : plan.status, harness: plan.harness, file: plan.file, mode: plan.mode, conflicts: plan.conflicts, ownershipFile: plan.ownershipFile });
}

export function hookInstallationStatus({ projectRoot, harness }) {
  const spec = target(harness);
  const file = path.join(projectRoot, spec.directory, spec.file);
  const record = readJson(ownershipFile(projectRoot, harness));
  if (!fs.existsSync(file)) return Object.freeze({ harness, file, installed: false, owned: false, changed: Boolean(record) });
  const owned = Boolean(record?.owner === OWNER);
  return Object.freeze({
    harness, file, installed: true, owned,
    changed: owned ? record.file_hash !== hash(fs.readFileSync(file, "utf8")) : false,
    installation_root: record?.installation_root ?? null
  });
}

export function removeOwnedHookInstallation({ projectRoot, harness }) {
  const spec = target(harness);
  const file = path.join(projectRoot, spec.directory, spec.file);
  const marker = ownershipFile(projectRoot, harness);
  const record = readJson(marker);
  if (record?.owner !== OWNER) return Object.freeze({ status: "not_owned", harness, file });
  const existing = readJson(file);
  if (existing) {
    const entries = [...(existing.hooks?.[EVENT] ?? [])];
    const script = path.join(record.installation_root ?? "", HOOK_SCRIPT);
    const ours = ourEntry(entries, script, record.entry ?? null);
    if (ours >= 0) entries.splice(ours, 1);
    atomicJson(file, { ...existing, hooks: { ...(existing.hooks ?? {}), [EVENT]: entries } });
  }
  fs.rmSync(marker, { force: true });
  return Object.freeze({ status: "removed", harness, file, preserved_foreign_entries: existing?.hooks?.[EVENT]?.length ? Math.max(0, existing.hooks[EVENT].length - 1) : 0 });
}
