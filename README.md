# Zodchi

[Русский](README.ru.md)

Zodchi runs shared workflows for Codex and Claude Code. The Rust engine prepares context, calls models by role, runs checks and records each step so that another client can continue the same run.

[Install](#install) · [Workflows](#workflows) · [Source code](#source-code)

## Install

Get a build for your system from [GitHub Releases](https://github.com/Inkasor/zodchi/releases). Each 1.x package brings the native CLI, workflow catalog, model roles and plugins for both clients together. See [installation and updates](docs/flow.md#client-packages).

Use the [source installation guide](docs/install-from-source.md) to build and run the current checkout.

## Workflows

Run `zodchi flow list` to see the workflows available to your project. The same [start and resume commands](docs/flow.md#running-it) work in Codex and Claude Code.

| Task | Guide |
| --- | --- |
| Turn a goal into a brief | [Design brief](docs/design-brief.md) |
| Implement and review a code change | [Code package](docs/flow.md) |
| Test a web app or a game player | [Acceptance](docs/acceptance.md) |
| Prepare and verify a video | [Video](docs/flow-video.md) |
| Upload an approved video privately | [YouTube upload](docs/youtube-publish.md) |

The [shared workflow catalog](workflows/catalog.json) includes the other workflows. Use [model roles](docs/model-roles.md) to choose the models that run them.

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

## License

[MIT](LICENSE).
