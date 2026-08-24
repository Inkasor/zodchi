# Changelog

All notable changes to Workflow Platform are recorded here. The version in
`package.json` is the authoritative component version.

## [0.2.3] - Unreleased

- Separated replaceable release code from shared local configuration and SQLite state.
- Added shared-installation configuration with an external local data root.
- Replaced persistent release backups with a transient rollback removed after a successful atomic replacement.
- Stored local provider assignments as an overlay over replaceable release adapters.
- Added a locally activated BSL Language Server gate for 1C workflows, with Git-revision baselines stored as normalized SQLite diagnostics.
- Added the versioned BSL 1.0.7 diagnostic catalog and project policies: new critical correctness defects block ordinary work, maintainability findings remain advisory, and security modes add vulnerabilities and security hotspots.
- Removed the ungrounded generic 1C source-structure gate; Stejmins build and target runtime remain separate project bindings.

## [0.2.2] - Unreleased

- Preserved execution harness and model provider as separate workflow statistics.
- Allowed secret-free API environment-variable references during local onboarding.
- Taught onboarding and release validation about OpenCode, Cursor and direct OpenAI-compatible profiles.

## [0.1.0] - Unreleased

- Added one universal normalized quality contract for `prototype`, `mvp`, `production` and `security-audit`, with per-level budgets, deterministic checks, correction limits, reviewer escalation and documentation evidence.
- Moved workflow-wide call, correction and time budgets into Workflow Platform while keeping AgentGateway calls individually bounded.
- Added fail-closed quality-policy and semantic-contract linting, quality-aware document operations and generated package version 2 contracts.

- Captured the Project R-oriented prototype as a non-release baseline.
- Began portable product hardening under `OneManCompanyGoalPlan.md` version 1.0.0.
- Adopted the standard MIT License, copyright 2026 Petr Tsap.
- Replaced machine-specific runtime defaults with installation-relative and locally confirmed configuration.
- Added local onboarding for project, workflow, provider-profile and model assignments without embedding secrets.
- Added an allowlist-based reproducible release builder, checksum manifest and fail-closed release-lint.
- Removed Project R-specific defaults and migration experiments from the universal runtime source.
- Added checksum-verified numbered SQLite migrations, normalized runtime entities and fail-closed legacy-database handling.
- Added closed task, workflow, step and attempt state vocabularies with checked transitions, immutable events and completion blockers.
- Included both component migration chains in reproducible release builds.
- Added idempotent inbox events, atomic expiring leases, independent attempts, sequential per-run execution and parallel independent-task checkout.
- Added pause/resume/cancel, crash recovery, bounded retry, dead-letter escalation and approval-gated replay of irreversible work.
- Added transactional project/task/workflow/role/attempt budget reservations that hard-stop before provider invocation.
- Replaced keyword routing and confirmation regexes with a strict registry-backed classifier contract and fail-closed output parsing.
- Replaced hidden document/material scanning with deterministic registered discovery, explicit role permissions and opt-in Git snapshots.
- Added stable-prefix classifier context with accepted decisions, pending interactions and byte-budgeted ordered conversation history.
- Added versioned portable role contracts with separate local Gateway profile assignments, strict planner/worker/reviewer/documentator result schemas and contract/result hashes.
- Added a structured execution chain in which planner questions stop before work, workers receive only normalized packages, registered project gates remain authoritative and reviewer rejection blocks completion.
- Reworked the generic Documentator to enforce registered authority, permissions and exact document versions, lint a same-directory temporary file and replace atomically without partial writes.
- Removed implicit package-manager gate discovery; only project checks registered for the artifact type and operational level may run.
- Replaced regex XML handling with a strict bounded XML envelope parser and canonical JSON payload for complete portable workflow packages.
- Added semantic-key export, local-ID import mappings, dependency/collision/version validation and hash-bound proposal/diff/apply with explicit confirmation.
- Added controlled experience observations, four bounded proposal types, anonymized scenario evaluation and confirmed patch-version application with quality/cost/time comparison.
- Added separate portable Indie Studio packages for Project M and Project R, plus Shared Map Engine, Shared Lore and a disabled-by-default 1C development contract skeleton.
- Added deterministic generated-package verification and contract tests for human acceptance boundaries, clean imports and 1C green/red/timeout/unavailable outcomes.
- Added real hook/project evidence runners, normalized per-run statistics, package-prefixed portable profile keys and independent Codex/Claude/Kimi adapter contracts without fallback.
- Made imported workflow IDs executable from the local registry, bounded complete role prompts correctly, and made Windows registered `.cmd` gates deterministic.
- Separated Shared Map Engine core suites from locally registered M/R consumer compatibility and preserved Lore/asset owner approval boundaries.
- Added checksum-bound two-database backup and non-overwriting integrity-checked restore.
- Added six portable company workflows for Marketplace Data, Dashboard, Photo Hub, Mapping Hub, Interior Hub and company operations.
- Added a semantic company bundle manifest with package hashes and staged activation metadata.
- Added classifier-driven project route selection for hooks that are not pinned to one workflow.
- Bound structured execution to the selected workflow roles and checks, and stopped irreversible deployment or access routes before productive calls without owner approval.
