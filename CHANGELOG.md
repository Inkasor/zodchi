# Zodchi changelog

[English](CHANGELOG.md) · [Русский](docs/ru/CHANGELOG.md)

## Unreleased

- A workflow declares the quality it was built for, and that declaration is now a floor: the classifier may raise a routed run above it but never below, because a lower level drops the checks the workflow depends on.
- The hook can deliver a prepared answer as the final word instead of advisory context. In `final` delivery mode it ends the turn and shows the answer directly, so the chat cannot repeat research the run already paid for; `advisory` stays the default.
- Every clarification is settled by the next message: the one the classifier answers is approved and anything older is superseded. Pending clarifications used to accumulate, so a later classifier read questions the user had already answered as still open.
- The classifier prompt keeps the whole invariant contract above the run state, and the contract now states what each output field means and how a planning level and quality mode are chosen. A provider can reuse the prefix, and the same message no longer draws a different level twice.
- Delivery mode is chosen per project on the hook command, because hooks are installed per project.
- Project Lore records a LORE-CHANGE card in `docs/decisions` before the owner decides, so a candidate that stays open or turns out to be a conflict still leaves a durable record without reaching canon. The change workflow also asks for the candidate scope and the impact on both projects, and every level keeps the owner gate.

## 0.3.0-beta.8 — 2026-08-24

- Run statistics report the entry point the run came from. The per-call `harness` field repeated the gateway provider and read as the chat client, so a Claude Code run was reported as Codex; it is replaced by `client` on the run.

## 0.3.0-beta.7 — 2026-08-24

- The harness is identified by the only fields that differ between the two hook payloads: Codex names the turn and the model, Claude Code names the prompt. Both send the same session id, transcript path and permission mode, so a Codex turn is no longer recorded as Claude Code.
- The hook records the field names of the event it received, so the sending harness stays identifiable from the run history alone.
- The instruction returned to the harness states plainly that the turn is already complete and is repeated after the result, because hook output is advisory context in both harnesses and a chat that researches the answer again charges the user twice.
- Classifier and researcher receipts carry the workflow run they belong to, which only the structured work steps recorded before.

## 0.3.0-beta.6 — 2026-08-24

- The classifier is offered only the work types a project actually routes, plus conversation and clarification, so a narrow project can no longer be classified into a route it does not have.
- Conversation, clarification and research answers no longer require a registered workflow route, because they are delivered directly and never enter a workflow.
- A check that cannot run no longer blocks a workflow: it is reported as unavailable, and gate coverage is measured by the executable required checks instead, so a project is blocked only when nothing can actually verify it.
- 1C and company operations gained an executable secret scan at prototype and MVP, because neither package had a check that could run.
- Project M, Project R, Shared Map Engine, Shared Lore and 1C gained the entry points their roles already supported: fix, documentation and verification runs.
- Company workflows route verification and testing to a checks-and-review run instead of leaving them unroutable.
- Indie release and playtest run at production quality, the prototype workflow runs at prototype quality, and the 1C review step is required.

## 0.3.0-beta.5 — 2026-08-24

- Claude Code events are recognized by identifiers the harness actually sends, so runs started from Claude Code are recorded under their own client instead of falling back to Codex.
- The shipped Claude Code settings template uses the exec command form, which keeps Windows paths intact when the hook starts.

## 0.3.0-beta.4 — 2026-08-24

- Claude Code joins Codex as a supported chat entry point through one shared UserPromptSubmit hook.
- Renamed the hook entry to hooks/user-prompt-submit.mjs and kept the former Codex filename as a compatibility entry for existing installations.
- Hook results now expose additionalContext at the top level of the hook output, which is where Claude Code reads it.
- Workflow runs record the originating client, and Claude Code prompt identifiers are used for duplicate-delivery protection.

## 0.3.0-beta.3 — 2026-08-24

- Added conversation-language resolution across hooks, workflow state, model prompts, questions, and final responses.
- Human-facing project documents are now available in English and Russian; machine-facing semantic instructions use English.
- Removed duplicate component readmes, changelogs, and license files left from the former separate repositories.
- Updated the release builder and linter for the unified product layout.

## 0.3.0-beta.2 — 2026-08-24

- Added English and Russian human introductions with a one-link setup flow.
- Reworked installation and update procedures as LLM-operated instructions and added verified GitHub Release installation.
- Added a portable workflow for developing Zodchi itself.
- Defined a single Codex project layout: development sources as the primary folder, installed release and local data as secondary folders.

## 0.3.0-beta.1 — 2026-08-24

- Created the first public snapshot under the Zodchi name.
- Combined WorkflowPlatform and AgentGateway in one repository while keeping their runtime responsibilities separate.
- Added portable workflows, quality modes, classification, documentation, and deterministic project checks.
- Kept personal databases, model assignments, projects, credentials, and run history outside the release.
- Added reproducible release assembly, content validation, checksums, and recoverable updates.

The full experimental history before the public snapshot remains only in the author's local repositories.
