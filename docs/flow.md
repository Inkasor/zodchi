# zodchi flow

**Experimental (version 1).** Opt-in; the Claude Code workflows stay the default. Open review points are listed at
the end of this page.

`zodchi flow code-package` runs the `code-package` workflow as code inside the gateway, without Claude Code: the same
gate, claim, write, cheap checks, verify, commit, review, close and stop rules as the JavaScript workflow
(`core/workflows/code-package.js`), decided by a state machine in Rust (`gateway/crates/zodchi-flow`). Models only
propose a patch or judge a change; every transition is the engine's. This is version 1: Codex executors only,
through the local gateway.

## Three ways to start it

The same `zodchi flow code-package --args <file>` run starts three ways, and all three reach the same engine, journal
and result. An agent does the starting from a skill; the skill tells it how to write the brief (goal, files, done,
checks, verify and the `## Review boundary` section), how to write the args file, to run the command in the foreground
with the longest timeout its shell tool allows, to read `verdict`, `stoppedAt`, `next`, `openFindings` and
`verifiedBy` from the result, to resume a cut run with `--resume <run-id>` (the id is the newest journal folder of the
repository and label with no `result.json`), and never to edit the journal, resubmit a step by hand, background the
run or switch branches during it.

| Way | Skill | Model steps |
|---|---|---|
| 1. From a Codex session (Codex first) | `codex/skills/zodchi-flow/SKILL.md`, installed by `install/install.mjs` into `$CODEX_HOME/skills` (else `~/.codex/skills`) | the local gateway, or for a colleague the company server named in `flow.json` (`server`, `tokenFile`; [flow-server.md](flow-server.md)) |
| 2. From a Codex session with Claude roles | the same skill | `"claude": true` in `flow.json` and a Claude candidate first for `expertWriter` ([flow-claude.md](flow-claude.md)) |
| 3. From a Claude Code session (Claude first) | `core/skills/zodchi-flow/SKILL.md`, in the `zodchi-core` plugin | as in 1 or 2, by the person's `flow.json` and `models.json` |

The two skills share one body (`scripts/check.mjs` fails when they differ); only their descriptions differ. The existing
Claude Code workflows (`/zodchi-core:code-package`) are unchanged and stay the default.

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
| `label`, `brief`, `repo`, `files` | as in `code-package`: the package name, its brief, the repository (the top of a Git work tree) and the files it may change, each by itself (a folder is refused) |
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
   brief, the rules (the checks named by source and number, `checks #1`, never by their command lines) and each
   claimed file with the blob id of its current content (a claimed path Git keeps as a link stops the run: its
   target is not shown); it answers with a structured
   patch by `flows/code-package/v1/patch.schema.json`: create, modify (whole new content), delete or rename, each
   with the blob id it was written against.
5. **Apply.** The engine checks the patch whole before writing a byte: plain relative paths (no `..`, no absolute
   path, nothing under `.git/` or `.agent-tmp/`), no link on the way, every path claimed (else refused, or the claim
   extended with `extendClaim`), no existing protected check changed (`test/`, `tests/`, `e2e/`,
   `.claude/skills/verify/`, `REVIEW.md`, `args.protect`, as of the base commit; else the package stops before review
   with `protectedChanged`), and every blob id equal to the file now (else `stale patch`). Then it writes the files;
   a modified file keeps its exact permission bits, a renamed one takes its source's (on Unix saved in the plan and
   compared on recovery; Git's executable bit follows either way). Before
   it writes, the branch of the run must be checked out and the claim still this run's open claim.
