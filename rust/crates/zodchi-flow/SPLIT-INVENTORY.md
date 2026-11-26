# P01 pre-split inventory

The P01 baseline uses Zodchi 1.0.3 at the candidate base `5f6ebd69e4d2bf0a90bfdc5606018266f625af07`. The six P01 paths contain tests, captured fixtures and this report. For the claims register, `F` expands to `rust/crates/zodchi-flow`, `E` to `rust/crates/zodchi-flow-engine`, `C` to `rust/crates/zodchi-cli`, `K` to `rust/crates/zodchi-core`, and `S` to `scripts/e2e/scenarios`. `W(name)` expands to `rust/crates/zodchi-flow-<name>`. Unqualified Rust filenames in the boundary map are relative to `F/src`. Line references are to the pre-split tree.

## Release inputs and build graph

| Package | Pre-split source and test entry points |
| --- | --- |
| P03 | `F/src/research.rs:36` defines `MAX_EXPERT_TEXT_CHARS = 600`. `expert_prompt` at line 599 advertises the limit. The `items[].text` validator at lines 1101–1110 measures Unicode scalar values via `text.chars().count()`. A blank or oversized row yields “Question {q} has an invalid items line.” The fact claim filter at line 1147 uses the same unit and cap. Expert response schema is `roles/research-expert.schema.json`. The scenario file is `S/flow-research.mjs`. |
| P04 | `F/src/code_package.rs:1640,1732,1838` builds the review call, composes its prompt and validates the decoded JSON. The frame and schema live at `F/flows/code-package/v1/review.md` and `F/flows/code-package/v1/review.schema.json`. Check evidence enters via `review_verification` and `review_writer_checks`. The writer's waiting records and review-round processing are in `code_package.rs`. The owner entry points are `F/src/lib.rs:99–103` and `F/src/input.rs:401,421`. The input handler stores `rerun.ownerAnswer`, which the package reads when replaying the writer step. Branch-review and design-brief share `REVIEW_SCHEMA`, `check_review` and `blocking_findings`. |
| P05 | `F/src/executor/claude.rs:228–298` reserves the job, writes `job.json` and `started.json`, then syncs `raw.json` for an answer and `final.json` for the outcome. `F/src/gateway.rs:397` records the validated engine result as `done`. `K/src/claude.rs:154` passes `--no-session-persistence`. `S/flow-claude.mjs` and `S/flow-claude-experts.mjs` set `ZODCHI_CLAUDE_BIN` to `scripts/e2e/fake-claude.mjs` and use fixture homes. `scripts/e2e.mjs` selects `scripts/e2e/fake-codex-flow.mjs` via `ZODCHI_CODEX_BIN` for the local gateway. Check the one-shot file behavior in P05 before deciding whether cleanup code is needed. |
| P06 | `F/src/control.rs:15,97` reads status and handoff, `Journal::active` in `F/src/journal.rs:151` tests `lock/owner.json` and `worker.json` against process identity via `K/src/process.rs`. `control::launch` at line 161 writes the worker receipt and `worker` at line 228 writes its completion receipt. `F/src/lib.rs:57,79` owns help and top-level dispatch. |
| P07 | `F/flows/design-brief/v1/plan.json` and `facts.json` define the plan and fact response schemas. `F/src/design_brief.rs:544–565,623–635,726` builds the plan/facts researcher requests and validates them. `F/src/design_material.rs` resolves pinned files and `retain_verified_facts` validates quotes. `save_result` in `design_brief.rs:850–873` totals accepted and rejected facts from the `facts N` outputs. |
| Workspace | `rust/Cargo.toml` and `rust/Cargo.lock`. `rust/crates/zodchi-cli/Cargo.toml:15` depends on the facade. `rust/crates/zodchi-server/Cargo.toml` depends on `zodchi-core` and has no flow dependency. |
| Full release verification | `docs/verification.md:139` documents `cargo build --release --locked --manifest-path rust/Cargo.toml` followed by `node scripts/e2e.mjs --no-build`. `package.json`, `docs/flow-server.md:134` and `scripts/e2e.mjs:6` also expose the full suite via `node scripts/e2e.mjs`. P01 runs the two changed scenarios by name. |

`cargo tree --manifest-path rust/Cargo.toml --locked --workspace -i zodchi-flow` returned `zodchi-flow v1.0.3 ← zodchi-cli v1.0.3` on the candidate. The CLI enters the facade from `C/src/main.rs:497–502`. The P27 rebuild expectation after touching a workflow implementation is that workflow crate, the facade, and the CLI. The engine, its sibling workflows, and the server should stay fresh. Use the same workspace graph, Cargo profile and feature configuration for the warm build and the touched build.

### Server reattachment

The client owns re-entry. `F/src/lib.rs` dispatches `--resume` through `control::resume` and the workflow runner. `F/src/gateway.rs:324–346` freezes the request and appends the intent before `Executor::submit`. The cut follows the POST and precedes the `submitted` event. On resume it reads the stored intent and `Server::exists` checks origin before GET by key. `F/src/executor/server.rs:207,370,397,422,515,535` finds and checks the journaled request/digest, compares server and authenticated `GET /v1/account` user, looks up the exact key, repolls it and fetches its result. A 404 only replays a recent intent when there is no submitted receipt and the origin matches. `gateway.rs` validates the data and journals the `done` receipt. See `docs/flow-server.md:70–89` for the replay rules.

On the server, `rust/crates/zodchi-server/src/api.rs:442–559` stores by tenant and key, returns the existing job for the same request fingerprint, and spawns the worker on new creation. `find`, `job` and `result` in that file serve the lookup, poll and answer. The `created` flag reports admission. Job identity is the server and tenant, key, and stored `createdAt`. `rust/crates/zodchi-server/src/public.rs:117–137` includes `workerPid` and `turnStartedAt` in the lookup response.

