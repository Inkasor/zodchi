<document id="workflow_platform_architecture" status="proposed" authority="workflow-platform" version="0.6.1" language="en">
  <title>Zodchi project configuration</title>
  <purpose>Template for the onboarding LLM. Replace TODO values only with verified project facts.</purpose>

  <system id="workflow_platform" status="accepted">
    <component id="workflow_platform_component" role="semantic_runtime">Owns intent, context, classification, routes, checks, and documents.</component>
    <component id="agent_gateway" role="model_gateway">Starts providers, profiles, and models. AgentGateway never selects a semantic route.</component>
    <component id="chat_entry_skill" role="entrypoint">The user explicitly sends a selected task from Codex or Claude Code through `/zodchi` or `/zod`.</component>
    <component id="workflow_database" role="state_store">Stores projects, documents, roles, runs, decisions, and check results.</component>
  </system>

  <flow id="default_flow" status="accepted">
    <step order="1" role="chat_entry_skill">Receive only the explicitly selected task and preserve its UTF-8 bytes.</step>
    <step order="2" role="context_builder">Assemble registered documents and bounded working context.</step>
    <step order="3" role="classifier">Determine intent, work_type, discipline, planning level, quality mode, artifact, and documentation need.</step>
    <step order="4" role="router">Select a registered route from the classifier decision.</step>
    <step order="5" role="agent_gateway">Send one concrete role and bounded context to its assigned profile.</step>
    <step order="6" role="checks">Run registered deterministic checks.</step>
    <step order="7" role="documentator">Apply an authorized document change and run document-lint.</step>
    <step order="8" role="response_formatter">Return a plain result in the current conversation language.</step>
  </flow>

  <installation status="proposed">
    <field id="workflow_platform_path">TODO</field>
    <field id="agent_gateway_path">TODO</field>
    <field id="workflow_db_path">TODO</field>
    <field id="gateway_db_path">TODO</field>
    <field id="codex_cli_path">TODO</field>
    <field id="response_language">TODO: en or ru; conversation language may override it.</field>
    <field id="project_root">TODO</field>
    <field id="project_id">TODO</field>
    <field id="selected_package">TODO: package key, version, and support status.</field>
    <field id="selected_preset">TODO: preset key or none.</field>
    <field id="explicit_skill_roots">TODO: owned Codex and/or Claude Code user skill roots.</field>
  </installation>

  <initial_configuration status="proposed">
    <purpose>Starter roles, catalogs, checks, and routes are an editable baseline.</purpose>
    <rule id="initial_config_is_editable">Initial configuration is not immutable canon.</rule>
    <rule id="project_owns_configuration">The project owner controls roles, documents, routes, and checks.</rule>
    <source>TODO: semantic package hash, optional preset proposal hash, and local record used as the source.</source>
  </initial_configuration>

  <registry id="project_registry" status="accepted">
    <rule id="documents_are_registered">Register project documents in Workflow DB; never hard-code them into runtime logic.</rule>
    <rule id="role_owns_document_access">Grant document access through role_documents read_access and write_access.</rule>
    <rule id="documentator_writes_by_permission">Documentator changes only a registered document for which the role has write permission.</rule>
    <documents>TODO: registered documents.</documents>
    <roles>TODO: project roles.</roles>
    <assignments>TODO: role-to-document assignments.</assignments>
  </registry>

  <roles status="accepted">
    <role id="classifier" artifact="classification" access="read">Determines intent and route.</role>
    <role id="coordinator" artifact="plan" access="read">Creates the smallest executable plan from the owner objective and registered evidence.</role>
    <role id="worker" artifact="result">Executes a bounded package step using only supplied context and declared resources.</role>
    <role id="reviewer" artifact="review" access="read">Checks the result and acceptance criteria.</role>
    <role id="editor" artifact="document_patch" access="registered_write">Applies project document rules to an evidenced result without changing product truth.</role>
    <role id="release_operator" artifact="release_evidence" access="declared_external_write">Executes only the exact release action bound to owner approval.</role>
    <service id="documentator">Validates authority, version, semantic markup, and atomic application for an authorized document patch.</service>
    <profiles>TODO: harness, local profile, provider, and model ID for each role.</profiles>
    <contract_rule id="portable_role_contract">Purpose, boundaries, work and artifact types, documents, tools, skills, checks, transitions, limits, result schema, and escalation belong in a portable versioned role contract.</contract_rule>
    <assignment_rule id="local_profile_assignment">Concrete profile and model ID are local assignments, not part of a portable role contract.</assignment_rule>
    <assignment_rule id="harness_provider_separation">Harness and model provider are independent fields; one model may be called through different harnesses or a compatible API.</assignment_rule>
  </roles>

  <structured_execution status="accepted">
    <rule id="planner_schema">Planner returns either a strict plan or questions before authorization; a worker receives only a normalized package.</rule>
    <rule id="registered_gates_only">Run only checks registered for the project, artifact type, and quality mode.</rule>
    <rule id="reviewer_decision">Reviewer returns PASS, CHANGES_REQUESTED, or REJECT; the latter two block completion.</rule>
    <rule id="human_acceptance_separate">Reviewer PASS does not replace deterministic gates or visual, gameplay, product, or business acceptance.</rule>
    <rule id="documentator_atomic">Documentator verifies target, authority, write permission, operation, and exact version; it lints before atomic replacement and preserves the source on conflict.</rule>
    <rule id="role_and_quality_contracts_are_separate">A role has one stable contract; quality is a separate universal contract.</rule>
    <rule id="workflow_owns_retries">WorkflowPlatform owns budgets, correction, checks, and escalation. One Gateway run performs one model call.</rule>
    <rule id="empty_program_gate_is_unavailable">For a program artifact, no applicable checks means unavailable, never passed.</rule>
    <rule id="typed_waits">Clarification waits for owner authority; external evidence waits for a registered factual packet. Both resume the same run only after structural validation.</rule>
    <rule id="resource_leases">Write-capable steps use registered resource aliases and ordered shared/exclusive leases. Unknown identity is unavailable.</rule>
    <rule id="approval_binding">Irreversible approval binds objective, plan, checkpoint, and exact action hashes; any change invalidates it.</rule>
  </structured_execution>

  <portable_package status="accepted">
    <field id="package_key">TODO: stable semantic key.</field>
    <field id="package_version">TODO: semantic version.</field>
    <field id="package_purpose">TODO: package purpose.</field>
    <rule id="complete_package">A package includes support status, role contracts, logical profiles, graph and transitions, state contract, routes, questions, schemas, checks, evidence flows, adapter capabilities, resource aliases, quality modes and budgets, correction and escalation, document authority and permissions, prompt-template versions, migrations, and anonymized scenarios.</rule>
    <rule id="no_local_identity">Never export secrets, root paths, local profile IDs, or model IDs.</rule>
    <rule id="proposal_first_import">Import first creates a hash-bound proposal and diff; apply requires owner confirmation and unchanged package and target hashes.</rule>
  </portable_package>

  <project_preset status="proposed">
    <field id="preset_key">TODO: shipped preset key or none.</field>
    <field id="source_scopes">TODO: verified source scopes.</field>
    <field id="required_adapters">TODO: capability, local binding, and evidence contract.</field>
    <field id="resource_aliases">TODO: alias, kind, canonical authority source, and allowed modes.</field>
    <field id="authority_boundary">TODO: default mode, live mutation, and publication rules.</field>
    <field id="first_value">TODO: first scenario and expected outcome.</field>
    <field id="acceptance_boundary">TODO: MECHANICS_ONLY, known-answer private, or OWNER_READ_REQUIRED.</field>
    <field id="substitution_metric">TODO: manual coordination artifact measured before and after.</field>
    <rule id="preset_is_not_user_voice">A machine-derived profile is an implementation hypothesis, not a quote, request, demand, or acceptance by the person whose work was analyzed.</rule>
  </project_preset>

  <external_control status="proposed">
    <field id="executors">TODO: registered executor IDs, public keys, capabilities, and resource aliases.</field>
    <rule id="signed_packets">External requests and results are Ed25519-signed and bound to project, run, step, request, checkpoint, payload, and idempotency hashes.</rule>
    <rule id="bounded_payload">Oversized or mismatched packets are rejected before hashing or persistence; unknown results remain pending or blocked, never partially accepted.</rule>
  </external_control>

  <experience_v1 status="accepted">
    <rule id="structured_observations_only">Store structured result, error category, gate outcomes, confirmed human feedback, and technical metrics; do not store full prompt, output, or transcript.</rule>
    <rule id="bounded_changes">Propose only a role contract, prompt template, check, or route change.</rule>
    <rule id="scenario_evaluation">Compare quality, estimated cost, duration, and pass state on saved anonymized scenarios.</rule>
    <rule id="confirmed_new_version">Apply only after confirmation as a new patch version of the package.</rule>
  </experience_v1>

  <workflows status="proposed">
    <rule id="package_routes_are_canonical">The imported package graph is canonical; the examples below are explanatory shapes, not hidden runtime defaults.</rule>
    <workflow id="conversation">classifier → response_formatter</workflow>
    <workflow id="research">classifier → coordinator → response_formatter</workflow>
    <workflow id="implementation">classifier → coordinator → worker → checks → bounded_correction → conditional_reviewer → documentator</workflow>
    <workflow id="content_production">classifier → coordinator → worker → editor → checks → conditional_reviewer → documentator</workflow>
    <workflow id="release">classifier → coordinator → worker → checks → reviewer → hash_bound_owner_approval → release_operator → verification</workflow>
    <project_workflows>TODO: project-specific routes.</project_workflows>
  </workflows>

  <quality_modes status="accepted">
    <mode id="prototype" reviewer="none" correction_limit="0">Test one risky assumption; require configured static checks and one observable signal.</mode>
    <mode id="mvp" reviewer="conditional" correction_limit="1">Complete one end-to-end user scenario; require applicable checks and purpose-built tests.</mode>
    <mode id="production" reviewer="required" correction_limit="1">Build, deploy, verify the target environment, and define rollback; irreversible action requires owner approval.</mode>
    <mode id="security-audit" reviewer="security_required" correction_limit="0">Run a separate read-only security review; remediation belongs to another workflow.</mode>
    <contract_source>contracts/quality-contracts.xml</contract_source>
  </quality_modes>

  <chat_entry_skill status="proposed">
    <command harness="codex">/zodchi or /zod</command>
    <command harness="claude-code">/zodchi or /zod</command>
    <ordinary_messages>not intercepted</ordinary_messages>
    <verification>Verify the host version, one explicit task, the workflow_runs record with the expected client value, and the absence of a run for an ordinary message.</verification>
  </chat_entry_skill>

  <extension_rules status="accepted">
    <rule id="no_project_names_in_runtime">WorkflowPlatform contains no names of user projects or project documents.</rule>
    <rule id="new_workflow_is_configured">Configure a new workflow through catalogs, roles, document bindings, profiles, and routes.</rule>
    <rule id="fail_closed_classifier">If the LLM classifier returns no valid decision, stop with classification_failed.</rule>
  </extension_rules>
</document>
