# zodchi flow: Claude as an executor

**Experimental, opt-in.** A step of `zodchi flow code-package` (the writer or the reviewer) may be played by Claude
through the Claude Code CLI installed on this machine, signed in with the person's own Claude subscription: for
example an Opus writer with a Codex reviewer. Codex only stays the default. The engine, its journal, its checks and
its commits are the same as in [flow.md](flow.md); only who answers a model step changes.

## Enabling it

Claude runs only when the person enabled it in their own `~/.zodchi/flow.json` (or `$ZODCHI_HOME/flow.json`):

```json
{ "claude": true }
```

Nothing else enables it: not a repository's `.zodchi/models.json`, not `args.models`, not a server. Without it every
Claude candidate is skipped with the reason `Claude is not an executor of this run: not enabled`.

Then put Claude candidates in the role table, as for any provider:

```json
{
  "version": 1,
  "roles": {
    "expertWriter": { "candidates": [{ "provider": "claude", "model": "opus", "effort": "high" }, { "provider": "codex", "model": "gpt-6.2-sol", "effort": "medium" }] },
    "reviewer": { "candidates": [{ "provider": "codex", "model": "gpt-6.2-sol", "effort": "medium" }] }
  }
}
```

`model` is what `claude --model` takes (an alias such as `opus` or a full model name); `effort` is what
`claude --effort` takes (`low`, `medium`, `high`, `xhigh`, `max`).

The program is the native `claude` on PATH (`claude.exe` on Windows; an npm `claude.cmd` shim is a shell script and
is never run), or the one named by `ZODCHI_CLAUDE_BIN` (a `.js` or `.mjs` file runs with the Node on PATH).

## The pair

At the gate, before anything is claimed, the resolver walks the writer candidates in order and, for each, the
reviewer candidates. A Codex candidate needs the Codex subscription usable (`zodchi account`); a Claude candidate
needs Claude enabled and its preflight passed. The writer and the reviewer are distinct provider/model identities
(`claude/opus` and `codex/gpt-6.2-sol` are distinct; the same model twice is not). The first pair found is pinned
for the whole run (every write, close and review step) and recorded in `run.json` with every candidate skipped and
its reason. No pair left: the gate refuses with those reasons and nothing is claimed.

## Preflight

Run at the gate only for the Claude candidates the walk reaches, each model and effort once per gate:

1. the program is found and `claude --version` answers;
2. `claude auth status` says it is signed in with a Claude subscription (`authMethod` `claude.ai`, first-party API):
   an API key, a key helper or another provider is refused; only the kind of sign-in is read and named, never the
   account;
3. a tiny structured call with the candidate's model and effort answers `{"ok": true}` in the asked form. A passed
   call is cached in `~/.zodchi/claude-preflight.json` by CLI version, model and effort for a day; a newer CLI or
   another model is checked again.

A failed preflight skips the candidate with the reason (`Claude preflight: the claude program is missing ...`,
`... is not signed in with a Claude subscription ...`, `... did not answer a tiny structured call: ...`), before
anything of the run was sent.

## The call

```
claude -p --model <m> --effort <e> --output-format json --tools "" --strict-mcp-config --disable-slash-commands
       --no-session-persistence --safe-mode --settings <job>/settings.json --system-prompt <short frame>
```

- The message goes on stdin: the frame of the installed gateway role (`flow-patch` or `code-review`), the step's
  prompt as the Codex writer or reviewer gets it, and the step's JSON Schema with the instruction to answer one JSON
  object and nothing else.
- No tools (`--tools ""`), no MCP servers (`--strict-mcp-config` and none given), no hooks (`disableAllHooks` in the
  settings file), no skills, plugins, CLAUDE.md or other customizations (`--safe-mode`), no session kept. It runs in
  an empty folder of the job.
