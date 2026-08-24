# Changelog

All notable changes to AgentGateway are recorded here. The version in
`package.json` is the authoritative component version.

## [0.3.1] - Unreleased

- Resolved the native OpenCode executable on Windows without shell interpolation.
- Verified the OpenCode Desktop-selected free model through the real CLI and Gateway receipt path.
- Made local policies profile overlays so release adapter updates do not overwrite personal assignments.

## [0.3.0] - Unreleased

- Separated the execution harness from the model provider in receipts and statistics.
- Added OpenCode and Cursor Agent CLI harness adapters.
- Added a secret-free OpenAI-compatible HTTP adapter for DeepSeek, xAI, Gemini, Z.AI, Qwen and local endpoints.
- Kept API keys in named environment variables and rejected inline keys in local policy profiles.
- Added an isolated OpenCode home with copied authentication only, disabled plugins and profile-driven permissions.

## [0.2.0] - Unreleased

- Reduced every operational-level task to one provider call with no Gateway-owned correction cycle; Workflow Platform now owns total workflow budgets, corrections, checks and reviewer escalation.

- Captured the multi-provider prototype as a non-release baseline.
- Began portability, receipt-schema, provider-isolation, and contract hardening.
- Adopted the standard MIT License, copyright 2026 Petr Tsap.
- Replaced machine-specific data, policy, provider-home and temporary paths with portable resolution.
- Removed personal profiles, concrete models, duplicate entry points and Gateway-owned gate pipeline logic from the universal source.
- Added restricted, marker-owned ephemeral homes with minimal auth/config allowlists and cleanup coverage.
- Added portability and cleanup tests.
- Replaced runtime schema mutation with checksum-verified numbered SQLite migrations and fail-closed legacy-database handling.
- Reduced the Gateway database to providers, immutable technical receipts and provider status snapshots.
- Stopped persisting provider prompts, full output, stderr, account identifiers and workflow/gate state; retained only whitelisted metrics, hashes, compact failure categories and references.
- Added independent Codex, Claude Code and Kimi adapter contract tests that preserve provider identity and prove failed calls do not fall back.
- Made AgentGateway profile names local receipt identifiers and wrote the selected Codex model, reasoning effort and sandbox directly into each isolated ephemeral home.
