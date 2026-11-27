# Verification

How `code-package` decides that a change works, and how a repository tells it
what matters. Running the real thing matters more than tests, one reviewer
with a written focus beats stacked reviewers, and a change must not edit the
checks that judge it.

## What the workflow does

The activity log in `code-package` and `design-brief` names the model doing
each task, its effort, the package label and the brief title when available.
The line before a gateway call includes its job key. A review line gives
the round limit, followed by the verdict and the number of blocking findings.
Checks report pass or fail. A design brief starts with its label and gains
its title after the writer produces the draft.

In these two workflows the first gateway step submits the job, or waits on its
recorded key after a resume. That command waits at most nine minutes. If the job
is still live, the step returns `pending`. Each follow-up wait has its own step,
such as `write export wait 1`, and uses the same key.
Its log entry gives the status and up to three public progress lines or recent
action types. A job without a progress file or actions reports its status alone.
The original step label remains the one to use with `args.rerun`.

In agent mode, the workflow waits for each Codex writer job to reach a final
status before handing its changes to another writer or to checks. A timeout
or a successful `more` answer allows up to `args.continuations` extra jobs
per writing step (default 2, or 0 to stop at the first handoff). Every work
job keeps its thread. The next job uses a new key and resumes the previous
job's thread. If a timeout left no thread ID, it starts from the uncommitted
checkout and the previous prompt. The workflow combines the changed files
reported by all turns. A `question` or a `more` answer containing questions
goes to the lead. At the continuation limit the claim is marked `awaiting`.
`stoppedAt` names the last job and `next` gives the write step and attempt
for `args.rerun`. Raising `args.continuations` also lets the run continue.
An `unknown` outcome waits for a human decision.

On Windows, `0xC0000142` (`3221225794` or `-1073741502`) is
`STATUS_DLL_INIT_FAILED`. It records a process initialization failure.
An `EPERM` when creating a test fixture link indicates an unavailable prerequisite.
Work roles record the command and exit code and leave the affected checks
unverified. The project runner provides authoritative verification on the candidate tree.
For a standalone `mode: work` job, the lead runs the declared verification on the
candidate. Directly observed Windows initialization failures appear in `actions.json`
and in the job's `actions.startupFailures` count.

The Zodchi E2E runner reports a Windows startup failure as `BLOCKED` and stops
that suite. It reports a denied fixture link as `BLOCKED` for the affected scenario.
Return code 2 records incomplete verification. A recorded test failure still returns 1.

