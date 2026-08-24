# Agent Gateway

Local gateway for one bounded model call through Codex, Claude Code, Kimi,
OpenCode, Cursor Agent, or an OpenAI-compatible HTTP endpoint.
It enforces task-level limits and writes immutable technical SQLite receipts. Full provider output is returned to the caller but is not stored by AgentGateway; receipts contain metrics, compact error summaries, hashes, and artifact or decision references only.
It does not use the OpenAI Responses API.

Persistent data is stored in the local Gateway data directory and can be
configured with `AGENT_GATEWAY_DATA` or `AGENT_GATEWAY_DB`. The Zodchi release
does not include anyone's database or credentials.

Project checks and deterministic gates are owned by Workflow Platform.
AgentGateway only routes model calls, enforces provider/profile limits, and
writes usage receipts to its own database.

Each Gateway task is exactly one bounded provider call. A multi-step workflow,
including correction and review calls, is assembled and budgeted by Workflow
Platform.

Gateway treats two choices independently:

- the execution harness (`codex`, `claude`, `kimi`, `opencode`, `cursor`, or
  `openai-compatible`);
- the model provider recorded by the local profile (`openai`, `anthropic`,
  `deepseek`, `xai`, `google`, `zai`, `alibaba`, `moonshot`, `local`, etc.).

This makes DeepSeek through OpenCode different from DeepSeek through the direct
API while preserving shared model-provider statistics.

Example:

```powershell
node src/cli.mjs run --provider codex --profile local-worker --level mvp --task-file packet.md --project "<project-path>"
```

Every provider requires an explicit named subscription profile. Profiles define
the provider model, native instruction mode, turn/tool limits, and read-only
policy. Claude uses `CLAUDE.md` and `.claude/`; Kimi uses its native config,
`KIMI_CODE_HOME`, and project skills/agents.

The distributed `policy.json` contains provider adapters and operational-level
limits, but no personal profiles or model assignments. Onboarding writes those
assignments to a local policy file and selects it with `AGENT_GATEWAY_POLICY`.
The local file is an overlay: new or updated adapters continue to come from the
replaceable release, while local profile/model assignments survive upgrades.
Relative data, policy, and temporary paths resolve from the AgentGateway
installation directory; absolute paths are accepted only as explicit local
configuration.

`model-providers.json` is the non-secret onboarding catalog. It records which
harnesses can carry each model provider and supplies direct API connection
templates where the shipped adapter supports them. Model IDs remain local and
are selected during onboarding.

An OpenCode model uses its native `provider/model` identifier. OpenCode runs
with a temporary home, copied authentication only, no global plugins, and
profile-driven permissions. Cursor uses non-interactive JSON output; write
profiles receive `--force`, while read-only profiles do not.

OpenCode Desktop and OpenCode CLI are separate installation surfaces. A
working Desktop application does not guarantee that the `opencode` command is
available to AgentGateway. On Windows, install the official CLI package with
`npm install -g opencode-ai`, verify `opencode --version`, and then run a small
Gateway smoke call with the model selected during onboarding.

The `openai-compatible` adapter is intended for bounded roles that do not need
an agent's filesystem tools, such as classification or structured analysis.
Its local profile contains connection metadata only; secrets remain in a named
environment variable:

```json
{
  "baseUrl": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "modelProvider": "deepseek",
  "model": "deepseek-v4-flash",
  "reasoningEffort": "low",
  "passReasoningEffort": true,
  "readOnly": true
}
```

For a local OpenAI-compatible server, set `allowAnonymous` to `true` and use a
loopback `baseUrl`, for example `http://localhost:11434/v1` for Ollama. Inline
API keys in policy files are rejected.

Capture authentication/quota status for all providers:

```powershell
node src/quota.mjs
```

The supported runtime is Node.js 24 or newer. Cross-component backup and restore
are exposed by Workflow Platform; Gateway never puts auth files or full model
output into that snapshot.

## License

AgentGateway is open-source software licensed under the standard MIT License.
Copyright 2026 Petr Tsap.
