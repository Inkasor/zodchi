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

## License

By submitting a contribution, you agree that it may be distributed under this repository's MIT License.
