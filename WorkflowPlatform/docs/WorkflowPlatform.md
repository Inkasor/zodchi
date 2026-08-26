<document id="workflow_platform" version="0.5.23" status="working" kind="governance" language="en">
<metadata owner="workflow-platform" authority="Zodchi">
</metadata>
<section id="documentator_contract" status="accepted">
Document changes go only through Documentator and pass Document Lint.
</section>
<rule id="document_changes_go_through_documentator" status="accepted">
A model proposes a structured patch; the program validates and applies it.
</rule>
<section id="installation_boundary" status="accepted">
Product sources, replaceable release, and local user state are separate areas.
</section>
<rule id="development_sources_use_git" status="accepted">
WorkflowPlatform and AgentGateway are modules of the single Zodchi repository; Git is the source history.
</rule>
<rule id="release_is_replaceable" status="accepted">
A release is assembled from committed sources, validated, and replaced as one unit; successful replacement leaves no permanent duplicate of the previous release.
</rule>
<rule id="local_state_is_external" status="accepted">
Local profiles, model assignments, project registry, run history, and both databases stay outside the release and survive product updates.
</rule>
<rule id="project_hooks_use_release" status="accepted">
Project hooks start WorkflowPlatform from the installed release, never from the development repository.
</rule>
<rule id="response_language" status="accepted">
WorkflowPlatform stores the resolved response language and passes it to every user-facing role; schema keys and enum values remain English.
</rule>
<section id="project_roots" status="accepted">
A project holds one primary writable root and any number of additional roots, each registered with the access it grants.
</section>
<rule id="read_root_is_never_written" status="accepted">
A document on a read-only root is never offered as writable and a write to it is refused; changing another project's files belongs to that project's own workflow, checks and review.
</rule>
<rule id="only_writable_roots_reach_the_provider" status="accepted">
A model invocation receives the writable roots and never a read-only one; what a role reads was collected into the prompt before the call.
</rule>
<section id="context_collection" status="accepted">
The platform reads the project and assembles the context; a role works from what it was given and does not open files itself.
</section>
<rule id="collection_covers_the_project" status="accepted">
Source collection covers the project's tracked and unignored files; a declared source scope narrows that, and a credential-shaped or dump-shaped name is never collected.
</rule>
<rule id="collection_searches_before_planning" status="accepted">
Collection searches the declared scope for the identifiers carried by the request and supplies the matching files to the planner.
</rule>
<section id="bounded_convergence" status="accepted">
Recovery is governed by deterministic packet identity, semantic state and evidence frontier before another model call is admitted.
</section>
<rule id="duplicate_review_packet_short_circuits" status="accepted">
An identical canonical review evidence hash is absolute no-progress: the platform records it and enters bounded strategy recovery without invoking reviewers again.
</rule>
<rule id="recovery_never_repeats_an_exhausted_route" status="accepted">
A route is exhausted for one semantic gap when neither its canonical semantic state nor deterministic evidence frontier advances. NO_VIABLE_STRATEGY is terminal, targeted verification feeds the canonical package, and recovery never falls back to the route that caused stagnation.
</rule>
<rule id="progress_channels_are_independent" status="accepted">
Gate and semantic-review snapshots are compared only with earlier snapshots of the same kind; one channel cannot erase stagnation in the other.
</rule>
<rule id="frontier_only_progress_is_bounded" status="accepted">
New deterministic anchors may defer stagnation while claim semantics stay unchanged, but only for three consecutive snapshots and without setting verified semantic progress.
</rule>
<rule id="parallel_review_settles_before_terminal_state" status="accepted">
All admitted consilium participants settle before the run can become terminal; a participant failure cancels outstanding Gateway invocations and the parent waits for their queue lifecycle to close.
</rule>
<rule id="evidence_flows_are_package_contracts" status="accepted">
Evidence-flow nodes, required edges, material symbols and transition capabilities are portable package data bound to semantic workflow keys. Runtime owner wording does not select a flow, and no selection is recorded explicitly.
</rule>
<rule id="context_limits_are_utf8_bytes" status="accepted">
Every context limit is enforced against the final UTF-8 prompt. Fixed prompt floor, mandatory context floor and dynamic context are measured separately and reported with distinct failure categories.
</rule>
<rule id="collection_translates_through_the_project" status="accepted">
Where a request carries no identifier, collection searches for its ordinary words, reads the identifiers standing on the matching lines, and searches again for those; every name it searches for was read out of the project.
</rule>
<rule id="collection_expands_language_graph" status="accepted">
Lexical candidates expand through a bounded language adapter: TypeScript Compiler API symbols for TypeScript and JavaScript, or BSL procedures, functions, unique-name calls and metadata references. Adapter coverage, ambiguity and truncation are part of the evidence.
</rule>
<rule id="code_search_is_reproducible" status="accepted">
The `code-search --project &lt;id&gt; --query &lt;text&gt;` command returns the same lexical and language-graph package used during planning, including timing and completeness statistics.
</rule>
<section id="evidence_gauntlet" status="accepted">
Workflow completion is governed by registered deterministic evidence and the canonical completion blockers; planner completion criteria are advisory.
</section>
<rule id="owner_objective_is_verbatim" status="accepted">
Review receives the original owner message verbatim from conversation history together with a measured change, analytical, or mixed evidence package.
</rule>
<rule id="run_relative_writes" status="accepted">
Every writable root is baselined before productive work; committed and working-tree changes are compared with the baseline so a clean final Git status cannot hide an unauthorized run write.
</rule>
<rule id="targeted_correction" status="accepted">
A failed check or primary review gap reruns only the plan steps connected to that evidence. Blocker fingerprints are normalized by the platform and progress snapshots stop a stagnant or diverging loop.
</rule>
<rule id="gauntlet_strategy" status="accepted">
An operational policy selects standard or gauntlet independently of quality. Gauntlet repeats bounded deterministic correction and independent review phases under declared call, time, cycle, cost, and parallelism limits.
</rule>
<rule id="post_factum_cost" status="accepted">
Provider cost is settled from completed receipts. Already admitted parallel calls may cause bounded overshoot; every receipt is retained and no later model call is admitted after exhaustion.
</rule>
<rule id="owner_controls" status="accepted">
The CLI exposes run status, watch, pause, resume, and cancel. Pause applies at a safe unit boundary; cancel terminates the active Gateway process tree and closes its lease and attempt.
</rule>
<section id="license" status="accepted">
WorkflowPlatform is distributed as part of Zodchi under the repository-level MIT License. Copyright 2026 Petr Tsap.
</section>
</document>
