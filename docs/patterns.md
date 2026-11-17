# Patterns

Short rules that came out of real packages. Each one names the problem it
prevents.

## An allow-list refusal names what is allowed

A tool allow-list (permission rules of an agent, a gateway role's command
list, a wrapper that runs only certain commands) refuses everything else.
When it refuses, the message lists the commands it does allow, for example:

```
refused: `git push --force` is not allowed here.
Allowed: git status, git diff, git add <path>, git commit -m <message>.
```

A refusal that only says "not allowed" leaves a model guessing: it tries
variants of the same command, or stops and asks a human. With the allowed
commands in front of it, it picks the right one and goes on.

## A script a human runs with sudo

A script that needs root is written so that a human can trust it before typing
a password. `--check` is the default mode: it needs no root, reads and
validates, prints what it would do and changes nothing. `--apply` needs root
and does the change. Before `--apply` replaces any file it makes a backup of
that file, and it records every file it creates. After the change it verifies
the result. When applying or verifying fails, it rolls back: it restores every
backup, removes the files this run created, and exits with an error. The human runs it in a
real terminal, not through Claude Code's `!`: a sudo password needs a TTY, and
`!` has none ("sudo: a terminal is required"). The `ops-script` workflow runs
the `--check` mode on one snapshot of the script and its files (a fresh folder with the SHA-256 of every file) before it hands over the command; the command checks those hashes and runs that same snapshot, locally or on the host.
