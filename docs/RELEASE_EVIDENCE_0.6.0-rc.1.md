<document id="zodchi_release_evidence_0_6_0_rc_1" status="working" authority="zodchi" version="0.6.0-rc.1" language="en" format="markdown+xml_semantic">

# Zodchi 0.6.0-rc.1 release evidence

<scope id="candidate_scope" status="working">

This record describes a pushed development branch and local release candidate. No pull request, candidate tag, GitHub Release, publication smoke or installed-production update has been performed. A completed workflow is not owner or domain acceptance.

</scope>

<automated_verification id="automated_verification" status="verified" evidence="local_deterministic_checks">

- Repository source at `6e2edc3`: tools `33/33`, WorkflowPlatform `329/329`, AgentGateway `26/26`; no failures or skips.
- Package regeneration/import: all seven package artifacts match their definitions and public catalog; all fifteen presets validate and produce proposal-first local onboarding material.
- Two independently assembled canonical release roots contain the same 217 manifest entries and identical file hashes; release lint passes.
- The full suite executed from the assembled release at `66b0c80`: tools `31/33` with two source-only checks skipped, WorkflowPlatform `328/329` with one skipped, AgentGateway `26/26`, and packages `7/7`. The product archive intentionally omits its GitHub publishing workflow and the canary configuration template, while the TypeScript semantic test requires the analyzed project to supply a compatible TypeScript compiler API; every skip is explicit and its runtime boundary is covered separately.
- Two archives compressed from the same canonical `Zodchi` root by the pinned Node 24 runtime are byte-identical. This proves deterministic retries under the release runtime; cross-version zlib byte identity is not claimed. The one-command acceptance covers install, explicit skills for both hosts, routed runs, update, rollback, legacy-hook absence and uninstall.

</automated_verification>

<live_canaries id="windows_live_canaries" status="verified" evidence="local_run_receipts">

All four runs used a deterministic contract provider through the real AgentGateway process and preserved their source baseline.

| Project scenario | Run | Terminal result | Calls and tokens | Interpretation |
|---|---|---|---|---|
| Web/TypeScript Dashboard | `run_1787932472245_434a52e5` | `blocked`, gate `failed` | 3 calls; 192 input, 48 cached, 96 output, 12 reasoning | Routing worked. Registered project tests reported real project/environment failures; no product PASS is claimed. |
| Clean 1C advertising checkout | `run_1787982231374_fc2d2f83` | `completed`, gate `passed` | 3 calls; 192 input, 48 cached, 96 output, 12 reasoning | The owner accepted revision `c194e41a…` as the debt boundary. BSL LS 1.0.7 compared the same clean 59-file corpus to that baseline; no new policy-blocking signature was found and the worktree fingerprint remained unchanged. |
| Unity Project M | `run_1787932772830_305c321f` | `completed`, gate `passed` | 3 calls; 192 input, 48 cached, 96 output, 12 reasoning | Real-repository Windows mechanics passed after rejecting an incompatible TypeScript API and correcting a false secret-scan boundary. Owner gameplay, visual and milestone acceptance remain pending. |
| Marketing/content project | `run_1787932582084_5b933dc8` | `completed`, gate `passed` | 3 calls; 192 input, 48 cached, 96 output, 12 reasoning | Real-repository workflow mechanics passed. Domain quality and owner acceptance remain pending. |

</live_canaries>

<canary_reproduction id="canary_reproduction" status="working">

The four canary runs above were produced by `WorkflowPlatform/scripts/run-e2e-evidence.mjs`, which is shipped and reproducible. Their configurations are not, and cannot be: every entry names an absolute path to a private project root, and the release lint refuses to publish such a path. A run is therefore traceable through its own output directory rather than through this repository.

