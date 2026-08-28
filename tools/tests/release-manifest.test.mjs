import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

// The manifest exists so an asset set can be checked as a set. These cases are the disagreements that
// a checksum file alone cannot report, and one of them is what shipped in v0.5.24.

const generator = path.join(import.meta.dirname, "..", "..", "scripts", "build-release-manifest.mjs");

function fixture({ tag = "v9.9.9", version = "9.9.9", archiveName = "Zodchi-v9.9.9.zip", checksumName = archiveName, checksumHash = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-manifest-test-"));
  const releaseRoot = path.join(root, "Zodchi");
  fs.mkdirSync(releaseRoot);
  fs.writeFileSync(path.join(releaseRoot, "product.json"), JSON.stringify({ name: "zodchi", displayName: "Zodchi", workingName: false, version, releaseChannel: "beta" }), "utf8");
  fs.writeFileSync(path.join(releaseRoot, "bundle-manifest.json"), JSON.stringify({ schemaVersion: 1, name: "zodchi", version, components: { WorkflowPlatform: version, AgentGateway: version }, files: [] }), "utf8");
  const archive = path.join(root, archiveName);
  fs.writeFileSync(archive, Buffer.from("archive bytes"));
  const hash = checksumHash ?? crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const checksums = path.join(root, "SHA256SUMS.txt");
  fs.writeFileSync(checksums, `${hash}  ${checksumName}\n`, "utf8");
  return { root, releaseRoot, archive, checksums, tag, out: path.join(root, "zodchi-release-manifest.json") };
}

function run(context) {
  return execFileSync(process.execPath, [generator, "--archive", context.archive, "--checksums", context.checksums, "--tag", context.tag, "--commit", "0".repeat(40), "--release-root", context.releaseRoot, "--out", context.out], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
}

test("a consistent asset set produces a manifest naming the archive and its checksum", () => {
  const context = fixture();
  run(context);
  const manifest = JSON.parse(fs.readFileSync(context.out, "utf8"));
  assert.equal(manifest.tag, "v9.9.9");
  assert.equal(manifest.archive.name, "Zodchi-v9.9.9.zip");
  assert.equal(manifest.checksums.name, "SHA256SUMS.txt");
  assert.equal(manifest.archive.sha256, crypto.createHash("sha256").update(fs.readFileSync(context.archive)).digest("hex"));
  fs.rmSync(context.root, { recursive: true, force: true });
});

test("a tag that does not match the product version is refused", () => {
  const context = fixture({ tag: "v9.9.8" });
  assert.throws(() => run(context), /RELEASE_TAG_VERSION_MISMATCH/);
  fs.rmSync(context.root, { recursive: true, force: true });
});

test("a checksum file naming a different archive is refused", () => {
  const context = fixture({ checksumName: "SHA256SUMS-9.9.9.txt" });
  assert.throws(() => run(context), /RELEASE_CHECKSUM_ENTRY_MISSING/);
  fs.rmSync(context.root, { recursive: true, force: true });
});

test("a checksum that does not match the archive is refused", () => {
  const context = fixture({ checksumHash: "0".repeat(64) });
  assert.throws(() => run(context), /RELEASE_CHECKSUM_ENTRY_MISMATCH/);
  fs.rmSync(context.root, { recursive: true, force: true });
});
