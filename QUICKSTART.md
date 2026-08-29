<document id="zodchi_quickstart" status="accepted" authority="zodchi" version="0.6.0" language="en">
  <title>LLM-operated Zodchi quick start</title>
  <purpose>This instruction is for an LLM. The person describes the desired outcome; the LLM performs technical operations and asks only for decisions that cannot be inferred safely.</purpose>

  <entry status="accepted">
    <user_message>Open the Zodchi repository, read ONBOARDING_PROMPT.md, install the latest release, and configure it for my project.</user_message>
    <rule id="llm_operates_tools">Do not delegate commands to the person when you can execute them safely with your tools.</rule>
    <rule id="human_decisions_only">Ask only about the installation location, target project, model assignments, permissions, publication, and other owner decisions.</rule>
  </entry>

  <installation status="accepted">
    <step order="1">Read ONBOARDING_PROMPT.md completely.</step>
    <step order="2">If Zodchi is not installed, use the platform bootstrap from a trusted checkout: `tools/install-latest.ps1` on Windows or `tools/install-latest.sh` on macOS/Linux. Install only a published release whose workflow, manifest, checksum, publisher, and provenance checks pass.</step>
    <step order="3">Verify Node.js 24 or newer and the chat host the person uses: Codex CLI, Claude Code, or both.</step>
    <step order="4">Create a separate personal-data directory outside the program directory.</step>
    <step order="5">Register the project, inspect the matching package and optional project preset, create a hash-bound import proposal, apply only the confirmed proposal, bind required local adapters/resources/checks, and assign local model profiles.</step>
    <step order="6">Verify that the installer deployed the user-level `zodchi` and `zod` skills for each selected host. Do not create project hooks.</step>
    <step order="7">Restart or open a new host session when required for skill discovery.</step>
    <step order="8">Run `/zodchi &lt;safe test task&gt;` and confirm that the run and receipts exist in local databases. Also confirm that an ordinary message does not create a Zodchi run.</step>
  </installation>

  <verification status="accepted">
    <command id="product_tests">npm test</command>
    <command id="run_statistics">node WorkflowPlatform/src/cli.mjs run-statistics --db &lt;workflow-db&gt; --run &lt;run-id&gt;</command>
    <rule id="no_raw_transcript">Do not store full model requests or responses in databases.</rule>
    <rule id="failed_gate_is_not_green">An unavailable or failed required check is not a successful result.</rule>
    <rule id="preview_boundary">A preview package or `MECHANICS_ONLY` fixture proves delivery mechanics only; it does not prove domain truth, product fit, or owner acceptance.</rule>
    <rule id="owner_records_are_explicit">Only the person can create an owner acceptance record. `OWNER_READ` records reading, not domain acceptance.</rule>
  </verification>
</document>
