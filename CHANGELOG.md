<document id="zodchi_changelog" status="working" authority="zodchi" version="1.0" language="en" format="markdown+xml_semantic">

# Zodchi changelog

[English](CHANGELOG.md) · [Русский](docs/ru/CHANGELOG.md)

<section id="0_5_8_2026_08_26" status="working">

## 0.5.8 — 2026-08-26

- Software reviewer, adversarial reviewer, strategy reviewer and judge contracts use the next measured bounded tier of 256 KiB.
- A live 107-range Dashboard package measured 153,817 evidence bytes and a 198,277-byte complete prompt; the former 128 KiB tier could not retain its primary evidence.
- The full-prompt acceptance remains tied to each configured role contract, so the larger tier does not create unbounded context.

</section>

<section id="0_5_7_2026_08_26" status="working">

## 0.5.7 — 2026-08-26

- Review evidence allowance is derived from the smallest selected reviewer contract instead of a fixed global byte limit.
- The configured allowance reserves 30% for role/schema/XML framing, while the final full-prompt measurement remains authoritative.
- The live 128 KiB Dashboard contract measured 90,057 evidence bytes and a 122,584-byte complete reviewer prompt while retaining 88 source ranges.

</section>

<section id="0_5_6_2026_08_26" status="working">

## 0.5.6 — 2026-08-26

- Review evidence no longer discards every source body after a shared 24 KB pre-compaction allowance.
- Supplied source is represented as independently inspectable line ranges; measured compaction retains at least 512 bytes from every range and fits the complete prompt to the configured 128 KiB reviewer tier.
- A pathless review gap now targets the source-producing plan step named by top-level evidence references and required actions instead of falling back to a pathless synthesis step.
- Review-gap corrections receive the exact blocker, required actions and evidence references as both bounded authority and source-search intent.

</section>

<section id="0_5_5_2026_08_26" status="working">

## 0.5.5 — 2026-08-26

- Review evidence stores identical code-intelligence graphs once in a content-deduplicated catalog and keeps per-worker references.
- Correction snapshots no longer repeat the same global TypeScript compiler statistics, while every distinct graph and every source snapshot remains represented.
- The dense analytical regression now covers seven snapshots, including a correction-sized addition, and still measures the final reviewer prompt.

</section>

<section id="0_5_4_2026_08_26" status="working">

## 0.5.4 — 2026-08-26

- Independent reviewers now receive one immutable evidence package instead of duplicated owner, blocker, planner, and gate fields plus a full project context.
- Review evidence uses a 32 KB allowance so the complete measured XML role prompt fits the 65,536-byte reviewer contract.
- Dense exact scans preserve every term count in a compact index while retaining concrete path and line anchors; the regression now measures the final reviewer prompt.

</section>

<section id="0_5_3_2026_08_26" status="working">

## 0.5.3 — 2026-08-26

- Review evidence compaction now uses bounded linear reduction passes instead of repeatedly serializing the whole envelope for each small metadata trim.
- The dense 24-file TypeScript regression compacts in a fraction of a second while preserving the 0.5.2 evidence guarantees.

</section>

<section id="0_5_2_2026_08_26" status="working">

## 0.5.2 — 2026-08-26

- Review evidence now compacts repeated TypeScript graph summaries and exact-term scan metadata across multi-step analytical runs while preserving paths, term counts, unresolved categories, line anchors, and gate provenance.
- The measured envelope reserves space for its final evidence hash, so the object delivered to reviewers remains within 40 KB.
- Added a regression with six source snapshots, repeated compiler metadata, 24 files, dense exact scans, and large analytical conclusions.

</section>

<section id="0_5_1_2026_08_26" status="working">

## 0.5.1 — 2026-08-26

- Fixed operational policy lint so an explicitly selected Gauntlet strategy may use its declared project-local budget allowance, matching runtime admission semantics.
- Added regression coverage proving standard policies remain bounded by the universal quality contract.

</section>

<section id="0_5_0_2026_08_26" status="working">

## 0.5.0 — 2026-08-26