`S/flow-server.mjs` instruments the existing `flow-server-approve` cut with a local HTTP observer. It checks one POST before cut, a successful GET for the same key on resume, one additional POST for review, the pinned server/account and request bytes, the same remote job and worker/turn, one fake writer turn and one fake reviewer turn, and one persisted write receipt equal to the result fetched by key. The existing approved result, local commit, schema, claim and privacy assertions still run. See the baseline commands below for the local verification status.

The isolated Windows check run recorded client origin `http://127.0.0.1:56836`, fixture account `flow-user-7b2e49` and journal key `flow-20261126-213931-7937d1-write`. Both lookups resolved that key to the job created at `2026-11-26T21:39:32.443Z`. The write kept worker PID `1616` and turn start `2026-11-26T21:39:33.387Z`. The trace showed two POSTs, one write receipt equal to the same key's result, turns `write` and `review 1`, and an approved exit 0. These identifiers are run-specific. The assertions compare the corresponding identities within each run.

## Boundary map for P02 approval

Engine boundaries below use neutral artifacts and callback parameters for lifecycle actions. The facade owns CLI selection and workflow-specific routing. Keep any pre-split public signatures under the explicit paths in `F/tests/public_paths.rs`.

| Caller → callee today | New owner | Compatibility route |
| --- | --- | --- |
| `checks.rs:443,1303`, `gateway.rs:337`, `code_package.rs:355,529,1216,1422,1553,1575`, `executor/claude.rs:92,139,249` → `cut`. The candidate apply path, cleanup, acceptance, asset-round, design-brief, incident adapter/triage, method-question, ops-script, research, Unity and video paths also call it | Engine crash-test helper | Keep exact cut names, call positions and code 75. Re-export `CUT_EXIT` at the facade root and `code_package::CUT_EXIT`. Share the helper with the Claude executor. |
| All starts, resumes and controls → `code_package::Exit` (commonly via root `Exit`) | Engine result type | One type, re-exported at both public paths. |
| `journal.rs:74–99` → `code_package::WORKFLOW`, `cleanup::{lock_sources,note_package_home}` | Engine source-journal lifecycle | Preserve source lock order and code-package home registration from the journal's wire name. Preserve `Journal::create` and its behavior for external callers. |
| `executor/server.rs:30,457` → `code_package::{WRITER_GATEWAY_ROLE,REVIEWER_GATEWAY_ROLE}`. `budget.rs:55,123` → reviewer role, package name | Engine frozen request, role and budget contract. Facade CLI budget policy. | Keep paired server preflight for the package roles and the budget classification of review events. Re-export the original constants from the package compatibility module. |
| `gateway.rs:219,223,296` → `input::{model_context,scrub,Scrubber}`. `research_material.rs:69,95` → `input::Scrubber`. Agent, research, design material and incident adapter use the same screening. | Engine scrubber and neutral journal reads | Keep one screening implementation and the same serialized owner remarks/clarifications. Facade input dispatch calls the shared primitives. |
| `asset_round.rs:236,254,260,377`, research and incident → `input::{args_digest,args_match}`. `control.rs:202` → `args_match` | Engine input matching | Canonical sorted-object hash when `argsSha256` exists, otherwise compare legacy `inputs.args`. Keep the digest fields. |
| `branch_review.rs:671,722,740` and `design_brief.rs:438,586,642,644` → `code_package::{REVIEW_SCHEMA,check_review,blocking_findings}` | Engine shared review contract | P02 pins the pre-split shared schema in `F/flows/shared-review.schema.json` and routes both consumers through the shared module. P04 can then evolve the code-package schema and policy independently. |
| `branch_review.rs` and code-package candidate workflow → `package_source::Source::load` and `review_source::screen` | Engine source receipt readers and screening | Load a pinned code-package source by its wire formats, with receipt/commit checks. Keep candidate apply implementation with code-package and preserve the source read API used by branch-review. |
| `asset_round.rs:438–461` → `code_package::start_child`, `unity_check::start_child`, `rubric_probe::start_child`. `ops_script.rs:910–916` → package start/resume | The parent chooses start/resume and the ID. The facade binds the calls through the child adapter. | Keep the protocol detailed below. Use injected child entry points for Unity/rubric. The adapter follows the existing control resume path as required by P12. `start_child` stays outside the pre-split facade API. |
| `branch_review.rs:297`, `design_brief.rs:34`, `ops_script.rs:727`, `code_package.rs:362`, `acceptance/mod.rs:56`, `asset_round.rs:25`, `incident_triage.rs:496`, `method_question.rs:79`, `research.rs:73`, `rubric_probe.rs:33`, `unity_check.rs:34`, `video.rs:34`, `voiceover.rs:248`, `workspace_audit.rs:24` → `control::launch` | Engine launch + facade `_worker` and paid-key policy | Supply the workflow's existing launch policy to the common worker launch. Keep the command, identity receipt, already-active status, and detach exit codes. |
| `video.rs:36,356` → `control::status` | Engine status snapshot with video projection | Use the same status snapshot and video projection for CLI status and video start/resume. Video can apply its projection without importing the facade. |
| `control.rs:15–94` → candidate application status, ops-script `checked_result`, video/YouTube `status_detail`, voiceover error/charge details | Engine common status read, facade workflow hooks | Preserve receipt sampling before journal snapshot and existing fields. Let ops revalidate the saved result and let media workflows project details using their own code. |
| `control.rs:97–150` → YouTube handoff, the three acceptance handoffs and branch-review head/screening/review metadata | Facade routing with workflow projections | Keep status and handoff JSON shapes, including `safetyBlock`, and keep the journal version/head fields. |
| `control.rs:161–194,228–258` → start worker with paid key for rubric/asset/voiceover only when recorded `policy.paid`. The ops-script worker redacts errors. `resume_workflow` dispatches all 17 names. | Facade registry policies, engine executor | Keep `Exit` values, worker receipt shape and saved workflow/version/args checks. All entry points pass the original rerun scope and retain safety-block handling. |
| `control.rs:219`, `journal.rs:74`, `cleanup.rs` and `lib.rs` → post-run cleanup, source locks, candidate apply and budget entry | Engine common retention/cleanup, facade routes, code-package application | Keep cleanup after eligible runs and preserve the claim-open and source-retention rules. Route `apply` and budget extension without pulling the package crate into the engine. |
| `cleanup.rs:530,1261` → `candidate::{applied,WORKSPACES_DIR}`. Cleanup's workspace tests also use `candidate::workspace` | Engine candidate receipt and directory reads | Share the existing path and applied-event decoder with candidate application. Keep application and its side effects in code-package. |
| `input.rs:28–46,431–469` → research `reply_text`, design-brief decision flags, video/YouTube JSON and `record_reply`. YouTube accepts a reply in the waiting state. | Facade reply routing, workflow validation hooks | Keep text clarification for stopped runs, budget/scope guards and reply event format. Keep dedicated text screening for research and JSON/media owner-words handling for video/YouTube. Scope, remarks and common recording stay shared. |
| `youtube_publish/mod.rs:87` → `video::accepted_upload`. It uses `Video::open`, `video_manifest::load` and `Video::assert_artifact`. Acceptance, video, voiceover and YouTube → `video_media`. Acceptance and rubric → local executor `pinned_image`. | Engine accepted artifact reader and neutral media/tool utilities | Share the read-side video plan and directory checks, journal lock, manifest recovery and artifact verification. Preserve the approved verdict, accepted manifest and render ID checks. Keep video manifest transitions and rendering in the video crate. |
| Workflow starts → `catalog::require`, `args::is_project_configuration` → catalog path, `lib.rs:79–193` → CLI catalog and workflow start/resume/subcommands | Engine project-catalog loading and policy, facade compiled registry and help | Keep project enablement pinned to the Git revision and project catalog wire shape. Delegate video/voiceover/YouTube subcommands through the facade. |

