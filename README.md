# Zodchi

[English](README.md) · [Русский](docs/ru/README.md)

Zodchi turns one ordinary AI chat into a coordinated team for real project work.

You describe the result in your own words. Zodchi decides what kind of work is needed, gives each specialist only the relevant context, runs the appropriate checks, records accepted decisions, and returns a clear answer in the same chat.

## Why use it

- Better results: planning, execution, review, and documentation follow explicit workflows instead of one oversized prompt.
- Lower model costs: routine work can use cheaper models, while stronger models are reserved for difficult decisions.
- Less repeated context: project facts and documents are selected programmatically and reused efficiently.
- Predictable quality: code, documents, releases, and other outputs pass checks configured for the project.
- One familiar interface: people keep talking naturally in their AI coding assistant.

## What it can help with

Zodchi can coordinate software development, research, marketing and content production, game design, visual and audio work, data operations, releases, and incident response. Its workflows and roles are configurable, so the same installation can support very different projects.

The owner still approves important decisions, publication, access changes, deployment, and subjective product acceptance.

## Start with one message

Open a new chat in Codex or Claude Code and send it this repository link with the following request:

> Open https://github.com/Inkasor/zodchi, read `ONBOARDING_PROMPT.md`, install the latest Zodchi release, and configure it for my project. Do the technical setup yourself and ask me only for decisions you cannot safely infer.

Keep that setup chat. You can later use it to add projects, change models, create roles, and customize workflows.

Zodchi is currently a Windows-first public beta. Codex and Claude Code are supported chat entry points. Other model harnesses can already be used as workers when they are installed and configured locally.

## For developers

The repository contains the source for `WorkflowPlatform` and `AgentGateway`. Human documentation is available in English and Russian. Machine-operated setup, update, architecture, and configuration contracts use concise semantic English:

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md) ([Russian](docs/ru/CONTRIBUTING.md))
- [Security](SECURITY.md) ([Russian](docs/ru/SECURITY.md))
- [Changelog](CHANGELOG.md) ([Russian](docs/ru/CHANGELOG.md))
- [Third-party notices](THIRD_PARTY_NOTICES.md) ([Russian](docs/ru/THIRD_PARTY_NOTICES.md))
- [Update contract](UPDATE.md)

Zodchi is released under the [MIT License](LICENSE).
