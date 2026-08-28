# Contributing to Zodchi

[English](CONTRIBUTING.md) · [Русский](docs/ru/CONTRIBUTING.md)

Thank you for helping Zodchi. Contributions may include fixes, new workflows, checks, model harnesses, and documentation improvements.

## Code changes

1. Create a short-lived branch from `main`.
2. Do not commit databases, credentials, authentication files, run logs, or private project data.
3. Run `npm test` from the repository root.
4. For release-layout changes, run `npm run release:build` and validate the result.
5. In the pull request, explain the problem, the solution, and the checks you ran in plain language.

## Workflow packages

Portable configuration is exported by WorkflowPlatform as semantic XML. Lint the package first, then include anonymized scenarios and expected routes. Local paths, profile names, model identifiers, and secrets do not belong in a portable package.

## Releases

A release is published by the tag workflow and by nothing else. Do not run `gh release create` or upload assets by hand: assets published that way are not build artifacts, and the workflow then fails because the release already exists.

1. Merge the release commit into `main` and make sure `product.json`, `package.json` and both component versions agree.
2. Push an annotated tag `vX.Y.Z`. The workflow refuses to publish with `RELEASE_PREEXISTED` if a release with that tag already exists.
3. The workflow runs the tests, builds the archive, writes `SHA256SUMS.txt` and `zodchi-release-manifest.json`, attaches build provenance and creates the release.
4. The smoke job then downloads the published assets from the GitHub Release API into a clean environment, verifies the checksum and the per-file bundle manifest, installs the product and runs one workflow end to end through a deterministic provider.
5. A red publish or a red smoke means the tag is not a supported version. Fix the cause and tag the next version; do not repair a published release by hand.

## License

By submitting a contribution, you agree that it may be distributed under this repository's MIT License.
