const provider = process.argv[2];
const mode = process.argv[3] ?? "pass";
if (!provider) process.exit(64);
if (provider === "opencode") {
  console.log(JSON.stringify({ type: "step_finish", sessionID: "session-opencode-contract", part: { type: "step-finish", cost: 0.001, tokens: { total: 51, input: 44, output: 7, reasoning: 3, cache: { read: 4, write: 1 } } } }));
  console.log(JSON.stringify({ type: "text", part: { text: "opencode-contract-result" } }));
} else if (provider === "cursor") {
  console.log(JSON.stringify({ type: "result", subtype: "success", duration_ms: 25, result: "cursor-contract-result", session_id: "cursor-contract-session" }));
} else {
  console.log(JSON.stringify({
    type: "turn.completed",
    provider_contract: provider,
    provider_args: process.argv.slice(4),
    usage: {
      input_tokens: provider === "codex" ? 11 : provider === "claude" ? 22 : 33,
      cached_input_tokens: provider === "codex" ? 1 : provider === "claude" ? 2 : 3,
      output_tokens: provider === "codex" ? 4 : provider === "claude" ? 5 : 6,
      reasoning_output_tokens: provider === "codex" ? 2 : 0,
      service_tier: "contract-test"
    }
  }));
  console.log(JSON.stringify({ result: `${provider}-contract-result` }));
}
if (mode === "fail") process.exit(9);
