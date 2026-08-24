# Security

[English](SECURITY.md) · [Русский](docs/ru/SECURITY.md)

Zodchi is currently beta software. Never include API keys, authentication files, databases, private-project content, or full model responses in a report.

## Reporting a vulnerability

Use private vulnerability reporting in the public repository's Security section. If it is unavailable, contact the author through the GitHub profile without publishing technical details in a public issue.

Include the Zodchi version, operating system, affected component, reproduction steps, and possible impact. Replace credentials and private data with safe examples.

## Boundaries

- A release must not contain personal databases, credentials, authentication files, or user-specific absolute paths.
- Credentials for compatible APIs are supplied only through environment variables.
- A person must explicitly trust a project hook in the Codex interface.
- Publication, deployment, access changes, and other irreversible operations require a separate owner decision.
