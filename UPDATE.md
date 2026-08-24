<document id="zodchi_update" status="accepted" authority="zodchi" version="0.3.0-beta.3" language="en">
  <title>LLM-operated Zodchi update</title>
  <purpose>Replace the program safely while preserving personal projects, settings, databases, and run history.</purpose>

  <contract status="accepted">
    <rule id="release_is_replaceable">The program directory is replaced as one unit.</rule>
    <rule id="data_is_external">Personal data stays outside the program directory and is never copied into a release.</rule>
    <rule id="verified_release_only">Use a published GitHub Release and verify the archive SHA-256.</rule>
    <rule id="llm_runs_update">The LLM runs commands; the person confirms the destination and trusts a changed hook.</rule>
  </contract>

  <procedure status="accepted">
    <step order="1">Inspect the installed version and external data path.</step>
    <step order="2">When needed, create a supported snapshot of local databases with the backup command.</step>
    <step order="3">Run tools/install-latest.ps1 from a trusted repository with the current destination.</step>
    <step order="4">Verify bundle-manifest.json and run npm test in the installed release.</step>
    <step order="5">If the hook changed, ask the person to trust it again in Codex.</step>
  </procedure>

  <recovery status="accepted">
    <rule id="atomic_installer">The supported installer replaces the program atomically and restores the previous directory on failure.</rule>
    <rule id="no_permanent_backups">Do not leave permanent release duplicates after a successful update.</rule>
  </recovery>
</document>