1. **Cheap checks first, then the slow run.** After each write the runner
   runs `args.checks` (build, lint, fast tests), then the slow run of the
   real program: the commands in `args.verify`, else the repository's skill
   `.claude/skills/verify/SKILL.md`. A failure caused by the code goes back
   to the writer. The runner reports each command, its exit code and the path
   of its log or trace (`verification.evidence`). The caller prepares the
   [interpreter and dependencies](flow.md#check-command-environment) used by these commands.
2. **What verified it.** `verifiedBy` is `args.verify`, `verify skill` or
   `checks`, the slowest of these that ran and passed. When none exists, it
   is `none` and the result says "not verified by running".
3. **Protected checks.** After each write the workflow compares the package
   diff with the base commit. A change to, or deletion of, an existing file
   under `test/`, `tests/`, `e2e/` or `.claude/skills/verify/`, of
   `REVIEW.md`, or of a path in `args.protect` stops the package before review
   with the list (`protectedChanged`), unless `args.allowCheckChanges` lists
   those paths (`checkChanges`). New files are allowed. The writer is told this
   rule up front.
4. **REVIEW.md from the base commit.** The review request carries `REVIEW.md`
   as of the base commit (`git show <base>:REVIEW.md`, attached as
   `REVIEW.base.md`, never dropped for size), so the package cannot change
   what judges it. When the base has none, the review prompt says so.
5. **Severities.** Findings are `important` (blocks), `nit` (does not block)
   or `pre-existing` (was there before the change; does not block). Older
   words are read as `blocking` = `important`, `should_fix` and `note` =
   `nit`. Only `important` findings block approval and count against the
   stop rule; the package `verdict` follows that rule, and the reviewer's own
   word stays in `rounds[].review.verdict`.
6. **A stamp on every commit.** Each round's commit message ends with
   `Verified: <how>`, for example
   `Verified: args.verify exit 0`, or `Verified: none`.
   `git log --grep "Verified: none"` lists the commits nothing ran.
7. **Flaky checks.** Neither the writer nor the runner may skip a check, add
   a sleep or run it again until it passes. A check that fails without a cause
   in the change is reported as flaky with its log, and the package stops;
   deleting a flaky test is the lead's decision (`args.allowCheckChanges`).

## Writing REVIEW.md

`REVIEW.md` sits at the root of the repository: what the owner would flag in
a pull request, and what not. One line per rule, each with its reason:

```markdown
# Review focus

Flag:
- A database query inside a loop over request items: the list pages time out (PR 214).
- Money as a float: totals drift by a cent (incident 2026-03).

Do not flag:
- Naming and formatting: the formatter owns them.
- Edge cases of inputs the API layer already rejects.
```

Write what the owner would flag, not general good practice. The "Do not
flag" list matters as much: it stops a review from finding a new hypothetical
case every round. When a review missed a real bug, add a line; remove rules
that never fire.

## Writing a verify skill

`.claude/skills/verify/SKILL.md` tells the runner how to start the app and
drive one real flow: the commands in order and what success looks like. Keep
it fast (one flow, a minute or two), reliable (no sleeps: wait for a port, a
log line or a page element; fixed test data) and evidence-making (each command
writes a log, a browser flow saves a trace or screenshot). It stops what it
started.

```markdown
---
name: verify
description: Start the app on a fresh database and place one order through the browser.
---

1. `npm run build` (exit 0).
2. `npm run start -- --port 4100 > $LOG_DIR/app.log 2>&1 &`; wait until `curl -s localhost:4100/health` prints `ok`.
3. `npx playwright test e2e/order.spec.ts --trace on --output $LOG_DIR/trace` (exit 0).
4. Stop the app.
```

A repository without a skill can pass the same commands as `args.verify`.

## How zodchi itself is verified

Every PR reports the required checks `test (windows-latest)`, `test (macos-latest)` and `test (ubuntu-latest)`
from [the CI workflow](../.github/workflows/ci.yml). Each runs `node scripts/check.mjs` for the repository checks
and publish guard, plus `node scripts/ci-select.test.mjs` for the coverage rules.

- PRs with only documentation, release notes or version bumps finish after the repository checks and coverage
  selection. The selector compares the checked-out PR merge commit with its first parent. For version files it
  checks the contents on both sides, including workspace package versions in the lockfile.
- Code PRs run all locked workspace Rust tests. The gateway binaries and Rust tests share the `dev` profile
  because the Rust integration tests also request binaries in that profile. The cache restores the Cargo registry,
  git dependencies and `rust/target` by runner OS, Rust toolchain and lockfile contents.
- A change in a mapped workflow crate or an e2e scenario file selects the scenarios that cover it. Changes to the
  engine, facade, core, CLI, server, e2e driver or fixtures run the full suite. Unmapped paths also run the full
  suite. Markdown used as workflow or plugin input follows those coverage rules.
- Pushes to `main`, `codex/zodchi-v*` and tags, and manual runs, run the full suite on every OS. Check the full
  run on the release revision before tagging it. Full runs split the registered scenario names by a stable hash
  into two concurrent shards on each runner, with both results reported by that OS's required check.

The CI driver runs the built binaries with `scripts/e2e/fake-codex.mjs`, including the installer round trip in a
scratch home on full runs. The suite writes one trace per scenario, and CI uploads the shard directories together
as the OS's trace artifact. To run the full suite locally, use `npm run e2e` or the
[verify skill](../.claude/skills/verify/SKILL.md).

Before a release, by hand: `npm run e2e:release -- --disposable` (`scripts/e2e-release.mjs`). A headless Claude Code
session with the plugins of the working tree runs the real `code-package` on a throwaway fixture repository (a `clamp`
function, its check and a smoke command); the review goes through the candidate gateway to the fake Codex with a
scripted approval. It spends model tokens: a cap passed to `claude -p --max-budget-usd` (default 3 USD; the run refuses
to start when the flag is missing or a limit is not a finite positive number), a pinned model, a wall-clock deadline,
only `ANTHROPIC_API_KEY` in an allow-listed environment, no retry.

Where it runs: a dedicated, disposable container or VM with no checkout but the one it runs from, no credential store
mounted and outbound network only to the model service. `--disposable` states that, always (`CI=true` does not count).
Known limit: the harness cannot prove that the machine is disposable; `--disposable` is the operator's word for it. Run it
only where that word is true. The release run moves to `zodchi flow`, which keeps writers without a shell.
The session runs with permissions bypassed, as the user who started the run, so its shell can reach whatever the
container holds; the script cannot limit the network or the file system, which is the container's job. It refuses
when it sees a machine that is not disposable: a credential store in the real home (`.ssh`, `.git-credentials`,
`.netrc`, `.aws`, `.config/gh`, `.codex`, `.zodchi`, a Claude sign-in) or a Git credential kept in the checkout
(`http.*.extraheader`, `credential.*`; the probe's output is never logged, and a probe that fails refuses too). What
the session is given is staged in the scratch folder read-only (on POSIX the folders too): the plugin, the roles, the
gateway binary, the fake Codex the gateway runs and the model table; each is hashed before the launch (an input that
cannot be hashed stops the run) and again after it.

Time is bounded: at the deadline the session's process tree (its process group on POSIX) is killed and the result of
the kill is logged; the run waits at most a minute more for its exit. After the session, every process whose command
line names the scratch folder (a detached gateway worker, the fake) is killed; one that survives stops the run. Every
other command of the harness has its own time limit.

It decides by:
- the session itself: it started and exited 0 before the deadline, its JSON reports success, and it carries a cost
  receipt (`total_cost_usd`, positive, within the cap); a missing or malformed receipt fails the run. The staged inputs
  are unchanged after it. A session that fails any of this ends the run there: its result, commits and tree are not
  judged and no command of the fixture runs.
- the workflow result: shape and terminal status, apart from the session's exit; the evidence of the cheap check and
  then the verify command, each from its source with exit code 0 and naming its log, a non-empty file in the
  package's scratch folder.
- the final committed tree (`git archive` of the branch tip): the harness reruns the cheap check, the new test and the
  smoke command itself, and runs its own acceptance check, written outside the fixture only after the session has
  ended. The baseline test and smoke command are unchanged at the tip, HEAD is the tip, no file is changed or new and
  uncommitted (ignored ones aside), and from the baseline to the tip the commits change exactly `src/math.mjs`
  (modified) and `test/clamp.test.mjs` (added: the brief requires this new test, which the protected-check rule must
  let through).
- the `Verified:` stamp of the branch tip, and the review turn that the fake Codex received with the baseline
  `REVIEW.md`.

`ops-script` in check mode joins in version 2.

The fake Codex keeps an invocation log (`fake-turns.jsonl` in its Codex home) and holds a turn whose prompt holds
`HOLD:<name>` until the scenario writes `fake-release-<name>` (a sign-in start likewise until `fake-login-release`), so
a scenario counts executions and waits for a condition, never for time. The markers it waits for (`fake-entered-<name>`
with the Codex pid, `fake-login-started` with the loginId) are written whole, through a rename.

### Workflow scenarios

Run selected end-to-end scenarios by passing their names to `node scripts/e2e.mjs --no-build`.

| Area | Scenarios |
| --- | --- |
| Package entry and real process evidence | `flow-entry-local`, `flow-entry-failing-verify`, `flow-review-check-records` |
| Private candidate and recovery | `flow-isolated-stops`, `flow-isolated-successor` |
| Research, owner reply and brief publication | `flow-design-brief-private-jobs`, `flow-design-brief-decision`, `flow-design-brief-unsafe-evidence` |
| Plugin packaging and stale cache detection | `flow-client-plugin`, `flow-release-bundle`, `install-plugins-stale-other-workflow` |

Run the full suite with `node scripts/e2e.mjs`. Scenario files under `scripts/e2e/scenarios/` describe the precise fixtures and expected results.
