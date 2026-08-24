ALTER TABLE gateway_calls ADD COLUMN model TEXT;
ALTER TABLE gateway_calls ADD COLUMN reasoning_effort TEXT;
ALTER TABLE gateway_calls ADD COLUMN correction_cycles INTEGER NOT NULL DEFAULT 0 CHECK (correction_cycles >= 0);
ALTER TABLE gateway_calls ADD COLUMN retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0);
ALTER TABLE gateway_calls ADD COLUMN service_tier TEXT;
