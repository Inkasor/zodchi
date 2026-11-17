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
