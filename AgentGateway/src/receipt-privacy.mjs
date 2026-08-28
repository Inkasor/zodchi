const ATTESTATION = Object.freeze({
  raw_prompt: false,
  raw_output: false,
  raw_error: false,
  source_samples: false,
  secret_samples: false
});

const FORBIDDEN_KEYS = new Set([
  "prompt", "raw_prompt", "output", "raw_output", "error", "raw_error",
  "source", "source_text", "source_sample", "source_samples", "content",
  "sql_rows", "secret", "secrets", "credential", "credentials"
]);

export const DEFAULT_PRIVACY_MODE = "no_source_persistence";

function inspectKeys(value, location = "receipt") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) throw new Error(`RECEIPT_PRIVACY_FIELD_FORBIDDEN: ${location}.${key}`);
    inspectKeys(child, `${location}.${key}`);
  }
}

function meaningfulSamples(values) {
  const result = new Set();
  for (const value of values) {
    const text = String(value ?? "");
    for (const candidate of [text, ...text.split(/\r?\n/)].map(item => item.trim())) {
      // Short words and ordinary JSON punctuation cause false positives in technical metadata. A source,
      // output, SQL row or secret capable of leaking useful content is long enough for this sentinel.
      if (candidate.length >= 12) result.add(candidate);
    }
  }
  return [...result];
}

export function privacyAttestation(mode = DEFAULT_PRIVACY_MODE) {
  if (mode !== DEFAULT_PRIVACY_MODE) throw new Error(`RECEIPT_PRIVACY_MODE_UNSUPPORTED: ${mode}`);
  return { ...ATTESTATION };
}

export function assertMetadataOnlyReceipt(storedReceipt, transient = {}) {
  if (storedReceipt.privacy_mode !== DEFAULT_PRIVACY_MODE) throw new Error(`RECEIPT_PRIVACY_MODE_UNSUPPORTED: ${storedReceipt.privacy_mode}`);
  inspectKeys(storedReceipt);
  const persisted = JSON.stringify(storedReceipt);
  for (const sample of meaningfulSamples([transient.prompt, transient.stdout, transient.stderr, ...(transient.secretSamples ?? [])])) {
    if (persisted.includes(sample)) throw new Error(`RECEIPT_PRIVACY_SAMPLE_PERSISTED: ${sample.slice(0, 48)}`);
  }
  const expected = JSON.stringify(ATTESTATION);
  if (storedReceipt.persistence_attestation_json !== expected) throw new Error("RECEIPT_PRIVACY_ATTESTATION_INVALID");
  return true;
}