6. **Checks.** The candidate tree (the last commit with the claimed paths from the work tree) is written as a Git
   tree (refused if it differs from the last commit anywhere but at the claimed files) and compared with the base:
   an existing protected check changed, deleted or with another mode, by the patch or by anybody, stops the package
   before the checks with `protectedChanged`. The tree is exported to a temporary folder outside the checkout. There
   the cheap checks run with bash, in order, each to its end, then the verify commands when they all passed; each
   with its real exit code and its log in the journal. A command starts only after its pid and start time are in
   the journal (bash waits for the engine's word on stdin), and its end is journaled too. The environment is cut down to what programs need to start (paths, home, temporary folder, locale):
   tokens and keys in the caller's environment do not reach a check. A failure goes back to the writer with the
   end of its log, up to `args.fixes` times: the command by source and number, the temporary folder, the journal,
   the repository and the home folder replaced by `<tmp>`, `<journal>`, `<repo>` and `~`, and every line that may
   hold a credential (password, token, key, secret, cookie, a URL with a user) left out; the raw logs stay in the
   journal.
7. **Commit**, by the engine only: after rechecking that the branch is where the run left it, that the claim is
   still open with every file, and that the work tree still gives the checked tree, the checked tree is committed
   on the branch (`git commit-tree`, then `git update-ref` from the expected parent), so the commit holds the claimed
   paths only. Its message is `<label>: round N` and `Verified: <source> exit <codes>; ...`, sources and exit codes
   only. The index entries of the claimed files follow the commit before the branch moves (staged work in them that
   is neither the parent's nor the commit's stops the run first). Nothing is pushed.
8. **Review**, an expert gateway call (role `code-review`, the reviewer of the pair) with the diff from the base, the
   brief, `REVIEW.md` of the base commit (never dropped), the previous review, the checks by source and number with
   their exit codes, and the claimed regular files as the reviewed commit holds them (never a link), which are
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
  the validated answer or the Git receipt; a `made` line with the commit id between `git commit-tree` and moving
  the branch; a `check started` line with the pid and start time of each check command and a `check ended` line
  when it ended or was stopped; `stop`, `rerun`, `closing` (the result is saved and the claim is about to be
  closed) and `finished` lines. A record cut in the middle of its write can only be the last one: a resume drops it from the
  file (under the lock) before it writes; a record that does not read anywhere else stops the resume.
- `requests/` (the exact request of each gateway job), `plans/` (each applied patch with its blobs before and after,
  written and synced before its intent),
  `reviews/`, `logs/` (one log per check command), `result.json` once the run has finished.
- `lock/`: the process working on the run (pid and start time). One at a time; a lock whose process is gone is taken
  over.

## Recovery

`zodchi flow code-package --resume <run-id>` runs the machine again from the start, in the repository the run pinned
(whatever folder it is started from), with the saved brief and base REVIEW.md (a run that had one stops without
it). Each step comes back from the journal when it has a `done`; otherwise:

- a model call with an `intent` is never submitted again: the job of its stored key is looked up and waited for, so
  a cut after a submission never asks the model twice. A key without its job folder is an unknown outcome: a
  cleaned or swept folder looks the same as a job never submitted. A job that failed before its model turn started
  is asked again under the next key (`-r2`, `-r3`, at most two); any other end of a job is not asked again by
  itself. A writer turn with an `intent` or a `done` is replayed before any claimed file is read.
- an apply with an `intent` reads its saved plan (missing, damaged or not matching the intent's digest: an unknown
  outcome), checks the branch and the claim, and compares every file with the blobs before and after: all after, it
  is done; each before or after, applying again finishes it; a link on the way or anything else is an unknown
  outcome.
- a commit with an `intent` compares the branch tip with the expected parent: the tip is the parent, the commit is
  made; the tip is the exact commit of the `made` line, it is taken as the receipt; anything else (a commit of the
  same tree made by hand included) is an unknown outcome. Taking the receipt checks that the claim, with every path
  it was extended by, is still this run's, and never touches the index: its entries followed the commit before the
  branch moved, so an entry that differs from the commit now is somebody's staging, left as it is and named in the
  receipt's `indexLeft`.
- checks without a `done` (a rerun included) first stop every check command of the run that has a `check started`
  and no `check ended` line, whatever step or attempt started it (by pid and start time; on Unix the whole process
  group), then run again (they change nothing but their export). One that cannot be stopped, or a start or end the
  journal cannot record, stops the run.
- a run with a saved `result.json` returns it; when the cut came after the `closing` line, the claim of this run is
  closed as the result says first.

What neither the journal, Git nor the gateway can settle (a job that ended `unknown`, a file changed by somebody
else in the middle of an apply, a branch that moved during a commit, a submitted job whose folder is gone) stops the
run with `stoppedAt: "unknown outcome at <step>"`, keeps the claim open and is never retried silently. An
infrastructure failure (the gateway refused, a job failed after its turn started, an answer outside the schema)
stops with `infrastructure at <step>`, `gateway <status> at <step>` or `invalid answer at <step>`, the claim open.
After looking, `--resume <run-id> --rerun "<step>"` runs that step again under a new key (`-a2`, ...); `--rerun`
must name the step the run stopped at. A finished run resumed returns its result and runs nothing. `--args` with
`--resume` must be the args the run started with.

`ZODCHI_FLOW_CUT=<step>` (for example `submit write`, `commit 1`, or `result` between the saved result and the
closing of the claim) ends the process with exit code 75 right after that effect and before its receipt is
journaled, as a crash would. It exists for the recovery scenarios of the end-to-end suite.

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
| `flow-protected-worktree` | a claimed test edited in the work tree while the run is cut: `protected checks changed at checks 1`, no check run, nothing committed |
| `flow-cleaned-job` | a cut after the write submission, then the job folder removed: `unknown outcome at write`, the model asked once, the claim open |
| `flow-no-review-md` | a base with neither REVIEW.md nor a verify skill passes the gate and runs to approval; the review judges by the brief |
| `flow-cut-result` | a cut after the result is saved and before the claim is closed: resume returns the approval and closes the claim `done`, nothing runs again |
| `flow-staged-after-commit` | a cut right after the commit, then the parent's version staged by hand: resume records the commit, leaves that staging alone and names it in `indexLeft` |
| `flow-private-checks` | no check command line reaches a model; the fixing writer gets the failed check's log with `<tmp>` for the export folder and a credential line left out |

## Known limits of version 1

- **No network or file system isolation for checks.** A check runs as the user, in a temporary export with a
  reduced environment, but it can reach the network and read whatever the user can read (the home folder with its
  credential stores included). Isolating the network is not available on every operating system the gateway runs
  on; run untrusted checks in a container or VM.
- The export holds the tracked files of the candidate tree only: what the checks need beyond them (dependencies,
  build caches) is installed by a check (`npm ci`, a build), every round anew.
- Codex executors through the local gateway in this page's runs; a company server and Claude roles are in
  [flow-server.md](flow-server.md) and [flow-claude.md](flow-claude.md). The skills of the three ways above are
  instructions for an agent, not part of the engine: an agent that ignores them is not stopped by them. The JavaScript
  workflows are unchanged and keep their own runs.
- One writer turn per step: a package too large for one answer, or whose required context passes 512 KB, stops
  with `context too large at <step>` before anything is submitted.
- Blob ids in a patch are those of the bytes in the work tree (`git hash-object --no-filters`).
- A finished gateway job is kept seven days; a run resumed after that cannot poll a job it submitted and stops
  with an unknown outcome instead of asking again.
- On Windows a check command that an interrupted run left behind is stopped with what it started only while it
  still runs itself; processes it started that outlived it are not found. On Unix what a check leaves in its
  process group is ended when the check ends.
- What a fixing writer sees of a failed check is cleaned of the known private folders and of lines with credential
  words, not of every possible secret: a check that prints a private value without such a word passes it on.

## Open review points (version 1)

- F17 (important), src/code_package.rs: The pre-publication index check accepts an entry that already matches the candidate commit, but if update-ref fails, the rollback resets every affected entry to the parent without recording its original state.
- F18 (important), src/code_package.rs: The saved-result path discards errors from claims::close and returns the saved result as though closing succeeded.
- F9 (important), src/git.rs: The writer view and optional reviewer copies now exclude tracked links, but candidate_tree can still stage a claimed regular file that was replaced by a symlink after the writer request.
- F10 (important), src/patch.rs: Fresh writes use the exact saved destination mode, but the plan does not record before modes.
- F12 (important), src/checks.rs: The stdin gate prevents an unrecorded launch, but it still opens if process_start returns no identity.
- F19 (important), src/journal.rs: After a partial append fails, halt_infra tries to append a stop record to the same file.
- F16 (important), src/code_package.rs: Direct command strings are gone from the prompt templates, but the engine truncates raw logs before sanitizing them and forwards whatever the marker list does not recognize.
- F20 (important), src/checks.rs: Failure to create a log or launch bash returns a null exit code as an ordinary check failure rather than an infrastructure stop.
- F13 (nit), src/code_package.rs: The release CLI still honors inherited ZODCHI_FLOW_CUT, now including the result boundary.

## Model steps through a server

See [flow-server.md](flow-server.md).

## Claude as an executor

See [flow-claude.md](flow-claude.md).

## The entry points

`node scripts/e2e.mjs` runs `scripts/e2e/scenarios/flow-entry.mjs`, which follows the skills as written: the brief is made
from the skill's own template, the args file from its own JSON example, and each command line of its `sh` blocks is
run with its placeholders filled. A real run with real Codex and Claude sessions belongs to the before-release run, not
to CI.

| Scenario | What a user would see |
|---|---|
| `flow-entry-skills` | the two skills share one body; exactly the run, resume and rerun commands; a brief template with the review boundary; an args example the engine takes; nothing that backgrounds a run, edits the journal, resubmits or switches branches; no real host |
| `flow-entry-install` | the installer puts the Codex skill in `$CODEX_HOME/skills` (else `~/.codex/skills`) and the Claude Code skill in the plugin it installs; it leaves a file it did not write or you changed, `--force` replaces it, `--no-codex-skill` skips it, `--uninstall` removes both |
| `flow-entry-local` | the Codex skill's steps on the local gateway: brief, args, run from another folder, result read, finished run resumed, a refusal read |
| `flow-entry-cut` | the Claude Code skill's steps with the run cut after the write submission: the run id found as the skill says, resumed, one model turn per step, no second run |
| `flow-entry-server` | the Codex skill's steps with the model steps on a zodchi-server; nothing runs on this machine's Codex, the token is in no result or commit |
| `flow-entry-claude` | the Codex skill's steps with a Claude writer (the fake `claude`): a failed write stops the run, the skill's rerun of the step named in `stoppedAt` goes on to approval |