### Child protocols and observed outcomes

- **Asset-round.** `F/src/asset_round.rs:249–280` checks a finished parent step first. For a saved `child intent`, it checks canonical args and takes its ID. Otherwise it allocates `new_run_id` and appends intent with `step`, `attempt:1`, `runId`, `workflow`, and `argsSha256`. It checks the run folder and calls `control::resume(name, id, Some(args), None, false)` when it exists. A successful or terminal child is recorded as parent `done`. The context cut leaves the same child directory and zero `initialized` markers. Resume enters that child's code-package resume path, returns exit 1 naming its missing `brief.md`, and leaves the parent without a result. **Trigger P01b.**
- **Ops-script.** `F/src/ops_script.rs:851–931` looks for the first `ops-repair` event matching the current failed attempt before deciding repair scope. It allocates one fresh run ID via `journal::new_run_id`, writes `repair-<attempt>-<child>.md`, derives the label `ops-<parent>-<attempt>`, and appends `ops-repair` with the attempt, child and frozen args before invoking `start_child`. On a later entry it takes the recorded ID and args first. Existing `initialized` permits the current direct `code_package::resume`. Its absence returns exit 2 and `unresolved` at `repair <attempt> (<child>)`, without calling the child. `resume` at lines 976–999 routes a recorded failed effect back through `failed` before checking tools or taking a fresh snapshot. The context cut leaves one child folder with zero initialized markers. Re-entry preserves that ID and unresolved outcome. **P01a is inactive.**
- **Independent observation.** `F/tests/characterization.rs` records Git Trace2 `check-ignore -q -- .agent-tmp/gateway/` invocations outside both journals. With these same valid child args this gate runs once per `start_run`, before journal creation, so it also counts a start that fails to create a duplicate journal. Resume takes no such gate. Both tests observe exactly one gate across initial start and parent re-entry, pin the parent intent to the child ID, inspect unchanged child records, and assert zero fake model turns. The asset-round test also probes with a different saved child label and requires the exact rejection from `control::resume`. After restoring the journal bytes it gets the missing-brief error from the original child. The ops-script test pins the failed static receipt before the repair intent and the uninitialized guard's unresolved outcome. Preserve that guard and route initialized repairs through control in P12.
- **Cut placement.** `F/src/code_package.rs:208–212,263–267,354–362` passes the chosen ID into `start_run`, checks ignore rules, creates the journal with `run.json` and `events.jsonl`, cuts, writes `brief.md` and optional `REVIEW.base.md`, then writes `initialized`. `resume` at lines 373–419 reads the frozen args and journal brief. Both baseline tests assert the observed behavior and pass. P01b owns the new successful recovery expectation.

## Test matrix

`F/tests/characterization.rs` invokes the real sibling CLI, with isolated Git repos and homes and the repository's fake Codex via `ZODCHI_CODEX_BIN`. It covers the control commands, help and catalog views, invalid calls, all 17 starts and both child cuts. The local submit case checks exit codes for a wrong workflow and changed args, then completes the saved run via `_worker` and compares its receipt to the result of another `--resume`. `F/tests/fixtures/pre_split/journals.json` stores each captured `run.json`, the ordered complete events and stable CLI observations. Paths have fixture aliases. IDs, digests and timestamps are captured example values. The archive test reconstructs the two journal files and checks status and handoff. Full resume tests use live fixtures because resume also requires the pinned repository, tools and per-workflow material. Player checks the refusal on other platforms. Ops-script checks the platform or root refusal where the local dry-run boundary is unavailable. All 17 archived journals are read on every platform. Voiceover uses its offline missing-auth stop. YouTube stops before OAuth. Rubric stops before a decision call.

