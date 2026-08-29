<document id="zodchi_onboarding" status="accepted" authority="zodchi" version="0.6.1" language="en">
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
    <step order="3" id="install_mode">For ordinary use, install the latest published GitHub Release with `tools/install-latest.ps1` on Windows or `tools/install-latest.sh` on macOS/Linux. Do not use main-branch sources as the installed program, and do not accept assets that fail publisher, workflow, provenance, manifest, or checksum validation.</step>
    <step order="4" id="development_mode">For product development, clone the repository into a permanent development directory; still build and install the working release into a separate replaceable directory.</step>
    <step order="5" id="separate_data">Keep personal databases and settings in a third permanent directory outside both source and installed program.</step>
    <rule id="development_project_layout">In a Codex project for Zodchi development, use the source repository as the primary folder. The installed release and local data may be secondary folders for delivery verification and analytics. Edit code only in sources, update the release through the builder, and change data through supported commands.</rule>
  </acquisition>

  <preflight status="accepted">
    <check id="workflow_platform_path">Locate WorkflowPlatform inside the installed Zodchi release.</check>
    <check id="agent_gateway_path">Locate AgentGateway inside the installed Zodchi release.</check>
    <check id="model_provider_catalog">Read AgentGateway/model-providers.json and propose only implemented harness-provider combinations.</check>
    <check id="node_runtime">Verify Node.js 24 or newer and package.json. The bootstrap diagnoses a missing runtime but does not install system Node without separate owner authority.</check>
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
    <step order="13" id="configure_runtime_environment">On Windows, persist the returned WORKFLOW_PLATFORM_CONFIG as a user environment variable and explain that the chat host may require a restart. Installed user skills must reference WorkflowPlatform in the installed release, not the development repository.</step>
    <step order="14" id="role_contracts">Propose portable versioned role contracts separately from local profile/model assignments. Define boundaries, artifacts, documents, tools/skills, checks, transitions, limits, result schema, and escalation for each role; never put a local model in the contract.</step>
    <step order="15" id="registered_checks">Register only checks relevant to the project, artifact type, and quality mode. Do not infer commands automatically from a programming language or package.json.</step>
    <step order="16" id="portable_package_contract">Define semantic package key/version/purpose, full step graph and transitions, human questions, schemas, quality policies, prompt-template versions, and anonymized scenarios. Exclude local profiles, model IDs, absolute paths, and secrets.</step>
    <step order="17" id="import_confirmation">Before importing, run workflow-import-propose, show a compact diff, and run workflow-import-apply with confirmed-by only after explicit confirmation.</step>
    <step order="18" id="starter_package_selection">Show packages from WorkflowPlatform/packages/catalog.json with their support status. Do not import a package or assign local profiles/check commands until the person confirms the project and diff. A preview package proves executable mechanics, not domain truth or product fit.</step>
    <step order="19" id="preset_selection">When a shipped recipe matches the project, inspect it with `preset-inspect` and create a proposal with `preset-propose`. Show its package keys, source scopes, required adapters, resource aliases, authority boundaries, first-value scenario, fixture boundary, private acceptance contract, and substitution metric. Never treat the profile description as a statement made by that person.</step>
    <step order="20" id="local_capability_binding">Bind every required local adapter, project command, external runtime, database, information base, calendar, or resource alias explicitly. If a required capability or canonical resource identity is absent, report `unavailable`; never invent it or silently weaken the package.</step>
  </project_onboarding>

  <chat_entry_skill status="accepted">
    <rule id="explicit_only">Ordinary messages remain ordinary host-chat messages. Zodchi runs only after `/zodchi` or its short alias `/zod` is invoked explicitly.</rule>
    <step order="1" id="select_entry">Ask which chat entry point the person uses. Install user skills only for supported selected hosts.</step>
    <step order="2" id="verify_installation">Verify the owned `zodchi` and `zod` skill directories and their ownership records. They must reference the installed release, never the development repository.</step>
    <step order="3" id="verify_explicit_run">Invoke `/zodchi &lt;safe test task&gt;` and confirm a workflow_runs record with the expected client value.</step>
    <step order="4" id="verify_non_interception">Send or inspect an ordinary host message and confirm that it did not create a Zodchi run.</step>
    <rule id="exact_task_bytes">The skill writes the selected task to a fresh UTF-8 file and passes only the file path to the runtime. Never interpolate task text into a shell command.</rule>
    <rule id="empty_command_context">When the command has no arguments, use only the immediately preceding substantive user request and only when the selection is unambiguous; otherwise ask for an explicit task.</rule>
    <rule id="no_persistent_toggle">The 0.6 contract is one-shot explicit invocation. Do not add an unconditional hook to emulate persistent on/off mode.</rule>
    <rule id="legacy_hook_migration">Install and update remove only legacy project hooks proved to be owned by Zodchi. Foreign hook entries are never rewritten.</rule>
  </chat_entry_skill>

  <databases status="accepted">
    <database id="workflow_db">Local workflow state, document registry, roles, routes, decisions, and checks.</database>
    <database id="gateway_db">Local technical model-call receipts, tokens, cache, duration, and errors.</database>
    <rule id="local_only">Each user creates local databases; they are not part of the Zodchi release.</rule>
    <rule id="local_profiles">Concrete harnesses, providers, profiles, and models go only into local policy.local.json after confirmation.</rule>
  </databases>

  <owner_and_external_evidence status="accepted">
    <rule id="clarification_is_authority">Use `clarification_required` only when the owner must decide or clarify authority; the explicit answer resumes the same run and is not interpreted as a new task.</rule>
    <rule id="external_evidence_is_fact">Use `external_evidence_required` when a fact must come from a registered runtime, information base, database, or operator. Resume only after the packet matches the run, request, project, resource, collector, completeness rule, claims, and hashes.</rule>
    <rule id="approval_is_hash_bound">Approval of an irreversible action binds the owner objective, plan, checkpoint, and exact action. Any changed bound input requires a new approval.</rule>
    <rule id="owner_read_is_not_acceptance">Record `OWNER_READ` only from an explicit owner action bound to the terminal run, preset, active package version, and artifact SHA-256. It means read, not accepted.</rule>
  </owner_and_external_evidence>

  <safety status="accepted">
    <rule id="no_foreign_data">Never copy unrelated projects, documents, databases, credentials, or history.</rule>
    <rule id="no_silent_writes">Never change documents or assign ownership without confirmation.</rule>
    <rule id="classifier_fail_closed">If the LLM classifier does not return a valid decision, stop with classification_failed.</rule>
    <rule id="registered_context_only">Classifier, researcher, and other roles receive only registered documents permitted for the role. Do not scan well-known filenames or directories as hidden defaults.</rule>
    <rule id="structured_role_results">Planner, worker, reviewer, and documentator return their exact schemas. Reviewer PASS does not replace deterministic gates or human acceptance.</rule>
    <rule id="experience_confirmation">Evaluate experience proposals on anonymized scenarios and never apply them automatically. Owner confirmation creates a new package version.</rule>
    <rule id="foreign_skill_safety">Never overwrite a same-named skill without a valid Zodchi ownership record, and never remove an owned skill whose managed content was edited.</rule>
    <rule id="canonical_resource_safety">A write-capable step names registered resource aliases. WorkflowPlatform resolves canonical identities and ordered shared/exclusive leases; an unknown identity is unavailable, not an unprotected write.</rule>
    <rule id="private_receipts">Persist technical receipts, hashes, usage, timing, compact errors, and artifact references only. Do not persist full prompts, responses, transcripts, or source bodies.</rule>
  </safety>

  <output status="accepted">
    <field id="connected_components">Connected components.</field>
    <field id="registered_project">Registered project.</field>
    <field id="found_documents">Discovered documents.</field>
    <field id="proposed_roles">Proposed roles and owners.</field>
    <field id="selected_package_and_preset">Confirmed package, support status, optional preset, and proposal hash.</field>
    <field id="local_capabilities">Required adapters, commands, resource aliases, and any unavailable dependency.</field>
    <field id="human_actions">Decisions requiring confirmation.</field>
    <field id="test_instruction">First safe test.</field>
    <rule id="human_response">Do not show SQL, JSON, or internal identifiers unless requested.</rule>
  </output>
</document>
