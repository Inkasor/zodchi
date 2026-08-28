<document id="zodchi_readme" status="working" authority="zodchi" version="1.0" language="en" format="markdown+xml_semantic">

# Zodchi

[English](README.md) · [Русский](docs/ru/README.md)

Zodchi turns one ordinary AI chat into a coordinated team for real project work.

You describe the result in your own words. Zodchi decides what kind of work is needed, gives each specialist only the relevant context, runs the appropriate checks, records accepted decisions, and returns a clear answer in the same chat.

Ordinary chat messages stay ordinary. Invoke Zodchi explicitly with `/zodchi <task>` or the shorter `/zod <task>` in Codex or Claude Code. With no arguments, the command may use the immediately preceding substantive request when that choice is unambiguous.

<section id="why_use_it" status="working">

## Why use it

- Better results: planning, execution, review, and documentation follow explicit workflows instead of one oversized prompt.
- Lower model costs: routine work can use cheaper models, while stronger models are reserved for difficult decisions.
- Less repeated context: project facts and documents are selected programmatically and reused efficiently.
- Better code discovery: deterministic lexical retrieval expands through TypeScript/JavaScript compiler links and BSL structure before source is sent to a model; no vector database is required.
- Predictable quality: code, documents, releases, and other outputs pass checks configured for the project.
- One familiar interface: people keep talking naturally in their AI coding assistant.

</section>

<section id="what_it_can_help_with" status="working">

## What it can help with

Zodchi can coordinate software development, research, marketing and content production, game design, visual and audio work, data operations, releases, and incident response. Its workflows and roles are configurable, so the same installation can support very different projects.

The owner still approves important decisions, publication, access changes, deployment, and subjective product acceptance.

</section>

<section id="start_with_one_message" status="working">

## Start with one message

Open a new chat in Codex or Claude Code and send it this repository link with the following request:

> Open https://github.com/Inkasor/zodchi, read `ONBOARDING_PROMPT.md`, install the latest Zodchi release, and configure it for my project. Do the technical setup yourself and ask me only for decisions you cannot safely infer.

Keep that setup chat. You can later use it to add projects, change models, create roles, and customize workflows.

The 0.6 release candidate uses one cross-platform archive and targets Windows and macOS; Linux installation is experimental until live external acceptance. Windows is locally accepted, while macOS owner acceptance remains a release gate. Codex and Claude Code are supported chat entry points. Other model harnesses can be used as workers when installed and configured locally.

</section>

<section id="for_developers" status="working">

## For developers

The repository contains the source for `WorkflowPlatform` and `AgentGateway`. Human documentation is available in English and Russian. Machine-operated setup, update, architecture, and configuration contracts use concise semantic English:

- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md) ([Russian](docs/ru/CONTRIBUTING.md))
- [Security](SECURITY.md) ([Russian](docs/ru/SECURITY.md))
- [Changelog](CHANGELOG.md) ([Russian](docs/ru/CHANGELOG.md))
- [Third-party notices](THIRD_PARTY_NOTICES.md) ([Russian](docs/ru/THIRD_PARTY_NOTICES.md))
- [Update contract](UPDATE.md)

Zodchi is released under the [MIT License](LICENSE).

</section>

</document>