Every crash hook has a representative label. Each parameterized site uses one example step and attempt. Entries in existing scenarios are baseline coverage by source inspection. The command log below identifies which scenarios actually ran locally.

| Cutsite | Re-entry coverage |
| --- | --- |
| `checks.rs`: `check export staging`, per-command `{step} {source} #{n}` | `S/flow-cleanup.mjs` staged export and `S/flow-check-slot.mjs` cheap check before verify. |
| `code_package.rs`: child context, result, apply step, checks step, index, commit | Child tests above. `S/flow-entry.mjs` covers result and commit, `S/flow-edits-recovery.mjs` covers apply and index, and `S/flow-check-slot.mjs` covers checks. |
| `gateway.rs`, `executor/claude.rs`: `submit {step}`, `claude reserved` | `S/flow-entry.mjs` covers local submission, `S/flow-server.mjs` covers server submission and replay, and `S/flow-claude.mjs` covers submit and reservation. `screened_claude_submit_cut_reuses_the_receipt` covers the separate expert submit in `ask_screened`. |
| `candidate.rs`: candidate files/index/branch | `S/flow-isolated.mjs` applies after each of the three cut labels. |
| `cleanup.rs`: journal retired | `S/flow-cleanup.mjs` journal retention resumes cleanup. |
| `acceptance/`: checkout staging, fixture recorded, fixture started, model and receipt | `S/flow-acceptance.mjs` uses staging, fixture readiness, visual-review and test/browser receipt cuts. |
| `asset_round.rs`, `design_brief.rs`, `method_question.rs` | `S/flow-asset-round.mjs` asset ledger, `S/flow-design-brief.mjs` publish design brief, `S/flow-method-question.mjs` start method question. |
| `incident_adapter.rs`, `incident_triage.rs`: read intent/contained, synced/published/completed read receipt, evidence collection, publish, lock stage/owner/published/released/release synced/cleanup | `S/flow-incident-triage.mjs` unresolved-read and recovery. The added evidence cut pins the file before classifier intent and compares the published bytes and digest after resume. |
| `ops_script.rs`: ops-start, ops-effect, ops-done, ops-repair | `S/flow-ops-script.mjs` covers recovery and repair. `ops_cut_after_snapshot_effect_does_not_repeat_it` covers the new representative between the snapshot effect and its completion event. |
| `research.rs`: lock prepared/published/released and research decisions | `S/flow-research.mjs` lock cuts and owner resume. |
| `unity_check.rs`: before and after durable editor receipt | `S/flow-unity-check.mjs` editor and done editor. |
| `video.rs`: render exited | `S/flow-video.mjs` probe exited then finish and accept render. |

`F/tests/public_paths.rs` is an external Rust consumer compile gate. It pins the item paths, function signatures, callback types, public fields, enum cases, constants and the `Executor` trait and implementations for all public modules in `lib.rs`. Keep these re-exports even when current internal callers move. New inter-crate dispatch and child wiring get their own paths.

## Claims register

Paths below are exact claims after expansion of the prefixes above. A move claims its source and destination. The register is the proposed authorization boundary for each later package. Approve the boundary map first and reconcile this table with the lead's active-package ledger at admission. The private P01 candidate exposes no active writer claims for other packages. If an approved implementation needs another file, withhold that package until the lead approves the additional path and rechecks overlaps.

In the P10–P26 rows the arrow pairs give the old and new paths. Existing named e2e files are reserved with their owning changes when a path or expected behavior changes. The shared roles under `roles/`, catalog data and e2e fixture tooling remain at their existing repository-level paths except where an explicit claim below lists a change.

