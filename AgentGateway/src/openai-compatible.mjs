function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function normalizeOpenAICompatibleUsage(usage = {}) {
  const inputTokens = asNumber(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = asNumber(usage.output_tokens ?? usage.completion_tokens);
  return {
    input_tokens: inputTokens,
    cached_input_tokens: asNumber(
      usage.cached_input_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.prompt_cache_hit_tokens
      ?? 0
    ),
    cache_write_input_tokens: asNumber(
      usage.cache_write_input_tokens
      ?? usage.cache_creation_input_tokens
      ?? usage.prompt_cache_miss_tokens
      ?? 0
    ),
    output_tokens: outputTokens,
    reasoning_output_tokens: asNumber(
      usage.reasoning_output_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens
      ?? 0
    ),
    total_tokens: asNumber(usage.total_tokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)))
  };
}

function endpoint(baseUrl) {
  const normalized = new URL(baseUrl);
  if (normalized.username || normalized.password) throw new Error("OPENAI_COMPATIBLE_URL_CREDENTIALS_FORBIDDEN");
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(normalized.hostname);
  if (normalized.protocol !== "https:" && !(normalized.protocol === "http:" && loopback)) throw new Error("OPENAI_COMPATIBLE_HTTPS_REQUIRED_OUTSIDE_LOOPBACK");
  const path = normalized.pathname.replace(/\/$/, "");
  normalized.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  return normalized;
}

function textContent(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter(part => part?.type === "text" && typeof part.text === "string")
      .map(part => part.text)
      .join("\n");
  }
  return "";
}

export async function runOpenAICompatible({ profileConfig, prompt, systemPrompt, timeoutSec, env = process.env, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") throw new Error("OPENAI_COMPATIBLE_FETCH_UNAVAILABLE");
  if (!profileConfig.baseUrl) throw new Error("OPENAI_COMPATIBLE_BASE_URL_REQUIRED");
  if (!profileConfig.model) throw new Error("OPENAI_COMPATIBLE_MODEL_REQUIRED");
  if (!profileConfig.modelProvider) throw new Error("OPENAI_COMPATIBLE_MODEL_PROVIDER_REQUIRED");
  if (Object.hasOwn(profileConfig, "apiKey")) throw new Error("OPENAI_COMPATIBLE_INLINE_API_KEY_FORBIDDEN");

  const apiKeyEnv = profileConfig.apiKeyEnv ?? null;
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : null;
  if (!apiKey && profileConfig.allowAnonymous !== true) {
    throw new Error(apiKeyEnv ? `OPENAI_COMPATIBLE_API_KEY_MISSING: ${apiKeyEnv}` : "OPENAI_COMPATIBLE_API_KEY_ENV_REQUIRED");
  }

  const extraBody = profileConfig.extraBody && typeof profileConfig.extraBody === "object" ? profileConfig.extraBody : {};
  for (const reserved of ["model", "messages", "stream"]) if (Object.hasOwn(extraBody, reserved)) throw new Error(`OPENAI_COMPATIBLE_RESERVED_BODY_FIELD: ${reserved}`);
  const body = {
    ...extraBody,
    model: profileConfig.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt }
    ],
    stream: false,
    ...(profileConfig.maxOutputTokens ? { max_tokens: profileConfig.maxOutputTokens } : {}),
    ...(profileConfig.temperature !== undefined ? { temperature: profileConfig.temperature } : {}),
    ...(profileConfig.passReasoningEffort === true && profileConfig.reasoningEffort
      ? { reasoning_effort: profileConfig.reasoningEffort }
      : {})
  };
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (profileConfig.clientHeaderName && profileConfig.clientHeaderValue) {
    if (/(?:authorization|api[_-]?key|token|cookie|secret)/i.test(profileConfig.clientHeaderName)) throw new Error("OPENAI_COMPATIBLE_SECRET_HEADER_FORBIDDEN");
    headers[profileConfig.clientHeaderName] = profileConfig.clientHeaderValue;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const started = Date.now();
  try {
    const response = await fetchImpl(endpoint(profileConfig.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) {
      return { exitCode: 22, stdout: "", stderr: `OPENAI_COMPATIBLE_HTTP_${response.status}: ${raw}`, timedOut: false };
    }
    let value;
    try { value = JSON.parse(raw); }
    catch { return { exitCode: 65, stdout: "", stderr: "OPENAI_COMPATIBLE_RESPONSE_NOT_JSON", timedOut: false }; }
    const usage = { ...normalizeOpenAICompatibleUsage(value.usage), duration_ms: Date.now() - started };
    const result = textContent(value.choices?.[0]?.message);
    const sessionId = typeof value.id === "string" ? value.id : null;
    return {
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: "turn.completed", usage: { ...usage, session_id: sessionId } }),
        JSON.stringify({ type: "result", result, session_id: sessionId })
      ].join("\n") + "\n",
      stderr: "",
      timedOut: false
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return { exitCode: timedOut ? 124 : 70, stdout: "", stderr: timedOut ? "OPENAI_COMPATIBLE_TIMEOUT" : `OPENAI_COMPATIBLE_TRANSPORT_ERROR: ${error.message}`, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