- No API-key fallback and no other account: the child gets the caller's environment without `ANTHROPIC_*`,
  `CLAUDE_CODE_USE_*` and variables whose names hold `API_KEY`, `TOKEN`, `SECRET` or `PASSWORD`
  (`CLAUDE_CODE_OAUTH_TOKEN`, the person's own subscription sign-in for headless use, is kept). No
  `--fallback-model`.
- A wall-clock limit: the role's `timeoutMin` (30 minutes for an expert role). A call still running then is stopped
  with what it started.
- The engine reads the final result itself: `is_error` or a non-success result is a failure; the answer must be one
  JSON object (a single code fence around it is accepted) that follows the step's schema (types, enums, required
  fields, no extra fields), and then the step's own validation of a patch or a review.

## The journal

A Claude call is journaled like a gateway call: the `intent` (with `"executor": "claude"`, the model and effort,
the key and the stored request in `requests/`) before anything runs, and the `done` with the validated answer after.
The job of a key lives in the run's journal, `flows/<run-id>/claude/<key>/`:

- `job.json`, written and synced before the program starts, with `turnStartedAt` written and synced right before;
- `raw.json`, the raw final output of `claude -p` (the result message as Claude gave it);
- `final.json`, the final state: `succeeded` with the validated `result.data`, `failed` or `timeout` with the reason.

The folder of a key is created exclusively, so a key is called at most once.

## Outcomes

| What happened | What the run does |
|---|---|
| Claude not enabled, the program missing, not signed in with a subscription, the model or effort refused in the preflight | the candidate is skipped at the gate with the reason; the next candidate is tried; nothing was sent |
| No valid pair left | the gate refuses visibly; nothing is claimed |
| The program could not be started once the run was under way (nothing sent) | asked again under the next key (`-r2`, `-r3`), as a gateway job that died before its turn |
| An answer that is not JSON, outside the schema, an error result, a crash, or the time limit after the call started | a recorded failure: `gateway failed at <step>` or `gateway timeout at <step>`, the reason in `infra`, the claim open; never a silent switch to another model |
| The engine was cut after Claude was started and before `final.json` was saved | `unknown outcome at <step>` on resume: the call may have run, it is not asked again by itself |
| The engine was cut after `final.json` was saved | resume reads the saved answer; Claude is not asked again |

After looking, `zodchi flow code-package --resume <run-id> --rerun "<step>"` asks the step again under a new key
with the same pinned pair.

## Verification

`node scripts/e2e.mjs` runs `scripts/e2e/scenarios/flow-claude.mjs` against `scripts/e2e/fake-claude.mjs`, a
stand-in for the CLI that reads the message, logs each invocation and answers with the step's scripted JSON (on POSIX
it is a `claude` program on PATH; on Windows it is named by `ZODCHI_CLAUDE_BIN`):

| Scenario | What a user would see |
|---|---|
| `flow-claude-writer` | the preflight at the gate, a Claude writer with the fake-Codex reviewer to approval, the call without tools and without the caller's API key, the intent and the raw message in the journal, the preflight cached; a resumed finished run calls nothing |
| `flow-claude-cut` | a cut right after the Claude call: resume reads the saved answer, Claude asked once |
| `flow-claude-disabled` | Claude not enabled: the Codex-only pair, the Claude program never run |
| `flow-claude-missing` | the program missing or not signed in: skipped with the reason, the Codex pair runs; no pair left: refused at the gate |
| `flow-claude-invalid` | an answer that is not JSON, then one with a field outside the schema: each stops the run at the write step with the claim open and no other model asked; a rerun with a valid answer goes on to approval |

One real smoke run against the real Claude CLI belongs to the before-release run, not to CI.

## Known limits

- Usage of the Claude subscription is not read before the call (Claude Code has no non-interactive limit read); a
  call refused for a limit is a recorded failure of the step.
- The schema check covers the keywords the flow schemas use (`type`, `enum`, `const`, `required`, `properties`,
  `additionalProperties`, `items`).
- A Claude program the engine started and lost when it was cut keeps running to its end; its answer is not used.
- `run.json` still records `"executors": "codex only"` in its policy; the pinned pair names the providers.
