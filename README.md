# Zodchi

[Русский](README.ru.md)

Zodchi is a set of working practices for Claude Code. It gives you tuned
agents and workflows, grouped by the kind of work they are for, and a
gateway that lets those workflows call Codex models by **role** instead of by
model name.

It is not a framework that tries to fit every project. Each domain holds
agents and workflows tuned for that kind of work. Only what is truly the
same everywhere lives in `core/`.

> **Status: 1.0 in development.** The agents and workflows work today. The
> Rust gateway is being built. Until it ships, the `zodchi` command forwards
> calls to an existing Node gateway that you point it at. The 0.x line of
> this repository was a different tool and has been retired.

## What you get

| Folder | What is inside |
| --- | --- |
| `core/` | Agents every domain uses: `coder`, `runner`, `applier`, `researcher`. Workflows: `code-package`, `ops-script` |
| `domains/web-apps/` | Web application work: `branch-review` before a release |
| `domains/gamedev-unity/` | Game asset pipeline in Blender and Unity: `asset-round`, `method-question`, `rubric-probe`, `unity-check`, and the `modeller`, `unity-runner`, `art-critic` agents |
| `models.json` | The role table: which model plays each role, in order of preference |
| `roles/` | Gateway roles: `code-review`, `checkout-review`, `architecture-review`, `code-patch`, `package-work`, `research`, `text`, `image`, `art-critic`, `decisions` |
| `install/` | The installer and the `zodchi` command |
| `gateway/` | The Rust gateway (in progress) |
| `docs/` | How it works, subscriptions, forking for a company |

## The ideas behind it

- **Workflows ask for roles, not models.** Which model writes, reviews or
  runs depends on your subscription limits, and those change. `models.json`
  lists candidates for each role in order. The first step of a workflow
  picks the first candidate that still has limit left, and says when it had
  to switch.
- **The reviewer is never the author.** Code written by a Claude model is
  reviewed by a Codex model through the gateway, and the other way round.
- **Workflows stop.** `code-package` gives a change three review rounds.
  Without approval by then, it stops and hands the question back to you,
  instead of looping.
- **Cheap models do the legwork.** Running checks, applying a ready patch and
  searching are Haiku's job. Expensive models are kept for the decisions
  everything else depends on.
- **One package at a time per file.** `code-package` refuses to start when
  another open package already claims one of its files, so you do not get
  rebase conflicts later.
- **Nothing runs with sudo before a dry run.** `ops-script` checks a script
  and runs it without root on a copy before you are asked for a password.

## Install

You need [Claude Code](https://code.claude.com), Node.js 20 or later and,
for the gateway roles, the [Codex CLI](https://learn.chatgpt.com/docs) signed
in to your own ChatGPT plan.

```sh
git clone https://github.com/Inkasor/zodchi.git
cd zodchi
./install/install.sh                    # macOS, Linux
.\install\install.ps1                   # Windows PowerShell
```

The installer asks which domains you want; `core` is always installed. You
can also pass them directly: `--domains web-apps,gamedev-unity` or
`--domains all`.

- Agents and workflows go to `~/.claude/agents` and `~/.claude/workflows`,
  where Claude Code finds them in every project. With `--project <repo>`
  they go to that repository's `.claude/` instead. A project's own agent or
  workflow with the same name wins over yours.
- The role table, the gateway roles and the `zodchi` command go to
  `~/.zodchi`.
- The installer never overwrites a file it did not put there, or one you
  changed. `~/.zodchi/models.json` is yours after the first install: a newer
  table is written next to it as `models.json.new`.
- `--dry-run` shows what would change. `--uninstall` removes what the
  installer put there and leaves your changes in place.

Then run a workflow from Claude Code, for example `/code-package`, or ask
Claude to run it with your arguments. Each workflow's header lists its
arguments.

## Your models

Edit `~/.zodchi/models.json` to match your subscriptions. A repository can
override roles in `.zodchi/models.json`, and one run can override them in its
arguments (`models`). A `claude` candidate runs as a Claude Code subagent. A
`codex` candidate runs through the gateway on your Codex sign-in.

## Subscriptions: what is allowed

Each person uses **their own** subscription. OpenAI's terms do not allow one
ChatGPT plan to serve several people, whether by sharing a login or through a
server. They also forbid rotating accounts to get around usage limits. Zodchi
does not support either. The details and sources are in
[docs/subscriptions.md](docs/subscriptions.md).

## Forking for a company

Company-specific workflows, such as releases or onboarding, the company's
sign-in for the gateway server, and product policies, belong in a fork. See
[docs/fork.md](docs/fork.md).

## License

MIT, see [LICENSE](LICENSE).
