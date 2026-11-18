# zodchi flow

`zodchi flow code-package` runs the `code-package` workflow as code inside the gateway, without Claude Code: the same
gate, claim, write, cheap checks, verify, commit, review, close and stop rules as the JavaScript workflow
(`core/workflows/code-package.js`), decided by a state machine in Rust (`gateway/crates/zodchi-flow`). Models only
propose a patch or judge a change; every transition is the engine's. This is version 1: Codex executors only,
through the local gateway.

## Running it

From anywhere, with the repository named in the args:

```sh
zodchi flow code-package --args package.json
```

```json
{
  "label": "export-csv",
  "brief": "/abs/path/brief.md",
  "repo": "/abs/path/repo",
  "files": ["src/export.mjs", "test/export.test.mjs"],
  "checks": ["npm ci", "node test/export.test.mjs"],
  "verify": ["node scripts/smoke.mjs"]
}
```

It prints the result JSON and exits 0 when the change is approved, 2 for any other end (refused, stopped, changes
requested), 1 for a wrong call.

Arguments (a subset of the JavaScript workflow's; anything else is refused before anything is claimed):

| Field | Meaning |
|---|---|
| `label`, `brief`, `repo`, `files` | as in `code-package`: the package name, its brief, the repository (the top of a Git work tree) and the files it may change |
| `checks` | cheap checks, run in order after each write; a command string or `{ "cmd": ... }`. A command passes on exit code 0 and nothing else: a `pass` rule in words is refused |
| `verify` | the slow run of the real program, the same way, run only when every cheap check passed |
| `rounds` | review rounds at most, default 3 |
| `fixes` | how many times a failed check goes back to the writer, default 1 |
| `protect`, `allowCheckChanges` | more protected paths; protected paths the package may change |
| `models` | role table entries for this run (`expertWriter`, `reviewer`) |
| `extendClaim` | `true`: a patch that names files outside the claim extends the claim (atomically, under the claims lock, refused on a conflict) before anything is written. Default: such a patch is refused whole |
| `checkTimeoutMin` | time limit of one check command, default 60 |
| `tmp`, `mode: "expert"`, `commit: true` | accepted for compatibility; the journal replaces `tmp` |

Refused in version 1, each with its reason: `mode: "agent"`, `hard`, `continuations`, `branch` (check out the
branch first), `fixIgnore` (commit `.agent-tmp/` in `.gitignore` first), `closeShouldFix`, `rerun` (use
`--rerun`), `commit: false`. A repository with a verify skill (`.claude/skills/verify/SKILL.md`) and no
`args.verify` is refused too: the engine runs commands, not prose, so pass the skill's commands as `args.verify`.

The result keeps the fields of the JavaScript workflow: `label`, `mode`, `models`, `rounds[]`, `write`, `verdict`,
`approved`, `openFindings`, `verifiedBy`, `verification` (`evidence[]` with `command`, `source`, `exitCode`, `log`),
`next`, `stoppedAt`, `refused`, `question`, `questions`, `conflicts`, `claimAdded`, `protectedChanged`. It adds
`runId`, `journal`, `base`, `skipped` (candidates passed over, with reasons), `outsideClaim` and `infra`.

## What it does

1. **Gate**, with no effect: the args, the brief, a Git work tree with a commit on a checked-out branch, `.agent-tmp/`
   ignored, no uncommitted change in a claimed file, the gateway roles `flow-patch` and `code-review` installed, the
   Codex subscription usable (`zodchi account`), and the writer/reviewer pair.
2. **Pair.** From `~/.zodchi/models.json`, the repository's `.zodchi/models.json` and `args.models` (a later table
   replaces a role of an earlier one): the first `expertWriter` candidate, in order, that has a `reviewer` candidate
   of another model; Claude candidates are skipped in this version. The pair is pinned for the whole run and
   recorded with every candidate skipped and why. No pair: refused.
3. **Claim**, in `~/.zodchi/packages/<repository>/<label>.json`, the same files and lock as the JavaScript workflows
   use, so the two never take the same files at once.
4. **Write.** The writer is an expert gateway call (role `flow-patch`, no tools, no shell). Its prompt carries the
   brief, the rules and each claimed file with the blob id of its current content; it answers with a structured
   patch by `flows/code-package/v1/patch.schema.json`: create, modify (whole new content), delete or rename, each
   with the blob id it was written against.
5. **Apply.** The engine checks the patch whole before writing a byte: plain relative paths (no `..`, no absolute
   path, nothing under `.git/` or `.agent-tmp/`), no link on the way, every path claimed (else refused, or the claim
   extended with `extendClaim`), no existing protected check changed (`test/`, `tests/`, `e2e/`,
   `.claude/skills/verify/`, `REVIEW.md`, `args.protect`, as of the base commit; else the package stops before review
   with `protectedChanged`), and every blob id equal to the file now (else `stale patch`). Then it writes the files.
6. **Checks.** The candidate tree (the last commit with the claimed paths from the work tree) is written as a Git
   tree and exported to a temporary folder outside the checkout. There the cheap checks run with bash, in order,
   each to its end, then the verify commands when they all passed; each with its real exit code and its log in the
   journal. The environment is cut down to what programs need to start (paths, home, temporary folder, locale):
   tokens and keys in the caller's environment do not reach a check. A failure goes back to the writer with the
   end of its log, up to `args.fixes` times.
7. **Commit**, by the engine only: after rechecking that the branch is where the run left it, that the claim is
   still open with every file, and that the work tree still gives the checked tree, the checked tree is committed
   on the branch (`git commit-tree`, then `git update-ref` from the expected parent), so the commit holds the claimed
   paths only. Its message is `<label>: round N` and `Verified: <source> exit <codes>; ...`, sources and exit codes
   only. Nothing is pushed.
