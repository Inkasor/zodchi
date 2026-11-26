# zodchi flow

The same Rust engine and local journal serve Codex, Claude Code and any terminal. `zodchi flow list` shows the catalog.

In `code-package`, models propose changes and review them. The engine owns the claim, edits, process checks and commit.
Model steps can use Codex, a [Zodchi server](flow-server.md), or [Claude as an enabled executor](flow-claude.md).

## Three ways to start it

The same `zodchi flow code-package --args <file>` run starts three ways, and all three reach the same engine, journal
and result. An agent does the starting from a skill; the skill tells it how to write the brief (goal, files, done,
checks, verify and the `## Review boundary` section), how to write the args file, to run the command in the foreground
with the longest timeout its shell tool allows, to read `verdict`, `stoppedAt`, `next`, `openFindings` and
`verifiedBy` from the result, to resume a cut run with `--resume <run-id>` (the id is the newest journal folder of the
repository and label, a saved `result.json` included: a cut can come between it and the closing of the claim), and never to edit the journal, resubmit a step by hand, background the
run or switch branches during it.

| Way | Skill | Model steps |
|---|---|---|
| 1. From a Codex session (Codex first) | [`zodchi-flow`](../skills/zodchi-flow/SKILL.md) in the Zodchi plugin | the local gateway or the [company server](flow-server.md) configured in `flow.json` |
| 2. From a Codex session with Claude roles | the same skill | `"claude": true` in `flow.json` and a Claude candidate first for `expertWriter` ([flow-claude.md](flow-claude.md)) |
| 3. From a Claude Code session (Claude first) | the same skill in the Zodchi plugin | as in 1 or 2, by the person's `flow.json` and `models.json` |

The shared plugin supplies the same workflow catalog and skills to both clients.

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

The engine validates arguments before claiming files.