- Review now receives the owner's original message verbatim and the platform's canonical completion blockers; planner completion criteria are explicitly advisory.
- Run evidence distinguishes change, analytical, and mixed work. Writable roots retain a pre-work Git or complete inventory baseline, including initially dirty hashes and committed changes hidden by a clean final status.
- Operational policies can select a bounded `gauntlet` strategy with targeted correction, independent same-evidence reviewers, deterministic disagreement evidence, progress snapshots, stable blocker fingerprints, and stagnation stops.
- Cost budgets use post-factum provider receipts with bounded parallel overshoot semantics. Same-ordinal queue phases run concurrently without false `queue_drained` events or async SQLite transactions.
- Owner commands expose status/watch/pause/resume/cancel. Active cancellation terminates the complete Gateway/provider process tree and late receipts cannot continue a cancelled run.
- Acceptance coverage A–M exercises verbatim intent, analytical evidence, committed and dirty deltas, targeted replay, cost overshoot, cancellation, pause boundaries, fingerprints, queue phases, transaction safety, and cross-project gate provenance.

</section>

<section id="0_4_4_2026_08_26" status="working">

## 0.4.4 — 2026-08-26

- Sequential worker steps now receive a bounded structured handoff of completed prior worker summaries, evidence, and artifacts.
- Synthesis and documentation-handoff steps no longer lose the evidence chain when their own allowed path is only a not-yet-created output document.
- Prior-result handoffs report retained and total result counts plus explicit truncation under the role prompt budget.

</section>

<section id="0_4_3_2026_08_26" status="working">

## 0.4.3 — 2026-08-26

- Complete-file exact-term scans now include bounded line numbers and source snippets, so workers receive positive evidence even when the larger selected excerpt is later reduced to fit the prompt.
- Exact scans still report deterministic zero counts and now separately report matched lines and location truncation.
- The strongest literal match for a worker objective is reserved before inferred call-chain windows can consume the source byte budget.

</section>

<section id="0_4_2_2026_08_26" status="working">

## 0.4.2 — 2026-08-26

- Planner contracts now distinguish ranked locator evidence from the full source contents supplied to workers; missing source detail becomes an investigation step rather than an owner clarification.
- Exact request identifiers carry a compact corpus-wide index of every matching path and line count, with independent scan-completeness and result-cap fields.
- Tracked files deleted from the current working tree no longer appear as unreadable corpus entries, and NDJSON payloads are excluded from source retrieval.
- Compact exact-term indexes are fitted deterministically under extreme prompt budgets while retaining explicit truncation evidence.

</section>

<section id="0_4_1_2026_08_26" status="working">

## 0.4.1 — 2026-08-26

- Exact identifiers found near the end of a large source file now displace earlier generic matches instead of disappearing behind the per-file line cap.
- Long workflow instructions retain enough domain vocabulary for the two-pass bridge; operational wording at the start no longer displaces the actual subject at the end.
- Planner evidence reserves both exact lexical anchors and the strongest language-graph paths, keeping prior analysis and implementation sources together under one measured byte budget.
- Global graph detail and repeated excerpts are compacted before relevant files are removed, while a final fallback still guarantees the role prompt stays inside its contract.

</section>

<section id="0_4_0_2026_08_26" status="working">

## 0.4.0 — 2026-08-26

- Source discovery now combines the existing corpus-derived two-pass lexical search with a bounded language graph instead of handing the planner a file inventory alone.
- TypeScript Compiler API adapters resolve definitions, references, imports, calls, and constructors across TypeScript and JavaScript projects, including `.js`, `.jsx`, and `.mjs` sources through `allowJs`.
- The BSL adapter indexes procedures, functions, unique-name calls, and 1C metadata references; ambiguous calls remain explicitly measured rather than presented as compiler-resolved truth.
- Identifier harvesting ranks names by proximity to the rare request words that found them, so a direct bridge such as `avgCost: "Средняя себестоимость"` outranks generic nearby members.
- Every result reports adapter coverage, parsed and skipped files, graph size, returned evidence, duration, and truncation. The `code-search` CLI exposes the same package used by planners for reproducible measurement.

</section>

<section id="0_3_22_2026_08_26" status="working">

## 0.3.22 — 2026-08-26

- Worker completion semantics now treat a zero exact-term count across complete allowed files as a conclusive negative result inside the authorized scope.
- A scoped static analysis completes by reporting an absent producer and the nearest supported facts instead of blocking on a request for an excluded downstream system.
- `blocked` remains reserved for evidence that is unavailable or unreadable inside the authorized boundary, not for a valid negative answer.

