export function utf8Prefix(value, maxBytes) {
  const text = String(value ?? "");
  const limit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}
