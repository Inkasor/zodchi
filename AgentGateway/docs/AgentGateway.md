<document id="agent_gateway" status="accepted" authority="zodchi" version="0.6.12-preview" language="en">
  <title>AgentGateway runtime contract</title>
  <purpose>Perform one bounded model call through a configured harness or compatible API and return the result to WorkflowPlatform.</purpose>
  <responsibilities status="accepted">
    <rule id="one_call">One Gateway run performs exactly one model call.</rule>
    <rule id="technical_routing_only">Gateway resolves local harness, provider, profile, and model configuration; it does not select semantic workflows.</rule>
    <rule id="named_openrouter_provider">OpenRouter is a named direct API provider with local model profiles. Structured role calls require endpoint support for the supplied JSON Schema; an unavailable or unverified profile is never replaced silently.</rule>
    <rule id="direct_api_boundary">A direct API profile performs bounded work over the supplied context. Roles that require a terminal, project files, or interactive tools use an agent harness instead.</rule>
    <rule id="receipt_only">Gateway stores normalized technical receipts, token and cache metrics, duration, compact errors, and artifact references; it does not store full prompts or responses.</rule>
    <rule id="workflow_owns_checks">WorkflowPlatform owns project checks, corrections, reviewer policy, and completion state.</rule>
    <rule id="external_local_state">Gateway database, local policy overlay, authentication, and provider state stay outside the replaceable release.</rule>
    <rule id="process_tree_cancellation">Receipts declare cancellation capability and mode. Process-backed harness cancellation terminates the complete provider process tree; WorkflowPlatform owns the corresponding lease, attempt, and run state.</rule>
    <rule id="parallel_settlement">A parallel review group waits for every admitted invocation to settle. On participant failure, outstanding calls are cancelled and closed before WorkflowPlatform exposes a terminal state or calculates final budget use.</rule>
    <rule id="receipt_linkage">Every completed or failed call with a receipt is linked to its run before role-result validation evidence is recorded; schema repair cannot erase the original call or spend.</rule>
  </responsibilities>
  <security status="accepted">
    <rule id="no_shell_interpolation">Harness commands use bounded argument arrays without shell interpolation.</rule>
    <rule id="environment_credentials">Compatible API credentials are read from named environment variables and never written to product configuration.</rule>
    <rule id="openrouter_credentials">OpenRouter reads only the environment variable named by the local profile, normally OPENROUTER_API_KEY. Onboarding checks availability without printing the value and requires a live smoke before assigning the profile.</rule>
    <rule id="receipt_privacy">Persistent storage contains normalized receipt metadata, hashes, usage, duration, status, compact errors, and artifact references only. Full prompts, responses, transcripts, source bodies, and credential samples are forbidden.</rule>
  </security>
  <section id="license" status="accepted">AgentGateway is distributed as part of Zodchi under the repository-level MIT License. Copyright 2026 Petr Tsap.</section>
</document>
