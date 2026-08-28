import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The release manifest is what lets a downloaded asset set be checked as a set. A checksum file says
// the archive is intact; it cannot say the archive, the checksum file and the tag belong together, and
// that is exactly the disagreement that shipped in v0.5.24.

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    const next = argv[index + 1];
    result[key] = next === undefined || next.startsWith("--") ? true : argv[++index];
  }
  return result;
}

const options = parseArguments(process.argv.slice(2));
for (const required of ["archive", "checksums", "tag", "commit", "release-root", "out"]) {
  if (!options[required]) throw new Error(`Usage: node scripts/build-release-manifest.mjs --archive <zip> --checksums <txt> --tag <vX.Y.Z> --commit <sha> --release-root <dir> --out <json> [--workflow-run <id>] [--repository <owner/name>]`);
}

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

const archive = path.resolve(String(options.archive));
const checksums = path.resolve(String(options.checksums));
const releaseRoot = path.resolve(String(options["release-root"]));
const tag = String(options.tag);
const product = readJson(path.join(releaseRoot, "product.json"));
const bundleManifestPath = path.join(releaseRoot, "bundle-manifest.json");
const bundleManifest = readJson(bundleManifestPath);

if (`v${product.version}` !== tag) throw new Error(`RELEASE_TAG_VERSION_MISMATCH: ${tag} != v${product.version}`);
if (bundleManifest.version !== product.version) throw new Error(`RELEASE_BUNDLE_VERSION_MISMATCH: ${bundleManifest.version} != ${product.version}`);

// The checksum file has to name this archive under exactly the name the release will serve, because a
// mismatch there is not detectable later: the installer looks up the archive by name and finds nothing.
const archiveName = path.basename(archive);
const archiveHash = sha256(archive);
const line = fs.readFileSync(checksums, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).find(entry => entry.includes(archiveName));
if (!line) throw new Error(`RELEASE_CHECKSUM_ENTRY_MISSING: ${archiveName}`);
const declared = line.trim().split(/\s+/)[0].toLowerCase();
if (declared !== archiveHash) throw new Error(`RELEASE_CHECKSUM_ENTRY_MISMATCH: ${declared} != ${archiveHash}`);

const manifest = {
  schema_version: 1,
  tag,
  commit: String(options.commit),
  repository: options.repository ? String(options.repository) : null,
  built_at: new Date().toISOString(),
  product: { name: product.name, version: product.version, release_channel: product.releaseChannel ?? null },
  components: bundleManifest.components ?? {},
  archive: { name: archiveName, size: fs.statSync(archive).size, sha256: archiveHash },
  checksums: { name: path.basename(checksums), sha256: sha256(checksums) },
  bundle_manifest: { files: bundleManifest.files?.length ?? 0, sha256: sha256(bundleManifestPath) },
  workflow_run: options["workflow-run"] ? String(options["workflow-run"]) : null
};

fs.writeFileSync(path.resolve(String(options.out)), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