| Package | Exact claims |
| --- | --- |
| P01 | `F/tests/characterization.rs` `F/tests/public_paths.rs` `F/SPLIT-INVENTORY.md` `F/tests/fixtures/pre_split/journals.json` `S/flow-server.mjs` `S/flow-incident-triage.mjs` |
| P01a (inactive) | `F/src/ops_script.rs` `F/tests/characterization.rs` `S/flow-ops-script.mjs` |
| P01b | `F/src/asset_round.rs` `F/src/code_package.rs` `F/tests/characterization.rs` `S/flow-asset-round.mjs` |
| P02 in-crate boundaries | `F/src/lib.rs` `F/src/control.rs` `F/src/input.rs` `F/src/input_common.rs` `F/src/boundary.rs` `F/src/child_package.rs` `F/src/review_contract.rs` `F/flows/shared-review.schema.json` `F/src/accepted_media.rs` `F/src/code_package.rs` `F/src/args.rs` `F/src/branch_review.rs` `F/src/budget.rs` `F/src/candidate.rs` `F/src/catalog.rs` `F/src/checks.rs` `F/src/cleanup.rs` `F/src/design_brief.rs` `F/src/design_material.rs` `F/src/gateway.rs` `F/src/journal.rs` `F/src/agent.rs` `F/src/package_source.rs` `F/src/review_source.rs` `F/src/executor/claude.rs` `F/src/executor/server.rs` `F/src/acceptance/candidate.rs` `F/src/acceptance/fixture.rs` `F/src/acceptance/mod.rs` `F/src/acceptance/plan.rs` `F/src/asset_round.rs` `F/src/incident_adapter.rs` `F/src/incident_triage.rs` `F/src/method_question.rs` `F/src/ops_script.rs` `F/src/research.rs` `F/src/research_material.rs` `F/src/rubric_probe.rs` `F/src/unity_check.rs` `F/src/video.rs` `F/src/video_manifest.rs` `F/src/voiceover.rs` `F/src/workspace_audit.rs` `F/src/youtube_publish/mod.rs` |
| P03 expert line | `F/src/research.rs` `F/src/research_lists.rs` `roles/research-expert.schema.json` `S/flow-research.mjs` |
| P04 evidence gaps | `F/src/code_package.rs` `F/src/review_contract.rs` `F/src/input.rs` `F/src/lib.rs` `F/flows/code-package/v1/review.md` `F/flows/code-package/v1/review.schema.json` `S/flow-project-verify.mjs` `F/tests/characterization.rs` `F/tests/fixtures/pre_split/journals.json` |
| P05 Claude one-shot sessions | `K/src/claude.rs` `F/src/executor/claude.rs` `F/src/cleanup.rs` `scripts/e2e/fake-claude.mjs` `S/flow-claude.mjs` `S/flow-cleanup.mjs` |
| P06 runs, wait, skill rule | `F/src/lib.rs` `F/src/control.rs` `F/src/journal.rs` `F/tests/characterization.rs` `F/tests/fixtures/pre_split/journals.json` `S/flow-worker.mjs` `S/flow-entry.mjs` `skills/zodchi-flow/SKILL.md` `plugins/codex/skills/zodchi-flow/SKILL.md` `plugins/claude-code/core/skills/zodchi-flow/SKILL.md` |
| P07 design source facts | `F/src/design_brief.rs` `F/src/design_material.rs` `F/flows/design-brief/v1/plan.json` `F/flows/design-brief/v1/facts.json` `S/flow-design-brief.mjs` |
| X1 prompt screening | `F/src/code_package.rs` `F/src/input_common.rs` `F/src/review_source.rs` `F/flows/code-package/v1/rules.md` `F/flows/code-package/v1/review.md` `S/flow-agent.mjs` `S/flow-branch-review.mjs` |
| X2 validation against quotes and screened goal | `F/src/code_package.rs` `F/src/review_contract.rs` `F/src/review_source.rs` `F/src/design_brief.rs` `F/src/design_material.rs` `F/flows/design-brief/v1/facts.json` `S/flow-agent.mjs` `S/flow-design-brief.mjs` |
| X3 | No package named in the approved list. No claims. Withheld. |
| X4 | No package named in the approved list. No claims. Withheld. |
| X5 | No package named in the approved list. No claims. Withheld. |
| X6 dry run | `F/src/lib.rs` `F/src/args.rs` `F/src/code_package.rs` `F/src/control.rs` `workflows/catalog.json` `F/tests/characterization.rs` `F/tests/fixtures/pre_split/journals.json` `S/flow-entry.mjs` |
| X7 cancel and close | `F/src/lib.rs` `F/src/control.rs` `F/src/journal.rs` `F/src/cleanup.rs` `F/src/code_package.rs` `F/src/claims.rs` `F/tests/characterization.rs` `F/tests/fixtures/pre_split/journals.json` `S/flow-worker.mjs` |
| X8 agent errors, exit 3, usage | `C/src/main.rs` `F/src/lib.rs` `F/src/agent.rs` `F/src/code_package.rs` `F/src/control.rs` `F/tests/characterization.rs` `F/tests/fixtures/pre_split/journals.json` `S/flow-agent.mjs` `S/flow-entry.mjs` |
| X9 skill install for any agent | `C/src/main.rs` `C/src/release/mod.rs` `C/src/release/bundle.rs` `C/src/release/managed.rs` `install/install.ps1` `install/install.sh` `scripts/e2e.mjs` `S/flow-client-plugin.mjs` |
| X10 progress, wave no-build argument, reply size | `F/src/lib.rs` `F/src/args.rs` `F/src/code_package.rs` `F/src/input.rs` `F/src/input_common.rs` `F/src/verify.rs` `F/flows/code-package/v1/agent-rules.md` `F/tests/characterization.rs` `F/tests/fixtures/pre_split/journals.json` `scripts/e2e.mjs` `S/flow-agent.mjs` `S/flow-budget.mjs` `S/flow-entry.mjs` |
| P08 accumulated deltas gate | `F/SPLIT-INVENTORY.md`. Read-only execution of the P01 suite and each package's named delta checks. |
| P09 registry | `F/src/lib.rs` `F/src/control.rs` `F/src/input.rs` `F/src/catalog.rs` `F/src/registry.rs` `F/src/child_package.rs` |
| P10 engine crate | `rust/Cargo.toml` `rust/Cargo.lock` `F/Cargo.toml` `E/Cargo.toml` `E/src/lib.rs` `E/src/control.rs` `F/src/lib.rs` `F/src/control.rs` `F/src/input.rs` `F/src/registry.rs` `F/src/child_package.rs` `F/src/code_package.rs` `F/src/acceptance/mod.rs` `F/src/acceptance/candidate.rs` `F/src/acceptance/fixture.rs` `F/src/acceptance/plan.rs` `F/src/acceptance/process.rs` `F/src/asset_round.rs` `F/src/branch_review.rs` `F/src/design_brief.rs` `F/src/design_material.rs` `F/src/incident_adapter.rs` `F/src/incident_draft.rs` `F/src/incident_triage.rs` `F/src/method_question.rs` `F/src/ops_script.rs` `F/src/research.rs` `F/src/research_material.rs` `F/src/rubric_probe.rs` `F/src/unity_check.rs` `F/src/workspace_audit.rs` `F/src/video.rs` `F/src/video_manifest.rs` `F/src/video_metrics.rs` `F/src/video_research.rs` `F/src/voiceover.rs` `F/src/youtube_publish/artifact.rs` `F/src/youtube_publish/auth.rs` `F/src/youtube_publish/mod.rs` `F/src/youtube_publish/tests.rs`. Moves below. |
| P11 crate skeletons | `rust/Cargo.toml` `rust/Cargo.lock` `F/Cargo.toml` and the two exact files per crate in the skeleton table below. Each workflow manifest declares its final dependencies and features, including target-specific, dev and build dependencies. `F/Cargo.toml` adds normal dependencies on all 15 workflow crates. P11 resolves `rust/Cargo.lock` for this graph. |
| P12 code-package | `F/src/lib.rs` `F/src/registry.rs` `F/src/child_package.rs` `F/src/control.rs` `F/src/asset_round.rs` `F/src/ops_script.rs` `W(code-package)/src/lib.rs` `F/src/code_package.rs → W(code-package)/src/code_package.rs` `F/src/candidate.rs → W(code-package)/src/candidate.rs` `S/flow-server.mjs`. Assets move below. |
| P13 asset-round | `F/src/lib.rs` `F/src/registry.rs` `W(asset-round)/src/lib.rs` `F/src/asset_round.rs → W(asset-round)/src/asset_round.rs` |
| P14 branch-review | `F/src/lib.rs` `F/src/registry.rs` `W(branch-review)/src/lib.rs` `F/src/branch_review.rs → W(branch-review)/src/branch_review.rs` |
| P15 design-brief | `F/src/lib.rs` `F/src/registry.rs` `W(design-brief)/src/lib.rs` `F/src/design_brief.rs → W(design-brief)/src/design_brief.rs` `F/src/design_material.rs → W(design-brief)/src/design_material.rs`. Assets move below. |
| P16 incident-triage | `F/src/lib.rs` `F/src/registry.rs` `W(incident-triage)/src/lib.rs` `F/src/incident_triage.rs → W(incident-triage)/src/incident_triage.rs` `F/src/incident_adapter.rs → W(incident-triage)/src/incident_adapter.rs` `F/src/incident_draft.rs → W(incident-triage)/src/incident_draft.rs` |
| P17 method-question | `F/src/lib.rs` `F/src/registry.rs` `W(method-question)/src/lib.rs` `F/src/method_question.rs → W(method-question)/src/method_question.rs` |
| P18 ops-script | `F/src/lib.rs` `F/src/registry.rs` `W(ops-script)/src/lib.rs` `F/src/ops_script.rs → W(ops-script)/src/ops_script.rs` |
| P19 research | `F/src/lib.rs` `F/src/registry.rs` `W(research)/src/lib.rs` `F/src/research.rs → W(research)/src/research.rs` `F/src/research_lists.rs → W(research)/src/research_lists.rs` `F/src/research_material.rs → W(research)/src/research_material.rs` |
| P20 rubric-probe | `F/src/lib.rs` `F/src/registry.rs` `W(rubric-probe)/src/lib.rs` `F/src/rubric_probe.rs → W(rubric-probe)/src/rubric_probe.rs` |
| P21 unity-check | `F/src/lib.rs` `F/src/registry.rs` `W(unity-check)/src/lib.rs` `F/src/unity_check.rs → W(unity-check)/src/unity_check.rs` |
| P22 workspace-audit | `F/src/lib.rs` `F/src/registry.rs` `W(workspace-audit)/src/lib.rs` `F/src/workspace_audit.rs → W(workspace-audit)/src/workspace_audit.rs` |
| P23 video | `F/src/lib.rs` `F/src/registry.rs` `W(video)/src/lib.rs` `F/src/video.rs → W(video)/src/video.rs` `F/src/video_manifest.rs → W(video)/src/video_manifest.rs` `F/src/video_metrics.rs → W(video)/src/video_metrics.rs` `F/src/video_research.rs → W(video)/src/video_research.rs` |
| P24 voiceover | `F/src/lib.rs` `F/src/registry.rs` `W(voiceover)/src/lib.rs` `F/src/voiceover.rs → W(voiceover)/src/voiceover.rs` |
| P25 YouTube publish | `F/src/lib.rs` `F/src/registry.rs` `W(youtube-publish)/src/lib.rs` `F/src/youtube_publish/mod.rs → W(youtube-publish)/src/youtube_publish/mod.rs` `F/src/youtube_publish/api.rs → W(youtube-publish)/src/youtube_publish/api.rs` `F/src/youtube_publish/artifact.rs → W(youtube-publish)/src/youtube_publish/artifact.rs` `F/src/youtube_publish/auth.rs → W(youtube-publish)/src/youtube_publish/auth.rs` `F/src/youtube_publish/tests.rs → W(youtube-publish)/src/youtube_publish/tests.rs` |
| P26 acceptance (three names) | `F/src/lib.rs` `F/src/registry.rs` `W(acceptance)/src/lib.rs` `F/src/acceptance/mod.rs → W(acceptance)/src/acceptance/mod.rs` `F/src/acceptance/browser_driver.mjs → W(acceptance)/src/acceptance/browser_driver.mjs` `F/src/acceptance/candidate.rs → W(acceptance)/src/acceptance/candidate.rs` `F/src/acceptance/desktop.rs → W(acceptance)/src/acceptance/desktop.rs` `F/src/acceptance/fixture.rs → W(acceptance)/src/acceptance/fixture.rs` `F/src/acceptance/plan.rs → W(acceptance)/src/acceptance/plan.rs` `F/src/acceptance/process.rs → W(acceptance)/src/acceptance/process.rs` `scripts/check.mjs` |
| P27 final build and measurement | `rust/Cargo.toml` `rust/Cargo.lock` `F/Cargo.toml` `F/src/lib.rs` `F/src/registry.rs` `F/SPLIT-INVENTORY.md`. Measure with an ignored scratch checkout and record the files Cargo rebuilds. The P01 API consumer remains a gate. |

