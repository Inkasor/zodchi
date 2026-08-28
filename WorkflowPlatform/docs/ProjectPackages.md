<document id="zodchi_project_packages" status="accepted" authority="zodchi" version="3.0.0" language="en">
  <title>Portable project packages</title>
  <purpose>Define what a portable workflow package is, where its source lives, and the boundaries every package must keep.</purpose>

  <package_source status="accepted">
    <rule id="definitions_are_local">A package definition describes a real project: its documents, checks, thresholds and approval boundaries. That is an installation's own material, so the source file is a parameter and this repository ships only the builders and one example.</rule>
    <rule id="source_is_stated">The definition source is named by the caller and never inherited from the environment. With no argument the repository example is used, so packages:check verifies this repository against itself on any machine; an installation names its own file with --definitions, or --installation to use the file its packageDefinitions setting declares. A generation run that follows an exported variable checks whichever installation that shell was configured for, which is a different check on every machine and no check at all in CI.</rule>
    <rule id="definition_shape">A definition file default-exports a function that receives the builder module and returns packages and bundles. It therefore needs no import path of its own and can live anywhere.</rule>
    <rule id="generated_beside_source">Generated packages are written to a generated directory beside their definition source, are produced by npm run packages:generate, and are verified by npm run packages:check.</rule>
    <rule id="import_is_confirmed">A package may be imported only through a proposed diff bound to the package hash, followed by a confirmed apply naming the person who confirmed it.</rule>
  </package_source>

  <portable_content status="accepted">
    <rule id="no_local_identity">A package contains no local paths, secrets, user profiles or model names. Model choice is a local overlay resolved by AgentGateway against the profile the package names.</rule>
    <rule id="normalized_policy">Budgets, checks and escalation policies are stored in normalized WorkflowPlatform tables, not in prose.</rule>
    <rule id="shareable">Because a package carries no local identity, an exported package can be handed to another installation as is. Use workflow-export to produce one from a live registry.</rule>
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
    <rule id="model_classification">The classifier selects only registered work types and routes and never routes by trigger phrase or keyword.</rule>
  </owner_boundary>

  <example status="accepted">
    <package>software.web-application</package>
    <purpose>The package this repository ships so the format, the builders and the generator can be built, validated and tested without any real project.</purpose>
    <rule id="replaceable">Generate and check your own packages by naming your definition file: npm run packages:generate -- --definitions &lt;file&gt;, or --installation to use the packageDefinitions setting. The repository contract tests always run against the example, because a suite that follows a machine-local setting proves nothing about the product.</rule>
  </example>
</document>
