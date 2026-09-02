<document id="agent_gateway" status="accepted" authority="zodchi" version="0.6.12" language="en">
  <title>AgentGateway runtime contract</title>
  <purpose>Perform one bounded model call through a configured harness or compatible API and return the result to WorkflowPlatform.</purpose>
  <responsibilities status="accepted">
    <rule id="one_call">One Gateway run performs exactly one model call.</rule>
    <rule id="technical_routing_only">Gateway resolves local harness, provider, profile, and model configuration; it does not select semantic workflows.</rule>
    <rule id="named_openrouter_provider" status="preview">OpenRouter is a preview named direct API provider with local model profiles. Structured role calls require endpoint support for the supplied JSON Schema; an unavailable or unverified profile is never replaced silently.</rule>
    <rule id="direct_api_boundary">A direct API profile performs bounded work over the supplied context. Roles that require a terminal, project files, or interactive tools use an agent harness instead.</rule>
    <rule id="receipt_only">Gateway stores normalized technical receipts, token and cache metrics, duration, compact errors, and artifact references; it does not store full prompts or responses.</rule>
    <rule id="workflow_owns_checks">WorkflowPlatform owns project checks, corrections, reviewer policy, and completion state.</rule>
    <rule id="external_local_state">Gateway database, local policy overlay, authentication, and provider state stay outside the replaceable release.</rule>
    <rule id="process_tree_cancellation">Receipts declare cancellation capability and mode. Process-backed harness cancellation terminates the complete provider process tree; WorkflowPlatform owns the corresponding lease, attempt, and run state.</rule>
    <rule id="parallel_settlement">A parallel review group waits for every admitted invocation to settle. On participant failure, outstanding calls are cancelled and closed before WorkflowPlatform exposes a terminal state or calculates final budget use.</rule>
    <rule id="receipt_linkage">Every completed or failed call with a receipt is linked to its run before role-result validation evidence is recorded; schema repair cannot erase the original call or spend.</rule>
    <rule id="executor_capability_contract">Every invocation carries an explicit capability requirement. Gateway derives the assigned profile's provider-specific capability matrix and starts the provider only when every required capability is technically available and every forbidden capability is technically unavailable; declarative and unknown guarantees fail closed.</rule>
    <rule id="browser_profile_boundary">A Codex browser profile receives only browser or Chrome plugins and MCP servers named by its local allowlists. That configuration remains an unknown capability until a live smoke for the exact Gateway contour records an explicit technical profile capability; ambient desktop plugins are not inherited by other Gateway profiles.</rule>
    <rule id="browser_evidence_boundary">A browser-capable worker may edit and inspect a bounded browser-facing change in one model call. Its observation helps implementation but never replaces WorkflowPlatform's separately registered deterministic browser check or owner acceptance.</rule>
  </responsibilities>
  <security status="accepted">
    <rule id="no_shell_interpolation">Harness commands use bounded argument arrays without shell interpolation.</rule>
    <rule id="environment_credentials">Compatible API credentials are read from named environment variables and never written to product configuration.</rule>
    <rule id="openrouter_credentials" status="preview">OpenRouter reads only the environment variable named by the local profile, normally OPENROUTER_API_KEY. Onboarding checks availability without printing the value and requires a live smoke on that installation before assigning the profile. Absence of the preview provider does not block stable product release.</rule>
    <rule id="receipt_privacy">Persistent storage contains normalized receipt metadata, hashes, usage, duration, status, compact errors, and artifact references only. Full prompts, responses, transcripts, source bodies, and credential samples are forbidden.</rule>
    <rule id="capability_receipt">The receipt records the effective profile capability matrix and provider-environment inventory without storing credentials, prompts, responses, or browser content.</rule>
  </security>
  <section id="license" status="accepted">AgentGateway is distributed as part of Zodchi under the repository-level MIT License. Copyright 2026 Petr Tsap.</section>
</document>