### Exact move and skeleton files

P10 engine moves:

| Source | Destination |
| --- | --- |
| `F/src/accepted_media.rs` | `E/src/accepted_media.rs` |
| `F/src/agent.rs` | `E/src/agent.rs` |
| `F/src/args.rs` | `E/src/args.rs` |
| `F/src/boundary.rs` | `E/src/boundary.rs` |
| `F/src/budget.rs` | `E/src/budget.rs` |
| `F/src/catalog.rs` | `E/src/catalog.rs` |
| `F/src/checks.rs` | `E/src/checks.rs` |
| `F/src/claims.rs` | `E/src/claims.rs` |
| `F/src/cleanup.rs` | `E/src/cleanup.rs` |
| `F/src/executor/claude.rs` | `E/src/executor/claude.rs` |
| `F/src/executor/local.rs` | `E/src/executor/local.rs` |
| `F/src/executor/mod.rs` | `E/src/executor/mod.rs` |
| `F/src/executor/server.rs` | `E/src/executor/server.rs` |
| `F/src/gateway.rs` | `E/src/gateway.rs` |
| `F/src/git.rs` | `E/src/git.rs` |
| `F/src/input_common.rs` | `E/src/input_common.rs` |
| `F/src/journal.rs` | `E/src/journal.rs` |
| `F/src/models.rs` | `E/src/models.rs` |
| `F/src/package_source.rs` | `E/src/package_source.rs` |
| `F/src/patch.rs` | `E/src/patch.rs` |
| `F/src/review_contract.rs` | `E/src/review_contract.rs` |
| `F/flows/shared-review.schema.json` | `E/flows/shared-review.schema.json` |
| `F/src/review_source.rs` | `E/src/review_source.rs` |
| `F/src/verify.rs` | `E/src/verify.rs` |
| `F/src/video_media.rs` | `E/src/video_media.rs` |

