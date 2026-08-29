<document id="zodchi_update" status="accepted" authority="zodchi" version="0.6.0-rc.1" language="en">
  <title>LLM-operated Zodchi update</title>
  <purpose>Replace the program safely while preserving personal projects, settings, databases, and run history.</purpose>

  <contract status="accepted">
    <rule id="release_is_replaceable">The program directory is replaced as one unit.</rule>
    <rule id="data_is_external">Personal data stays outside the program directory and is never copied into a release.</rule>
    <rule id="verified_release_only">Use a published GitHub Release and verify the archive SHA-256.</rule>
    <rule id="llm_runs_update">The LLM runs commands; the person confirms the destination. The installer updates owned user skills and removes owned legacy project hooks transactionally.</rule>
  </contract>

  <procedure status="accepted">
    <step order="1">Inspect the installed version and external data path.</step>
    <step order="2">When needed, create a supported snapshot of local databases with the backup command.</step>
    <step order="3">Run the trusted platform bootstrap with the current destination: `tools/install-latest.ps1` on Windows or `tools/install-latest.sh` on macOS/Linux. It must reject a release whose workflow, publisher, provenance, manifest, checksum, or archive disagree.</step>
    <step order="4">Verify bundle-manifest.json and run npm test in the installed release.</step>
    <step order="5">Verify `/zodchi` and `/zod` in each selected host and verify that ordinary messages are not intercepted.</step>
  </procedure>

  <operations status="accepted">
    <rule id="run_observation">Use run-status or run-watch to observe strategy, cycle, active members, gates, primary gap, elapsed time, calls, and cost without reading raw model payloads.</rule>
    <rule id="run_control">Use run-pause, run-resume, or run-cancel for an existing run; cancellation stops the active process tree and pause takes effect at the next safe unit boundary.</rule>
  </operations>

  <skill_conflicts status="accepted">
    <rule id="fail_closed">An update that cannot install an explicit command fails and restores the previous state. A partially installed entry point would leave the product half working, so the conflict is reported instead of skipped.</rule>
    <rule id="foreign_entry">SKILL_TARGET_NOT_OWNED names a skill directory Zodchi did not write. The owner renames or removes that directory and repeats the update.</rule>
    <rule id="edited_entry">SKILL_OWNED_CONTENT_CHANGED names an owned skill whose files were edited by hand. The owner keeps the edit elsewhere or removes the directory and repeats the update.</rule>
    <rule id="other_installation">SKILL_OWNED_BY_OTHER_INSTALLATION names the installation that owns the commands. Installation never takes them over and uninstallation never removes them, reporting different_installation instead. Retiring that installation is a separate, explicitly confirmed act.</rule>
  </skill_conflicts>

  <recovery status="accepted">
    <rule id="atomic_installer">The supported installer replaces the program atomically and restores the previous directory on failure.</rule>
    <rule id="rollback_keeps_explicit_entry">Rollback restores installer-owned skills to the compatible application root and never resurrects a removed legacy hook.</rule>
    <rule id="no_permanent_backups">Do not leave permanent release duplicates after a successful update.</rule>
  </recovery>
</document>
