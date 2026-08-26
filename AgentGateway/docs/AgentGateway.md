<document id="agent_gateway" status="accepted" authority="zodchi" version="0.5.15" language="en">
  <title>AgentGateway runtime contract</title>
  <purpose>Perform one bounded model call through a configured harness or compatible API and return the result to WorkflowPlatform.</purpose>
  <responsibilities status="accepted">
    <rule id="one_call">One Gateway run performs exactly one model call.</rule>
    <rule id="technical_routing_only">Gateway resolves local harness, provider, profile, and model configuration; it does not select semantic workflows.</rule>
    <rule id="receipt_only">Gateway stores normalized technical receipts, token and cache metrics, duration, compact errors, and artifact references; it does not store full prompts or responses.</rule>
    <rule id="workflow_owns_checks">WorkflowPlatform owns project checks, corrections, reviewer policy, and completion state.</rule>
    <rule id="external_local_state">Gateway database, local policy overlay, authentication, and provider state stay outside the replaceable release.</rule>
    <rule id="process_tree_cancellation">Receipts declare cancellation capability and mode. Process-backed harness cancellation terminates the complete provider process tree; WorkflowPlatform owns the corresponding lease, attempt, and run state.</rule>
  </responsibilities>
  <security status="accepted">
    <rule id="no_shell_interpolation">Harness commands use bounded argument arrays without shell interpolation.</rule>
    <rule id="environment_credentials">Compatible API credentials are read from named environment variables and never written to product configuration.</rule>
  </security>
  <section id="license" status="accepted">AgentGateway is distributed as part of Zodchi under the repository-level MIT License. Copyright 2026 Petr Tsap.</section>
</document>