P10 moves the Claude executor's code-package schema-specific unit test to `F/src/code_package.rs`, which P12 then moves with the schema. The engine owns its stable shared review contract. This keeps workflow assets out of the engine's build inputs.

P11 derives the skeletons' dependency entries from the post-P10 sources and tests assigned to each workflow. Keep the existing facade dependencies needed by its remaining modules and tests, then prune unused entries in P27. P12–P26 use the P11 manifests and lockfile as read-only inputs and run their Cargo checks with `--locked`. If an extraction needs a dependency correction, return it to the lead for a sequential P11 correction before the extraction continues.

P11 skeletons:

| Manifest | Library |
| --- | --- |
| `W(code-package)/Cargo.toml` | `W(code-package)/src/lib.rs` |
| `W(asset-round)/Cargo.toml` | `W(asset-round)/src/lib.rs` |
| `W(branch-review)/Cargo.toml` | `W(branch-review)/src/lib.rs` |
| `W(design-brief)/Cargo.toml` | `W(design-brief)/src/lib.rs` |
| `W(incident-triage)/Cargo.toml` | `W(incident-triage)/src/lib.rs` |
| `W(method-question)/Cargo.toml` | `W(method-question)/src/lib.rs` |
| `W(ops-script)/Cargo.toml` | `W(ops-script)/src/lib.rs` |
| `W(research)/Cargo.toml` | `W(research)/src/lib.rs` |
| `W(rubric-probe)/Cargo.toml` | `W(rubric-probe)/src/lib.rs` |
| `W(unity-check)/Cargo.toml` | `W(unity-check)/src/lib.rs` |
| `W(workspace-audit)/Cargo.toml` | `W(workspace-audit)/src/lib.rs` |
| `W(video)/Cargo.toml` | `W(video)/src/lib.rs` |
| `W(voiceover)/Cargo.toml` | `W(voiceover)/src/lib.rs` |
| `W(youtube-publish)/Cargo.toml` | `W(youtube-publish)/src/lib.rs` |
| `W(acceptance)/Cargo.toml` | `W(acceptance)/src/lib.rs` |

P12 and P15 asset moves:

| Package | Source | Destination |
| --- | --- | --- |
| P12 | `F/flows/code-package/v1/agent-rules.md` | `W(code-package)/flows/code-package/v1/agent-rules.md` |
| P12 | `F/flows/code-package/v1/check-rules.md` | `W(code-package)/flows/code-package/v1/check-rules.md` |
| P12 | `F/flows/code-package/v1/close.md` | `W(code-package)/flows/code-package/v1/close.md` |
| P12 | `F/flows/code-package/v1/fix.md` | `W(code-package)/flows/code-package/v1/fix.md` |
| P12 | `F/flows/code-package/v1/patch.schema.json` | `W(code-package)/flows/code-package/v1/patch.schema.json` |
| P12 | `F/flows/code-package/v1/review.md` | `W(code-package)/flows/code-package/v1/review.md` |
| P12 | `F/flows/code-package/v1/review.schema.json` | `W(code-package)/flows/code-package/v1/review.schema.json` |
| P12 | `F/flows/code-package/v1/rules.md` | `W(code-package)/flows/code-package/v1/rules.md` |
| P12 | `F/flows/code-package/v1/write.md` | `W(code-package)/flows/code-package/v1/write.md` |
| P12 | `F/flows/code-package/v2/patch.schema.json` | `W(code-package)/flows/code-package/v2/patch.schema.json` |
| P15 | `F/flows/design-brief/v1/draft.json` | `W(design-brief)/flows/design-brief/v1/draft.json` |
| P15 | `F/flows/design-brief/v1/facts.json` | `W(design-brief)/flows/design-brief/v1/facts.json` |
| P15 | `F/flows/design-brief/v1/plan.json` | `W(design-brief)/flows/design-brief/v1/plan.json` |

