<document id="zodchi_readme" status="accepted" authority="zodchi" version="0.6.3" language="en" format="markdown+xml_semantic">

# Zodchi

[English](README.md) · [Русский](docs/ru/README.md)

Zodchi turns one ordinary AI chat into a coordinated team for real project work.

You describe the result in your own words. Zodchi decides what kind of work is needed, gives each specialist only the relevant context, runs the appropriate checks, records accepted decisions, and returns a clear answer in the same chat.

Ordinary chat messages stay ordinary. Invoke `/zodchi` once in a Codex or Claude Code chat to enter Zodchi mode for that chat only; then describe and refine tasks with ordinary messages. A neighboring or newly opened chat remains an ordinary host chat. Closing the chat ends the mode, so there are no separate public status, execute, or exit commands.

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

Packages do not impose GDD, infrastructure, marketing, or other template filenames. During onboarding Zodchi automatically analyzes existing project documents and explains why controlling selected files is useful: roles receive stable project truth, accepted decisions become lintable, and absent templates are not invented as requirements. It then proposes a minimal registry, but the owner chooses whether to register any of it. A controlled document can be added or removed without rebuilding its workflow package:

```powershell
node WorkflowPlatform/src/cli.mjs document-register --db <workflow.sqlite> --project <project-id> --root primary --path docs/Decisions.md --type decision-log --authority owner --read-roles classifier,coordinator,worker,reviewer --write-roles editor
node WorkflowPlatform/src/cli.mjs document-unregister --db <workflow.sqlite> --project <project-id> --root primary --path docs/Decisions.md
```

Projects may also register their own semantic status and evidence-type keys with `document-status-register` and `document-evidence-register`; those keys do not leak into other projects. `document-status-unregister` and `document-evidence-unregister` remove obsolete local vocabulary after documents have been migrated. Project-aware lint is explicit:

```powershell
node WorkflowPlatform/src/cli.mjs lint --db <workflow.sqlite> --project <project-id> --file <project-document.md>
```

The setup chat is the canonical administration place: it discovers documents, presents a proposal, waits for owner confirmation, and then runs these registry commands. A project `/zodchi` run can analyze current documents and recommend a change, but 0.6.3 does not yet turn a later natural-language confirmation inside that run into an automatic registry transaction. Apply the confirmed proposal in the setup chat. Unregistering a document only removes control metadata; it never deletes the file.

Prefer the portable global status vocabulary when it expresses the same meaning. A project-local status is appropriate only for a real project concept that should not become a rule for every other project. It gives the linter exact local vocabulary without polluting or weakening the global contract.

Before implementation Zodchi fixes one visible run profile with four independent axes: `Quality` (`prototype | mvp | production | security-audit`), `Execution` (`standard | goal`), `Verification` (`baseline | gauntlet`), and `Planning` (`single | ensemble`). Onboarding explains the choices and records project defaults; a task may override them in ordinary language. If an ensemble was requested but fewer than two independent planner bindings are available, Zodchi reports the fallback instead of pretending that one model is an ensemble. Setup automation uses the internal `run-profile-list` and `run-profile-set` operations; they are not additional chat commands.

Gauntlet is a verification policy, not a synonym for quality mode, Goal execution, or mandatory review. It repeats trials only while deterministic evidence changes and stops honestly on a proven blocker or safety boundary. Goal is the persistent execution policy: it keeps the objective across checkpoints rather than treating an arbitrary correction count as task completion. Reflection checkpoints derive from Goal execution and elapsed active work; known long builds and tests do not by themselves trigger a change of strategy.

```powershell
node WorkflowPlatform/src/cli.mjs run-profile-list --db <workflow.sqlite> --project <project-id>
node WorkflowPlatform/src/cli.mjs run-profile-set --db <workflow.sqlite> --project <project-id> --quality prototype --execution goal --verification gauntlet --planning ensemble --confirmed-by <owner>
```

The setup chat displays these choices during onboarding. Later the owner can return to it and ask to show or change a project's run defaults. The CLI above is the auditable internal mechanism, not something an ordinary user has to memorize.

`standard` uses the ordinary bounded execution and correction allowance. `gauntlet` is first of all a persistence strategy: deterministic gates run, a failed gate is routed to a targeted correction, and the result is checked again until green or a bounded honest blocker. Review admission is a separate quality-contract decision. When review is required, standard uses one primary reviewer while Gauntlet may admit at most three independent opinions: the primary reviewer checks the result as a whole, the adversarial reviewer tries to disprove its strongest material claim, and the evidence reviewer checks primary evidence, provenance, and claimed completeness. They see the same canonical proof packet but not each other's opinion. A judge is not a fourth routine reviewer: it runs only when admissible reviewer conclusions materially disagree. A strategy reviewer is not a result reviewer at all: it runs only after correction stops adding semantic or evidence-frontier progress and chooses a new bounded route or an honest `blocked` outcome.

Prototype keeps `reviewer_policy=none`: Gauntlet does not manufacture a review requirement. MVP requires an independent review; production and security use stricter review contracts. When review is required, baseline uses the primary reviewer while Gauntlet may admit primary, adversarial, and evidence opinions. Judge and strategy reviewer remain conditional. Deterministic gates and owner approvals never depend on reviewer count.

See [Portable project packages](WorkflowPlatform/docs/ProjectPackages.md) and the [0.6 release evidence](docs/RELEASE_EVIDENCE_0.6.0.md).

</section>

<section id="for_developers" status="accepted">

## For developers

The repository contains the source for `WorkflowPlatform` and `AgentGateway`. This root README is the canonical human-facing English edition, although its semantic wrapper is also linted by machines. The Russian human edition lives under `docs/ru`. Additional human translations belong under `docs/<language-tag>/` and must name the English source version they translate. Adding a fully supported runtime response language also requires deterministic response copy, language normalization, and tests; translating README files alone does not silently enable a new runtime language. Machine-operated setup, update, architecture, and configuration contracts stay in concise semantic English so one portable contract is linted instead of several diverging machine instructions:

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
