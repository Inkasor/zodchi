import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OWNER = "zodchi";
const EVENTS = Object.freeze(["UserPromptSubmit", "SessionEnd"]);
const markerFor = file => path.join(path.dirname(file), ".zodchi-session-hooks.json");

export function defaultSessionHookFiles(home = os.homedir()) {
  const root = path.resolve(home);
  return Object.freeze({ codex: path.join(root, ".codex", "hooks.json"), "claude-code": path.join(root, ".claude", "settings.json") });
}

function readJson(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); fs.renameSync(temporary, file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}
function samePath(left, right) {
  if (!left || !right) return false;
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function tokens(command) { return typeof command === "string" ? [...command.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g)].map(match => match[1] ?? match[2] ?? match[3]) : []; }
function entryUses(entry, script) { return (entry?.hooks ?? []).some(hook => tokens(hook.command).some(token => samePath(token, script)) || (hook.args ?? []).some(token => samePath(token, script))); }
function entry(applicationRoot, client, event) {
  const script = path.join(path.resolve(applicationRoot), "WorkflowPlatform", "hooks", "session-router.mjs");
  const parameters = [script, "--client", client, "--delivery-mode", "final"];
  const hook = client === "claude-code"
    ? { type: "command", command: "node", args: parameters, timeout: 3600, statusMessage: event === "SessionEnd" ? "Zodchi is closing the session" : "Zodchi is processing the request" }
    : { type: "command", command: `node "${script}" --client ${client} --delivery-mode final`, commandWindows: `node "${script}" --client ${client} --delivery-mode final`, timeout: 3600, statusMessage: event === "SessionEnd" ? "Zodchi is closing the session" : "Zodchi is processing the request" };
  return { hooks: [hook] };
}
function snapshotFile(file) { return fs.existsSync(file) ? { exists: true, content: fs.readFileSync(file) } : { exists: false, content: null }; }
function restoreFile(file, snapshot) { if (!snapshot.exists) fs.rmSync(file, { force: true }); else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, snapshot.content); } }

export function snapshotSessionHooks({ files = defaultSessionHookFiles() } = {}) {
  return Object.freeze(Object.entries(files).map(([client, file]) => ({ client, file: path.resolve(file), marker: markerFor(path.resolve(file)), config: snapshotFile(path.resolve(file)), ownership: snapshotFile(markerFor(path.resolve(file))) })));
}
export function restoreSessionHooks(snapshots) { for (const item of snapshots) { restoreFile(item.file, item.config); restoreFile(item.marker, item.ownership); } }

export function installSessionHooks({ applicationRoot, files = defaultSessionHookFiles() }) {
  const application = path.resolve(applicationRoot), script = path.join(application, "WorkflowPlatform", "hooks", "session-router.mjs");
  if (!fs.existsSync(script)) throw new Error(`SESSION_HOOK_SCRIPT_MISSING: ${script}`);
  const results = [];
  for (const [client, rawFile] of Object.entries(files)) {
    if (!new Set(["codex", "claude-code"]).has(client)) throw new Error(`SESSION_HOOK_CLIENT_INVALID: ${client}`);
    const file = path.resolve(rawFile), marker = markerFor(file), ownership = readJson(marker);
    if (ownership?.owner === OWNER && !samePath(ownership.application_root, application)) throw new Error(`SESSION_HOOK_OWNED_BY_OTHER_INSTALLATION: ${file}: ${ownership.application_root}`);
    const document = readJson(file) ?? {};
    const hooks = { ...(document.hooks ?? {}) }, recorded = ownership?.entries ?? {};
    for (const event of EVENTS) {
      const entries = [...(hooks[event] ?? [])];
      const indices = entries.map((item, index) => (JSON.stringify(item) === JSON.stringify(recorded[event]) || entryUses(item, script)) ? index : -1).filter(index => index >= 0);
      if (indices.length > 1) throw new Error(`SESSION_HOOK_DUPLICATE_OWNED_ENTRY: ${client}:${event}`);
      const desired = entry(application, client, event);
      if (indices.length === 1) entries[indices[0]] = desired; else entries.push(desired);
      hooks[event] = entries;
    }
    const next = { ...document, hooks };
    atomicJson(file, next);
    atomicJson(marker, { owner: OWNER, schema_version: 1, client, application_root: application, entries: Object.fromEntries(EVENTS.map(event => [event, entry(application, client, event)])), installed_at: new Date().toISOString() });
    results.push({ status: ownership ? "updated" : "installed", client, file });
  }
  return Object.freeze(results);
}

export function removeSessionHooks({ applicationRoot, files = defaultSessionHookFiles() }) {
  const application = path.resolve(applicationRoot);
  return Object.freeze(Object.entries(files).map(([client, rawFile]) => {
    const file = path.resolve(rawFile), marker = markerFor(file), ownership = readJson(marker);
    if (ownership?.owner !== OWNER) return { status: "not_owned", client, file };
    if (!samePath(ownership.application_root, application)) return { status: "different_installation", client, file, application_root: ownership.application_root ?? null };
    const document = readJson(file) ?? {}, hooks = { ...(document.hooks ?? {}) };
    for (const event of EVENTS) hooks[event] = [...(hooks[event] ?? [])].filter(item => JSON.stringify(item) !== JSON.stringify(ownership.entries?.[event]));
    atomicJson(file, { ...document, hooks }); fs.rmSync(marker, { force: true });
    return { status: "removed", client, file };
  }));
}