8. **Review**, an expert gateway call (role `code-review`, the reviewer of the pair) with the diff from the base, the
   brief, `REVIEW.md` of the base commit (never dropped), the previous review, and the full claimed files, which are
   dropped first, the largest first, when the request would pass the gateway's 512 KB, and named in a "Not attached
   for size" line. Severities and the verdict rule are those of `docs/verification.md`.
9. **Close** the important findings with the same writer, then checks, commit and review again, until approval, a
   blocked review or `rounds` rounds.

## The journal

`~/.zodchi/flows/<run-id>/` (or `$ZODCHI_HOME/flows/`), outside the repository and every folder a model or a check
is pointed at:

- `run.json`: run id, workflow and version, repository, base commit and branch, the inputs (the args as given, the
  brief's hash), the pinned pair with the skipped candidates, the policy.
- `brief.md`, `REVIEW.base.md`: the brief and the base REVIEW.md as the run read them; a resumed run uses these.
- `events.jsonl`: before each effect an `intent` (step, round, attempt, input digest, the effect, the gateway key or
  the expected commit parent and tree), a `submitted` line once the gateway took a job, and after it a `done` with
  the validated answer or the Git receipt; `stop`, `rerun` and `finished` lines.
- `requests/` (the exact request of each gateway job), `plans/` (each applied patch with its blobs before and after),
  `reviews/`, `logs/` (one log per check command), `result.json` once the run has finished.
- `lock/`: the process working on the run (pid and start time). One at a time; a lock whose process is gone is taken
  over.

## Recovery

`zodchi flow code-package --resume <run-id>` runs the machine again from the start. Each step comes back from the
journal when it has a `done`; otherwise:

- a model call with an `intent` submits its stored request under its stored key again, which the gateway answers
  with the job it already has, and waits for it: a cut after a submission never asks the model twice. A job that
  failed before its model turn started is asked again under the next key (`-r2`, `-r3`, at most two); any other
  end of a job is not asked again by itself.
- an apply with an `intent` compares every file with the blobs before and after: all after, it is done; each before
  or after, applying again finishes it; anything else is an unknown outcome.
- a commit with an `intent` compares the branch tip with the expected parent and tree: the tip is the parent, the
  commit is made; the tip is a commit of that tree on that parent, it is taken as the receipt; anything else is an
  unknown outcome.
- checks without a `done` run again (they change nothing but their export).

What neither the journal, Git nor the gateway can settle (a job that ended `unknown`, a file changed by somebody
else in the middle of an apply, a branch that moved during a commit, a submitted job whose folder is gone) stops the
run with `stoppedAt: "unknown outcome at <step>"`, keeps the claim open and is never retried silently. An
infrastructure failure (the gateway refused, a job failed after its turn started, an answer outside the schema)
stops with `infrastructure at <step>`, `gateway <status> at <step>` or `invalid answer at <step>`, the claim open.
After looking, `--resume <run-id> --rerun "<step>"` runs that step again under a new key (`-a2`, ...); `--rerun`
must name the step the run stopped at. A finished run resumed returns its result and runs nothing. `--args` with
`--resume` must be the args the run started with.

`ZODCHI_FLOW_CUT=<step>` (for example `submit write` or `commit 1`) ends the process with exit code 75 right after
that effect and before its receipt is journaled, as a crash would. It exists for the recovery scenarios of the
end-to-end suite.

## Verification of the engine

`node scripts/e2e.mjs` runs the release `zodchi flow` against `scripts/e2e/fake-codex-flow.mjs`, which answers each
model turn by its step from a scripted file, on a throwaway fixture repository (a `clamp` stub, its test, a smoke
command and a REVIEW.md):

| Scenario | What a user would see |
|---|---|
| `flow-approve` | write, apply, the cheap check then verify on the export, one commit of the claimed file with `Verified: checks exit 0; args.verify exit 0`, a review carrying the base REVIEW.md, approval, the claim closed `done`; the skipped candidates with reasons; a resumed finished run runs nothing |
| `flow-close-round` | a review with an important finding, the close round, a second commit and a second review that sees the first, approval |
| `flow-round-exhaustion` | important findings in every review: `stop rule: 2 review rounds without approval`, the findings open, the claim `stopped` |
| `flow-outside-claim` | unsupported options and a pass rule in words refused before any claim or model call; a patch naming an unclaimed file refused whole, nothing applied, committed or reviewed |
| `flow-protected` | a patch editing an existing test: `protectedChanged`, stopped before review, the test unchanged |
| `flow-failing-verify` | the cheap check passes, verify exits 1: no commit, no review, `verifiedBy: "none"` with both exit codes |
| `flow-resume-cuts` | a cut right after the write submission and one right after the commit, each `--resume` going on: one model turn per step, one commit, one intent each |

## Known limits of version 1

- **No network or file system isolation for checks.** A check runs as the user, in a temporary export with a
  reduced environment, but it can reach the network and read whatever the user can read (the home folder with its
  credential stores included). Isolating the network is not available on every operating system the gateway runs
  on; run untrusted checks in a container or VM.
- The export holds the tracked files of the candidate tree only: what the checks need beyond them (dependencies,
  build caches) is installed by a check (`npm ci`, a build), every round anew.
- Codex executors only, through the local gateway; no Claude writer or reviewer, no company server client, no Codex
  skill or Claude Code wrapper yet. The JavaScript workflows are unchanged and keep their own runs.
- One writer turn per step: a package too large for one answer, or whose required context passes 512 KB, stops
  with `context too large at <step>` before anything is submitted.
- Blob ids in a patch are those of the bytes in the work tree (`git hash-object --no-filters`).
- A finished gateway job is kept seven days; a run resumed after that cannot poll a job it submitted and stops
  with an unknown outcome instead of asking again.
