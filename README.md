# Zodchi

[Русский](README.ru.md)

Zodchi is a set of working practices for Claude Code. It gives you tuned
agents and workflows, grouped by the kind of work they are for, and a
gateway that lets those workflows call Codex models by **role** instead of by
model name.

It is not a framework that tries to fit every project. Each domain holds
agents and workflows tuned for that kind of work. Only what is truly the
same everywhere lives in `core/`.

> **Status: 1.0 in development.** The agents, the workflows and the `zodchi`
> gateway (Rust) work today; the multi-user gateway server comes next. The 0.x
> line of this repository was a different tool and has been retired.

## What you get

| Folder | What is inside |
| --- | --- |
| `core/` | Agents every domain uses: `coder`, `runner`, `applier`, `researcher`. Workflows: `code-package`, `ops-script`, `incident-triage` (a user's error report to a draft reply or fix brief, see [docs/incident-triage.md](docs/incident-triage.md)). Skill: `workspace-audit` (tidy a cluttered folder: read-only researchers, one batch of decisions, then one worker) |
| `domains/web-apps/` | Web application work: `branch-review` before a release |
| `domains/gamedev-unity/` | Game asset pipeline in Blender and Unity: `asset-round`, `method-question`, `rubric-probe`, `unity-check`, and the `modeller`, `unity-runner`, `art-critic` agents |
| `models.json` | The role table: which model plays each role, in order of preference |
| `roles/` | Gateway roles: `code-review`, `checkout-review`, `architecture-review`, `code-patch`, `package-work`, `research`, `text`, `image`, `art-critic`, `decisions` |
| `.claude-plugin/` | The marketplace: each of `core/` and `domains/*` is a Claude Code plugin |
| `install/` | The installer and the `zodchi` command |
| `gateway/` | The `zodchi` gateway in Rust: calls Codex models by role, over your own subscriptions |
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
- **Run before review.** `code-package` runs the repository's verification, stops when a change edits an existing test, records how each commit was verified and reviews against the repository's `REVIEW.md`, see [docs/verification.md](docs/verification.md).
- **Cheap models do the legwork.** Running checks, applying a ready patch and
  searching are Haiku's job. Expensive models are kept for the decisions
  everything else depends on.
- **One package at a time per file.** `code-package` refuses to start when
  another open package already claims one of its files, so you do not get
  rebase conflicts later.
- **Nothing runs with sudo before a dry run.** `ops-script` checks a script
  and runs it without root on a copy before you are asked for a password.
  Files the script needs next to it go in `files`; you get the command for your
  own terminal (`ssh -t` when remote), because Claude Code's `!` has no TTY for
  a sudo password. [docs/patterns.md](docs/patterns.md) describes the shape
  of such a script ("A script a human runs with sudo").

## Install

You need [Claude Code](https://code.claude.com) and Node.js 20 or later. For
the gateway you also need [Rust](https://rustup.rs) to build it, and the
[Codex CLI](https://learn.chatgpt.com/docs) signed in to your own ChatGPT
plan.

```sh
git clone https://github.com/Inkasor/zodchi.git
cd zodchi
./install/install.sh                    # macOS, Linux
.\install\install.ps1                   # Windows PowerShell
```

This installs `zodchi-core` for you in every project, builds the gateway
(when Rust is installed) and puts the role table and the gateway roles into
`~/.zodchi`. Domains are switched on per project:

```sh
./install/install.sh --project ~/code/my-game --domains gamedev-unity
```

- Agents and workflows come as Claude Code plugins from this repository (the
  marketplace `zodchi`): `zodchi-core`, `zodchi-web-apps`,
  `zodchi-gamedev-unity`. The core is on in every project; a domain is on
  only in the projects you name, for you alone (it goes into the project's
  `.claude/settings.local.json`, which is not committed). `--domains` without
  `--project` turns a domain on everywhere.
- Plugins are read from a copy, not from your clone. The installer takes the
  commit your clone's HEAD points at and has git write its plugin files
  (`.claude-plugin`, `core`, `domains`) into
  `~/.zodchi/plugins/<commit hash>/`, which it registers as the marketplace.
  The copy comes only from that commit, never from the working tree:
  uncommitted changes are left out (the installer says so in one line), and
  switching a branch or editing files in the clone changes nothing for the
  Claude Code sessions on your machine. It refuses to copy from a branch
  other than the default one (the branch `refs/remotes/origin/HEAD` points
  at), from a detached HEAD, or when that default is not set (`git remote
  set-head origin --auto` sets it); `--force` copies the commit anyway. A
  folder that is not a git clone is refused unless `--dev`. A copy is
  written under a temporary name, every file is checked against its blob in
  the commit, it is marked complete last and then renamed; a copy folder
  without its `.complete` mark or with a file missing is moved aside and
  made again. After a
  `git pull`, rerun the installer: it makes a new copy, points the
  marketplace at it, updates `zodchi-core` and the domains you name in that
  run, and rebuilds the gateway. A domain you enabled in another project is
  not updated by that run: rerun the installer with
  `--project <that repo> --domains <domain>` for each such project. The copy
  the marketplace reads, the one it read before and the two newest complete
  copies are kept, and so is every copy made in the last seven days (a running Claude Code session keeps
  reading the copy it started with); older ones are removed. After moving the marketplace the
  installer reads the registration back and prints where it points; if the
  move fails it prints what is registered now, and the new copy stays beside
  it. Only one install runs at a time (`~/.zodchi/plugins/.install.lock`; a
  lock left by a process that is gone is taken over). An install made by an earlier version, which read the clone
  itself, is moved to a copy on the next run. The installer is meant for one person on their own machine: the
  lock guards the plugin copies and the marketplace, not every file the installer writes, and two installers
  started at the same moment can still race on a stale lock.
- `--dev` is for working on zodchi itself: the clone is the marketplace, as
  before. Every Claude Code session on the machine that starts or reloads
  then reads the clone's working tree as it is, including a branch that is
  half done, so use it only while you develop zodchi, and rerun without
  `--dev` afterwards to go back to a copy.
- Workflows run as `/zodchi-core:code-package`, `/zodchi-gamedev-unity:asset-round`
  and so on, and agents are named `zodchi-core:runner` and the like, so they
  never clash with a project's own.
- With Rust installed, the installer builds the gateway itself (`--no-build`
  skips that). List your subscriptions in `~/.zodchi/accounts.json`, see
  [gateway/README.md](gateway/README.md).
- The installer never overwrites a file it did not put there, or one you
  changed. `~/.zodchi/models.json` is yours after the first install: a newer
  table is written next to it as `models.json.new`.
- `--dry-run` shows what would change. `--uninstall` removes what the
  installer put there and leaves your changes in place. Installed from a copy
  (the default), it removes the marketplace registration and the plugin
  copies, and Claude Code takes every plugin installed from that marketplace
  with it: zodchi-core and also the domain plugins you enabled in other
  projects. After `--dev` the marketplace is the clone itself: uninstall
  removes only zodchi-core, and the marketplace and the domain plugins stay
  (the installer prints how to remove them). With `--no-plugins` Claude
  Code's plugins, the marketplace and the copies are left alone.

Then run a workflow from Claude Code, for example `/zodchi-core:code-package`,
or ask Claude to run it with your arguments. Each workflow's header lists its
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
