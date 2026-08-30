<document id="zodchi_onboarding" status="accepted" authority="zodchi" version="0.6.7" language="en">
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
    <check id="installed_harness_inventory">Inspect Codex, Claude Code, Kimi, OpenCode, Cursor, and configured compatible APIs separately. Record verified version and authentication as available, unauthenticated, unavailable, or unverified; never infer access from an installed desktop application.</check>
    <check id="provider_access">Verify configured provider access through a safe Gateway call only after the owner permits that provider.</check>
    <check id="harness_access">Verify each selected harness separately. A chat entry host, an agent harness, a model provider, and a model ID are four different facts.</check>
    <check id="existing_data">Never copy another person's databases, credentials, history, or receipts.</check>
  </preflight>

  <project_onboarding status="accepted">
    <step order="1" id="identify_project">Locate the first project root. If several candidates remain, ask one short question.</step>
    <step order="2" id="register_project">Register the project, root path, domain, and disciplines in Workflow DB.</step>
    <step order="3" id="load_catalogs">Load catalogs from configs/catalogs.json.</step>
    <step order="4" id="discover_documents">Automatically inspect the existing project documents during onboarding; do not wait for the person to request this analysis. Explain that controlled documents give roles stable project truth, make accepted decisions lintable, and prevent the workflow from inventing filenames or treating absent templates as facts. A package filename is never a requirement and absence is not a gap until the owner selects that document.</step>
    <step order="5" id="propose_ownership">Present a short, evidence-based proposal of zero or more controlled documents, their lint mode, owners, and role read/write access. Prefer global semantic statuses and evidence types; propose a project-local key only when its meaning cannot be represented by the portable global vocabulary. The person may keep no controlled documents.</step>
    <step order="6" id="confirm_ownership">Never assign ownership silently. Wait for the person's confirmation.</step>
    <step order="7" id="write_registry">After confirmation, use document-register and the project vocabulary commands to write project_documents and role_documents to Workflow DB. Adding or removing one controlled document must not require rebuilding the workflow package.</step>
    <step order="8" id="confirm_routes">Propose mappings from registered work_types to workflow_routes and wait for owner confirmation; never select a product route silently.</step>
    <step order="9" id="write_routes">Write only confirmed workflow_routes. The classifier must not use a route absent from the registry.</step>
    <step order="10" id="architecture_document">Copy configs/WorkflowPlatformArchitecture.template.md into a local project-onboarding document and fill only verified values.</step>
    <step order="11" id="local_assignments">Show the verified harness/provider/model inventory, ask which systems the owner permits Zodchi to use, and ask about cost, privacy, and role preferences that cannot be inferred. Propose the smallest role assignment that satisfies the selected workflows; do not enable every available model merely because it is installed. The direct chat runtime always requires both a classifier and a read-only researcher assignment: research is a valid classifier outcome even when the selected package does not contain a researcher step. Create a local installation config from configs/installation.example.json only from confirmed assignments. Never include tokens, cookies, passwords, or authentication files.</step>
    <step order="11.1" id="researcher_document_access">When controlled documents were owner-confirmed, explicitly include proposed read-only researcher access in the same ownership proposal. The owner may instead confirm no researcher-readable documents; record that choice and explain that bounded research will then have no registered document context. Never grant document access merely because the researcher profile exists.</step>
    <rule id="separate_harness_and_model_provider">For each local profile, record harness, model provider, and model ID separately. For a compatible API, store only baseUrl and the apiKeyEnv variable name, never the key value.</rule>
    <rule id="tool_roles_need_harness">Assign roles that need files, terminal, or tools to an agent harness. Use a direct compatible API only for bounded work over supplied context.</rule>
    <rule id="selected_provider_smoke">Run one safe smoke for every selected provider/profile. Keep a failed or unverified profile unavailable and explain the exact boundary instead of silently replacing it.</rule>
    <step order="12" id="configure_installation">Run `node WorkflowPlatform/src/cli.mjs configure --config &lt;local-installation-config&gt;`. A shared installation uses scope=shared and a localDataRoot outside the release. The command creates external runtime.json, a local policy overlay containing only profiles, and both database paths. Do not modify release adapters or universal policy.</step>
    <step order="13" id="configure_runtime_environment">On Windows, persist the returned WORKFLOW_PLATFORM_CONFIG as a user environment variable and explain that the chat host may require a restart. Installed user skills must reference WorkflowPlatform in the installed release, not the development repository.</step>
    <step order="14" id="role_contracts">Propose portable versioned role contracts separately from local profile/model assignments. Define boundaries, artifacts, documents, tools/skills, checks, transitions, limits, result schema, and escalation for each role; never put a local model in the contract.</step>
    <step order="15" id="registered_checks">Register only checks relevant to the project, artifact type, and quality mode. Do not infer commands automatically from a programming language or package.json.</step>
    <step order="16" id="portable_package_contract">Define semantic package key/version/purpose, full step graph and transitions, human questions, schemas, quality policies, prompt-template versions, and anonymized scenarios. Exclude local profiles, model IDs, absolute paths, and secrets.</step>
    <step order="17" id="import_confirmation">Before importing, run workflow-import-propose, show a compact diff, and run workflow-import-apply with confirmed-by only after explicit confirmation.</step>
    <step order="18" id="starter_package_selection">Show packages from WorkflowPlatform/packages/catalog.json with their support status. Do not import a package or assign local profiles/check commands until the person confirms the project and diff. A preview package proves executable mechanics, not domain truth or product fit.</step>
    <step order="19" id="preset_selection">When a shipped recipe matches the project, inspect it with `preset-inspect` and create a proposal with `preset-propose`. Show its package keys, source scopes, required adapters, resource aliases, authority boundaries, first-value scenario, fixture boundary, private acceptance contract, and substitution metric. Never treat the profile description as a statement made by that person.</step>
    <step order="20" id="local_capability_binding">Bind every required local adapter, project command, external runtime, database, information base, calendar, or resource alias explicitly. If a required capability or canonical resource identity is absent, report `unavailable`; never invent it or silently weaken the package.</step>
    <step order="21" id="run_profile_selection">Explain and propose project defaults for four independent axes at every quality level: Quality selects the result contract; Execution selects standard or persistent Goal; Verification selects baseline or Gauntlet trials; Planning selects one planner or an independent planner ensemble with synthesis. Inspect the confirmed provider/profile inventory before proposing ensemble. If fewer than two independent planner bindings are available, state that Planning will be single and never simulate an ensemble. Explain that reflection checkpoints derive from Goal execution and elapsed active work, while known long builds/tests are exempt from strategy alarms. Wait for owner confirmation, then apply each default with run-profile-set. The same setup chat later handles plain-language requests to inspect or change these defaults. Prototype has no mandatory reviewer, MVP requires review, and production/security use stricter review contracts; Gauntlet never creates a review requirement by itself.</step>
    <step order="22" id="runtime_readiness">Run `project-readiness` after profile and document bindings are applied. Do not spend a classifier call until both direct runtime roles are configured. Show an explicit warning when the owner selected controlled documents but none are readable by the researcher.</step>
  </project_onboarding>

  <chat_entry_skill status="accepted">
    <rule id="explicit_only">Ordinary messages remain ordinary host-chat messages until `/zodchi` activates Zodchi mode for that exact client session.</rule>
    <step order="1" id="select_entry">Ask which chat entry point the person uses. Install user skills only for supported selected hosts.</step>
    <step order="2" id="verify_installation">Verify the owned `zodchi` skill and the owned conditional session-router entries in each selected host. Both must reference the installed release, never the development repository. Remove only an unchanged legacy `zod` alias owned by this exact installation.</step>
    <step order="3" id="codex_hook_trust">For Codex, open `/hooks` after every install or hook-command change, approve the exact Zodchi UserPromptSubmit and SessionEnd entries, and start a new chat. An enabled toggle is not proof of approval: inspect Codex `hooks/list` and require `trustStatus=trusted` for both current hashes. Never write Codex private trust hashes on the person's behalf without their explicit approval.</step>
    <step order="4" id="verify_explicit_run">Invoke `/zodchi` through the host's real skill mention, send a safe ordinary follow-up in that same chat, and confirm a workflow_runs record with the expected client value. A direct call of session-router.mjs is only a component test and does not prove host dispatch, hook trust, or skill-input decoding.</step>
    <step order="5" id="verify_non_interception">Send or inspect an ordinary message in another session and confirm that it did not create a Zodchi run.</step>
    <rule id="session_identity">Activation is keyed by client and session id, cannot silently move to another registered project, and ends automatically with the host session.</rule>
    <rule id="single_public_command">`/zodchi` is the only public command. Status, preparation, execution, and cleanup remain internal platform operations rather than separate slash commands.</rule>
    <rule id="conditional_router_only">The installed router must emit no output and create no run for an inactive session. Never restore the legacy unconditional project hook.</rule>
    <rule id="activation_delivery">A successful activation is a normal non-blocking host turn in both Codex and Claude Code. Claude Code consumes the advisory activation context directly. If Codex omits that context, the managed skill checks the exact current `CODEX_SESSION_ID` in the canonical database before acknowledging activation. A blocking final hook response is reserved for a prepared Zodchi result, where it prevents the host from repeating paid work.</rule>
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
    <field id="run_profile_defaults">Owner-confirmed Quality, Execution, Verification, and Planning defaults, including any ensemble capability fallback.</field>
    <field id="human_actions">Decisions requiring confirmation.</field>
    <field id="test_instruction">First safe test.</field>
    <rule id="human_response">Do not show SQL, JSON, or internal identifiers unless requested.</rule>
  </output>
</document>