</section>

<section id="0_3_21_2026_08_26" status="working">

## 0.3.21 — 2026-08-26

- Documentators now receive the completed worker evidence, completion criteria and deterministic gate result needed to compose the final registered document.
- The documentator contract explicitly requires a proposal rather than direct filesystem editing, because the platform atomically applies and lints the returned operation.
- Supported document operations are now an exact validated enum; invented blocker operations can no longer pass schema validation and fail only during patch application.

</section>

<section id="0_3_20_2026_08_26" status="working">

## 0.3.20 — 2026-08-26

- Worker source metadata now includes bounded exact-term occurrence counts scanned across each complete allowed file, even when only excerpts fit the prompt.
- A zero count gives deterministic evidence that a requested code identifier is absent from that source snapshot, avoiding false requests for ever-larger excerpts.
- The scan is limited to code-shaped terms already present in the owner request or step objective and adds no file contents beyond the existing source scope.

</section>

<section id="0_3_19_2026_08_26" status="working">

## 0.3.19 — 2026-08-26

- Every explicit source range now reserves its highest-scoring page before long semantic call-chain excerpts can consume the role context budget.
- Call-chain and referenced-definition evidence still follows those reserved pages, and remaining range pages continue round-robin within the measured prompt envelope.
- Regression coverage proves that three distant requested regions and a long function chain remain represented together under a tight source budget.

</section>

<section id="0_3_18_2026_08_26" status="working">

## 0.3.18 — 2026-08-26

- Role call budgets are now scoped to a concrete workflow step as well as run and role, so independent planner packages assigned to the same analyst do not consume one shared two-call allowance.
- Project, task and workflow budgets continue to cap the complete run, while attempt and step-qualified role budgets bound retries inside each assignment.
- Regression coverage executes two independent worker steps under a one-call role contract and requires both to complete without weakening the global budget hierarchy.

</section>

<section id="0_3_17_2026_08_26" status="working">

## 0.3.17 — 2026-08-26

- Explicit source ranges now reserve the page immediately before their best lexical hit, retaining function headers, selected fields and query parameters together with a matching register or condition.
- Semantic call-chain fallback is suppressed when explicit ranges exist; only exact cross-file definitions may precede that direct owner evidence.
- Regression coverage keeps a query-setup page with its following register-hit page under a budget too small for the full requested range.

</section>

<section id="0_3_16_2026_08_26" status="working">

## 0.3.16 — 2026-08-26

- Cross-file call discovery now uses a bounded second collection pass, so planner path priority no longer determines whether a later form can lead to an earlier object-module definition.
- Member calls are harvested from the complete allowed peer file for routing only; the worker still receives only measured excerpts inside its role contract.
- Local objective windows seed their directly called definitions when no exact cross-file definition exists, preserving both the form handler and the implementation chain in either path order.

</section>

<section id="0_3_15_2026_08_26" status="working">

## 0.3.15 — 2026-08-26

- Source collection follows member calls from an earlier planned file into definitions in a later allowed file, so a form-to-object-module entry path remains visible without granting workers direct filesystem access.
- A bounded call-chain pass follows relevant definitions for at most three hops and eight functions, retaining compact function bodies that connect entry points, wrappers, packet builders and senders.
- Regression coverage traces a form server call through a separate implementation file to NDJSON construction and delivery under a fixed evidence budget.

</section>

<section id="0_3_14_2026_08_25" status="working">

## 0.3.14 — 2026-08-25

- Worker source capacity is now calculated after measuring the complete role, package, history and JSON envelope instead of assuming that source may always occupy 80% of the role limit.
- When the first estimate is too large, source windows are recollected against the measured remainder; final prompt fitting no longer cuts off a requested range that deterministic selection had already retained.
- Regression coverage rejects late `prompt_truncated` cuts in a tight worker contract while retaining local and globally requested BSL regions.

</section>

<section id="0_3_13_2026_08_25" status="working">

## 0.3.13 — 2026-08-25

- Worker source budgets now follow planner path priority. The first of two readable sources may use two thirds of the remaining capacity while a smaller entry-point file still retains its bounded share.
- Calendar spans such as `15–22 August` are no longer misclassified as requested source line ranges.
- Regression coverage reproduces the unused-capacity failure where a large primary BSL module was truncated before a small form module consumed less than its equal share.

