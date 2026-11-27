# Zodchi

[Русский](README.ru.md)

Zodchi runs shared workflows for Codex and Claude Code. The Rust engine prepares context, calls models by role, runs your checks and records each step in a journal, so an interrupted run continues where it stopped and another client can pick it up. The rules — who writes, who reviews, which checks must pass, what a review may block on — are enforced by the program, not by a prompt.

[Why Zodchi](#why-zodchi) · [Install](#install) · [Quick start](#quick-start) · [Workflows](#workflows) · [What goes to which model](#what-goes-to-which-model) · [Source code](#source-code)

## Why Zodchi

- **The program keeps the rules, not the prompt.** A writer never reviews its own change. Your checks must pass before review. The review is limited to the brief's review boundary, and the claim stops two runs from editing the same files. An agent cannot talk its way past them.
- **Interrupted work resumes.** Every model call, check and commit is journaled. A cut run continues from the last step, in the same or another client, without paying for a finished step twice.
- **Cheaper on small and medium tasks.** In one early user's benchmark, the same tasks cost $0.21 instead of $1.05 and took 6 minutes instead of 20 on small changes. On large ones they cost $2.98 instead of $4.03, in about the same time.

## Install

Give this repository link to Codex or Claude Code and ask it to **install and connect Zodchi**. The guide specifies how to select a build, verify it, register the clients and confirm the installation. [Installation guide](docs/install.md) · [Download a release](https://github.com/Inkasor/zodchi/releases/latest)

Use the [source installation guide](docs/install-from-source.md) to build and run the current checkout.

## Quick start

1. Install (above) and start a new chat in your project.
2. Say to your agent: **"Do this as a Zodchi code package: <the change you want>. Show me the dry run first."**
3. The agent writes a brief and an arguments file, shows `--dry-run` (which models, which files, which checks — nothing is sent or claimed), then starts the run and waits for it:

```sh
zodchi flow code-package --args package.json --dry-run
zodchi flow code-package --args package.json --detach
zodchi flow wait <run-id>
```

```json
{
  "label": "export-csv",
  "brief": "/abs/path/repo/.agent-tmp/flow/export-csv-brief.md",
  "repo": "/abs/path/repo",
  "files": ["src/export.mjs", "test/export.test.mjs"],
  "checks": ["npm ci", "node test/export.test.mjs"]
}
```

A writer model makes the change, the engine runs your checks, an independent model reviews it against the brief's review boundary, and the approved change is committed. Read [Code package](docs/flow.md) for the full argument list and [Large work in packages](docs/large-work.md) for features that need several packages.

Examples of what people run:
- *"Add CSV export to the report page as a Zodchi package; claim the exporter and its test."*
- *"Review my branch against main with Zodchi branch-review and our test suite."*
- *"Turn this goal into a design brief with Zodchi, then split it into packages."*

Everyday commands: `zodchi flow runs` lists live runs, `zodchi flow wait` blocks until a run needs you, `zodchi flow status <id>` shows one, `zodchi flow close|cancel <id> --reason …` ends one without another model step, and `zodchi flow verify <commit>` runs your project's checks without a model. Agents can set `ZODCHI_AGENT=1` for JSON errors on stderr, and `zodchi --usage` prints every command, flag, variable and setting as JSON. Exit codes: 0 success or approved, 1 failure, 2 wrong call or not approved, 3 sign-in required.

**Pin the version in CI.** Install a fixed release in CI and in shared machines (see [Installation guide](docs/install.md)). Workflow versions are recorded in every journal, but a moving install changes prompts and checks under you.

## Workflows

Run `zodchi flow list` to see the workflows available to your project and `zodchi flow <workflow> --help` for one of them. The same [start and resume commands](docs/flow.md#running-it) work in Codex and Claude Code.

| Task | Guide |
| --- | --- |
| Turn a goal into a reviewed brief or a package plan | [Design brief](docs/design-brief.md) |
| Implement and review a code change | [Code package](docs/flow.md) |
| Run a large piece of work as a series of packages | [Large work](docs/large-work.md) |
| Review a finished branch with your test suite | [Branch review](docs/flow.md#branch-review) |
| Test a web app or a game player | [Acceptance](docs/acceptance.md) |
| Research a question from your own materials | [Research](docs/research.md) |
| Prepare and verify a video | [Video](docs/flow-video.md) |
| Speak timed cues and export a dubbing track | [Voiceover](docs/voiceover.md) |
| Upload an approved video privately | [YouTube upload](docs/youtube-publish.md) |
| Remove leftovers of finished runs | [Cleanup](docs/cleanup.md) |

The [shared workflow catalog](workflows/catalog.json) includes the other workflows. Use [model roles](docs/model-roles.md) to choose the models that run them: the default table uses Codex models; Claude models can take one-shot roles when you enable them ([Claude roles](docs/flow-claude.md)).

## What goes to which model

Zodchi runs on your machine. The journal, Git, checks and commits stay local; only model steps leave it, and only through the route you configured:

| Route | When | Where it goes |
| --- | --- | --- |
| Local Codex gateway | a `codex` pick, no server configured (default) | OpenAI, on your own Codex sign-in; with `"credits": true` in `~/.zodchi/flow.json`, steps may spend ChatGPT credits once the subscription limit is used up, and `flow status` shows what each step spent |
| Company server | a `codex` pick with `server` in `~/.zodchi/flow.json` | your organisation's zodchi-server, which calls the model; journal and Git stay local ([Server](docs/flow-server.md)) |
| Claude Code CLI | a `claude` pick, only if `"claude": true` is in your own `~/.zodchi/flow.json` | Anthropic, on your own Claude subscription; no tools, MCP servers, hooks or CLAUDE.md in the call |
| OpenAI Decisions API | only `rubric-probe` | OpenAI, with your paid API key |

What each workflow sends:

| Workflow | Sent to a model |
| --- | --- |
| code-package | the brief and the full text of the claimed files, after the input check; the reviewer gets the diff, the brief, those files and `REVIEW.md`; check-log tails with credentials and machine paths removed |
| branch-review | the diff and context files, screened line by line for private words and credentials |
| design-brief | the goal and documents you pass, `AGENTS.md`/`CLAUDE.md`, and the full text of the files named in `questions` (`.env*`, keys and credential files are excluded) |
| research | only the request, question files, up to 12 attachments and earlier decisions — never the repository or the web |
| incident-triage | the incident report and the bounded reads you allowed, redacted |
| acceptance | nothing, unless you ask for scenario selection (`choose`) or visual review (`review`); then the criterion and the captured frames |
| ops-script | nothing, unless a repair runs; then a code-package child with the script |
| checks, `flow verify`, cleanup, workspace-audit | nothing — they run locally without a model |

Screening. Put words that must not reach a model (company, client or product names) one per line in `~/.zodchi/private-words.txt` (or the file named by `ZODCHI_DENYLIST`). Lines with such a word, credential values or a private key block are replaced before a prompt is built, for every route alike, in research, branch-review, design-brief, incident-triage, remarks and the review context. code-package checks its brief and claimed files before any claim or model call and refuses with the file and line (never the text) when one holds private material; after checking that a flagged line is not a secret (a test fixture, for example), list it in `allowInputLines`. In agent mode the writer works in a copy of the repository that is not screened, and the result says so. Research refuses to run without a private-words file unless you allow it explicitly.

Everything Zodchi stores — journals with full prompts, writer copies, candidates, check folders — is under `~/.zodchi` (or `ZODCHI_HOME`) and the repository's ignored `.agent-tmp/`. Nothing uploads journals. See [Cleanup](docs/cleanup.md) for what is removed and when.

## Source code

| Path | Contents |
| --- | --- |
| [rust](rust/README.md) | Cargo workspace with the CLI, workflow engine, model gateway and server |
| [rust/crates/zodchi-flow-engine](rust/crates/zodchi-flow-engine) | Workflow engine: journal, claims, checks, model routes, screening |
| `rust/crates/zodchi-flow-<workflow>` | One crate per workflow with its prompts and schemas; a change rebuilds only that crate, the facade and the CLI |
| [rust/crates/zodchi-flow](rust/crates/zodchi-flow) | Facade: CLI dispatch and the workflow registry |
| [workflows](workflows/catalog.json) | Shared workflow catalog |
| [skills](skills) | Shared instructions packaged for both clients |
| [roles](roles) and [models.json](models.json) | Model prompts, response schemas and default picks |
| [plugins](plugins) | Client skills and additional agents for Claude Code |
| [install](install) | Commands to build a portable distribution from source |
| [scripts/e2e](scripts/e2e) | End-to-end checks and fixtures |

Build the CLI from the repository root.

```sh
cargo build --release --locked --manifest-path rust/Cargo.toml
```

See the [verification guide](docs/verification.md) for checks. See [subscriptions](docs/subscriptions.md) for account setup and [company forks](docs/fork.md) for private configurations.

## Contributors

[Inkasor](https://github.com/Inkasor), [Codex](https://github.com/codex), and [Claude](https://github.com/claude).

## License

[MIT](LICENSE).
