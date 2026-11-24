import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
export const lineSha = (obj) => createHash("sha256").update(JSON.stringify(obj), "utf8").digest("hex");

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = value => typeof value === "string";
const nonblank = value => isText(value) && value.trim().length > 0;
const ownerWords = value => nonblank(value) && [...value].length <= 2000;
const videoId = value => isText(value) && /^[a-z0-9][a-z0-9._-]{0,47}$/u.test(value);
const itemId = value => isText(value) && /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(value);
const renderId = value => isText(value) && /^r[1-9]\d*$/u.test(value);
const digest = value => isText(value) && /^[a-f0-9]{64}$/u.test(value);
const positive = value => Number.isFinite(value) && value > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const byteCount = value => Number.isInteger(value) && value > 0;
const boolean = value => typeof value === "boolean";
const nullable = predicate => value => value === null || predicate(value);
const formats = ["short", "long"];
const statuses = ["draft", "accepted", "published"];
const purposes = ["probe", "build"];
const states = ["allocated", "built", "failed"];
const events = ["init", "render-new", "render-done", "accepted", "published"];
const videoExt = ["mp4", "mov", "mkv", "webm"];
const probeExt = [...videoExt, "wav", "mp3", "png", "jpg"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function isoTime(value) {
  if (!isText(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const time = Date.parse(value);
  const normalized = value.includes(".") ? value : value.slice(0, -1) + ".000Z";
  return Number.isFinite(time) && new Date(time).toISOString() === normalized;
}

const proposed = { title: isText, description: isText, prompt: isText, voiceText: isText };
const lists = {
  sources: { id: itemId, kind: ["screen", "voice", "music", "image", "other"], path: nonblank, sha256: nullable(digest), note: isText },
  segments: { id: itemId, source: itemId, in: nonnegative, out: nonnegative, speed: positive, speedMarked: boolean,
    reason: isText, evidence: isText, model: isText, effort: isText },
  audio: { id: itemId, role: ["voice", "music", "effect"], origin: ["recorded", "synthetic", "licensed", "own"],
    source: nullable(itemId), license: isText, attribution: isText, licenseChecked: boolean },
  costs: { id: itemId, label: isText, scope: ["in-frame", "production"], basis: ["api-equivalent", "subscription-estimate", "measured"],
    amount: nonnegative, currency: ["RUB", "USD"], rubPerUsd: nullable(positive), note: isText },
  claims: { id: itemId, text: isText, kind: ["reported", "confirmed"], segment: nullable(itemId), confirmation: isText, note: isText },
};
const editorial = { proposed: isObject, ...Object.fromEntries(Object.keys(lists).map(key => [key, Array.isArray])) };
const manifestFields = { version: [1], id: videoId, format: formats, status: statuses, ...editorial,
  deliveryLimitBytes: byteCount, renders: Array.isArray, chosen: nullable(renderId), publication: nullable(isObject), history: Array.isArray };
const renderFields = { id: renderId, path: isText, purpose: purposes, state: states, createdAt: isoTime,
  doneAt: nullable(isoTime), bytes: nullable(byteCount), sha256: nullable(digest), note: isText, edit: isObject, editSha256: digest };

function editOf(manifest) {
  return Object.fromEntries(Object.keys(editorial).map(key => [key, manifest[key]]));
}

function validPath(render) {
  const extensions = render.purpose === "build" ? videoExt : probeExt;
  return renderId(render.id) && extensions.some(ext => render.path === `renders/${render.id}/${render.id}.${ext}`);
}

function shape(value, where, fields, errors) {
  if (!isObject(value)) {
    issue(errors, where, "expected an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) issue(errors, where + "." + key, "unknown field");
  }
  for (const [key, rule] of Object.entries(fields)) {
    const valid = Array.isArray(rule) ? rule.includes(value[key]) : rule(value[key]);
    if (!valid) issue(errors, where + "." + key, "missing or invalid value");
  }
  return true;
}

function issue(list, where, message) {
  if (list.length < 50) list.push(where + ": " + message);
}

// Index each list in its own record. A frozen cut must refer to a frozen source.
function rows(record, key, prefix, fields, errors, visit) {
  const indexed = new Map();
  if (!Array.isArray(record[key])) return indexed;
  for (const [i, row] of record[key].entries()) {
    const at = `${prefix}.${key}[${i}]`;
    if (!shape(row, at, fields, errors)) continue;
    if (indexed.has(row.id)) issue(errors, at + ".id", "duplicate id");
    if (isText(row.id)) indexed.set(row.id, row);
    visit(row, at);
  }
  return indexed;
}

function checkEdit(record, prefix, errors, draft) {
  shape(record.proposed, prefix + ".proposed", proposed, errors);
  const sources = rows(record, "sources", prefix, lists.sources, errors, (row, at) => {
    if (draft && nonblank(row.path) && !fs.existsSync(path.resolve(draft.dir, row.path))) {
      issue(draft.warnings, at + ".path", "source path missing");
    }
  });
  const segments = rows(record, "segments", prefix, lists.segments, errors, (row, at) => {
    if (!sources.has(row.source)) issue(errors, at + ".source", "unknown source");
    if (Number.isFinite(row.in) && Number.isFinite(row.out) && row.in >= row.out) issue(errors, at + ".out", "must follow in");
    if (!draft) return;
    if (row.speed !== 1 && row.speedMarked === false) issue(draft.notReady, at + ".speedMarked", "label the speed change");
    if (!nonblank(row.reason)) issue(draft.notReady, at + ".reason", "explain the cut");
    if (!nonblank(row.evidence)) issue(draft.warnings, at + ".evidence", "describe what is visible");
  });
  if (draft && Array.isArray(record.segments) && !record.segments.length) issue(draft.notReady, prefix + ".segments", "no segments");
  rows(record, "audio", prefix, lists.audio, errors, (row, at) => {
    if (row.source !== null && !sources.has(row.source)) issue(errors, at + ".source", "unknown source");
    if (!draft) return;
    if (row.role === "music") {
      for (const field of ["license", "attribution"]) {
        if (!nonblank(row[field])) issue(draft.notReady, at + "." + field, "required for music");
      }
    }
    if (row.role === "voice" && row.origin === "synthetic" && !row.licenseChecked) {
      issue(draft.warnings, at + ".licenseChecked", "synthetic voice licence unchecked");
    }
  });
  rows(record, "costs", prefix, lists.costs, errors, () => {});
  rows(record, "claims", prefix, lists.claims, errors, (row, at) => {
    if (row.segment !== null && !segments.has(row.segment)) issue(errors, at + ".segment", "unknown segment");
    if ((row.kind === "confirmed" && !nonblank(row.confirmation)) || (row.kind === "reported" && row.confirmation !== "")) {
      issue(errors, at + ".confirmation", "must give evidence exactly for confirmed claims");
    }
    if (draft && row.kind === "reported") issue(draft.warnings, at + ".kind", "claim is reported");
  });
}

function checkHistory(manifest, renders, errors) {
  if (!Array.isArray(manifest.history)) return;
  const fields = { at: isoTime, event: events, render: nullable(renderId), by: ["helper", "owner"], words: nullable(isText) };
  const allocated = new Set(), finished = new Set(), milestones = new Set();
  for (const [i, entry] of manifest.history.entries()) {
    const at = `manifest.history[${i}]`;
    if (!shape(entry, at, fields, errors)) continue;
    const { event, render, by, words } = entry;
    const owner = event === "accepted" || event === "published";
    if (by !== (owner ? "owner" : "helper")) issue(errors, at + ".by", "wrong author for event");
    if (owner ? !ownerWords(words) : words !== null) issue(errors, at + ".words", "wrong words for event");
    if (event !== "init" && !renders.has(render)) issue(errors, at + ".render", "unknown render");
    if (event === "render-new" || event === "render-done") {
      const seen = event === "render-new" ? allocated : finished;
      if (seen.has(render)) issue(errors, at, "duplicate render event");
      if (event === "render-done" && !allocated.has(render)) issue(errors, at, "must follow render-new");
      seen.add(render);
    } else {
      if (milestones.has(event)) issue(errors, at, "duplicate event");
      if (event === "init" && (i !== 0 || render !== null)) issue(errors, at, "init must be first and have no render");
      if (owner && (render !== manifest.chosen || !finished.has(render))) issue(errors, at + ".render", "expected the finished chosen render");
      if (event === "published" && !milestones.has("accepted")) issue(errors, at, "publication must follow acceptance");
      milestones.add(event);
    }
  }
  for (const [id, render] of renders) {
    if (!allocated.has(id)) issue(errors, "manifest.history", "missing allocation of " + id);
    if (finished.has(id) !== (render.state !== "allocated")) issue(errors, "manifest.history", "completion differs from state of " + id);
  }
  for (const [event, required] of [["init", true], ["accepted", ["accepted", "published"].includes(manifest.status)],
    ["published", manifest.status === "published"]]) {
    if (milestones.has(event) !== required) issue(errors, "manifest.history", "unexpected count of " + event);
  }
}

function inspect(manifest, paths, verifyFiles, recoverMediaErrors) {
  const errors = [], notReady = [], warnings = [];
  const summary = { status: null, chosen: null, renders: [], errors, notReady, warnings };
  if (!shape(manifest, "manifest", manifestFields, errors)) return summary;
  checkEdit(manifest, "manifest", errors, { dir: paths.dir, notReady, warnings });
  const renders = rows(manifest, "renders", "manifest", renderFields, errors, (render, at) => {
    const { id, state, purpose } = render;
    if (isText(id)) summary.renders.push({ id, state: state ?? null, purpose: purpose ?? null, path: render.path ?? null });
    const canonical = validPath(render);
    if (!canonical) issue(errors, at + ".path", "expected the allocated render path and extension");
    if (shape(render.edit, at + ".edit", editorial, errors)) {
      checkEdit(render.edit, at + ".edit", errors);
      if (lineSha(editOf(render.edit)) !== render.editSha256) issue(errors, at + ".editSha256", "frozen record digest differs");
    }
    if ((state === "allocated") !== (render.doneAt === null)) issue(errors, at + ".doneAt", "does not match state");
    for (const key of ["bytes", "sha256"]) {
      if ((state === "built") === (render[key] === null)) issue(errors, at + "." + key, "does not match state");
    }
    if (verifyFiles && state === "built" && canonical) {
      try { verifyMedia(paths, render); }
      catch (error) {
        if (error instanceof Refusal) {
          issue(notReady, at + ".path", error.message);
        } else if (recoverMediaErrors && error instanceof Error && typeof error.code === "string" && error.code.length > 0 &&
          ["lstat", "stat", "realpath", "readlink", "open", "read", "close"].includes(error.syscall)) {
          issue(notReady, at + ".path", "media file could not be verified");
        } else throw error;
      }
    }
  });
  if (statuses.includes(manifest.status)) summary.status = manifest.status;
  if (manifest.status === "accepted" || manifest.status === "published") {
    const chosen = renders.get(manifest.chosen);
    if (renderId(manifest.chosen) && chosen?.purpose === "build" && chosen.state === "built") summary.chosen = manifest.chosen;
    else issue(errors, "manifest.chosen", "expected a built build render");
  } else if (manifest.chosen !== null) issue(errors, "manifest.chosen", "expected null in draft");
  if (manifest.status === "published") shape(manifest.publication, "manifest.publication", { id: nonblank, snapshotAt: isoTime }, errors);
  else if (manifest.publication !== null) issue(errors, "manifest.publication", "only a published video has a publication");
  checkHistory(manifest, renders, errors);
  for (const entry of paths.entries) {
    if (renderId(entry.name) && entry.isDirectory() && !renders.has(entry.name)) issue(warnings, "renders/" + entry.name, "orphan directory");
  }
  return summary;
}

class Refusal extends Error {}

function requireRule(condition, message) {
  if (!condition) throw new Refusal(message);
}

// Check each component from an already checked parent. When a leaf is absent,
// its parent is the nearest existing ancestor (or was checked the same way).
function owned(dir, file, type) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return false;
  requireRule(!stat.isSymbolicLink(), file + ": links are not allowed");
  const relative = path.relative(dir, fs.realpathSync(file));
  requireRule(relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative), file + ": outside video directory");
  requireRule(type === "directory" ? stat.isDirectory() : stat.isFile(), file + ": expected a " + type);
  return true;
}

function videoPaths(spec, writing) {
  requireRule(path.isAbsolute(spec.dir) && !spec.dir.includes("\0") && !spec.dir.split(/[\\/]/u).includes(".."),
    "dir: expected an absolute directory without ..");
  requireRule(fs.lstatSync(spec.dir, { throwIfNoEntry: false })?.isDirectory(), "dir: expected an existing real directory");
  const dir = fs.realpathSync(spec.dir);
  const manifest = path.join(dir, "manifest.json");
  const temp = manifest + ".tmp-" + process.pid;
  const renders = path.join(dir, "renders");
  const hasManifest = owned(dir, manifest, "file");
  if (writing) requireRule(!owned(dir, temp, "file"), "temporary manifest already exists");
  const hasRenders = owned(dir, renders, "directory");
  const entries = hasRenders ? fs.readdirSync(renders, { withFileTypes: true }) : [];
  return { dir, manifest, temp, renders, hasManifest, hasRenders, entries };
}

function readMedia(paths, render) {
  const folder = path.join(paths.renders, render.id);
  const file = path.join(paths.dir, render.path);
  requireRule(owned(paths.dir, folder, "directory") && owned(paths.dir, file, "file"), render.path + ": missing media file");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, "r");
  let bytes = 0;
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      hash.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  requireRule(bytes > 0, render.path + ": empty media file");
  return { bytes, sha256: hash.digest("hex") };
}

function verifyMedia(paths, render) {
  const actual = readMedia(paths, render);
  requireRule(actual.bytes === render.bytes && actual.sha256 === render.sha256, render.path + ": size or digest differs from recorded file");
}

function save(paths, manifest, madeFolder) {
  let ownsTemp = false;
  try {
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    const hash = sha(bytes);
    const fd = fs.openSync(paths.temp, "wx");
    ownsTemp = true;
    try {
      requireRule(process.env.ZODCHI_VIDEO_FAIL !== "write", "simulated manifest write failure");
      fs.writeFileSync(fd, bytes);
    } finally { fs.closeSync(fd); }
    requireRule(process.env.ZODCHI_VIDEO_FAIL !== "rename", "simulated manifest rename failure");
    fs.renameSync(paths.temp, paths.manifest);
    return hash;
  } catch (error) {
    if (ownsTemp) fs.unlinkSync(paths.temp);
    if (madeFolder) {
      try { fs.rmdirSync(madeFolder); }
      catch (cleanup) { if (cleanup.code !== "ENOTEMPTY") throw cleanup; }
    }
    throw error;
  }
}

function history(event, render = null, words = null) {
  return { at: new Date().toISOString(), event, render, by: words === null ? "helper" : "owner", words };
}

function init(spec, paths) {
  requireRule(!paths.hasManifest, "manifest.json already exists");
  requireRule(videoId(spec.id), "id: invalid video id");
  requireRule(formats.includes(spec.format), "format: expected short or long");
  const manifest = { version: 1, id: spec.id, format: spec.format, status: "draft",
    proposed: { title: spec.title ?? "", description: "", prompt: "", voiceText: "" }, deliveryLimitBytes: 20971520,
    sources: [], segments: [], audio: [], costs: [], claims: [], renders: [], chosen: null, publication: null, history: [history("init")] };
  if (!paths.hasRenders) fs.mkdirSync(paths.renders);
  return { ok: true, manifest: "manifest.json", manifestSha256: save(paths, manifest, !paths.hasRenders && paths.renders) };
}

function allocate(spec, paths, manifest) {
  requireRule(purposes.includes(spec.purpose), "purpose: expected probe or build");
  requireRule((spec.purpose === "build" ? videoExt : probeExt).includes(spec.ext), "ext: unsupported extension for this purpose");
  requireRule(paths.hasRenders, "renders: missing directory");
  let highest = 0n;
  for (const id of [...manifest.renders.map(render => render.id), ...paths.entries.map(entry => entry.name)]) {
    if (renderId(id)) {
      const number = BigInt(id.slice(1));
      if (number > highest) highest = number;
    }
  }
  const edit = editOf(manifest);
  const editSha256 = lineSha(edit);
  let id, folder;
  for (;;) {
    id = "r" + (++highest);
    folder = path.join(paths.renders, id);
    if (fs.lstatSync(folder, { throwIfNoEntry: false })) continue;
    try { fs.mkdirSync(folder); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const relative = `renders/${id}/${id}.${spec.ext}`;
  const event = history("render-new", id);
  manifest.renders.push({ id, path: relative, purpose: spec.purpose, state: "allocated", createdAt: event.at, doneAt: null,
    bytes: null, sha256: null, note: "", edit, editSha256 });
  manifest.history.push(event);
  save(paths, manifest, folder);
  return { ok: true, render: id, path: relative, absolutePath: path.join(paths.dir, relative), editSha256 };
}

function complete(spec, paths, manifest) {
  const render = manifest.renders.find(row => row.id === spec.render);
  requireRule(render, "render: unknown render");
  requireRule(render.state === "allocated", "a recorded render is final; allocate another with video-render-new");
  const event = history("render-done", render.id);
  const state = spec.ok ? "built" : "failed";
  const answer = { ok: true, render: render.id, state };
  if (spec.ok) {
    const measured = readMedia(paths, render);
    Object.assign(render, measured);
    Object.assign(answer, measured, { overDeliveryLimit: measured.bytes > manifest.deliveryLimitBytes });
  }
  Object.assign(render, { state, doneAt: event.at, note: spec.note ?? "" });
  manifest.history.push(event);
  return { ...answer, manifestSha256: save(paths, manifest) };
}

function setStatus(spec, paths, manifest, checked) {
  requireRule(spec.ownerConfirmed === true, "ownerConfirmed: explicit confirmation required");
  requireRule(ownerWords(spec.ownerWords), "ownerWords: expected 1 to 2000 characters from the owner");
  if (spec.status === "accepted") {
    const publicationFields = ["publicationId", "snapshotAt"].filter(field => field in spec);
    requireRule(!publicationFields.length, publicationFields.join(", ") + ": only allowed when status is published");
  }
  if (spec.status === "published" || "publicationId" in spec) requireRule(nonblank(spec.publicationId), "publicationId: required");
  if (spec.status === "published" || "snapshotAt" in spec) requireRule(isoTime(spec.snapshotAt), "snapshotAt: expected a UTC timestamp");
  const render = manifest.renders.find(row => row.id === spec.render);
  requireRule(render?.purpose === "build" && render.state === "built", "render: expected a built build render");
  if (spec.status === "accepted") {
    requireRule(manifest.status === "draft", "only a draft can be accepted");
    requireRule(render.editSha256 === lineSha(editOf(manifest)), "draft changed since allocation; a new render is needed");
    requireRule(!checked.notReady.length, checked.notReady.join("; "));
    manifest.chosen = render.id;
  } else if (spec.status === "published") {
    requireRule(manifest.status === "accepted" && render.id === manifest.chosen, "only the accepted chosen render can be published");
    manifest.publication = { id: spec.publicationId, snapshotAt: spec.snapshotAt };
  } else throw new Refusal("status: expected accepted or published");
  verifyMedia(paths, render);
  manifest.status = spec.status;
  manifest.history.push(history(spec.status, render.id, spec.ownerWords));
  return { ok: true, status: spec.status, chosen: render.id, editSha256: render.editSha256, manifestSha256: save(paths, manifest) };
}

const specs = {
  "video-init": { required: ["id", "format"], optional: ["title"] },
  "video-check": { required: [], optional: ["verifyFiles"] },
  "video-render-new": { required: ["purpose", "ext"], optional: [] },
  "video-render-done": { required: ["render", "ok"], optional: ["note"] },
  "video-set-status": { required: ["render", "status"], optional: ["ownerConfirmed", "ownerWords", "publicationId", "snapshotAt"] },
};

function command(name, spec) {
  if (!isObject(spec)) throw new Error("expected an object spec");
  const { required, optional } = specs[name];
  for (const field of Object.keys(spec)) {
    if (!["dir", "api", ...required, ...optional].includes(field)) throw new Error(field + ": unknown spec field");
  }
  for (const field of ["dir", ...required, ...optional]) {
    if (["ownerConfirmed", "ownerWords", "publicationId", "snapshotAt"].includes(field)) continue;
    if (optional.includes(field) && !Object.hasOwn(spec, field)) continue;
    const type = ["ok", "verifyFiles"].includes(field) ? "boolean" : "string";
    if (typeof spec[field] !== type) throw new Error(field + ": expected " + type);
  }
  try {
    const paths = videoPaths(spec, name !== "video-check");
    if (name === "video-init") return init(spec, paths);
    requireRule(paths.hasManifest, "manifest.json is missing");
    const bytes = fs.readFileSync(paths.manifest);
    let manifest;
    try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Refusal("manifest.json: invalid UTF-8 JSON"); }
    const checked = inspect(manifest, paths, spec.verifyFiles === true, name === "video-check");
    if (name === "video-check") return { ok: true, ...checked, manifestSha256: sha(bytes) };
    requireRule(!checked.errors.length, checked.errors.join("; "));
    if (name === "video-render-new") return allocate(spec, paths, manifest);
    if (name === "video-render-done") return complete(spec, paths, manifest);
    return setStatus(spec, paths, manifest, checked);
  } catch (error) {
    if (error instanceof Refusal || error.syscall) return { ok: false, error: error.message };
    throw error;
  }
}

export const VIDEO_COMMANDS = Object.fromEntries(Object.keys(specs).map(name => [name, spec => command(name, spec)]));

function main() {
  try {
    const [name, argument] = process.argv.slice(2);
    if (process.argv.length !== 4 || !Object.hasOwn(VIDEO_COMMANDS, name)) throw new Error("expected a video command and one JSON spec");
    let json = argument;
    if (argument.startsWith("b64:")) {
      const body = argument.slice(4);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(body)) throw new Error("invalid base64 spec");
      json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(body, "base64"));
    }
    const spec = JSON.parse(json);
    if (!isObject(spec)) throw new Error("expected an object spec");
    if (spec.api !== 1) {
      process.exitCode = 3;
      throw new Error("expected api 1");
    }
    const answer = { ...VIDEO_COMMANDS[name](spec), api: 1 };
    return { ...answer, lineSha256: lineSha(answer) };
  } catch (error) {
    process.exitCode ??= 2;
    return { ok: false, api: 1, error: error.message };
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(main()));
}