</section>

<section id="0_3_12_2026_08_25" status="working">

## 0.3.12 — 2026-08-25

- Workers receive bounded, path-specific Git history for their allowed sources when Git discovery is enabled, so file-history claims can be verified rather than repeated from the request.
- Final document artifacts remain owned by the documentator even when a planner assigns their keys to analytical worker steps.
- A missing Markdown target directly under `docs/` can be registered as the task's new document output; existing unregistered files and paths outside that boundary remain protected.

</section>

<section id="0_3_11_2026_08_25" status="working">

## 0.3.11 — 2026-08-25

- Pathless `decision` artifacts are now materialized from a completed worker's structured summary and evidence instead of being incorrectly required as files.
- Planner validation reserves `path: null` for native decisions; all file-backed artifact types must still declare a project-relative path and pass existence and hash checks.
- Worker artifact post-validation failures now settle the attempt as failed and the exhausted step as blocked instead of leaving it permanently running.

</section>

<section id="0_3_10_2026_08_25" status="working">

## 0.3.10 — 2026-08-25

- Worker evidence may use up to 80% of the measured role contract before final prompt fitting, allowing large contiguous source regions to use capacity that the fixed envelope does not need.
- Source budget is divided only among readable text inputs. Missing output artifacts and invalid or binary paths no longer reserve a share that real source files could use.
- Regression coverage verifies that a not-yet-created document path cannot starve a large BSL input.

</section>

<section id="0_3_9_2026_08_25" status="working">

## 0.3.9 — 2026-08-25

- Explicit source ranges are supplied as contiguous 40-line pages instead of sparse 13-line samples. Pages containing objective matches lead, while the remaining pages fill the available budget round-robin across ranges.
- Planner evidence inputs are now visible to workers as bounded task evidence, so supplied Git facts and accepted runtime limitations remain available for analysis rather than only influencing source search.
- Regression coverage keeps local, late-range, and task-evidence signals together under a tight role contract.

</section>

<section id="0_3_8_2026_08_25" status="working">

## 0.3.8 — 2026-08-25

- Large-source selection now keeps the worker's local objective and global request evidence as separate priorities. Local objective matches lead, while global ranges and identifiers supplement them instead of displacing step-specific proof.
- Regression coverage verifies one local entry-point marker outside the globally requested ranges together with both later requested BSL regions under the same 24,000-byte contract.

</section>

<section id="0_3_7_2026_08_25" status="working">

## 0.3.7 — 2026-08-25

- Worker source ranking now combines the step objective with the original user request and planner evidence inputs. Exact line ranges and identifiers therefore survive a planner's shorter per-step wording.
- Portable disabled checks are recognized as local installation hooks by their declared `config.reason` as well as by their runner name, so package upgrades preserve an activated machine-local BSL Language Server runner.
- Regression coverage reproduces both failures observed in the live 1C documentation chain: ranges present only in the original request and the actual `bsl_language_server` portable placeholder shape.

</section>

<section id="0_3_6_2026_08_25" status="working">

## 0.3.6 — 2026-08-25

- Worker source collection now selects line-numbered windows around explicit ranges and objective-derived identifiers instead of truncating every large file from its beginning. Requested ranges are interleaved, and every planned path receives a fair share of the evidence budget.
- The final assembled worker prompt is measured against its role contract and source text yields deterministically when the fixed envelope, plan, and evidence together exceed it.
- New portable role contracts default to 65,536 bytes instead of the original undocumented 24,000-byte value; packages may still declare a smaller contract to exercise or enforce tighter fitting.
- Regression coverage verifies a 4,500-line BSL source with relevant evidence around lines 2,800 and 4,400, a second planned file, and a complete worker prompt bounded to 24,000 bytes.

</section>

<section id="0_3_5_2026_08_25" status="working">

## 0.3.5 — 2026-08-25

- Planner source evidence now obeys the role's single byte contract. Large inventories are reduced to structural counts, low-ranked search hits are removed deterministically, and the highest-ranked proven source path is retained instead of rejecting the task before a model call.
- Importing a newer workflow package no longer replaces an activated machine-local check definition with its disabled portable placeholder. Package-owned bindings still update while executable paths and runner settings remain local.
- Regression coverage reproduces a 24,000-byte planner contract with 451 source files and verifies both deterministic context fitting and preservation of a locally configured check across package upgrades.