### Order and overlaps

1. P01 → P01b → P02. P01b overlaps P01 on characterization and P02 on asset-round/code-package. P01a stays inactive based on the repair observation.
2. After P02, the disjoint wave in this register is **P03, P05, P06 and X9**. P07 is disjoint from those four and may join the wave. X2 overlaps P07 on design-brief and its scenario. X9 overlaps X8 on CLI dispatch and must land before X8 opens. P05 overlaps X7 on cleanup and P10 on executor and cleanup paths.
3. After that wave, use sequential **P04 → X1 → X2 → X6 → X7 → X8 → X10**. The code-package state machine is a common claim. P04, X6, X7, X8 and X10 also share the CLI characterization files. X1/X2 share screening and the agent scenario. Each package owns the expected delta when its gate changes. P06 owns the top-level help snapshot and CLI expectations, and P01b owns the asset child test. Preserve the captured 1.0.3 run and event records as the archive when updating live expectations.
4. **P08 → P09 → P10 → P11 → P12 → P13 → … → P26 → P27** after the release deltas. Each extraction claims facade module wiring and the registry, so those writers are sequential. The resulting workflow crates build independently. P10/P11/P27 alone reserve the workspace manifest and lockfile and execute sequentially. P12 updates the schema lookup in the server scenario when its assets move. P26 updates the publish guard's exact allowlisted browser-driver path when that file moves.
5. Where P01 records an environment prerequisite, obtain the verification on the project runner before using that check as the baseline gate. Full release e2e remains a release check.

## Baseline run

The writer ran on Windows 10.0.26300 with Windows PowerShell 5.1, Rust/Cargo 1.100.0 (`x86_64-pc-windows-gnu`), Git for Windows 2.55.0.windows.3, Node 24.19.0 and Python 3.14.7. Cargo used the writer target cache and `CARGO_BUILD_JOBS=4`. Runtime fixtures use local fake executors and isolated homes. The named e2e runs used the candidate debug binaries and the harness's OS temporary directory. Logs are in `.agent-tmp/p01/`.

| Command | Writer result |
| --- | --- |
| `cargo tree --manifest-path rust/Cargo.toml --locked --workspace -i zodchi-flow` | Exit 0. Only `zodchi-cli` depends on `zodchi-flow`. |
| `node scripts/check.mjs` | Exit 0. Publish guard checked the candidate files. |
| `node --check scripts/e2e.mjs`, `node --check scripts/e2e/scenarios/flow-server.mjs` and `node --check scripts/e2e/scenarios/flow-incident-triage.mjs` | Exit 0 for each. |
| `node .agent-tmp/p01/check-claims.mjs` | Exit 0. Expanded 39 package rows, checked 33 disjoint paths in the parallel wave, and matched the six changed paths against P01. |
| `cargo test --manifest-path rust/Cargo.toml --locked -p zodchi-flow --test characterization --test public_paths` | Exit 0. All 24 characterization tests passed and the public API consumer compiled. See `.agent-tmp/p01/characterization-continue.log`. |
| `node scripts/e2e.mjs --no-build --bin-dir <writer-target>/debug --out .agent-tmp/p01/e2e-native-temp flow-server-approve flow-incident-triage-recovery` | Exit 1 overall. Incident recovery passed, including the added evidence cut, exact bytes and digest, and one classifier turn. Server approval stopped in configured-check preflight because Git Bash failed to initialize. |
| `node scripts/e2e.mjs --no-build --bin-dir <writer-target>/debug --out .agent-tmp/p01/e2e-incident flow-incident-triage-recovery` | Exit 0. The independent incident recovery run passed with the harness defaults. |
| `<Git for Windows>/bin/bash.exe -c 'exit 0'` | Exit `-1073741502` (`STATUS_DLL_INIT_FAILED`, `0xC0000142`). Standard Git Bash verification remains for the project runner. |
| `node .agent-tmp/p01/link-probe.cjs` | Exit 1 with EPERM for `fs.linkSync` under the candidate directory. Redirecting `TEMP` there reproduced access denied at the incident artifact link and the server worker lock. The harness's normal OS temp directory allowed those links. |
| `node scripts/e2e.mjs --no-build --bin-dir <writer-target>/debug --out .agent-tmp/p01/e2e-server-reattach flow-server-approve` | Exit 1 with the temporary fixture launcher and the default check slot. The reattachment and receipt assertions passed, then the old approval assertion reported access denied at `checks 1`. |
| `node scripts/e2e.mjs --no-build --bin-dir <writer-target>/debug --out .agent-tmp/p01/e2e-server-isolated-checks flow-server-approve` | Exit 0 with `ZODCHI_CHECK_SLOT_DIR` set to a writer scratch directory and `ZODCHI_BASH` set to a temporary fixture launcher. The launcher accepts only preflight and the two original Node check commands, waits for the engine's start gate, and forwards each command's exit code. All server reattachment and local commit assertions passed. The Git Bash and default slot paths remain unverified in this diagnostic. See `.agent-tmp/p01/e2e-server-isolated-checks/flow-server-approve.log`. |
| `cargo test --workspace --locked --manifest-path rust/Cargo.toml` | Authoritative workspace gate on the project runner. The writer used the focused integration test command above. |
| `node scripts/e2e.mjs` | Full suite reserved for release under the owner's test rule. |
