import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOpenAICompatibleUsage, runOpenAICompatible } from "../src/openai-compatible.mjs";

test("OpenAI-compatible adapter keeps credentials in env and normalizes usage", async () => {
  const fixtureCredential = ["secret", "fixture"].join("-");
  let request;
  const result = await runOpenAICompatible({
    profileConfig: {
      baseUrl: "https://example.invalid/v1/",
      apiKeyEnv: "FIXTURE_API_KEY",
      modelProvider: "fixture-provider",
      model: "fixture-model",
      reasoningEffort: "low",
      passReasoningEffort: true,
      clientHeaderName: "x-client",
      clientHeaderValue: "agent-gateway-test"
    },
    prompt: "fixture prompt",
    systemPrompt: "fixture system",
    timeoutSec: 1,
    env: { FIXTURE_API_KEY: fixtureCredential },
    fetchImpl: async (url, options) => {
      request = { url: String(url), options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "response-fixture",
        choices: [{ message: { content: "fixture result" } }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: 0.0123, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 10 } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(request.url, "https://example.invalid/v1/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer secret-fixture");
  assert.equal(request.options.headers["x-client"], "agent-gateway-test");
  assert.equal(request.body.reasoning_effort, "low");
  assert.equal(request.body.messages[1].content, "fixture prompt");
  assert.equal(result.stdout.includes("secret-fixture"), false);
  const lines = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(lines[0].usage.input_tokens, 120);
  assert.equal(lines[0].usage.cached_input_tokens, 80);
  assert.equal(lines[0].usage.cache_write_input_tokens, 12);
  assert.equal(lines[0].usage.cost_usd, 0.0123);
  assert.equal(lines[0].usage.output_tokens, 30);
  assert.equal(lines[0].usage.reasoning_output_tokens, 10);
  assert.equal(lines[1].result, "fixture result");
});

test("OpenAI-compatible adapter rejects inline or missing credentials", async () => {
  await assert.rejects(() => runOpenAICompatible({
    profileConfig: { baseUrl: "https://example.invalid/v1", modelProvider: "fixture", model: "fixture", apiKey: "forbidden" },
    prompt: "x", systemPrompt: "x", timeoutSec: 1, env: {}, fetchImpl: async () => { throw new Error("must not call"); }
  }), /INLINE_API_KEY_FORBIDDEN/);
  await assert.rejects(() => runOpenAICompatible({
    profileConfig: { baseUrl: "https://example.invalid/v1", modelProvider: "fixture", model: "fixture", apiKeyEnv: "MISSING" },
    prompt: "x", systemPrompt: "x", timeoutSec: 1, env: {}, fetchImpl: async () => { throw new Error("must not call"); }
  }), /API_KEY_MISSING/);
  const insecure = await runOpenAICompatible({
    profileConfig: { baseUrl: "http://example.invalid/v1", modelProvider: "fixture", model: "fixture", allowAnonymous: true },
    prompt: "x", systemPrompt: "x", timeoutSec: 1, env: {}, fetchImpl: async () => { throw new Error("must not call"); }
  });
  assert.equal(insecure.exitCode, 70);
  assert.match(insecure.stderr, /HTTPS_REQUIRED/);
});

test("OpenAI-compatible usage recognizes provider cache fields", () => {
  assert.deepEqual(normalizeOpenAICompatibleUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 3 }), {
    input_tokens: 10,
    cached_input_tokens: 7,
    cache_write_input_tokens: 3,
    output_tokens: 4,
    reasoning_output_tokens: 0,
    total_tokens: 14,
    cost_usd: null
  });
});

test("OpenRouter profile sends strict structured output only to capable endpoints", async () => {
  let request;
  const schema = { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false };
  const result = await runOpenAICompatible({
    profileConfig: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      modelProvider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      structuredOutput: true,
      extraBody: { provider: { require_parameters: true } },
      clientHeaders: { "X-OpenRouter-Title": "Zodchi AgentGateway" }
    },
    prompt: "fixture prompt", systemPrompt: "fixture system", outputSchema: schema, outputSchemaName: "reviewer_result", timeoutSec: 1,
    env: { OPENROUTER_API_KEY: "fixture-key" },
    fetchImpl: async (url, options) => {
      request = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ id: "openrouter-fixture", choices: [{ message: { content: '{"status":"passed"}' } }], usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.001 } }), { status: 200 });
    }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer fixture-key");
  assert.equal(request.headers["X-OpenRouter-Title"], "Zodchi AgentGateway");
  assert.deepEqual(request.body.provider, { require_parameters: true });
  assert.deepEqual(request.body.response_format, { type: "json_schema", json_schema: { name: "reviewer_result", strict: true, schema } });
});