</section>

<section id="0_3_4_2026_08_25" status="working">

## 0.3.4 — 2026-08-25

- A question raised by the planner is now treated as a clarification throughout classification and lifecycle settlement. Previously its `planner_clarification` kind was mistaken for an approval decision, so a valid `null` decision response failed the classifier contract and the already answered question remained pending.
- Regression coverage verifies that a planner clarification accepts an ordinary answer, never grants authority, and is settled before work continues.

</section>

<section id="0_3_3_2026_08_25" status="working">

## 0.3.3 — 2026-08-25

- Classification now uses Codex native structured output instead of relying on prompt-only JSON. Invalid responses fail with safe structural detail, while raw prompts and model output remain outside the gateway database.
- Project source discovery now preserves non-ASCII Git paths, balances capped inventories across top-level areas, ranks direct request terms first, and excludes Codex attachment metadata. A registered project root is explicitly treated as source available to downstream roles, so documentation work no longer asks the user to paste code that is already present.
- Regression coverage verifies the output schema and gateway propagation, safe failure diagnostics, Cyrillic paths, balanced inventories, search ranking, and attachment filtering.

</section>

<section id="0_3_2_2026_08_25" status="working">

## 0.3.2 — 2026-08-25

- The 0.3.1 migration could not be applied to a database that had been used. Rebuilding a table other tables reference is refused while foreign keys are enforced, and a fresh database has nothing referencing it — so the migration passed every test and failed on the first real database, which rolled it back and left the release unusable there. Enforcement is now turned off around each migration and a foreign key check runs before it commits, which is the documented rebuild and moves the check rather than dropping it. A migration is now tested against a database that already holds referencing rows.

</section>

<section id="0_3_1_2026_08_25" status="working">

## 0.3.1 — 2026-08-25

- A project can now hold more than one directory. One root stays primary and writable, and further roots are registered explicitly with the access each one grants. Work that reconciles two systems has to read the producing end and the consuming end, and neither is a subdirectory of the other, so until now such a run could see only half of what it was about. A document on a read-only root is never offered as writable and a write to it is refused: changing another project's files belongs to that project's own workflow, checks and review.
- The platform now collects source files, not only registered documents. A role reads what collection assembled for it and does not open files itself, which is what keeps a run repeatable and its cost bounded. Registering a project registered its directory, so collection covers what git already calls the project — its tracked and unignored files — and a workflow that declares `sources` narrows that rather than switching it on. Registration still decides which files are documents: an unregistered file has no authority, no role may write it, and its text is never read into the context. A credential-shaped or dump-shaped name is refused whatever the scope says.
- Collection searches the project for the identifiers the request already contains, before any model is called. An inventory says what exists but not where the subject of the request lives, and in a project of a thousand files choosing paths by name is guessing. The planner now receives the files that actually mention what was asked about.
- A role prompt says that its context was collected for it. A role holding an empty tool list concluded that sources were unreachable and asked the owner to paste them into the message, when the real fault was that collection had never supplied them.
- A receipt counts the changes made in every writable root. Measuring only the primary directory would have left whatever a call did in a second root out of the record that exists to say what it changed.

- Collection reads the project in the vocabulary the project uses. A request is written in ordinary words and the code is written in identifiers, and the project itself holds the translation between them: a label, a comment, the text of a query. Collection searches for the words of the request, reads the identifiers standing beside them, and searches again for those. Nothing is guessed and no model is involved — every name searched for the second time was read out of this project, so it is a name that exists here. A word is followed only if it is rare enough in the project to mean something, which is measured rather than listed.
- One message settles every question it answered. The platform asks several questions at once and a person answers them in one paragraph; recording one and cancelling the rest lost answers that had been given.
- A clarification named wrongly no longer ends the run. A clarification is settled by the next message either way, so an unknown id is dropped and recorded, where before it failed the classification and threw away both the answer and the call that was paid for. A decision on an action stays exact: it authorizes something, and one named wrongly is left open.
- A classification failure says which contract was broken instead of blaming the request or the project settings.
- A run that fails on its way into execution now ends. Execution can fail before it plans anything — a role contract that does not permit the classified work type, a role with no profile assigned at this level — and the state machine had no transition out of classified, so the person was told the run was rejected while the run itself stayed classified for ever, neither finished nor waiting, and nothing could act on it afterwards. The answer also names the contract that was broken.
- An unconfigured Codex project delivers its prepared answer instead of losing it. Advisory output travels in the additional-context shape, and a Codex turn was observed receiving neither that context nor the prepared text: the classification ran, the call was paid for, and the answer reached nobody. Codex now defaults to the blocking shape, which both harnesses have been seen to honour. A project that states a delivery mode still gets the mode it stated.
</section>

