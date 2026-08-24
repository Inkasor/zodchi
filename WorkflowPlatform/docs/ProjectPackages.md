<document id="zodchi_project_packages" status="accepted" authority="zodchi" version="2.1.1" language="en">
  <title>Portable project packages</title>
  <purpose>Define the portable workflow packages shipped with Zodchi and their verified boundaries.</purpose>

  <package_contract status="accepted">
    <rule id="generated_packages">All twelve project packages live in packages/generated, are listed in packages/catalog.json, pass npm run packages:check, and may be imported only through a proposed diff followed by confirmed apply.</rule>
    <rule id="portable_content">Packages contain no local paths, secrets, user profiles, or model names. Shared contracts use version 2.1.0; one-c.development 2.1.1 adds local BSL Language Server integration with accepted baselines.</rule>
    <rule id="normalized_policy">Budgets, checks, and escalation policies are stored in normalized WorkflowPlatform tables.</rule>
  </package_contract>

  <quality_modes status="accepted">
    <mode id="prototype">Test one risky assumption with static analysis or language diagnostics and no mandatory expensive independent reviewer.</mode>
    <mode id="mvp">Run every deterministic check relevant to the change, add purpose-built tests, and review conditionally for risk or correction.</mode>
    <mode id="production">Rerun MVP checks and add build, release, deployment, observability, rollback, and independent review.</mode>
    <mode id="security-audit">Run a separate read-only security audit with a required reviewer and no remediation inside the audit.</mode>
    <rule id="quality_cascade">Each stricter level reruns applicable lower-level checks for the changed result. A previous green result is not inherited after a change.</rule>
    <rule id="unavailable_is_not_passed">A missing tool or unconfigured target environment is unavailable, never passed.</rule>
    <rule id="gateway_boundary">AgentGateway performs one bounded model call; WorkflowPlatform owns total budget, one permitted correction cycle, and reviewer selection.</rule>
  </quality_modes>

  <package_group id="indie_studio" status="accepted">
    <packages>indie-studio.project-m, indie-studio.project-r</packages>
    <roles>producer_assistant, game_designer, narrative_designer, game_programmer, visual_artist, technical_artist, sound_designer, game_tester, playtester, release_operator, classifier, researcher, planner, reviewer, documentator</roles>
    <routes>strategy, game design, narrative design, game implementation, visual asset, audio asset, prototype, playtest, release</routes>
    <rule id="separate_project_contracts">Project M and Project R reuse role semantics but keep separate workflow keys, documents, and checks.</rule>
    <rule id="project_m_checks">Project M uses ESLint and registered monorepo typecheck, build, and map-render commands.</rule>
    <rule id="project_r_checks">Project R uses ESLint, project tests, build, and map-engine compatibility checks.</rule>
    <rule id="human_game_acceptance">Technical PASS never closes gameplay, visual, product, or publication acceptance; release requires separate publication authority.</rule>
  </package_group>

  <package_group id="shared_map_engine" status="accepted">
    <package>shared-map-engine.core</package>
    <roles>architect, programmer, tester, reviewer, documentator</roles>
    <rule id="presentation_neutral">The route goes from consumer contract to version documentation and remains presentation-neutral.</rule>
    <rule id="consumer_checks">Compatibility checks resolve local Project M and Project R roots from the project registry. A missing consumer stays unavailable.</rule>
    <known_limit id="project_m_renderer">Production-map integration with the Project M renderer remains unavailable while its test contains a non-portable relative import.</known_limit>
  </package_group>

  <package_group id="shared_lore" status="accepted">
    <package>shared-lore.canon</package>
    <flow>exact source search → proposal → continuity review → owner decision → canon and index → separate Project M and Project R synchronization proposals</flow>
    <rule id="owner_canon">The package cannot accept shared canon on behalf of the owner.</rule>
    <rule id="registered_validators">Index, continuity, and source-hash checks remain unavailable until local validators are registered.</rule>
  </package_group>

  <package_group id="one_c_development" status="accepted">
    <package>one-c.development</package>
    <flow>task analysis → owner boundary confirmation → change → deterministic checks → conditional review → documentation → user acceptance</flow>
    <roles>analyst, developer, tester, reviewer, documentator</roles>
    <rule id="independent_acceptance">The analyst keeps business, source, local build, server runtime, and user acceptance as independent criteria.</rule>
    <rule id="skill_allowlist">Role skills are an explicit project allowlist; importing the package installs no tools.</rule>
    <check id="bsl_language_server">The BSL Language Server check is required by the workflow but configured locally with an executable path, 1C bin directory, and an owner-accepted Git-revision baseline.</check>
    <rule id="normalized_bsl_baseline">Normalized check_baselines and check_baseline_diagnostics store the baseline. The generated 186-rule catalog keeps severity and tags separately from project policy.</rule>
    <rule id="ordinary_bsl_policy">Ordinary work blocks only new critical correctness findings. Complexity, style, documentation, and maintainability findings remain visible but non-blocking.</rule>
    <rule id="security_bsl_policy">Security audit also blocks new vulnerability and security-attention findings; ordinary style findings remain non-blocking.</rule>
    <rule id="separate_build_runtime">Stejmins build and target-environment verification are separate project checks and may never be represented as green when unavailable.</rule>
    <rule id="deterministic_bsl_gate">Interactive MCP/LSP may be offered to 1C roles separately. The deterministic workflow gate uses analyze and parses its JSON report.</rule>
  </package_group>

  <package_group id="company_web" status="accepted">
    <packages>company-web.marketplaces-data, company-web.dashboard, company-web.photo-hub, company-web.mapping-hub, company-web.interior-hub, company-operations.core</packages>
    <rule id="ordinary_language">Colleagues describe work in ordinary language; the classifier selects only registered work types and routes.</rule>
    <rule id="separate_research_execution">Research never starts a developer unless classification selects an execution route.</rule>
    <rule id="safe_data_change">Data changes are prepared and verified on a safe copy first.</rule>
    <rule id="owner_actions">Access, publication, and deployment require a separate human approval step.</rule>
    <rule id="local_installations">Company settings may be shared as packages, but every installation uses its own databases and project hooks.</rule>
    <rollout status="proposed">Marketplace Data is the first active rollout. Dashboard and colleague projects may be imported in advance but do not execute without their own trusted project hook.</rollout>
  </package_group>
</document>
