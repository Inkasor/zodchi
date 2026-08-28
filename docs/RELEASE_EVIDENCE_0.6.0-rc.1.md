<document id="zodchi_release_evidence_0_6_0_rc_1" status="working" authority="zodchi" version="0.6.0-rc.1" language="en" format="markdown+xml_semantic">

# Zodchi 0.6.0-rc.1 release evidence

<scope id="candidate_scope" status="working">

This record describes a local release candidate. No tag, push, GitHub Release, publication smoke or installed-production update has been performed. A completed workflow is not owner or domain acceptance.

</scope>

<automated_verification id="automated_verification" status="verified" evidence="local_deterministic_checks">

- Repository source: tools `25/25`, WorkflowPlatform `322/322`, AgentGateway `26/26`.
- Package regeneration/import: all seven package artifacts match their definitions and public catalog; all fifteen presets validate and produce proposal-first local onboarding material.
- Two independently assembled canonical release roots contain the same 217 manifest entries and identical file hashes; release lint passes.
- The full suite executed from the assembled release: tools `24 passed, 1 source-only CI test skipped`, WorkflowPlatform `321 passed, 1 skipped`, AgentGateway `26/26`. The product archive intentionally omits its GitHub publishing workflow, while the TypeScript semantic test requires the analyzed project to supply a compatible TypeScript compiler API; both skips are explicit and their runtime boundaries are covered separately.
- Two archives compressed from the same canonical `Zodchi` root by the pinned Node 24 runtime are byte-identical. This proves deterministic retries under the release runtime; cross-version zlib byte identity is not claimed. The one-command acceptance covers install, owned hook, routed run, update, rollback, hook restoration and uninstall.

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

<legacy_release_preflight id="v0_5_24_checksum_repair" status="verified" evidence="github_release_api_and_downloaded_assets">

The required read-only preflight for `v0.5.24` was repeated on 2026-08-28. No release asset was modified by this verification.

- Published archive asset `531240357`, `Zodchi-v0.5.24-windows.zip`, has 485086 bytes and SHA-256 `23470bc95723f85b87cc6ff27393dd92c0db705e7fbaca487f7fc1932ef3fb81`.
- Legacy checksum asset `531240358`, `SHA256SUMS-0.5.24.txt`, and canonical alias asset `533631561`, `SHA256SUMS.txt`, are byte-identical: SHA-256 `3967cf6f44caea088e4a7c3c723319a48846bf30370367a2e1761bab15c341ae`.
- Both checksum files name the downloaded archive and contain its exact SHA-256. The canonical alias already existed when this preflight ran, so no repair write was necessary.
- All three assets were uploaded by `Inkasor`, not CI. This closes only the legacy checksum-repair/preflight item; `v0.5.24` does not become a green CI release.

</legacy_release_preflight>

<release_gates id="remaining_release_gates" status="blocked">

- Run the one-command owner acceptance on the Mac M1 and preserve its machine-readable verdict.
- Obtain an external macOS repeat where practical; keep Linux support experimental until a live acceptance exists.
- Register and accept the local 1C BSL diagnostic boundary, then rerun the clean 1C canary.
- Resolve or explicitly baseline the Dashboard project checks before claiming that canary green.
- After publication authority is granted: publish only through GitHub Actions. The workflow must keep the release as draft through three-OS asset/install/provenance smoke, publish RC tags as prereleases and stable tags as normal releases, repeat smoke against the public release, and restore draft state automatically if that final smoke fails. A local artifact cannot close this gate.
- Profile-level `OWNER_READ`, domain truth and the donor substitution metric remain open; synthetic fixtures cannot close them.

</release_gates>

</document>
