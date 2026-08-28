import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { extractZip } from "./lib/zip.mjs";

function argsObject(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) {
    const key = argv[index].slice(2);
    result[key] = argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

function headers(accept) {
  const value = { Accept: accept, "User-Agent": "Zodchi-Installer" };
  if (process.env.GITHUB_TOKEN) value.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return value;
}

async function requestJson(url) {
  const response = await fetch(url, { headers: headers("application/vnd.github+json") });
  if (!response.ok) throw new Error(`INSTALL_DOWNLOAD_FAILED: ${response.status} ${url}`);
  return response.json();
}

async function requestBytes(url) {
  const response = await fetch(url, { headers: headers("application/octet-stream"), redirect: "follow" });
  if (!response.ok) throw new Error(`INSTALL_DOWNLOAD_FAILED: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function one(values, label) { if (values.length !== 1) throw new Error(`INSTALL_RELEASE_ASSET_AMBIGUOUS: ${label}:${values.length}`); return values[0]; }

export function selectReleaseAssets(release) {
  const archive = one(release.assets.filter(asset => /^Zodchi-v.+\.zip$/.test(asset.name) && !/-windows\.zip$/i.test(asset.name)), "universal archive");
  const checksums = one(release.assets.filter(asset => asset.name === "SHA256SUMS.txt"), "SHA256SUMS.txt");
  const manifest = one(release.assets.filter(asset => asset.name === "zodchi-release-manifest.json"), "release manifest");
  for (const asset of [archive, checksums, manifest]) if (asset.uploader?.login !== "github-actions[bot]") throw new Error(`INSTALL_RELEASE_NOT_CI_PUBLISHED: ${asset.name}:${asset.uploader?.login ?? "unknown"}`);
  return { archive, checksums, manifest };
}

export function requireProvenanceAttestation(response, archiveHash) {
  const attestations = response?.attestations;
  if (!Array.isArray(attestations) || attestations.length === 0) throw new Error(`INSTALL_RELEASE_ATTESTATION_MISSING: sha256:${archiveHash}`);
  const usable = attestations.filter(item => Number.isInteger(item?.repository_id) && typeof item?.bundle_url === "string" && item.bundle_url.startsWith("https://"));
  if (usable.length === 0) throw new Error(`INSTALL_RELEASE_ATTESTATION_INVALID: sha256:${archiveHash}`);
  return { subject_digest: `sha256:${archiveHash}`, records: usable.length };
}

function productRoots(directory) {
  const result = [];
  const walk = current => { for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const full = path.join(current, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name === "product.json" && fs.existsSync(path.join(current, "bundle-manifest.json"))) result.push(current); } };
  walk(directory); return result;
}

export async function installLatest({ repository = "Inkasor/zodchi", destination = null, dataRoot = null, releaseTag = null } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-install-"));
  try {
    const release = releaseTag
      ? await requestJson(`https://api.github.com/repos/${repository}/releases/tags/${releaseTag}`)
      : (await requestJson(`https://api.github.com/repos/${repository}/releases?per_page=20`)).find(item => !item.draft);
    if (!release) throw new Error(`INSTALL_RELEASE_NOT_FOUND: ${repository}`);
    const assets = selectReleaseAssets(release);
    const [archive, checksumBytes, manifestBytes] = await Promise.all([requestBytes(assets.archive.browser_download_url), requestBytes(assets.checksums.browser_download_url), requestBytes(assets.manifest.browser_download_url)]);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.schema_version !== 1 || manifest.tag !== release.tag_name || manifest.repository !== repository) throw new Error("INSTALL_RELEASE_MANIFEST_INVALID");
    if (manifest.archive?.name !== assets.archive.name || manifest.archive?.size !== assets.archive.size || manifest.archive?.sha256 !== sha256(archive)) throw new Error("INSTALL_RELEASE_ARCHIVE_PROVENANCE_INVALID");
    if (manifest.checksums?.name !== assets.checksums.name || manifest.checksums?.sha256 !== sha256(checksumBytes)) throw new Error("INSTALL_RELEASE_CHECKSUM_PROVENANCE_INVALID");
    const line = checksumBytes.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).find(item => item.includes(assets.archive.name));
    const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected ?? "") || expected !== sha256(archive)) throw new Error("INSTALL_RELEASE_CHECKSUM_MISMATCH");
    const workflow = await requestJson(`https://api.github.com/repos/${repository}/actions/runs/${manifest.workflow_run}`);
    if (workflow.status !== "completed" || workflow.conclusion !== "success" || workflow.head_sha !== manifest.commit) throw new Error("INSTALL_RELEASE_WORKFLOW_NOT_GREEN");
    // The workflow's smoke performs cryptographic Sigstore verification. The bootstrap installer also
    // requires the exact archive digest to remain registered in GitHub's repository attestation API;
    // it does not silently downgrade when GitHub CLI is not installed on a fresh machine.
    requireProvenanceAttestation(await requestJson(`https://api.github.com/repos/${repository}/attestations/sha256:${sha256(archive)}?predicate_type=provenance`), sha256(archive));
    const extracted = path.join(scratch, "extracted"); extractZip(archive, extracted);
    const roots = productRoots(extracted); if (roots.length !== 1) throw new Error(`INSTALL_PRODUCT_ROOT_AMBIGUOUS: ${roots.length}`);
    const installer = path.join(roots[0], "tools", "install.mjs");
    const parameters = [installer, "update", "--source", roots[0]];
    if (destination) parameters.push("--destination", path.resolve(destination));
    if (dataRoot) parameters.push("--data-root", path.resolve(dataRoot));
    const output = execFileSync(process.execPath, parameters, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return { release: release.tag_name, archive: assets.archive.name, checksum: sha256(archive), installation: JSON.parse(output) };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

const cli = argsObject(process.argv.slice(2));
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  installLatest({ repository: String(cli.repository ?? "Inkasor/zodchi"), destination: cli.destination ? String(cli.destination) : null, dataRoot: cli["data-root"] ? String(cli["data-root"]) : null, releaseTag: cli.tag ? String(cli.tag) : null })
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
