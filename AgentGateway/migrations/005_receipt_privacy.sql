-- Receipt persistence is metadata-only. The model response remains available to the supervising process,
-- but neither it nor its prompt/source material is durable Gateway state. Persist the policy and a
-- machine-readable attestation with every immutable receipt so an exported receipt states this contract.
ALTER TABLE receipts ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'no_source_persistence'
  CHECK (privacy_mode IN ('no_source_persistence'));
ALTER TABLE receipts ADD COLUMN persistence_attestation_json TEXT NOT NULL DEFAULT
  '{"raw_prompt":false,"raw_output":false,"raw_error":false,"source_samples":false,"secret_samples":false}';