<section id="0_3_0_beta_16_2026_08_25" status="working">

## 0.3.0-beta.16 — 2026-08-25

- A registered manifest is no longer reported as a failing document. Every registered document was checked against the semantic document format when the project context was assembled, so a package manifest or a generated index — a file its own tool owns and formats — failed on every single run. The report is read by the roles, so that failure was permanent noise that meant nothing. Reference documents are now reported as not applicable instead.

</section>

<section id="0_3_0_beta_15_2026_08_25" status="working">

## 0.3.0-beta.15 — 2026-08-25

- A document registered as reference is read context, not a record the documentator maintains. Write access was granted on every registered document, which obliged the documentator to keep package manifests and generated indexes in the semantic document format; a manifest kept that way would stop being a manifest. Reference documents are now read-only, and the tools that own them keep owning them.
- This repository's own README and changelog are written in the semantic document format, like every other registered document. They are documents the platform may write, and until now no run could finish that wrote one.

</section>

<section id="0_3_0_beta_14_2026_08_25" status="working">

## 0.3.0-beta.14 — 2026-08-25

- A run whose decision follows its work is now continued instead of refused. The remaining phases need the plan, the verification and the review, and all three are already recorded, so the run resumes from what it holds rather than from its objective. Re-entering from the objective was the only path available before, and it would have repeated — and paid for — every step already completed, so approving such a run was recorded and left there.
- Continuing costs exactly the phase the decision was blocking. No worker, verification or review step is executed a second time.
- The example package's version now says that its content changed. The declared step templates changed in the previous release while the version stayed where it was, so two different packages carried the same version and an upgrade could not tell them apart.
- A work type the project registered is accepted even when the platform's own fallback list predates it. A package may register the work types its routes need, and the run was still judged against a frozen list, so a route every catalog offered could never start. The registry is now the authority; the list is only what a caller without one falls back to.
- A workflow whose every step is named for verification has a role to run it again. Excluding steps named for testing keeps the verification phase's own work out of the worker steps, but applied to a route that is nothing but such steps it left nothing to execute.
- A required document that several registered documents could satisfy now says that the workflow needs a planning step, which is what settles the choice, instead of reporting an ambiguity with no stated remedy. The registered documentation update declares that step.
- The example package states its own version instead of inheriting the shared default. That default also stamps every role contract in every package, so raising it to describe one example change silently re-versioned all of them.

</section>

<section id="0_3_0_beta_13_2026_08_25" status="working">

## 0.3.0-beta.13 — 2026-08-25

- A workflow that declares its steps is executed as declared, with no planning call at all. Its author already named the roles, the order, the artifact types and the checks; asking a model to invent that again is what let a plan name steps the route does not have. A declared planning step still runs, because a change needs the paths and objectives only the message can supply.
- Nothing in that derivation can produce an allowed path, and a worker without one may change nothing, so a workflow whose worker roles may write must declare a planning step. This is now asserted for every package, and the least-privilege access change workflow gained the planning step it was missing.
- An owner decision has three outcomes, not two. A person asked to authorize an action can also be neither agreeing nor refusing: doubting, asking back, agreeing in part. Only an unambiguous yes continues the waiting run; a refusal closes it; anything else leaves the decision open and answers the person. Reading hesitation as consent would take an action that was never authorized.
- A granted approval continues the run that asked for it instead of starting a new one. The confirming message classifies as a conversation, so the paused run supplies its own objective and classification; nothing could resolve these approvals before, and every message started over.
- The roles a route may execute after an owner decision are now known. Only the steps before the decision were ever named, so a granted approval left the route with nothing to run.
- A pending interaction is offered to the classifier under its real kind, which is what separates a question from a decision on an action.

