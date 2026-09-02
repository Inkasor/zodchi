<document id="zodchi_project_packages" status="accepted" authority="zodchi" version="4.0.0" language="en">
  <title>Portable project packages</title>
  <purpose>Define what a portable workflow package is, where its source lives, and the boundaries every package must keep.</purpose>

  <package_source status="accepted">
    <rule id="definitions_are_explicit">A package definition describes documents, checks, thresholds, evidence flows, resources, adapters, and approval boundaries. The definition source is always an explicit parameter. This repository ships the SDK and a public seven-package reference catalog; an installation may name its own definitions without changing platform core.</rule>
    <rule id="source_is_stated">The definition source is named by the caller and never inherited from the environment. With no argument the repository example is used, so packages:check verifies this repository against itself on any machine; an installation names its own file with --definitions, or --installation to use the file its packageDefinitions setting declares. A generation run that follows an exported variable checks whichever installation that shell was configured for, which is a different check on every machine and no check at all in CI.</rule>
    <rule id="definition_shape">A definition file default-exports a function that receives the builder module and returns packages and bundles. It therefore needs no import path of its own and can live anywhere.</rule>
    <rule id="generated_beside_source">Generated packages are written to a generated directory beside their definition source, are produced by npm run packages:generate, and are verified by npm run packages:check together with public catalog metadata.</rule>
    <rule id="import_is_confirmed">A package may be imported only through a proposed diff bound to the package hash, followed by a confirmed apply naming the person who confirmed it.</rule>
  </package_source>

  <portable_content status="accepted">
    <rule id="no_local_identity">A package contains no local paths, secrets, user profiles or model names. Model choice is a local overlay resolved by AgentGateway against the profile the package names.</rule>
    <rule id="normalized_policy">Budgets, checks and escalation policies are stored in normalized WorkflowPlatform tables, not in prose.</rule>
    <rule id="shareable">Because a package carries no local identity, an exported package can be handed to another installation as is. Use workflow-export to produce one from a live registry.</rule>
    <rule id="sdk_composition">SDK v4 composes capabilities into roles, workflows, checks, evidence flows, resource aliases, authority, schemas, quality modes, migration metadata, and deterministic generated XML. Project vocabulary stays in package definitions and adapters, never in generic runtime truth.</rule>
  </portable_content>

  <quality_modes status="accepted">
    <mode id="prototype">Test one risky assumption with static analysis or language diagnostics and no mandatory expensive independent reviewer.</mode>
    <mode id="mvp">Run every deterministic check relevant to the change, add purpose-built tests, and review conditionally for risk or correction.</mode>
    <mode id="production">Rerun MVP checks and add build, release, deployment, observability, rollback, and independent review.</mode>
    <mode id="security-audit">Run a separate read-only security audit with a required reviewer and no remediation inside the audit.</mode>
    <rule id="quality_cascade">A gate resolves the checks of its own level and every level below it. A previous green result is not inherited after a change.</rule>
    <rule id="security_reaches_release">A security audit sits above production, so a scan bound to the audit alone would never run on a release. Secret and dependency scans are bound to production as well.</rule>
    <rule id="declared_quality_is_a_floor">A workflow declares the quality it was built for. The classifier may raise a routed run above it and never below, because a lower level drops the checks the workflow depends on.</rule>
    <rule id="unavailable_is_not_passed">A missing tool or unconfigured target environment is unavailable, never passed.</rule>
    <rule id="gateway_boundary">AgentGateway performs one bounded model call; WorkflowPlatform owns total budget, one permitted correction cycle, and reviewer selection.</rule>
  </quality_modes>

  <owner_boundary status="accepted">
    <rule id="irreversible_is_human">An irreversible step carries no role. Approval, publication, deployment, access and acceptance belong to a person and are recorded as their own step.</rule>
    <rule id="approval_precedes_action">Where a workflow acts on the outside world, the approval step comes before that action and never after it.</rule>
    <rule id="green_is_not_acceptance">A passing check never closes an owner decision. Technical evidence and acceptance are separate records.</rule>
    <rule id="model_classification">The classifier selects only registered work types, routes, and typed pending interactions. Transport code passes ordinary user text unchanged and never selects confirmation, refusal, continuation, or another semantic transition by trigger phrase, keyword, command-shaped shortcut, or regular expression.</rule>
  </owner_boundary>

  <example status="accepted">
    <package>public reference catalog</package>
    <purpose>The repository definitions generate two support-grade packages and five executable previews so the SDK, migrations, catalogs, adapters, and fixtures are validated without private project data.</purpose>
    <rule id="replaceable">Generate and check your own packages by naming your definition file: npm run packages:generate -- --definitions &lt;file&gt;, or --installation to use the packageDefinitions setting. The repository contract tests always run against the example, because a suite that follows a machine-local setting proves nothing about the product.</rule>
  </example>

  <public_catalog status="accepted">
    <rule id="support_status_is_explicit">The public catalog labels `software.web-application` and `one-c.development` support-grade. `game.web`, `game.unity`, `data.analytics`, `infra.operations` and `marketing.content-operations` are executable previews. Their shipped mechanical contracts and regression fixtures must stay green; domain findings from private preview pilots do not become release-blocking support obligations until promotion.</rule>
    <rule id="preview_does_not_imply_truth">A synthetic preview result proves mechanics only. It cannot close domain truth, product fit, visual acceptance, gameplay acceptance or any owner decision.</rule>
    <rule id="deprecated_alias_is_migrated">`example.web-app` is a deprecated alias of `software.web-application`. Existing projects receive a hash-bound migration proposal rather than a silent package replacement.</rule>
    <rule id="web_evidence_contract">`software.web-application` can use TypeScript or JavaScript compiler evidence for API-to-client-to-state-to-UI claims. Every sufficient transition needs source or graph provenance; shared identifiers alone remain search hints.</rule>
    <rule id="one_c_evidence_contract">`one-c.development` combines scoped BSL/XML structure, authoritative corpus boundaries, revision-bound BSL Language Server debt baselines, registered project checks, and typed external runtime evidence. Existing diagnostics may be accepted only as owner-bound baseline debt; new policy-blocking signatures still fail.</rule>
    <rule id="unity_csharp_provider">`game.unity` uses a pinned external `csharp-ls` LSP process through the Zodchi definitions, references, callers, and completeness contract. The Unity-generated solution and project files define the boundary; a missing or partial boundary is unavailable or unknown, never lexical missing. Zodchi does not ship a separate C# parser.</rule>
  </public_catalog>

  <project_presets status="accepted">
    <rule id="preset_is_not_a_package">A project preset maps one observed working profile to public packages, source scopes, adapter requirements, resources, authority and a first-value scenario. It does not copy a workflow or modify platform core.</rule>
    <rule id="preset_is_proposal_first">Run `preset-lint` to validate the shipped catalog, `preset-inspect --preset &lt;key&gt;` to read one recipe, and `preset-propose --db &lt;db&gt; --project &lt;id&gt; --preset &lt;key&gt; --out &lt;directory&gt;` to create hash-bound package import proposals. Applying a proposal remains a separate confirmed action.</rule>
    <rule id="local_capabilities_are_not_invented">A proposal reports required local adapters, resource aliases and authority boundaries. It never fabricates an executable, information base, database, calendar, external runtime or owner acceptance.</rule>
    <rule id="profile_coverage_is_measured">Every public fixture is `MECHANICS_ONLY`. Version 0.6.0 ships all fifteen recipes and selected canaries; the remaining real-repository pilots belong to the 0.6.x pilot programme and are never presented as domain or product coverage. Value is measured by manual coordination work actually removed while domain guards remain.</rule>
    <rule id="owner_read_is_structured">A person records `OWNER_READ` with `record-owner-acceptance.mjs`. The append-only record binds project, terminal run, preset, active package version and reviewed artifact SHA-256 to an explicit owner identity. `review_status=read` and `domain_status=open` mean exactly that the result was read; they do not mean accepted.</rule>
    <rule id="owner_record_is_not_model_output">Only `source=owner_explicit` is accepted. Models, reviewers and synthetic fixtures cannot create an owner record. A changed decision is a new record naming the exact record it supersedes.</rule>
    <rule id="profile_reports_are_hypotheses">Preset profiles come from machine analysis of observed work and repositories. They are implementation hypotheses, not quotes, requests, interest, market demand, or product acceptance from the named people.</rule>
    <rule id="preset_catalog_is_canonical">`WorkflowPlatform/presets/catalog.json` is the canonical list of fifteen recipes. Each entry declares packages, source scopes, adapters, authority, resources, first value, fixture proof boundary, private acceptance, substitution metric, and migration notes.</rule>
  </project_presets>
</document>
