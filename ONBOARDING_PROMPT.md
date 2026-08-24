<document id="zodchi_onboarding" status="accepted" authority="zodchi" version="0.3.0-beta.3" language="en">
  <title>Initial Zodchi setup</title>
  <purpose>Instructions for the LLM that installs and configures Zodchi. Use the person's actual conversation language, explain things plainly, and never ask them to fill internal fields.</purpose>

  <input id="user_request" status="accepted">Open the Zodchi repository, read this document, install the latest published release, and configure it for my project.</input>

  <communication status="accepted">
    <rule id="host_language_first">Use an explicit language supplied by the host when available.</rule>
    <rule id="installation_language_second">Otherwise use the responseLanguage value confirmed during onboarding.</rule>
    <rule id="conversation_language_wins">When the person starts or continues speaking another supported language, continue in that language.</rule>
    <rule id="machine_contracts_are_english">Keep schema keys, enum values, portable packages, and machine-operated prompts in English.</rule>
  </communication>

  <acquisition status="accepted">
    <rule id="repository_link_is_enough">When the person supplies only the repository URL, read this file and continue independently. Do not require a manual download or command entry.</rule>
    <step order="1" id="obtain_installer">If no local repository exists, clone https://github.com/Inkasor/zodchi into a disposable directory, read the documentation, and use its supported tools.</step>
    <step order="2" id="choose_mode">Determine whether the person wants to use Zodchi or develop Zodchi. If this is unclear and affects paths, ask one plain question.</step>
    <step order="3" id="install_mode">For ordinary use, install the latest published GitHub Release with tools/install-latest.ps1. Do not use main-branch sources as the installed program.</step>
    <step order="4" id="development_mode">For product development, clone the repository into a permanent development directory; still build and install the working release into a separate replaceable directory.</step>
    <step order="5" id="separate_data">Keep personal databases and settings in a third permanent directory outside both source and installed program.</step>
    <rule id="development_project_layout">In a Codex project for Zodchi development, use the source repository as the primary folder. The installed release and local data may be secondary folders for delivery verification and analytics. Edit code only in sources, update the release through the builder, and change data through supported commands.</rule>
  </acquisition>

  <preflight status="accepted">
    <check id="workflow_platform_path">Locate WorkflowPlatform inside the installed Zodchi release.</check>
    <check id="agent_gateway_path">Locate AgentGateway inside the installed Zodchi release.</check>
    <check id="model_provider_catalog">Read AgentGateway/model-providers.json and propose only implemented harness-provider combinations.</check>
    <check id="node_runtime">Verify Node.js and package.json.</check>
    <check id="codex_cli">Locate Codex CLI and run codex --version.</check>
    <check id="opencode_desktop_cli">When OpenCode is selected, verify Desktop and CLI independently. OpenCode Desktop does not imply an opencode command. If the CLI is absent, install the official opencode-ai package, run opencode --version, and then perform a safe Gateway smoke call.</check>
    <check id="codex_project_config">Locate the Codex project configuration and .codex directory.</check>
    <check id="provider_access">Verify configured provider access through a safe Gateway call.</check>
    <check id="harness_access">Verify the selected harness separately: Codex, Claude Code, Kimi, OpenCode, Cursor, or a direct compatible API. A program name is not a model-provider name.</check>
    <check id="existing_data">Never copy another person's databases, credentials, history, or receipts.</check>
  </preflight>

  <project_onboarding status="accepted">
    <step order="1" id="identify_project">Locate the first project root. If several candidates remain, ask one short question.</step>
    <step order="2" id="register_project">Register the project, root path, domain, and disciplines in Workflow DB.</step>
    <step order="3" id="load_catalogs">Load catalogs from configs/catalogs.json.</step>
    <step order="4" id="discover_documents">Discover project documents and validate their format, status, and encoding.</step>
    <step order="5" id="propose_ownership">Propose document owners and role read/write access.</step>
    <step order="6" id="confirm_ownership">Never assign ownership silently. Wait for the person's confirmation.</step>
    <step order="7" id="write_registry">After confirmation, write project_documents and role_documents to Workflow DB.</step>
    <step order="8" id="confirm_routes">Propose mappings from registered work_types to workflow_routes and wait for owner confirmation; never select a product route silently.</step>
    <step order="9" id="write_routes">Write only confirmed workflow_routes. The classifier must not use a route absent from the registry.</step>
    <step order="10" id="architecture_document">Copy configs/WorkflowPlatformArchitecture.template.md into a local project-onboarding document and fill only verified values.</step>
    <step order="11" id="local_assignments">Create a local installation config from configs/installation.example.json using confirmed assignments. Never include tokens, cookies, passwords, or authentication files.</step>
    <rule id="separate_harness_and_model_provider">For each local profile, record harness, model provider, and model ID separately. For a compatible API, store only baseUrl and the apiKeyEnv variable name, never the key value.</rule>
    <rule id="tool_roles_need_harness">Assign roles that need files, terminal, or tools to an agent harness. Use a direct compatible API only for bounded work over supplied context.</rule>
    <step order="12" id="configure_installation">Run `node WorkflowPlatform/src/cli.mjs configure --config &lt;local-installation-config&gt;`. A shared installation uses scope=shared and a localDataRoot outside the release. The command creates external runtime.json, a local policy overlay containing only profiles, and both database paths. Do not modify release adapters or universal policy.</step>
    <step order="13" id="configure_runtime_environment">On Windows, persist the returned WORKFLOW_PLATFORM_CONFIG as a user environment variable and explain that Codex must restart. Project hooks must reference WorkflowPlatform in the installed release, not the development repository.</step>
    <step order="14" id="role_contracts">Propose portable versioned role contracts separately from local profile/model assignments. Define boundaries, artifacts, documents, tools/skills, checks, transitions, limits, result schema, and escalation for each role; never put a local model in the contract.</step>
    <step order="15" id="registered_checks">Register only checks relevant to the project, artifact type, and quality mode. Do not infer commands automatically from a programming language or package.json.</step>
    <step order="16" id="portable_package_contract">Define semantic package key/version/purpose, full step graph and transitions, human questions, schemas, quality policies, prompt-template versions, and anonymized scenarios. Exclude local profiles, model IDs, absolute paths, and secrets.</step>
    <step order="17" id="import_confirmation">Before importing, run workflow-import-propose, show a compact diff, and run workflow-import-apply with confirmed-by only after explicit confirmation.</step>
    <step order="18" id="starter_package_selection">Show packages from WorkflowPlatform/packages/catalog.json. Do not import a package or assign local profiles/check commands until the person confirms the project and diff.</step>
    <step order="19" id="company_bundle_validation">For a company bundle, first run workflow-bundle-inspect on WorkflowPlatform/packages/generated/company-workflows.xml. Propose only the project package matching the current project. Do not copy unrelated projects or enable their hooks.</step>
  </project_onboarding>

  <codex_hook status="accepted">
    <step order="1">Use configs/codex-hooks.template.json.</step>
    <step order="2">Insert the installed WorkflowPlatform path.</step>
    <step order="3">Create or update the project's .codex/hooks.json.</step>
    <step order="4">Verify that the command starts hooks/codex-user-prompt-submit.mjs.</step>
    <step order="5">Use a test event to confirm a workflow_runs record.</step>
    <rule id="stable_event_id">Pass the client's stable event_id for duplicate-delivery protection. Never replace a missing ID with a message-text hash.</rule>
    <human_gate>If Codex marks the hook untrusted, tell the person in their language to open the Codex project settings and trust the WorkflowPlatform hook. This is an authorization step, not a system failure.</human_gate>
    <new_chat>After trust is confirmed, ask the person to open a new chat and send an ordinary test message.</new_chat>
  </codex_hook>

  <databases status="accepted">
    <database id="workflow_db">Local workflow state, document registry, roles, routes, decisions, and checks.</database>
    <database id="gateway_db">Local technical model-call receipts, tokens, cache, duration, and errors.</database>
    <rule id="local_only">Each user creates local databases; they are not part of the Zodchi release.</rule>
    <rule id="local_profiles">Concrete harnesses, providers, profiles, and models go only into local policy.local.json after confirmation.</rule>
  </databases>

  <safety status="accepted">
    <rule id="no_foreign_data">Never copy unrelated projects, documents, databases, credentials, or history.</rule>
    <rule id="no_silent_writes">Never change documents or assign ownership without confirmation.</rule>
    <rule id="classifier_fail_closed">If the LLM classifier does not return a valid decision, stop with classification_failed.</rule>
    <rule id="registered_context_only">Classifier, researcher, and other roles receive only registered documents permitted for the role. Do not scan well-known filenames or directories as hidden defaults.</rule>
    <rule id="structured_role_results">Planner, worker, reviewer, and documentator return their exact schemas. Reviewer PASS does not replace deterministic gates or human acceptance.</rule>
    <rule id="experience_confirmation">Evaluate experience proposals on anonymized scenarios and never apply them automatically. Owner confirmation creates a new package version.</rule>
    <rule id="human_hook_trust">Only a person can trust a hook in Codex.</rule>
  </safety>

  <output status="accepted">
    <field id="connected_components">Connected components.</field>
    <field id="registered_project">Registered project.</field>
    <field id="found_documents">Discovered documents.</field>
    <field id="proposed_roles">Proposed roles and owners.</field>
    <field id="human_actions">Decisions requiring confirmation.</field>
    <field id="test_instruction">First safe test.</field>
    <rule id="human_response">Do not show SQL, JSON, or internal identifiers unless requested.</rule>
  </output>
</document>
