import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { extractZip, readZipEntries, readZipEntryContent } from "../lib/zip.mjs";

// A minimal writer so the reader is exercised against both storage methods and against deliberately
// malformed entries. The reader is what stands between a downloaded archive and the filesystem, so the
// cases that matter are the ones an intact archive never produces.
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content ?? "", "utf8");
    const method = entry.method ?? 8;
    const payload = method === 8 ? zlib.deflateRawSync(content) : content;
    const crc = entry.crc ?? zlib.crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + payload.length;
  }
  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-zip-test-"));
}

test("deflated and stored entries both round-trip", () => {
  const archive = buildZip([
    { name: "docs/readme.md", content: "# release\n".repeat(64) },
    { name: "product.json", content: "{\"name\":\"zodchi\"}", method: 0 }
  ]);
  const entries = readZipEntries(archive);
  assert.equal(entries.length, 2);
  assert.equal(readZipEntryContent(archive, entries[0]).toString("utf8"), "# release\n".repeat(64));
  assert.equal(readZipEntryContent(archive, entries[1]).toString("utf8"), "{\"name\":\"zodchi\"}");
});

test("extraction writes every entry under the destination", () => {
  const destination = scratch();
  const archive = buildZip([{ name: "WorkflowPlatform/src/cli.mjs", content: "export default 1;\n" }]);
  const result = extractZip(archive, destination);
  assert.equal(result.files, 1);
  assert.equal(fs.readFileSync(path.join(destination, "WorkflowPlatform", "src", "cli.mjs"), "utf8"), "export default 1;\n");
  fs.rmSync(destination, { recursive: true, force: true });
});

test("a traversing entry name is refused before anything is written", () => {
  const destination = scratch();
  const archive = buildZip([{ name: "../escaped.txt", content: "no" }]);
  assert.throws(() => extractZip(archive, destination), /ZIP_ENTRY_ESCAPES_DESTINATION/);
  assert.equal(fs.existsSync(path.join(path.dirname(destination), "escaped.txt")), false);
  fs.rmSync(destination, { recursive: true, force: true });
});

test("an absolute entry name is refused", () => {
  const destination = scratch();
  for (const name of ["/etc/passwd", "C:/Windows/system.ini"]) {
    assert.throws(() => extractZip(buildZip([{ name, content: "no" }]), destination), /ZIP_ENTRY_ABSOLUTE/);
  }
  fs.rmSync(destination, { recursive: true, force: true });
});

test("a corrupted entry fails on its checksum rather than being written", () => {
  const destination = scratch();
  const archive = buildZip([{ name: "product.json", content: "{}", crc: 1 }]);
  assert.throws(() => extractZip(archive, destination), /ZIP_CRC_MISMATCH/);
  assert.equal(fs.existsSync(path.join(destination, "product.json")), false);
  fs.rmSync(destination, { recursive: true, force: true });
});

test("an unsupported compression method is refused instead of guessed", () => {
  const archive = buildZip([{ name: "product.json", content: "{}", method: 12 }]);
  const entries = readZipEntries(archive);
  assert.throws(() => readZipEntryContent(archive, entries[0]), /ZIP_COMPRESSION_UNSUPPORTED/);
});

test("a buffer without a central directory is refused", () => {
  assert.throws(() => readZipEntries(Buffer.alloc(64)), /ZIP_END_OF_CENTRAL_DIRECTORY_MISSING/);
});
