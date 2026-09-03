import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";

export const BROWSER_PROOF_VIEWPORT = Object.freeze({ width: 800, height: 600 });

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

export function decodePngPixels(content) {
  const width = content.readUInt32BE(16), height = content.readUInt32BE(20), bitDepth = content[24], colorType = content[25], interlace = content[28];
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) throw new Error("PNG_PIXEL_FORMAT_UNSUPPORTED");
  const chunks = [];
  for (let offset = 8; offset + 12 <= content.length;) {
    const length = content.readUInt32BE(offset), type = content.subarray(offset + 4, offset + 8).toString("ascii"), end = offset + 12 + length;
    if (end > content.length) throw new Error("PNG_CHUNK_TRUNCATED");
    if (type === "IDAT") chunks.push(content.subarray(offset + 8, offset + 8 + length));
    offset = end;
  }
  if (!chunks.length) throw new Error("PNG_IDAT_MISSING");
  const channels = colorType === 2 ? 3 : 4, stride = width * channels, encoded = zlib.inflateSync(Buffer.concat(chunks));
  if (encoded.length !== height * (stride + 1)) throw new Error("PNG_SCANLINES_INVALID");
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const encodedOffset = y * (stride + 1), rowOffset = y * stride, filter = encoded[encodedOffset];
    if (filter > 4) throw new Error("PNG_FILTER_UNSUPPORTED");
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[encodedOffset + 1 + x], left = x >= channels ? pixels[rowOffset + x - channels] : 0, up = y ? pixels[rowOffset - stride + x] : 0, upperLeft = y && x >= channels ? pixels[rowOffset - stride + x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      pixels[rowOffset + x] = (raw + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

export function screenshotContainsMarker(decoded, marker) {
  for (const scale of [1, 2, 3]) {
    if ((marker.left + marker.columns * marker.cellSize) * scale > decoded.width || (marker.top + marker.rows * marker.cellSize) * scale > decoded.height) continue;
    const matched = marker.bits.every((bit, index) => {
      const column = index % marker.columns, row = Math.floor(index / marker.columns);
      const x = Math.floor((marker.left + column * marker.cellSize + marker.cellSize / 2) * scale), y = Math.floor((marker.top + row * marker.cellSize + marker.cellSize / 2) * scale), pixel = (y * decoded.width + x) * decoded.channels;
      return marker.colors[bit].every((channel, channelIndex) => decoded.pixels[pixel + channelIndex] === channel);
    });
    if (matched) return { matched: true, scale };
  }
  return { matched: false, scale: null };
}

export function screenshotEvidence(file, marker, artifactPath = file) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return { status: "unknown", enforcement: "unknown", source: "artifact_missing", artifact: null };
  const content = fs.readFileSync(file), signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (content.length < 24 || !content.subarray(0, 8).equals(signature) || content.subarray(12, 16).toString("ascii") !== "IHDR") return { status: "unknown", enforcement: "unknown", source: "artifact_not_png", artifact: null };
  const width = content.readUInt32BE(16), height = content.readUInt32BE(20), base = { path: artifactPath, bytes: content.length, width, height, sha256: crypto.createHash("sha256").update(content).digest("hex") };
  if (width < BROWSER_PROOF_VIEWPORT.width || height < BROWSER_PROOF_VIEWPORT.height) return { status: "unknown", enforcement: "unknown", source: "artifact_below_probe_viewport", artifact: base };
  try {
    const match = screenshotContainsMarker(decodePngPixels(content), marker);
    return match.matched
      ? { status: "available", enforcement: "technical", source: "retained_sentinel_png_artifact", artifact: { ...base, marker_sha256: marker.sha256, marker_scale: match.scale } }
      : { status: "unknown", enforcement: "unknown", source: "sentinel_marker_missing", artifact: { ...base, marker_sha256: marker.sha256 } };
  } catch (error) { return { status: "unknown", enforcement: "unknown", source: "artifact_pixels_unverifiable", artifact: { ...base, marker_sha256: marker.sha256, detail: error.message } }; }
}
