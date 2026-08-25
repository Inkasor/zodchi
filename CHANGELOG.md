# Zodchi changelog

[English](CHANGELOG.md) · [Русский](docs/ru/CHANGELOG.md)

## 0.3.0-beta.14 — 2026-08-25

- A run whose decision follows its work is now continued instead of refused. The remaining phases need the plan, the verification and the review, and all three are already recorded, so the run resumes from what it holds rather than from its objective. Re-entering from the objective was the only path available before, and it would have repeated — and paid for — every step already completed, so approving such a run was recorded and left there.
- Continuing costs exactly the phase the decision was blocking. No worker, verification or review step is executed a second time.
- The example package's version now says that its content changed. The declared step templates changed in the previous release while the version stayed where it was, so two different packages carried the same version and an upgrade could not tell them apart.
- A work type the project registered is accepted even when the platform's own fallback list predates it. A package may register the work types its routes need, and the run was still judged against a frozen list, so a route every catalog offered could never start. The registry is now the authority; the list is only what a caller without one falls back to.
- A workflow whose every step is named for verification has a role to run it again. Excluding steps named for testing keeps the verification phase's own work out of the worker steps, but applied to a route that is nothing but such steps it left nothing to execute.
- A required document that several registered documents could satisfy now says that the workflow needs a planning step, which is what settles the choice, instead of reporting an ambiguity with no stated remedy. The registered documentation update declares that step.
- The example package states its own version instead of inheriting the shared default. That default also stamps every role contract in every package, so raising it to describe one example change silently re-versioned all of them.

## 0.3.0-beta.13 — 2026-08-25

- A workflow that declares its steps is executed as declared, with no planning call at all. Its author already named the roles, the order, the artifact types and the checks; asking a model to invent that again is what let a plan name steps the route does not have. A declared planning step still runs, because a change needs the paths and objectives only the message can supply.
- Nothing in that derivation can produce an allowed path, and a worker without one may change nothing, so a workflow whose worker roles may write must declare a planning step. This is now asserted for every package, and the least-privilege access change workflow gained the planning step it was missing.
- An owner decision has three outcomes, not two. A person asked to authorize an action can also be neither agreeing nor refusing: doubting, asking back, agreeing in part. Only an unambiguous yes continues the waiting run; a refusal closes it; anything else leaves the decision open and answers the person. Reading hesitation as consent would take an action that was never authorized.
- A granted approval continues the run that asked for it instead of starting a new one. The confirming message classifies as a conversation, so the paused run supplies its own objective and classification; nothing could resolve these approvals before, and every message started over.
- The roles a route may execute after an owner decision are now known. Only the steps before the decision were ever named, so a granted approval left the route with nothing to run.
- A pending interaction is offered to the classifier under its real kind, which is what separates a question from a decision on an action.

## 0.3.0-beta.12 — 2026-08-25

- A role assignment now records which portable requirement it satisfies. A package names a requirement key and onboarding creates a local profile, so comparing the two by equality left most role contracts unloadable and no project could execute structured work at all.
- The result schema a role is judged against is now written into its own prompt, from the same source the validator reads. The prompt said "matching this schema" without ever showing it while the validator demanded an exact field set, and a test now fails if the two ever drift apart.
- Recorded decisions are bounded in a role's context the same way artifacts already were, and history gives way before authority when a prompt has to be trimmed. Every run records a decision, so a project used to grow until nothing fit and then stopped working the more it had been used.
- Planning is a declared step of a workflow rather than a platform role assumed to exist, and a workflow that declares its shape without a planning step now says so instead of reporting a missing role.
- The planner is given the roles the route may execute, each one's purpose, boundaries and permitted work, and the phases that run after its steps. It was validated against a list it was never shown, so it named itself, assigned edits to a read-only role, and spent worker steps on work the verification and documentation phases already perform.
- A package must declare a local profile for every portable requirement its roles allow, which is now asserted for every package.

## 0.3.0-beta.11 — 2026-08-25

- Package definitions describe real projects, so their source is now chosen by the `packageDefinitions` setting and this repository ships only the builders and one complete example. A definition file default-exports a function that receives the builder module, so it needs no import path and can live outside the repository; generated packages are written beside their source.
- The package tests assert the contract every package must satisfy instead of the content of any one project, so they run against whichever definitions an installation configured.
- A secret scan and a dependency scan also run on a release. A gate resolves its own level and every level below it, and a security audit sits above production, so bound to the audit alone these never ran at the one moment a project publishes code.
- An irreversible step never carries a role, and where a release acts on the outside world the approval comes before that action. Both are now checked for every package.

## 0.3.0-beta.10 — 2026-08-25

- MarketplacesData verifies that a release actually reached production. The GitHub Actions run for the exact commit, the revision the server is serving and the health of the running service were declared but unavailable; they now call registered project scripts, so the project keeps the server alias, paths and endpoint and the package carries only a script name.
- A production incident runs at production quality in every company web package. The workflow named itself production work while declaring MVP, which required a single check and no independent reviewer.
- MarketplacesData routes live data collection to its own workflow. Collection spends real marketplace requests and no rollback returns them, so a measured dry run and a review come first, the owner then approves the exact endpoint identifiers, and only the approved list may run.
- A collection operator role may never send a write request, widen the approved endpoint list or expose credentials.
- A reversible data change is now also checked against the database itself, not only by the tests and the build it shares with a code change.

## 0.3.0-beta.9 — 2026-08-24

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