- `WorkflowPlatform/scripts/canary-config.example.json` states the exact configuration shape, with placeholders instead of local paths.
- Each run writes `summary.json`, one `<project_id>.statistics.json` per project and the canary database `workflow-evidence.sqlite` into its `output_root`. The run identifiers quoted above resolve in that database and nowhere else; they are absent from any installation database by design, because a canary must not run against production state.
- Whoever repeats a canary keeps its `output_root` next to this record. Without it a quoted run identifier is a claim, not evidence.
- A canary that has to prove a check the package ships disabled declares it under `checks`. The 1C package binds `bsl_language_server` as required at `mvp` and `production` but leaves it inert, because the analyzer is a local binary and the diagnostics it compares against are the owner's accepted debt. `WorkflowPlatform/scripts/canary-checks.mjs` registers that baseline and binds the analyzer before the run, and writes a `<project_id>.checks.json` receipt naming the baseline identifier, the accepted revision and who confirmed it. Without that step the canary would report a passing gate for a check that never ran.
- The baseline is a ratchet, not an amnesty: it freezes the diagnostics already present at the accepted revision and fails the gate only on new findings the diagnostic policy classifies as blocking. `confirmed_by` is never defaulted, so a canary cannot manufacture the acceptance it depends on.
- The runner requires a structural `classification` tuple and verifies that its `work_type` is actually routed to the named workflow before invoking the deterministic provider. This was added after an initial 1C attempt correctly failed classification when the fixture fell back to its Web default; that failed attempt is not counted as acceptance.
- The retained 1C evidence directory contains nine files / 2,450,048 bytes with normalized inventory SHA-256 `a1cd6bdec1ba5c767010f036147a82c1056ac610b4d90e5be9f6a7bb0262d890`. Its active baseline records BSL LS `1.0.7`, revision `c194e41a86227e1a2bd7b48284dc4a2946d39192`, 354 Error and 3,166 Warning diagnostics across 59 files; these are accepted only as pre-existing debt.

</canary_reproduction>

<legacy_release_preflight id="v0_5_24_checksum_repair" status="verified" evidence="github_release_api_and_downloaded_assets">

The required read-only preflight for `v0.5.24` was repeated on 2026-08-28. No release asset was modified by this verification.

- Published archive asset `531240357`, `Zodchi-v0.5.24-windows.zip`, has 485086 bytes and SHA-256 `23470bc95723f85b87cc6ff27393dd92c0db705e7fbaca487f7fc1932ef3fb81`.
- Legacy checksum asset `531240358`, `SHA256SUMS-0.5.24.txt`, and canonical alias asset `533631561`, `SHA256SUMS.txt`, are byte-identical: SHA-256 `3967cf6f44caea088e4a7c3c723319a48846bf30370367a2e1761bab15c341ae`.
- Both checksum files name the downloaded archive and contain its exact SHA-256. The canonical alias already existed when this preflight ran, so no repair write was necessary.
- All three assets were uploaded by `Inkasor`, not CI. This closes only the legacy checksum-repair/preflight item; `v0.5.24` does not become a green CI release.

</legacy_release_preflight>

<release_gates id="remaining_release_gates" status="blocked">

- Run the updated explicit-skill acceptance archive with Fedor Danilov first and preserve its machine-readable verdict; after any fixes, repeat the final candidate on the owner's Mac M1. Keep Linux support experimental until a live acceptance exists.
- Resolve or explicitly baseline the Dashboard project checks before claiming that canary green.
- After publication authority is granted: publish only through GitHub Actions. The workflow must keep the release as draft through three-OS asset/install/provenance smoke, publish RC tags as prereleases and stable tags as normal releases, repeat smoke against the public release, and restore draft state automatically if that final smoke fails. A local artifact cannot close this gate.
- All fifteen installable recipes are part of 0.6.0. Remaining profile-level `OWNER_READ`, domain truth and donor substitution measurements are explicitly scheduled for the 0.6.x pilot programme; synthetic fixtures do not close them and their absence is no longer a 0.6.0 release gate.

</release_gates>

</document>
