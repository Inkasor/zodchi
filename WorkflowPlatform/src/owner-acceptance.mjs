import crypto from "node:crypto";
import { openDb, now } from "./db.mjs";
import { loadDefaultProjectPresetCatalog } from "./project-presets.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const REVIEW = new Set(["read", "accepted", "rejected"]);
const DOMAIN = new Set(["open", "accepted", "rejected"]);
const TERMINAL_RUN_STATES = new Set(["completed", "documented", "blocked", "rejected", "failed", "cancelled"]);

function requiredText(value, field, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`OWNER_ACCEPTANCE_FIELD_INVALID: ${field}`);
  return value.trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

export function recordOwnerAcceptance(dbFile, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("OWNER_ACCEPTANCE_INPUT_REQUIRED");
  const allowed = new Set(["schema_version", "project_id", "preset_key", "run_id", "package_key", "package_version", "artifact_sha256", "owner_identity", "review_status", "domain_status", "note", "supersedes_id"]);
  if (input.schema_version !== 1 || Object.keys(input).some(key => !allowed.has(key))) throw new Error("OWNER_ACCEPTANCE_SCHEMA_INVALID");
  const projectId = requiredText(input.project_id, "project_id");
  const presetKey = requiredText(input.preset_key, "preset_key");
  const runId = requiredText(input.run_id, "run_id");
  const packageKey = requiredText(input.package_key, "package_key");
  const packageVersion = requiredText(input.package_version, "package_version");
  const artifactSha256 = requiredText(input.artifact_sha256, "artifact_sha256").toLowerCase();
  const ownerIdentity = requiredText(input.owner_identity, "owner_identity");
  const reviewStatus = requiredText(input.review_status, "review_status");
  const domainStatus = requiredText(input.domain_status, "domain_status");
  const note = input.note == null || input.note === "" ? null : requiredText(input.note, "note", 1000);
  const supersedesId = input.supersedes_id == null || input.supersedes_id === "" ? null : requiredText(input.supersedes_id, "supersedes_id");
  if (!SHA256.test(artifactSha256)) throw new Error("OWNER_ACCEPTANCE_ARTIFACT_HASH_INVALID");
  if (!REVIEW.has(reviewStatus)) throw new Error(`OWNER_ACCEPTANCE_REVIEW_STATUS_INVALID: ${reviewStatus}`);
  if (!DOMAIN.has(domainStatus)) throw new Error(`OWNER_ACCEPTANCE_DOMAIN_STATUS_INVALID: ${domainStatus}`);

  const preset = loadDefaultProjectPresetCatalog().presets.find(item => item.key === presetKey);
  if (!preset || !preset.package_keys.includes(packageKey)) throw new Error(`OWNER_ACCEPTANCE_PRESET_PACKAGE_MISMATCH: ${presetKey}: ${packageKey}`);
  const payload = canonical({ schema_version: 1, project_id: projectId, preset_key: presetKey, run_id: runId, package_key: packageKey, package_version: packageVersion, artifact_sha256: artifactSha256, owner_identity: ownerIdentity, review_status: reviewStatus, domain_status: domainStatus, note, source: "owner_explicit", supersedes_id: supersedesId });
  const contentHash = hash(payload), recordId = `owner_acceptance_${contentHash.slice(0, 24)}`;
  const db = openDb(dbFile);
  try {
    const duplicate = db.prepare("SELECT * FROM owner_acceptance_records WHERE content_hash=?").get(contentHash);
    if (duplicate) return Object.freeze({ ...duplicate, duplicate: true });
    const run = db.prepare("SELECT project_id,state FROM workflow_runs WHERE id=?").get(runId);
    if (!run || run.project_id !== projectId) throw new Error(`OWNER_ACCEPTANCE_RUN_PROJECT_MISMATCH: ${runId}: ${projectId}`);
    if (!TERMINAL_RUN_STATES.has(run.state)) throw new Error(`OWNER_ACCEPTANCE_RUN_NOT_TERMINAL: ${runId}: ${run.state}`);
    const release = db.prepare("SELECT version FROM workflow_package_releases WHERE project_id=? AND package_key=? AND status='active'").get(projectId, packageKey);
    if (!release || release.version !== packageVersion) throw new Error(`OWNER_ACCEPTANCE_PACKAGE_VERSION_MISMATCH: ${packageKey}: ${packageVersion}`);
    if (supersedesId) {
      const previous = db.prepare("SELECT project_id,preset_key,run_id,package_key,owner_identity FROM owner_acceptance_records WHERE id=?").get(supersedesId);
      if (!previous || previous.project_id !== projectId || previous.preset_key !== presetKey || previous.run_id !== runId || previous.package_key !== packageKey || previous.owner_identity !== ownerIdentity) throw new Error(`OWNER_ACCEPTANCE_SUPERSEDES_MISMATCH: ${supersedesId}`);
    }
    const recordedAt = now();
    db.prepare(`INSERT INTO owner_acceptance_records(id,project_id,preset_key,run_id,package_key,package_version,artifact_sha256,owner_identity,review_status,domain_status,note,source,supersedes_id,content_hash,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(recordId, projectId, presetKey, runId, packageKey, packageVersion, artifactSha256, ownerIdentity, reviewStatus, domainStatus, note, "owner_explicit", supersedesId, contentHash, recordedAt);
    return Object.freeze({ id: recordId, ...payload, content_hash: contentHash, recorded_at: recordedAt, duplicate: false });
  } finally { db.close(); }
}
