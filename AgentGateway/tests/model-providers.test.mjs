import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("model-provider catalog references only shipped harnesses and contains no secrets", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(root, "policy.json"), "utf8"));
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "model-providers.json"), "utf8"));
  const harnesses = new Set(Object.keys(policy.providers));
  for (const [key, provider] of Object.entries(catalog.providers)) {
    for (const harness of provider.harnesses) assert.equal(harnesses.has(harness), true, `${key}: unknown harness ${harness}`);
    if (provider.directProfile?.apiKeyEnv) assert.match(provider.directProfile.apiKeyEnv, /^[A-Z_][A-Z0-9_]*$/);
  }
  const source = JSON.stringify(catalog);
  assert.equal(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]{12,}/.test(source), false);
  for (const required of ["openai", "anthropic", "deepseek", "xai", "google", "zai", "alibaba", "moonshot", "local"]) assert.ok(catalog.providers[required]);
});
