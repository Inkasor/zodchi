# Zodchi

[Русский](README.ru.md)

Zodchi runs shared workflows for Codex and Claude Code. The Rust engine prepares context, calls models by role, runs your checks and records each step in a journal, so an interrupted run continues where it stopped and another client can pick it up. The rules — who writes, who reviews, which checks must pass, what a review may block on — are enforced by the program, not by a prompt.

[Install](#install) · [First package](#your-first-package) · [Workflows](#workflows) · [What goes to which model](#what-goes-to-which-model) · [Source code](#source-code)

## Install

Give this repository link to Codex or Claude Code and ask it to **install and connect Zodchi**. The guide specifies how to select a build, verify it, register the clients and confirm the installation. [Installation guide](docs/install.md) · [Download a release](https://github.com/Inkasor/zodchi/releases/latest)

Use the [source installation guide](docs/install-from-source.md) to build and run the current checkout.

## Your first package

After installation, start a new chat in your project and ask your agent to do a small, real change **as a Zodchi code package**. The agent writes a brief and an arguments file and runs one command:

```sh
zodchi flow code-package --args package.json --detach
zodchi flow status <run-id>
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
| Local Codex gateway | a `codex` pick, no server configured (default) | OpenAI, on your own Codex sign-in |
| Company server | a `codex` pick with `server` in `~/.zodchi/flow.json` | your organisation's zodchi-server, which calls the model; journal and Git stay local ([Server](docs/flow-server.md)) |
| Claude Code CLI | a `claude` pick, only if `"claude": true` is in your own `~/.zodchi/flow.json` | Anthropic, on your own Claude subscription; no tools, MCP servers, hooks or CLAUDE.md in the call |
| OpenAI Decisions API | only `rubric-probe` | OpenAI, with your paid API key |

What each workflow sends:

| Workflow | Sent to a model |
| --- | --- |
| code-package | the brief and the full text of the claimed files; the reviewer gets the diff, the brief, those files and `REVIEW.md`; check-log tails with credentials and machine paths removed |
| branch-review | the diff and context files, screened line by line for private words and credentials |
| design-brief | the goal and documents you pass, `AGENTS.md`/`CLAUDE.md`, and the full text of the files named in `questions` (`.env*`, keys and credential files are excluded) |
| research | only the request, question files, up to 12 attachments and earlier decisions — never the repository or the web |
| incident-triage | the incident report and the bounded reads you allowed, redacted |
| acceptance | nothing, unless you ask for scenario selection (`choose`) or visual review (`review`); then the criterion and the captured frames |
| ops-script | nothing, unless a repair runs; then a code-package child with the script |
| checks, verify, cleanup, workspace-audit | nothing — they run locally without a model |

Screening. Put words that must not reach a model (company, client or product names) one per line in `~/.zodchi/private-words.txt` (or the file named by `ZODCHI_DENYLIST`). Lines with such a word, credential prefixes or a private key block are replaced before a prompt is built, for every route alike, in research, branch-review, design-brief, incident-triage, remarks and the review context. **code-package does not screen the brief and claimed files it sends**: do not claim files that hold secrets, and keep secrets out of briefs. Research refuses to run without a private-words file unless you allow it explicitly.

Everything Zodchi stores — journals with full prompts, writer copies, candidates, check folders — is under `~/.zodchi` (or `ZODCHI_HOME`) and the repository's ignored `.agent-tmp/`. Nothing uploads journals. See [Cleanup](docs/cleanup.md) for what is removed and when.

## Source code

| Path | Contents |
| --- | --- |
| [rust](rust/README.md) | Cargo workspace with the CLI, workflow engine, model gateway and server |
| [rust/crates/zodchi-flow](rust/crates/zodchi-flow) | Workflow implementations, prompts and schemas |
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