</section>

<section id="0_3_0_beta_12_2026_08_25" status="working">

## 0.3.0-beta.12 — 2026-08-25

- A role assignment now records which portable requirement it satisfies. A package names a requirement key and onboarding creates a local profile, so comparing the two by equality left most role contracts unloadable and no project could execute structured work at all.
- The result schema a role is judged against is now written into its own prompt, from the same source the validator reads. The prompt said "matching this schema" without ever showing it while the validator demanded an exact field set, and a test now fails if the two ever drift apart.
- Recorded decisions are bounded in a role's context the same way artifacts already were, and history gives way before authority when a prompt has to be trimmed. Every run records a decision, so a project used to grow until nothing fit and then stopped working the more it had been used.
- Planning is a declared step of a workflow rather than a platform role assumed to exist, and a workflow that declares its shape without a planning step now says so instead of reporting a missing role.
- The planner is given the roles the route may execute, each one's purpose, boundaries and permitted work, and the phases that run after its steps. It was validated against a list it was never shown, so it named itself, assigned edits to a read-only role, and spent worker steps on work the verification and documentation phases already perform.
- A package must declare a local profile for every portable requirement its roles allow, which is now asserted for every package.

</section>

<section id="0_3_0_beta_11_2026_08_25" status="working">

## 0.3.0-beta.11 — 2026-08-25

- Package definitions describe real projects, so their source is now chosen by the `packageDefinitions` setting and this repository ships only the builders and one complete example. A definition file default-exports a function that receives the builder module, so it needs no import path and can live outside the repository; generated packages are written beside their source.
- The package tests assert the contract every package must satisfy instead of the content of any one project, so they run against whichever definitions an installation configured.
- A secret scan and a dependency scan also run on a release. A gate resolves its own level and every level below it, and a security audit sits above production, so bound to the audit alone these never ran at the one moment a project publishes code.
- An irreversible step never carries a role, and where a release acts on the outside world the approval comes before that action. Both are now checked for every package.

</section>

<section id="0_3_0_beta_10_2026_08_25" status="working">

## 0.3.0-beta.10 — 2026-08-25

- MarketplacesData verifies that a release actually reached production. The GitHub Actions run for the exact commit, the revision the server is serving and the health of the running service were declared but unavailable; they now call registered project scripts, so the project keeps the server alias, paths and endpoint and the package carries only a script name.
- A production incident runs at production quality in every company web package. The workflow named itself production work while declaring MVP, which required a single check and no independent reviewer.
- MarketplacesData routes live data collection to its own workflow. Collection spends real marketplace requests and no rollback returns them, so a measured dry run and a review come first, the owner then approves the exact endpoint identifiers, and only the approved list may run.
- A collection operator role may never send a write request, widen the approved endpoint list or expose credentials.
- A reversible data change is now also checked against the database itself, not only by the tests and the build it shares with a code change.

</section>

<section id="0_3_0_beta_9_2026_08_24" status="working">

## 0.3.0-beta.9 — 2026-08-24

- A workflow declares the quality it was built for, and that declaration is now a floor: the classifier may raise a routed run above it but never below, because a lower level drops the checks the workflow depends on.
- The hook can deliver a prepared answer as the final word instead of advisory context. In `final` delivery mode it ends the turn and shows the answer directly, so the chat cannot repeat research the run already paid for; `advisory` stays the default.
- Every clarification is settled by the next message: the one the classifier answers is approved and anything older is superseded. Pending clarifications used to accumulate, so a later classifier read questions the user had already answered as still open.
- The classifier prompt keeps the whole invariant contract above the run state, and the contract now states what each output field means and how a planning level and quality mode are chosen. A provider can reuse the prefix, and the same message no longer draws a different level twice.
- Delivery mode is chosen per project on the hook command, because hooks are installed per project.
- Project Lore records a LORE-CHANGE card in `docs/decisions` before the owner decides, so a candidate that stays open or turns out to be a conflict still leaves a durable record without reaching canon. The change workflow also asks for the candidate scope and the impact on both projects, and every level keeps the owner gate.

</section>

<section id="0_3_0_beta_8_2026_08_24" status="working">

