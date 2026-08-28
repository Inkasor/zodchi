<document id="zodchi_release_evidence_0_6_0_rc_1" status="working" authority="zodchi" version="0.6.0-rc.1" language="en" format="markdown+xml_semantic">

# Zodchi 0.6.0-rc.1 release evidence

<scope id="candidate_scope" status="working">

This record describes a local release candidate. No tag, push, GitHub Release, publication smoke or installed-production update has been performed. A completed workflow is not owner or domain acceptance.

</scope>

<automated_verification id="automated_verification" status="verified" evidence="local_deterministic_checks">

- Repository source: tools `19/19`, WorkflowPlatform `319/319`, AgentGateway `26/26`.
- Package regeneration/import: all seven package artifacts match their definitions and public catalog; all fifteen presets validate and produce proposal-first local onboarding material.
- Two independently assembled canonical release roots contain the same 215 manifest entries and identical file hashes; release lint passes.
- The full suite executed from the assembled release: tools `19/19`, WorkflowPlatform `318 passed, 1 skipped`, AgentGateway `26/26`. The skipped TypeScript semantic test requires the analyzed project to supply a compatible TypeScript compiler API; the unavailable path is covered separately and does not become partial evidence.
- Two independently compressed archives with the same canonical `Zodchi` root are byte-identical. The one-command acceptance covers install, owned hook, routed run, update, rollback, hook restoration and uninstall.

</automated_verification>

<live_canaries id="windows_live_canaries" status="verified" evidence="local_run_receipts">

All four runs used a deterministic contract provider through the real AgentGateway process and preserved their source baseline.

| Project scenario | Run | Terminal result | Calls and tokens | Interpretation |
|---|---|---|---|---|
| Web/TypeScript Dashboard | `run_1787932472245_434a52e5` | `blocked`, gate `failed` | 3 calls; 192 input, 48 cached, 96 output, 12 reasoning | Routing worked. Registered project tests reported real project/environment failures; no product PASS is claimed. |
| Clean 1C advertising checkout | `run_1787932570731_ab0afefc` | `blocked`, gate `unavailable` | 3 calls; 192 input, 48 cached, 96 output, 12 reasoning | Routing worked. The local accepted BSL diagnostic baseline/platform binding is absent; no BSL/domain PASS is claimed. |
| Unity Project M | `run_1787932772830_305c321f` | `completed`, gate `passed` | 3 calls; 192 input, 48 cached, 96 output, 12 reasoning | Real-repository Windows mechanics passed after rejecting an incompatible TypeScript API and correcting a false secret-scan boundary. Owner gameplay, visual and milestone acceptance remain pending. |
| Marketing/content project | `run_1787932582084_5b933dc8` | `completed`, gate `passed` | 3 calls; 192 input, 48 cached, 96 output, 12 reasoning | Real-repository workflow mechanics passed. Domain quality and owner acceptance remain pending. |

</live_canaries>

<release_gates id="remaining_release_gates" status="blocked">

- Run the one-command owner acceptance on the Mac M1 and preserve its machine-readable verdict.
- Obtain an external macOS repeat where practical; keep Linux support experimental until a live acceptance exists.
- Register and accept the local 1C BSL diagnostic boundary, then rerun the clean 1C canary.
- Resolve or explicitly baseline the Dashboard project checks before claiming that canary green.
- After publication authority is granted: publish only through GitHub Actions, then verify the downloaded asset, checksum, publisher and install/update/rollback path. A local artifact cannot close this gate.
- Profile-level `OWNER_READ`, domain truth and the donor substitution metric remain open; synthetic fixtures cannot close them.

</release_gates>

</document>
