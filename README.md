<document id="zodchi_readme" status="accepted" authority="zodchi" version="0.6.0" language="en" format="markdown+xml_semantic">

# Zodchi

[English](README.md) · [Русский](docs/ru/README.md)

Zodchi turns one ordinary AI chat into a coordinated team for real project work.

You describe the result in your own words. Zodchi decides what kind of work is needed, gives each specialist only the relevant context, runs the appropriate checks, records accepted decisions, and returns a clear answer in the same chat.

Ordinary chat messages stay ordinary. Invoke Zodchi explicitly with `/zodchi <task>` or the shorter `/zod <task>` in Codex or Claude Code. With no arguments, the command may use the immediately preceding substantive request when that choice is unambiguous.

<section id="why_use_it" status="accepted">

## Why use it

- Better results: planning, execution, review, and documentation follow explicit workflows instead of one oversized prompt.
- Lower model costs: routine work can use cheaper models, while stronger models are reserved for difficult decisions.
- Less repeated context: project facts and documents are selected programmatically and reused efficiently.
- Better code discovery: deterministic lexical retrieval expands through TypeScript/JavaScript compiler links and BSL structure before source is sent to a model; no vector database is required.
- Predictable quality: code, documents, releases, and other outputs pass checks configured for the project.
- One familiar interface: people keep talking naturally in their AI coding assistant.

</section>

<section id="what_it_can_help_with" status="accepted">

## What it can help with

Zodchi can coordinate software development, research, marketing and content production, game design, visual and audio work, data operations, releases, and incident response. Its workflows and roles are configurable, so the same installation can support very different projects.

The owner still approves important decisions, publication, access changes, deployment, and subjective product acceptance.

</section>

<section id="start_with_one_message" status="accepted">

## Start with one message

Open a new chat in Codex or Claude Code and send it this repository link with the following request:

> Open https://github.com/Inkasor/zodchi, read `ONBOARDING_PROMPT.md`, install the latest Zodchi release, and configure it for my project. Do the technical setup yourself and ask me only for decisions you cannot safely infer.

Keep that setup chat. You can later use it to add projects, change models, create roles, and customize workflows.

Zodchi requires Node.js 24 or newer. The 0.6 release candidate uses one cross-platform archive and targets Windows and macOS. Its complete lifecycle passed on Windows and on an independent macOS 15 `arm64` machine; Linux passes CI but remains experimental until a live external acceptance exists. Codex and Claude Code are supported chat entry points. Other model harnesses can be used as workers when installed and configured locally.

</section>

<section id="packages_and_recipes" status="accepted">

## Packages and recipes in 0.6

Two packages are support-grade: `software.web-application` and `one-c.development`. Five more are executable previews: `game.web`, `game.unity`, `data.analytics`, `infra.operations`, and `marketing.content-operations`. Preview means the workflow runs and its mechanical contract is tested; it does not claim domain, gameplay, product, visual, or owner acceptance.

Fifteen installable project recipes connect observed working patterns to these packages, required local adapters, source scopes, resource locks, authority boundaries, a first-value scenario, and an acceptance plan. Inspect a recipe with `preset-inspect`; create a hash-bound proposal with `preset-propose`. Import and any live action remain separate confirmed operations.

See [Portable project packages](WorkflowPlatform/docs/ProjectPackages.md) and the [0.6 release evidence](docs/RELEASE_EVIDENCE_0.6.0.md).

</section>

<section id="for_developers" status="accepted">

## For developers

The repository contains the source for `WorkflowPlatform` and `AgentGateway`. Human documentation is available in English and Russian. Machine-operated setup, update, architecture, and configuration contracts use concise semantic English:

- [Architecture](docs/ARCHITECTURE.md)
- [Quick start](QUICKSTART.md)
- [Project packages and presets](WorkflowPlatform/docs/ProjectPackages.md)
- [Contributing](CONTRIBUTING.md) ([Russian](docs/ru/CONTRIBUTING.md))
- [Security](SECURITY.md) ([Russian](docs/ru/SECURITY.md))
- [Changelog](CHANGELOG.md) ([Russian](docs/ru/CHANGELOG.md))
- [Third-party notices](THIRD_PARTY_NOTICES.md) ([Russian](docs/ru/THIRD_PARTY_NOTICES.md))
- [Update contract](UPDATE.md)

Zodchi is released under the [MIT License](LICENSE).

</section>

</document>
