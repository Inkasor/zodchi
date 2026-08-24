ALTER TABLE gateway_calls ADD COLUMN model_provider TEXT;

CREATE INDEX idx_gateway_calls_model_provider ON gateway_calls(model_provider, model);
