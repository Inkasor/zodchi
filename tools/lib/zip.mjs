import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

// A release archive must be readable before anything of ours is installed, so extraction cannot
// depend on an external unzip: Windows and macOS carry bsdtar, most Linux images carry neither it
// nor `unzip`. Reading the container here also keeps the traversal guard on our side of the line.

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const MAX_COMMENT = 0xffff;

function locateEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - MAX_COMMENT - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("ZIP_END_OF_CENTRAL_DIRECTORY_MISSING");
}

export function readZipEntries(buffer) {
  const eocd = locateEndOfCentralDirectory(buffer);
  if (buffer.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) throw new Error("ZIP64_NOT_SUPPORTED");
  const total = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) throw new Error(`ZIP_CENTRAL_HEADER_INVALID: entry ${index}`);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64_NOT_SUPPORTED");
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, crc, compressedSize, uncompressedSize, localOffset, directory: name.endsWith("/") });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntryContent(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_FILE_HEADER) throw new Error(`ZIP_LOCAL_HEADER_INVALID: ${entry.name}`);
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  let content;
  if (entry.method === 0) content = Buffer.from(raw);
  else if (entry.method === 8) content = zlib.inflateRawSync(raw);
  else throw new Error(`ZIP_COMPRESSION_UNSUPPORTED: ${entry.name} method ${entry.method}`);
  if (content.length !== entry.uncompressedSize) throw new Error(`ZIP_SIZE_MISMATCH: ${entry.name}`);
  if (zlib.crc32(content) !== entry.crc) throw new Error(`ZIP_CRC_MISMATCH: ${entry.name}`);
  return content;
}

// An archive entry name is attacker-controlled input even when we produced the archive ourselves,
// so the resolved target must stay inside the destination or extraction stops entirely.
function safeTarget(destination, name) {
  if (name.includes("\0")) throw new Error(`ZIP_ENTRY_NAME_INVALID: ${name}`);
  if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error(`ZIP_ENTRY_ABSOLUTE: ${name}`);
  const target = path.resolve(destination, name);
  const base = path.resolve(destination);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`ZIP_ENTRY_ESCAPES_DESTINATION: ${name}`);
  return target;
}

export function extractZip(buffer, destination) {
  const entries = readZipEntries(buffer);
  const written = [];
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const target = safeTarget(destination, entry.name);
    if (entry.directory) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readZipEntryContent(buffer, entry));
    written.push(entry.name);
  }
  return { entries: entries.length, files: written.length };
}
