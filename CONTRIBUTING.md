# Contributing to Zodchi

[English](CONTRIBUTING.md) · [Русский](docs/ru/CONTRIBUTING.md)

Thank you for helping Zodchi. Contributions may include fixes, new workflows, checks, model harnesses, and documentation improvements.

## Code changes

1. Create a short-lived branch from `main`.
2. Do not commit databases, credentials, authentication files, run logs, or private project data.
3. Read the accepted boundaries in [Architecture](docs/ARCHITECTURE.md) before changing routing, workflow, evidence, or delivery behavior.
4. Keep one semantic owner for user intent: hooks and session routers handle protocol and identity only. They must pass ordinary user text unchanged to the classifier and must never infer confirmation, refusal, continuation, or task type with keywords, regular expressions, or command shortcuts. Deterministic code validates the classifier's structural result; it does not replace the classifier.
5. Run `npm test` from the repository root.
6. Machine-operated documents must keep one `<document>` root, unique semantic IDs, balanced tags, current version/boundary statements, and no private paths. Run `node scripts/validate-source.mjs`; the root test command runs this semantic/documentator lint too.
7. For package changes, run `npm --prefix WorkflowPlatform run packages:check`. Generated package XML and the public catalog must match their named definitions exactly.
8. For release-layout changes, run `npm run release:build` and validate the assembled release rather than only the source checkout.
9. In the pull request, explain the problem, the solution, and the checks you ran in plain language.

## Workflow packages

Portable configuration is exported by WorkflowPlatform as semantic XML. Lint the package first, then include anonymized scenarios and expected routes. Local paths, profile names, model identifiers, and secrets do not belong in a portable package.

## Releases

A release is published by the tag workflow and by nothing else. Do not run `gh release create` or upload assets by hand: assets published that way are not build artifacts, and the workflow then fails because the release already exists.

1. Merge the release commit into `main` and make sure `product.json`, `package.json` and both component versions agree.
2. Push an annotated tag `vX.Y.Z`. The workflow refuses to publish with `RELEASE_PREEXISTED` if a release with that tag already exists.
3. The workflow runs the tests, builds the archive, writes `SHA256SUMS.txt` and `zodchi-release-manifest.json`, creates OIDC/Sigstore provenance, and uploads everything to a draft release.
4. Windows, macOS, and Linux smoke jobs download those draft assets through the GitHub Release API, verify the attestation with `gh attestation verify`, verify checksums and the per-file manifest, install the product, and run a deterministic workflow end to end.
5. Only then does the workflow publish the draft. A prerelease tag such as `-rc.*` becomes a prerelease; a stable semantic version becomes a normal Latest release. The three-platform smoke repeats against the public release.
6. A red post-publication smoke returns the release to draft. Fix the cause and tag the next version; do not repair published assets by hand.

## License

By submitting a contribution, you agree that it may be distributed under this repository's MIT License.
