<document id="zodchi_architecture" status="accepted" authority="zodchi" version="0.6.10" language="en">
  <title>Zodchi system architecture</title>

  <purpose status="accepted">
    Zodchi turns an ordinary project chat into a governed workflow. The program handles repeatable routing, context assembly, model calls, checks, and result recording while the person retains authority over important decisions.
  </purpose>

  <components status="accepted">
    <component id="workflow_platform" responsibility="workflow">Classifies the request, assembles registered context, selects a route, and manages stages, documents, and deterministic checks.</component>
    <component id="code_intelligence" responsibility="source_retrieval">Maps natural-language evidence to code identifiers, expands them through bounded BSL or TypeScript/JavaScript structure, and can query a registered external C# LSP provider over an attested Unity solution boundary. It returns measured source locations without embeddings.</component>
    <component id="agent_gateway" responsibility="model_calls">Performs one bounded call to the assigned model and stores a technical receipt without the full request or response.</component>
    <component id="explicit_skill" responsibility="chat_entry">Activates Zodchi mode for one explicit client session with `/zodchi`; the conditional router validates the host's managed skill reference and is a no-op for every inactive session. Codex command hooks additionally require owner-approved current trust hashes.</component>
    <component id="package_sdk" responsibility="portable_workflows">Composes versioned roles, workflow graphs, checks, evidence flows, authority, resources, schemas, and quality contracts into deterministic portable packages.</component>
    <component id="project_presets" responsibility="onboarding_recipes">Map observed working patterns to public packages, source scopes, local capabilities, authority boundaries, first-value scenarios, and explicit acceptance plans without copying private project data.</component>
    <component id="external_control_plane" responsibility="external_runtime">Exchanges signed, hash-bound requests and results with registered external executors while WorkflowPlatform retains run, resource, cancellation, and completion authority.</component>
  </components>

  <flow status="accepted">
    <step id="intake" order="1">Activate one client session explicitly, then receive ordinary messages from only that active session.</step>
    <step id="context" order="2">Programmatically assemble permitted project facts, registered documents, lexical source evidence, and a bounded language graph.</step>
    <step id="classification" order="3">Determine intent, work type, expected artifact, planning level, and quality mode.</step>
    <step id="dialog_or_route" order="4">Answer or ask a question when execution is unnecessary; otherwise start a registered workflow.</step>
    <step id="execution" order="5">Run planning, resource acquisition, execution, checks, correction, review, and documentation according to the selected contracts.</step>
    <step id="interaction" order="6">When authority or external fact is missing, enter the matching typed wait state and resume the same run only from a validated answer or evidence packet.</step>
    <step id="response" order="7">Return a concise human result, material limitations, and the next required action in the conversation language.</step>
  </flow>

  <contracts status="accepted">
    <rule id="registered_routes_only">Routes, roles, documents, and checks come from registries; runtime code does not infer them from keywords.</rule>
    <rule id="owner_selected_documents">Portable packages never impose project filenames. The owner may register zero or more existing or proposed documents, their role access, and project-local semantic vocabulary; absence becomes a gap only after that explicit selection.</rule>
    <rule id="one_gateway_call">One AgentGateway run performs exactly one bounded model call; WorkflowPlatform owns the overall process.</rule>
    <rule id="quality_cascade">A stricter quality mode includes applicable checks from simpler modes and reruns them for the changed result.</rule>
    <rule id="documentator_boundary">Documentator receives a target document and accepted decisions from the workflow, verifies version and semantic markup, then applies the change atomically.</rule>
    <rule id="human_acceptance">Technical success never implies visual, gameplay, product, business, access, publication, or deployment acceptance.</rule>
    <rule id="conversation_language">Response language comes from an explicit host value when available, then installation preference, then current conversation; the current user language has priority.</rule>
    <rule id="source_truth">Source files remain authoritative; language adapters report coverage, ambiguity, and truncation and return locations rather than replacing source with an inferred summary.</rule>
    <rule id="completion_truth">The registered completion blockers are the sole canonical completion authority; planner criteria remain advisory.</rule>
    <rule id="run_evidence">Review compares the verbatim owner objective with run-relative Git or inventory changes, deterministic gates, analytical conclusions, and retained primary source evidence.</rule>
    <rule id="orthogonal_run_profile">Every implementation run fixes four independent axes: quality, execution, verification, and planning. Reflection derives from execution and review admission derives from quality.</rule>
    <rule id="bounded_gauntlet">Gauntlet is a verification loop: targeted trials repeat while measurable evidence progresses and safety boundaries permit; reviewer admission remains a separate quality decision.</rule>
    <rule id="session_isolation">The conditional client router keys activation by client and session id, refuses project rebinding, and emits no output before explicit activation. Activation and prepared results use non-blocking additional context so Codex and Claude Code render ordinary assistant messages; the bounded delivery instruction forbids tools and independent work. Because Codex may omit activation context, its managed skill verifies the exact current `CODEX_SESSION_ID` against the canonical database before acknowledging activation; it never substitutes a recent or project-wide session.</rule>
    <rule id="bounded_frontier_credit">Evidence-frontier growth may defer stagnation for at most three consecutive snapshots with unchanged claim semantics; it never becomes verified semantic progress.</rule>
    <rule id="consilium_settlement">A terminal run transition waits for every admitted parallel review participant to settle; one failed participant cancels outstanding Gateway invocations before the parent exposes the failure.</rule>
    <rule id="provider_neutral_consilium">Portable packages declare review capabilities without model providers. Local installation policy may bind primary, adversarial, evidence, judge, and strategy roles to different providers; concrete models and credentials never enter the package.</rule>
    <rule id="registered_evidence_flows">Cross-layer evidence flows belong to portable project packages and bind structurally to semantic workflow keys; platform core contains no project business vocabulary and records an explicit none selection when no flow applies.</rule>
    <rule id="interruptible_execution">Gateway invocations declare cancellation capability; owner cancellation terminates the complete provider process tree, while pause waits for a safe execution boundary.</rule>
    <rule id="typed_wait_states">`clarification_required` asks the owner for authority or meaning; `external_evidence_required` asks a registered collector or runtime for facts. They have different validation and neither creates an implicit replacement run.</rule>
    <rule id="resource_identity">Write-capable steps refer to registered resource aliases. The platform resolves canonical identities, acquires multiple shared/exclusive leases in a fixed order, renews them with the attempt lease, and reports an unresolved identity as unavailable.</rule>
    <rule id="approval_binding">An irreversible approval is valid only for the exact objective, plan, checkpoint, and action hashes it names. Changed state invalidates the approval before execution.</rule>
    <rule id="owner_record_boundary">A technical PASS and `OWNER_READ` are separate append-only facts. Only an explicit owner action may record reading or acceptance, and reading does not imply domain acceptance.</rule>
    <rule id="support_status_boundary">Support-grade packages are release-blocking within their declared contract. Preview packages are executable but their domain defects and owner/private pilots do not block 0.6.0 until promotion.</rule>
  </contracts>

  <storage status="accepted">
    <rule id="replaceable_release">The program release is replaced as one unit and is not a user-state store.</rule>
    <rule id="external_local_data">Projects, local model assignments, databases, run history, and credentials stay outside the release.</rule>
    <rule id="portable_packages">Portable workflows use semantic keys and contain no secrets, absolute paths, or local identifiers.</rule>
    <rule id="privacy_safe_receipts">Persistent model receipts contain normalized usage, hashes, duration, status, compact errors, and artifact references; full prompts, outputs, transcripts, and source bodies are not stored.</rule>
    <rule id="replaceable_archive">One cross-platform archive is assembled deterministically under pinned Node 24, published only by the release workflow, and installed only after publisher, workflow, provenance, manifest, checksum, and archive agreement.</rule>
  </storage>
</document>