| Field | Meaning |
|---|---|
| `label`, `brief`, `repo`, `files` | as in `code-package`: the package name, its brief, the repository (the top of a Git work tree) and the files it may change, each by itself (a folder is refused) |
| `reviewContext` | Optional list of relative paths to committed UTF-8 source files the reviewer needs. Flow screens them and reads their copies from each candidate commit. The write claim is controlled by `files`. The context files together can use up to half the gateway prompt limit. |
| `setup` | commands to prepare each fresh writer workspace in agent mode. A nonempty list overrides project `setup` |
| `checks` | cheap checks, run in order after each write; a command string or `{ "cmd": ... }`. A command passes on exit code 0 and nothing else: a `pass` rule in words is refused |
| `verify` | the slow run of the real program, the same way, run only when every cheap check passed |
| `rounds` | review rounds at most, default 3 |
| `fixes` | how many times a failed check goes back to the writer, default 1 |
| `protect`, `allowCheckChanges` | more protected paths and the exact approved paths the package may change. For example, `"allowCheckChanges": ["tests/math.mjs"]` |
| `mode` | `expert` (default), or `agent` for a local Codex work role with a private workspace |
| `continuations` | extra writer turns for each agent writing step, default 2, range 0 to 32. Use `"continuations": 16` for a step expected to need many turns |
| `browser` | Agent mode opt-in. `{"executable":"/absolute/path/to/chromium"}` pins the browser for writer shells. Optional `variable` defaults to `ZODCHI_ACCEPTANCE_CHROMIUM`. See [Browser input for an agent writer](#browser-input-for-an-agent-writer). |
| `isolated` | `true` keeps writes, checks, and review on a private candidate. Apply the approved commit explicitly with `zodchi flow apply <run-id>` |
| `budget` | `{ "calls": N, "minutes": M }` limits new model submissions, including review and gateway retries. `minutes` is optional. In agent mode the budget replaces the per-step continuation limit |
| `sourceRun` | a finished isolated code package whose retained candidate seeds a correction on the same target branch and base. Declare every inherited changed path in `files` |
| `models` | role table entries for this run (`expertWriter` in expert mode, `writer` in agent mode, `reviewer` in either) |
| `extendClaim` | `true`: legacy preauthorization in expert mode. The default waits for an explicit scope decision before application |
| `checkTimeoutMin` | time limit in minutes of one setup or check command, default 60 |
| `tmp`, `commit: true` | accepted for compatibility; the journal replaces `tmp` |

Refused in version 1, each with its reason: `hard`, `branch` (check out the
branch first), `fixIgnore` (commit `.agent-tmp/` in `.gitignore` first), `closeShouldFix`, `rerun` (use
`--rerun`), `commit: false`. A repository with a verify skill (`.claude/skills/verify/SKILL.md`) and no
`args.verify` or committed project verification configuration is refused. Pass the skill's commands or declare
the plan in `.zodchi/verify.json`.

## Browser input for an agent writer

An agent-mode package may opt in with `"browser": {"executable": "/absolute/path/to/chromium"}`. The default
variable is `ZODCHI_ACCEPTANCE_CHROMIUM`. To use a project-specific name, set `"variable": "APP_TEST_CHROME"`.
The name must match `[A-Z_][A-Z0-9_]*` and have at most 128 characters. Names inherited by the reduced check
environment, such as `PATH` and `TEMP`, are reserved along with `ZODCHI_ACCEPTANCE_FRAMES`.

The engine pins the regular file's resolved path and SHA-256 in the run and checks it before new writer jobs,
including on resume. Only writer shells receive the configured variable. Keep the executable installed at the
same path and restore the same bytes if a resumed run reports a changed pin.

Project setup should install the project's Node and Playwright dependencies in the isolated writer workspace. Tests
must pass the configured variable as Playwright's `executablePath` and select `headless: true`. If the author's
sandbox cannot launch the browser, report the writer check as failed with the launch error and use the configured
candidate-acceptance check on the project's runner.

## Managing a run

`zodchi flow list` lists available workflows. Add `--detach` to start a worker and receive a run ID immediately.
`zodchi flow list --repo <directory>` applies the project's committed
`.zodchi/workflows.json`. The file uses an array such as `{"domains":["web-apps"]}`. Core workflows
are available in every project. Projects without the file can use any installed domain.
`zodchi flow status <run-id>` reads the same journal from any directory. A second client using `--resume` gets
the status of an active worker. An interrupted run can resume using the recorded inputs and steps.

Use `zodchi flow status <run-id> --handoff` to read the candidate, review verdict, full check receipts
and application state. It carries paths to the original evidence for targeted inspection.
An explicit Codex safety refusal that reaches Zodchi is recorded as `safetyBlock` with the step and job key.
The pinned request ends there. A desktop conversation can stop while a detached worker finishes. Check its
run ID and verified receipts before starting any new work.

A detached
start receipt is a submission, and the journal reports the verdict when the worker finishes.
If the Windows job hosting the caller prevents breakaway, the start receipt explains the refusal and keeps the
run ID for a foreground resume or for another terminal.

Use `zodchi flow remark <run-id> --file <text>` to record input for the next newly prepared model step. Flow
filters configured private words and recognizable credential patterns before writing the remark. A blocked
writer can leave a question and an open claim. Record the owner's answer with `zodchi flow reply <run-id> --file <text>`
and then resume. A plain resume while waiting reuses the recorded writer result.

Each new model job in Codex opens an ephemeral thread. In agent mode the writer works in a private export of
the candidate and uses local tools to read and edit the claimed files. The writer stays on its current step while
the scope and time limit permit. A `more` result hands the workspace and the writer's summary
to the next job. After a timed-out turn has stopped, the next job inspects the same workspace for saved edits.
A question or continuation limit leaves the run waiting. Flow compares the files with the original snapshot, applies changes via
the usual blob and scope checks, and performs verification before an independent review. Changes outside the claim
pause before application. The owner can ask the writer to continue in the same workspace within scope.
Adding paths requires a new package with those paths declared, or an explicit approval of the proposed paths for the same run:
`zodchi flow reply <run-id> --allow-files <file.json>`. The file is an array of the proposed relative paths.
On resume, Flow checks the added paths for conflicting claims and drift before applying the recorded result.
The agent writer requires the local gateway. Either chat client can start it.

The distribution's role table ships Terra 6.1 `xhigh` and Sol `high` for ordinary code packages. Existing
user-owned role tables keep their choices. A run's `models` override can request a one-off expert.

The committed `.zodchi/verify.json` can declare default `checks` and `verify` command lists. Explicit package
lists override those defaults. Flow pins the effective commands in the journal and keeps project verification
files protected. An optional `tools` list checks command availability on PATH before any model submission.
Check commands receive `LOG_DIR` for their artifacts and `ZODCHI_VERIFY_REPOSITORY` for locating declared inputs
in the source checkout. Run commands and write generated files in the exported candidate. The export has a
private parent folder for materializing fixtures or pinned sibling sources. An optional
`full: { "run": "local", "commands": [...] }` runs once on the reviewed candidate tree before the final result.
With `full: { "run": "ci" }`, the result records pending CI.

In agent mode, declare `setup` in the committed `.zodchi/verify.json` or run args. For a pnpm project, use
`"setup": ["CI=true corepack pnpm install --frozen-lockfile"]` and ignore `node_modules/` in Git. Flow pins this
list and runs it before the first writer turn in each private `write`, `fix` and `close` workspace. Continuations
and owner replies reuse the prepared workspace. Keep the install command in `checks` or `full.commands` as needed
for their separate exports.

The local engine runs setup with the same reduced environment and timeout as checks, with the host account's
network and filesystem access. Supply trusted commands that write generated files only to Git-ignored paths.
Every command's exit code and log are in the journal. A setup failure stops before the writer, leaves its claim
open and reports the failing command's log. After fixing the environment, retry the named step, for example
`zodchi flow code-package --resume <run-id> --rerun "setup write"`. The run retains its pinned commands.

### Check command environment

Flow runs `checks` and `verify` in Bash with the launching process's `PATH` and a limited set of environment
variables. The caller provides the interpreter and installs the project's dependencies. For Python, activate the
project virtual environment in the shell that starts or resumes Zodchi before using `python -m pytest`. You can
also invoke the interpreter by its quoted absolute path. In a `.venv` directory, it is typically `Scripts/python.exe`
on Windows and `bin/python` on Unix. Relative paths in the command resolve from the temporary candidate checkout.
Set any additional non-secret variables required by a check in the command itself.

### Applying a private candidate

Use `"isolated": true` to keep the target work tree, index and branch out of writing and review. The result
identifies the cumulative candidate commit and its tree. Rejected candidates and candidates with failed checks
stay available under service refs. An approval reports `application.status: pending` and keeps the exact SHA
that was reviewed. On the original branch and base, run `zodchi flow apply <run-id>`. It reserves the scope,
checks the target files and index, applies the recorded tree and advances the branch to that SHA. If HEAD or a
claimed file changed, inspect the conflict before retrying. After an interrupted application, use the same
`apply` command to reconcile the files, index and branch with their recorded states. `flow status` reports the
application receipt. Ordinary packages without `isolated` retain their original round-by-round commit behavior.

A correction with `sourceRun` keeps the original comparison base, starts from the retained commit, and gives
its new writer and independent reviewer the original brief and prior findings. A correction has its own run ID,
scope, verification and budget. Use `--resume` for a live, paused or interrupted run.

### Extending a package budget

`budget.calls` includes a reservation for every new gateway key. A restart can still poll a submitted key and
replay recorded answers after the budget is spent. `budget.minutes` measures wall time from the first reservation,
including waits. The time limit stops new submissions and lets a running job finish. When `flow status` reports
`reason: budget`, use `zodchi flow budget <run-id> --add-calls <n>` or `--add-minutes <n>`, then resume. A time
extension starts from the later of the previous deadline and now. Scope decisions and retries of unknown jobs
retain their separate commands. In budgeted packages, a repeated failure with the same diagnostic and unchanged
candidate tree ends the check repair loop early.

The result keeps the fields of the JavaScript workflow: `label`, `mode`, `models`, `rounds[]`, `write`, `verdict`,
`approved`, `openFindings`, `verifiedBy`, `verification` (`evidence[]` with `command`, `source`, `exitCode`, `log`),
`next`, `stoppedAt`, `refused`, `question`, `questions`, `conflicts`, `claimAdded`, `protectedChanged`. It adds
`runId`, `journal`, `base`, `skipped` (candidates passed over, with reasons), `outsideClaim` and `infra`.

## Branch review

`zodchi flow branch-review --args <file.json>` reviews the exact committed trees selected by `base` and the
current `HEAD` of `repo`, or the commit supplied in `head`. Give a `label` and list the authors as `provider/model` in `author`. An optional
absolute `brief` supplies the intended behavior. Use `context` to attach committed files around the diff.
`architecture: true` adds a separate architect. The engine selects independent models and records the
comparison, review material, and workflow version before the first review. Starting a worker and resuming the run
use the same flags as code-package. Review inputs come from those pinned files on each continuation.

For a fork with a remote named `upstream`, the review uses `.zodchi/allowed-words.txt` from the base commit for terminology in the diff and verification evidence. Set `"publicRepo": true` to apply public screening for a public review. Credential screening applies in both modes. Recognized environment variable lookups and HTTP header names in regular source can remain visible. The result and handoff report the number of affected diff lines in `screening.diffLinesWithheld` and list their file, diff line, reason and scope in `screening.withheld`. The reviewer can report missing evidence in `notVerified` and independently decides its verdict.

Set `exclude` to changed Git paths whose diff contents are too large to include, for example
`"exclude": ["tests/copy_restore_frozen.json"]`. The full commit range and file list stay pinned. The review material
and result record the omitted paths, their change type, and the before and after Git blobs and byte counts. Attach
verification for the omitted data on the exact candidate tree. Size refusals report the
largest contributions and the byte limit. A local review checks the gateway's Git ignore requirement before it starts.

For repeat review, give `sourceRun` and an explicit `head` in place of `base`. The source package supplies its
base, brief, claimed paths, writers and its previous verdict and findings. `author` can name additional authors
of the correction. Review refuses a candidate that contains paths outside the original package. An optional
`verificationRun` attaches recorded passing commands only if their checked tree matches `head`. The workflow
submits independent review jobs and records its verdict.

To follow up on a finished `branch-review`, keep the same repository, base and `sourceRun` if used, and set
`previousReview` to the most recent review's run ID. The reviewer receives earlier findings and open evidence gaps
with the revisions they refer to. Set `rounds` on the first review to cap the chain at 1, 2 or 3 rounds. The default
is 3. Each linked round reports `reviewRound` and `reviewLimit`.

To verify a committed candidate in `branch-review`, supply `checks` or `verify` as lists of trusted commands. Flow
runs them in a temporary Git checkout of `head`, with access to the complete candidate tree. The fast `checks`
must pass before `verify` starts. Commands use the same [check environment](#check-command-environment) as
`code-package`. A failed command stops the run before review. Successful commands attach the exact commit and
tree, exit codes and screened log excerpts to the review. Full logs stay in the run journal. Resume reuses
completed verification.

When the coordinator runs checks in their own checkout, set `verificationFile` to the absolute path of a UTF-8 JSON receipt.
Set `tree` to the value from `git rev-parse 'HEAD^{tree}'` for the checked commit. Optionally give its commit hash
in `head`. Include `commands` as an array of objects with `command`, `exitCode` of 0, and optional `output` text.
Run the commands against the candidate tree and record their actual exit codes. Flow checks the receipt against
the pinned tree and attaches it with `provenance: "coordinator"`. The result records its SHA-256. Choose
`verificationFile`, `verificationRun` or local commands for each review.

The Rust implementations of `branch-review` and `design-brief` can resume version 1 journals from
the original shared CLI. They verify the original definition digest and reuse the recorded steps.

Discover the catalog with `zodchi flow list` (or `list --repo <directory>` for enabled domains), `zodchi flow --help`, and `zodchi flow <workflow> --help`. These commands return JSON without starting a run.

## UI acceptance

Use `candidate-acceptance` for a local candidate, `release-acceptance` for a deployed web version and `player-acceptance` for a prepared Windows player. Browser acceptance requires an explicit `browser.executable`; candidate acceptance supports either managed fixture steps or committed Node tests. Both journal the approved scenario, real process receipts and captured frames. The browser supports headless and a private Windows desktop. Optional scenario selection and visual review use Terra 6.1 `medium` by default. See [UI acceptance](acceptance.md).

## Client packages

Follow the [installation guide](install.md) to set up the CLI and the plugin in both clients. Browser acceptance uses Node.js for its [Playwright driver](acceptance.md).

When upgrading a local development install, save its existing `bin/zodchi` (Windows `bin/zodchi.exe`) under another name after its active processes finish. Reuse the same Zodchi home for your project settings and journals. The installer preserves an existing launcher when its bytes differ from the new one.

Before a new Flow, the launcher checks the latest stable release of the installed major version. It verifies the GitHub digest, platform, archive and file hashes before activating the CLI and selected client plugins together. The previous release handles the request when an update fails. Existing runs use the executable pinned in their journal. The launcher retains installed releases for that purpose.

For contributors, use the [source build](install-from-source.md). `zodchi release build --out <new-directory> --archive` produces the same release format, and `zodchi release marketplace --out <new-directory>` builds just the client plugin. Run these commands with the binary built from the source being packaged.

## What it does

1. **Gate**, with no effect: the args, the brief, a Git work tree with a commit on a checked-out branch, `.agent-tmp/`
   ignored, no uncommitted change in a claimed file, the gateway roles `flow-patch` and `code-review` installed, the
   Codex subscription usable (`zodchi account`), and the writer/reviewer pair.
2. **Pair.** From `~/.zodchi/models.json`, the repository's `.zodchi/models.json` and `args.models` (a later table
   replaces a role of an earlier one): the first `expertWriter` candidate, in order, that has a `reviewer` candidate
   of another model; Claude candidates count only when Claude is enabled ([flow-claude.md](flow-claude.md)). The pair is pinned for the whole run and
   recorded with every candidate skipped and why. No pair: refused.
3. **Claim**, in `~/.zodchi/packages/<repository>/<label>.json`. The engine checks this claim under a lock before reserving the package's files.
4. **Write.** The writer is an expert gateway call (role `flow-patch`, no tools, no shell). Its prompt carries the
   brief, the rules (the checks named by source and number, `checks #1`, never by their command lines) and each
   claimed file with the blob id of its current content (a claimed path Git keeps as a link stops the run: its
   target is not shown); it answers with a structured
   patch: create, modify, delete or rename, each against the recorded blob. New runs pin writer patch schema 2.
   A localized `modify` supplies `edits: [{ "old": "...", "new": "..." }]` and `content: null`. The engine resolves
   each nonempty old fragment exactly once in the original text after matching its uniform line endings, and rejects overlaps.
   Use full `content` for complete replacements and new files. Existing runs retain their saved schema.
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
   before the checks with `protectedChanged`. A temporary Git repository outside the checkout gets an index and a
   local HEAD with that exact tree. It reads objects from the source repository and keeps its own index and refs. There
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
   brief, `REVIEW.md` of the base commit (never dropped), the previous review, and `verification.json`. That attachment
   maps each check to its command, exit code and a bounded log excerpt, and names the reviewed commit and matching
   checked tree. The engine removes private paths, private words and credential lines from the command and output
   before sending them. In agent mode, `writer-checks.json` carries up to twelve recent workspace checks that the
   writer reported in this round, screened before review. The review also receives the claimed regular files as
   the reviewed commit holds them (never a link).
   These copies are dropped first, the largest first, when the request would pass the gateway's 512 KB, and named in a "Not attached
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
  `reviews/`, `logs/` (one log per setup or check command), `result.json` once the run has finished. An agent
  `writer prepared` event records the workspace and its successful `setup.evidence`, when configured. The writer's
  own `checks` are in its model receipt.
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
- writer setup without a `writer prepared` or failure receipt stops any recorded commands still running and retries
  in a fresh export. A prepared workspace is reused. A recorded failure waits for `--rerun "setup <step>"`.
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
| `flow-review-check-records` | Git checks see the exact candidate tree and index while the neighboring staged change stays in the checkout. The review receives commands, exit codes and sanitized output bound to the published commit's tree |
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
| `flow-claim-close-error` | resume reports a claim error and returns the saved verdict only after closure succeeds, with no new model turn |
| `flow-staged-after-commit` | a cut right after the commit, then the parent's version staged by hand: resume records the commit, leaves that staging alone and names it in `indexLeft` |
| `flow-index-rollback` | a failed ref update after the index was prepared restores only the index paths changed by the engine |
| `flow-index-reconcile-worktree` | resume restores the prepared index before deciding that the checked tree has changed |
| `flow-edits-approve`, `flow-edits-refused` | exact substitutions preserve line endings and resume by recorded blobs. Missing, ambiguous, overlapping, stale and protected changes stop before any file is written |
| `flow-private-checks` | commands with private text are redacted in the review evidence. The fixing writer gets the failed check's log with `<tmp>` for the export folder and a credential line left out |

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
- One expert writer turn per step. Required context over 512 KB stops
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
run, as written, by bash with its placeholders filled, from files in a folder whose name has a space in it. A real run with real Codex and Claude sessions belongs to the before-release run, not
to CI.

| Scenario | What a user would see |
|---|---|
| `flow-entry-skills` | the two skills share one body; exactly the run, resume and rerun commands; a brief template with the review boundary; an args example the engine takes; nothing that backgrounds a run, edits the journal, resubmits or switches branches; no real host |
| `flow-entry-install` | the installer puts the Codex skill in `$CODEX_HOME/skills` (else `~/.codex/skills`) and the Claude Code skill in the plugin it installs; it leaves a file it did not write or you changed, `--force` replaces it, `--no-codex-skill` skips it (on `--uninstall` too, whatever `$CODEX_HOME` is by then), `--uninstall` removes both |
| `flow-entry-local` | the Codex skill's steps on the local gateway: brief, args, run from another folder, result read, finished run resumed, a refusal read |
| `flow-entry-cut` | the Claude Code skill's steps with the run cut after the write submission, and with the `result` cut after the result is saved: the run id found as the skill says, resumed, one model turn per step, no second run, the claim closed without a model call |
| `flow-entry-failing-verify` | the Codex skill's steps with a verify command that fails: `verifiedBy` is `none` while `verification.evidence` holds the command's exit code, as the skill says to tell it from a run in which nothing ran |
| `flow-entry-server` | the Codex skill's steps with the model steps on a zodchi-server; nothing runs on this machine's Codex, the token is in no result or commit |
| `flow-entry-claude` | the Codex skill's steps with a Claude writer (the fake `claude`): a failed write stops the run, the skill's rerun of the step named in `stoppedAt` goes on to approval |
