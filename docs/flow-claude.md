# zodchi flow: Claude as an executor

**Experimental, opt-in.** Claude can answer one-shot text roles through the locally installed Claude Code CLI,
signed in with the person's Claude subscription. The default role table supplies the usual Codex picks.

| Workflow | Role keys that accept Claude candidates |
|---|---|
| `code-package` | `expertWriter` in expert mode, `reviewer` |
| `design-brief` | `writer`, `researcher`, `architect` (uses the `reviewer` table entry unless `args.models.architect` is set) |
| `branch-review` | `reviewer`, `architect` |
| `research` | `constraintChecker`, `researchExpert`, `factChecker` |
| `incident-triage` | `architect` by default, or the role named by `args.role` |
| `method-question` | `methodEditor` |

The acceptor needs image input. The local Claude executor sends text, so acceptance selects a Codex candidate for
frame review. The `method-question` researcher uses Codex for read-only tool access and web search. The `code-package`
agent-mode writer uses the local Codex workspace.

## Enabling it

Claude runs only when the person enabled it in their own `~/.zodchi/flow.json` (or `$ZODCHI_HOME/flow.json`):

```json
{ "claude": true }
```

Nothing else enables it: not a repository's `.zodchi/models.json`, not `args.models`, not a server. Without it the
Claude gate skips otherwise eligible candidates with the reason `Claude is not an executor of this run: not enabled`.
Flow reads the setting again right before each Claude call. Turning it off blocks further Claude calls when a run
resumes (see [Outcomes](#outcomes)).

Use [the model table](model-roles.md) or per-run `models` to select Claude candidates. For example:

```json
{
  "version": 1,
  "roles": {
    "expertWriter": { "candidates": [{ "provider": "claude", "model": "opus", "effort": "high" }, { "provider": "codex", "model": "gpt-6.2-sol", "effort": "medium" }] },
    "reviewer": { "candidates": [{ "provider": "codex", "model": "gpt-6.2-sol", "effort": "medium" }] }
  }
}
```

This `args.models` object selects Opus as the branch reviewer.

```json
{"reviewer": {"candidates": [{"provider": "claude", "model": "opus", "effort": "high"}]}}
```

Each branch reviewer must have a different provider/model identity from every author and earlier reviewer.
Add another candidate to that role's list if the run should fall back when Opus is unavailable. Flow walks the list
in order and records any skipped candidate with its reason.

`model` is what `claude --model` takes (an alias such as `opus` or a full model name); `effort` is what
`claude --effort` takes (`low`, `medium`, `high`, `xhigh`, `max`).

Flow defaults a Haiku candidate's effort to `high` when the candidate omits it. For one-shot CLI calls, Claude Code resolves the context and auto-compaction settings. The Haiku subagents in the Claude Code plugin set their auto-compaction window to 100,000 tokens.

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
   an API key, a key helper or another provider is refused; only the kind of sign-in is named. The account it names
   (its `email` and `orgId`) becomes the run's binding: a digest, `claude-` and 16 hex digits, recorded with the
   pinned pick in `run.json` (`pair.expertWriter.account`). Neither the address nor the organization is written
   anywhere; a sign-in that names neither is refused, since the run could not be bound to it;
3. a tiny structured call with the candidate's model and effort answers `{"ok": true}` in the asked form; it counts
   only when the program also exits 0. A passed call is cached in `~/.zodchi/claude-preflight.json` by CLI version,
   account binding, model and effort for a day; a newer CLI, another account or another model is checked again.

A failed preflight skips the candidate with the reason (`Claude preflight: the claude program is missing ...`,
`... is not signed in with a Claude subscription ...`, `... did not answer a tiny structured call: ...`), before
anything of the run was sent.

## The call

```
claude -p --model <m> --effort <e> --output-format json --tools "" --strict-mcp-config --disable-slash-commands
       --no-session-persistence --safe-mode --settings <job>/settings.json --system-prompt <short frame>
```

- The message goes on stdin with the installed role's frame, the step's screened prompt and its JSON Schema.
  Flow uses the same 512 KiB limit for journaled text prompts on both executors.
- No tools (`--tools ""`), no MCP servers (`--strict-mcp-config` and none given), no hooks (`disableAllHooks` in the
  settings file), no skills, plugins, CLAUDE.md or other customizations (`--safe-mode`). It runs in an empty working
  folder of the job.
- No API-key fallback and no other account: the child gets the caller's environment without `ANTHROPIC_*`,
  `CLAUDE_CODE_USE_*` and variables whose names hold `API_KEY`, `TOKEN`, `SECRET` or `PASSWORD`
  (`CLAUDE_CODE_OAUTH_TOKEN`, the person's own subscription sign-in for headless use, is kept). No
  `--fallback-model`.
- A wall-clock limit: the role's `timeoutMin` (30 minutes for an expert role). A call still running then is stopped
  with what it started.
- Right before the program starts, the call is authorized again: `"claude": true` is still in `flow.json`, and
  `claude auth status`, with the environment of the call, names the account the run was bound to at the gate. If
  not, the call ends `refused` and nothing is sent.
- The engine reads the final result itself: `is_error` or a non-success result is a failure; the answer must be one
  JSON object (a single code fence around it is accepted) that follows the step's schema (types, enums, required
  fields, no extra fields), and then the step's own validation of a patch or a review. The program must also exit 0:
  a valid answer followed by a crash or another exit code is a failure, never a success.

## The journal

A Claude call is journaled like a gateway call: the `intent` (with `"executor": "claude"`, the model and effort,
the key and the stored request in `requests/`) before anything runs, and the `done` with the validated answer after.
The job of a key lives in the run's journal, `flows/<run-id>/claude/<key>/`:

- `job.json`, written and synced before the program starts, with `turnStartedAt` written and synced right before;
- `raw.json`, the raw final output of `claude -p` (the result message as Claude gave it);
- `final.json`, the final state: `succeeded` with the validated `result.data`, `failed`, `timeout` or `refused` with
  the reason. `job.json` and `final.json` name the account binding (`account`), never the account.

The folder of a key is created exclusively, so a key is called at most once. The new folder, and each file written
into it, is synced together with its folder entry (on POSIX the parent folder is synced too), so after a power cut
the folder of a call that started is still there. A folder without `job.json` is a key that was reserved and never
started: the step is asked again under the next key.

## Where Claude calls store data

Flow keeps its call records in the run journal and passes `--no-session-persistence` to Claude Code.

On 2026-11-27, one Haiku call at low effort completed with Claude Code 2.1.332 on Windows using the executor's flags,
a fresh working directory and `CLAUDE_CONFIG_DIR` set. The JSON answer included a `session_id`. The before-and-after
comparison of the config directory excluded the operator's live transcript and found no new `projects/<cwd-slug>/`
folder or session `.jsonl` file. The only observed changes were to two existing files. `.claude.json` was rewritten
with no entry for the working directory, and a plugin store updated the value of a single key to the latest session ID.

Files left by a Claude process killed mid-call remain unverified.

## Outcomes

| What happened | What the run does |
|---|---|
| Claude not enabled, the program missing, not signed in with a subscription, the model or effort refused in the preflight | the candidate is skipped at the gate with the reason; the next candidate is tried; nothing was sent |
| No valid pair left | the gate refuses visibly; nothing is claimed |
| The program could not be started once the run was under way, or the engine was cut after reserving the key and before writing `job.json` (nothing sent) | asked again under the next key (`-r2`, `-r3`), as a gateway job that died before its turn |
| Claude no longer enabled, or Claude Code signed in with another account than the one bound at the gate, when a call is about to start | `gateway refused at <step>`, the reason in `infra`, nothing sent, the claim open; after fixing it, `--rerun "<step>"` |
| An answer that is not JSON, outside the schema, an error result, a crash, a nonzero exit after a valid answer, or the time limit after the call started | a recorded failure: `gateway failed at <step>` or `gateway timeout at <step>`, the reason in `infra`, the claim open; never a silent switch to another model |
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
| `flow-claude-writer` | the preflight at the gate, a Claude writer bound to its account (a digest, no name in the journal) with the fake-Codex reviewer to approval, the sign-in checked again before the call, the call without tools and without the caller's API key, the intent and the raw message in the journal, the preflight cached; a resumed finished run calls nothing |
| `flow-claude-cut` | a cut right after the Claude call: resume reads the saved answer, Claude asked once; a cut after the key was reserved and before `job.json`: resume goes on under `-r2`, Claude asked once |
| `flow-claude-disabled` | Claude not enabled: the Codex-only pair, the Claude program never run |
| `flow-claude-missing` | the program missing or not signed in: skipped with the reason, the Codex pair runs; no pair left: refused at the gate |
| `flow-claude-invalid` | an answer that is not JSON, then one with a field outside the schema, then a valid one followed by exit 3: each stops the run at the write step with the claim open, nothing applied and no other model asked; a rerun with a valid answer and a clean exit goes on to approval |
| `flow-claude-account` | the sign-in changes between the gate and the call: refused, nothing sent; Claude disabled before a rerun: refused; enabled and signed in with the bound account again: the rerun goes on to approval |
| `flow-branch-review-claude` | resume after a cut returns the verdict from the saved Claude job with one review intent |
| `flow-research-claude` | a Claude research expert receives screened input, and its proposal reaches a finished owner decision |

One real smoke run against the real Claude CLI belongs to the before-release run, not to CI.

## Known limits

- Usage of the Claude subscription is not read before the call (Claude Code has no non-interactive limit read); a
  call refused for a limit is a recorded failure of the step.
- The schema check covers the keywords the flow schemas use (`type`, `enum`, `const`, `required`, `properties`,
  `additionalProperties`, `items`).
- A Claude program the engine started and lost when it was cut keeps running to its end; its answer is not used.
- The binding is as good as what `claude auth status` reports: two sign-ins that name the same e-mail and
  organization are the same account to the engine.
- On Windows a folder entry is flushed only where the folder can be opened for writing; otherwise NTFS's own
  metadata journal is relied on.
- `run.json` still records `"executors": "codex only"` in its policy; the pinned pair names the providers.
