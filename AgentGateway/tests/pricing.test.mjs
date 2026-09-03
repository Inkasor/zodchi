import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd, normalizePricing } from "../src/pricing.mjs";

test("configured model pricing estimates uncached, cached and output tokens without rounding to zero", () => {
  const pricing = { models: { fixture: { input_usd_per_million: 1, cached_input_usd_per_million: 0.1, output_usd_per_million: 2 } } };
  const result = estimateCostUsd({ model: "fixture", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 500 }, pricing });
  assert.equal(result.cost_usd, 0.00164);
  assert.equal(result.cost_source, "configured_model_pricing");
  assert.deepEqual(result.cost_breakdown, { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 500, input_usd: 0.0006, cached_input_usd: 0.00004, output_usd: 0.001 });
});

test("unknown models remain unpriced and invalid rate tables fail closed", () => {
  assert.equal(estimateCostUsd({ model: "unknown", usage: { input_tokens: 100, output_tokens: 10 }, pricing: { models: {} } }), null);
  assert.equal(estimateCostUsd({ model: "fixture", usage: { total_tokens: 110 }, pricing: { models: { fixture: { input_usd_per_million: 1, cached_input_usd_per_million: 0.1, output_usd_per_million: 2 } } } }), null);
  assert.throws(() => normalizePricing({ models: { broken: { input_usd_per_million: 0, cached_input_usd_per_million: 0, output_usd_per_million: 0 } } }), /PRICING_RATE_ZERO/);
});
