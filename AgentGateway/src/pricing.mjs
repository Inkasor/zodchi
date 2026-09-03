const RATE_KEYS = Object.freeze(["input_usd_per_million", "cached_input_usd_per_million", "output_usd_per_million"]);

function number(value, label) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(`PRICING_RATE_INVALID: ${label}`);
  return Number(value);
}

function normalizeRate(model, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`PRICING_MODEL_INVALID: ${model}`);
  const rate = Object.fromEntries(RATE_KEYS.map(key => [key, number(value[key], `${model}.${key}`)]));
  if (!rate.input_usd_per_million && !rate.cached_input_usd_per_million && !rate.output_usd_per_million) throw new Error(`PRICING_RATE_ZERO: ${model}`);
  return Object.freeze(rate);
}

export function normalizePricing(value) {
  if (value === null || value === undefined) return Object.freeze({});
  const models = value.models ?? value;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("PRICING_TABLE_INVALID");
  return Object.freeze(Object.fromEntries(Object.entries(models).map(([model, rate]) => [model, normalizeRate(model, rate)])));
}

function roundUsd(value) { return Number(value.toFixed(12)); }

/**
 * Estimate a receipt cost from the explicitly configured local rate table. Provider-reported cost wins
 * in the CLI; this helper is only for providers that report tokens but no price. Unknown models return
 * null so an absent rate can never masquerade as a free call.
 */
export function estimateCostUsd({ model, usage, pricing } = {}) {
  const rates = normalizePricing(pricing), rate = typeof model === "string" ? rates[model] : null;
  if (!rate || !usage || typeof usage !== "object") return null;
  const inputValue = Number(usage.input_tokens), outputValue = Number(usage.output_tokens);
  // A price calculated from a missing token field is not a price calculation: it would
  // turn an incomplete provider report into a misleading free call. Stay fail-closed
  // until both billable directions are explicitly present and valid.
  if (!Number.isFinite(inputValue) || inputValue < 0 || !Number.isFinite(outputValue) || outputValue < 0) return null;
  const cachedValue = Number(usage.cached_input_tokens ?? 0);
  if (!Number.isFinite(cachedValue) || cachedValue < 0) return null;
  const input = inputValue;
  const cached = Math.min(input, cachedValue);
  const output = outputValue;
  const billable = (input - cached) * rate.input_usd_per_million + cached * rate.cached_input_usd_per_million + output * rate.output_usd_per_million;
  return {
    cost_usd: roundUsd(billable / 1_000_000),
    cost_source: "configured_model_pricing",
    pricing_model: model,
    cost_breakdown: {
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      input_usd: roundUsd((input - cached) * rate.input_usd_per_million / 1_000_000),
      cached_input_usd: roundUsd(cached * rate.cached_input_usd_per_million / 1_000_000),
      output_usd: roundUsd(output * rate.output_usd_per_million / 1_000_000)
    }
  };
}