## 0.3.0-beta.8 — 2026-08-24

- Run statistics report the entry point the run came from. The per-call `harness` field repeated the gateway provider and read as the chat client, so a Claude Code run was reported as Codex; it is replaced by `client` on the run.

</section>

<section id="0_3_0_beta_7_2026_08_24" status="working">

## 0.3.0-beta.7 — 2026-08-24

- The harness is identified by the only fields that differ between the two hook payloads: Codex names the turn and the model, Claude Code names the prompt. Both send the same session id, transcript path and permission mode, so a Codex turn is no longer recorded as Claude Code.
- The hook records the field names of the event it received, so the sending harness stays identifiable from the run history alone.
- The instruction returned to the harness states plainly that the turn is already complete and is repeated after the result, because hook output is advisory context in both harnesses and a chat that researches the answer again charges the user twice.
- Classifier and researcher receipts carry the workflow run they belong to, which only the structured work steps recorded before.

</section>

<section id="0_3_0_beta_6_2026_08_24" status="working">

## 0.3.0-beta.6 — 2026-08-24

- The classifier is offered only the work types a project actually routes, plus conversation and clarification, so a narrow project can no longer be classified into a route it does not have.
- Conversation, clarification and research answers no longer require a registered workflow route, because they are delivered directly and never enter a workflow.
- A check that cannot run no longer blocks a workflow: it is reported as unavailable, and gate coverage is measured by the executable required checks instead, so a project is blocked only when nothing can actually verify it.
- 1C and company operations gained an executable secret scan at prototype and MVP, because neither package had a check that could run.
- Project M, Project R, Shared Map Engine, Shared Lore and 1C gained the entry points their roles already supported: fix, documentation and verification runs.
- Company workflows route verification and testing to a checks-and-review run instead of leaving them unroutable.
- Indie release and playtest run at production quality, the prototype workflow runs at prototype quality, and the 1C review step is required.

</section>

<section id="0_3_0_beta_5_2026_08_24" status="working">

## 0.3.0-beta.5 — 2026-08-24

- Claude Code events are recognized by identifiers the harness actually sends, so runs started from Claude Code are recorded under their own client instead of falling back to Codex.
- The shipped Claude Code settings template uses the exec command form, which keeps Windows paths intact when the hook starts.

</section>

<section id="0_3_0_beta_4_2026_08_24" status="working">

## 0.3.0-beta.4 — 2026-08-24

- Claude Code joins Codex as a supported chat entry point through one shared UserPromptSubmit hook.
- Renamed the hook entry to hooks/user-prompt-submit.mjs and kept the former Codex filename as a compatibility entry for existing installations.
- Hook results now expose additionalContext at the top level of the hook output, which is where Claude Code reads it.
- Workflow runs record the originating client, and Claude Code prompt identifiers are used for duplicate-delivery protection.

</section>

<section id="0_3_0_beta_3_2026_08_24" status="working">

## 0.3.0-beta.3 — 2026-08-24

- Added conversation-language resolution across hooks, workflow state, model prompts, questions, and final responses.
- Human-facing project documents are now available in English and Russian; machine-facing semantic instructions use English.
- Removed duplicate component readmes, changelogs, and license files left from the former separate repositories.
- Updated the release builder and linter for the unified product layout.

</section>

<section id="0_3_0_beta_2_2026_08_24" status="working">

## 0.3.0-beta.2 — 2026-08-24

- Added English and Russian human introductions with a one-link setup flow.
- Reworked installation and update procedures as LLM-operated instructions and added verified GitHub Release installation.
- Added a portable workflow for developing Zodchi itself.
- Defined a single Codex project layout: development sources as the primary folder, installed release and local data as secondary folders.

</section>

<section id="0_3_0_beta_1_2026_08_24" status="working">

## 0.3.0-beta.1 — 2026-08-24

- Created the first public snapshot under the Zodchi name.
- Combined WorkflowPlatform and AgentGateway in one repository while keeping their runtime responsibilities separate.
- Added portable workflows, quality modes, classification, documentation, and deterministic project checks.
- Kept personal databases, model assignments, projects, credentials, and run history outside the release.
- Added reproducible release assembly, content validation, checksums, and recoverable updates.

The full experimental history before the public snapshot remains only in the author's local repositories.

</section>

</document>
