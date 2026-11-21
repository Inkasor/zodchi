# Verification

How `code-package` decides that a change works, and how a repository tells it
what matters. Running the real thing matters more than tests, one reviewer
with a written focus beats stacked reviewers, and a change must not edit the
checks that judge it.

## What the workflow does

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

When a sandbox restriction is the sole reason a Codex writer's check failed,
the writer records the command, exit code and observed error. An otherwise
completed criterion can stay `done`. The workflow keeps
`sandbox: <command>: <error>` in `write.unverified`. The checks step runs
outside the writer sandbox and supplies the verification evidence.

1. **Cheap checks first, then the slow run.** After each write the runner
   runs `args.checks` (build, lint, fast tests), then the slow run of the
   real program: the commands in `args.verify`, else the repository's skill
   `.claude/skills/verify/SKILL.md`. A failure caused by the code goes back
   to the writer. The runner reports each command, its exit code and the path
   of its log or trace (`verification.evidence`).
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

zodchi is checked by running it as its users do; there are no unit tests and no mock runs of workflows. Pull
requests run, in `.github/workflows/ci.yml` on Windows, macOS and Linux:

1. `node scripts/check.mjs`: the static publish guard (workflows parse, agents, JSON, roles, no private paths or
   secrets). Not a test.
2. `cargo build --release --locked`, then `node scripts/e2e.mjs --no-build`: the end-to-end suite of the gateway. It
   runs the release `zodchi` and `zodchi-server` against `scripts/e2e/fake-codex.mjs` (no model, no network beyond
   127.0.0.1, nothing spent), one trace per scenario, kept as a CI artifact. Locally: `npm run e2e`, or the
   repository's verify skill (`.claude/skills/verify/SKILL.md`), which calls the same command.
3. The installer round trip in a scratch home.

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

### The scenarios of `scripts/e2e.mjs`

| Scenario | What a user would see |
|---|---|
| `cli-keyed-job` | submit, wait, job under a key; the same request from a fresh client is the same job and one execution; another request (prompt or effort) on the key is refused and runs nothing; schema answers, attachments, a failed turn, bad keys, a repository that does not ignore `.agent-tmp/`, no repository, `--root` |
| `cli-image-job` | an image job: the input image is stored, the PNG comes out with `--out`; a file that is not an image is refused and the key stays free |
| `cli-dead-worker` | a worker killed after its turn entered: four readers at once all settle it as `unknown` with the same end, Codex stopped, never rerun; a worker killed in the queue: `failed`, nothing asked |
| `cli-three-jobs` | three jobs at once in one repository: two enter Codex, the third waits queued until a place is free; each ends with its own result, each ran once |
| `cli-commands` | `help`, an unknown command, `roles` of this repository (all load, at least ten), `account` (masked e-mail), `check` (no turn), `auth_required` without a sign-in |
| `cli-worker-outlives-job-object` | Windows: the submitting shell sits in a job object that kills its processes on close; the worker breaks away and finishes the job |
| `cli-job-object-without-breakaway` | Windows: a job object that forbids breakaway does not make the submit fail; the worker starts inside it and runs the turn; when the job object closes, the worker and its Codex die with it and a look-up settles the job as `unknown`. It never skips: it reads no outer job object, and a shell that cannot make its own fails it |
| `server-auth` | no token, a wrong token, another scheme: 401; the bearer in any case; roles offered; one server per data folder; `server.json` holds the SHA-256 of each token in `tokenHashes` and no token; a new token or a removed user takes effect at once; a broken registry (or a bad id in it) lets nobody in, without paths; after a crash a new server takes the folder |
| `server-admin` | eight `user add` at once lose nobody; ids from names |
| `server-isolation` | A's job, its idempotent repeat (fields in any order), 409 for another request; B asks for A's key on every route: 404 with nothing of A's job; each job on its own user's Codex home; no token: 401, nothing stored |
| `server-results` | text, JSON, image manifest and bytes, 404 beyond them, 422 for a failed job without its stored text; a stored manifest that names other files of the job folder (`request.json`, `job.json`, a path with `..`) at valid indexes: 404 `not_found` without their contents; every refusal of the server (work, decisions, paid, resume, inline role, role file, missing role, images, unknown field) stores nothing; a body over 32 MB, by its announced length (refused before it is read) and as a chunked body of a valid job padded past 32 MB (refused, no job made), each a 400 `bad_request` naming the limit, with a deadline and a failure on a cut-off answer; the exact prompt limit; a changed or removed role on a retry; `auth_required` |
| `server-admission` | per-user and server limits: 429 with fixed text, key left free, counts only in the log; a repeat never refused; `not_final`; unreadable records count as unfinished; an unlistable folder refuses with 500 without paths |
| `server-diagnostics` | stored errors of every final status become public codes; nothing of a stored error of a running job; `resetsAt` only as a number; roles that cannot load; Codex failing with a path; unknown routes and methods |
| `server-sign-in` | device code with the completion after and before the answer; one open sign-in per user; cancel; sign-out of that user only; the caller's own account |
| `server-threads` | `--threads 1` and `0` refused; with two, `/health` answers while a long poll waits: the poll is shown admitted first (a probe poll is answered at once because the one poll place is taken) and still waiting after every `/health` |
| `server-stop` | POSIX: SIGTERM while the fake holds a sign-in start; once the server says it is stopping, the start is released: the request is answered, the sign-in cancelled with its loginId, its app-server gone, the lock free; finished workers are reaped |
| `flow-approve`, `flow-close-round`, `flow-round-exhaustion`, `flow-outside-claim`, `flow-protected`, `flow-failing-verify`, `flow-resume-cuts` | `zodchi flow code-package` on a throwaway fixture repository against `scripts/e2e/fake-codex-flow.mjs`, which answers each model turn by its step: approval with a `Verified:` stamp, a close round, round exhaustion, a patch outside the claim refused, a patch editing an existing test stopped before review, a failing verify, cuts after a submission and after a commit resumed with no duplicate effect; see [flow.md](flow.md) |
| `workflow-gate-helper-facts`, `workflow-gate-helper-claims`, `workflow-gate-helper-bootstrap`, `workflow-gate-helper-ledger-and-errors` | the gate helper `core/scripts/gate.mjs` run for real on throwaway repositories and a throwaway home: one line of JSON with the Git state, the dirty list, the ignore rule, the role table, the config and the Review boundary; the stale claim of a finished package closed and nothing else (a dirty one, one with commits off the default branch, one written to recently, a stray `.bak` stay; no backup is made); found in the copy the registration names and never in a checkout; the ledger of `asset-round`; a bad call exits 2 |
| `workflow-gate-code-package-decides-from-the-line`, `workflow-gate-code-package-claims-and-choice`, `workflow-gate-unknown-keeps-its-key`, `workflow-gate-other-workflows`, `workflow-gate-names-the-copy`, `workflow-gate-one-bootstrap` | the workflows run as Claude Code runs them, on scripted answers: they decide from the helper's line and exit code (a missing, stale or silent helper stops them first), read claims as `<label>.json` only, hand each role's effort to its Claude step, stop on a job that ended `unknown` with its key and never submit it again, and name the plugin copy; the eight bootstraps are the same text |
| `fixes-claim-reopened-after-stop`, `fixes-resumed-run-reopens-claim`, `fixes-gateway-keys-per-run`, `fixes-workflow-equals-its-copy`, `fixes-continuation-reviews-whole-package`, `fixes-writer-logs-under-tmp`, `fixes-resume-stopped-at-claim-base`, `fixes-continuation-needs-path-list`, `fixes-mismatched-run-closes-no-claim` | the fixes of 2026-11-20: the gate helper run for real on a scratch home and Git repository (a claim closed `stopped` is opened again by `claim-more` and `claim` and keeps its base, never over another open claim's files; a claim closed `done` or of another tmp folder is a new one; `claim-base`; the build stamp of the copy's `code-package.js`, line-end independent, and the check that the stamp in the file is current), and the workflow on scripted answers (a resumed run whose claim step comes from the journal goes on over the real helper; the gateway keys `<label>-<base7>-<run>-<kind>-<n>` differ for two runs (even at one base and HEAD), equal for a resume; a script that is not its copy's is refused at the gate with both builds; a continuation reviews `base..HEAD` of the recorded base with the files of every round (a rename lists both paths) and stops, leaving the claim's base, when that base left the branch; the writer is told logs go under the tmp folder; `claim-base` opens a claim closed `stopped` as `claim-more` does, so a run stopped at `claim-base` resumes; a continuation whose base step returns no `paths` array stops before the writer while `[]` is valid; a run refused as mismatched closes no other package's claim) |
| `install-plugins-first`, `install-plugins-refresh`, `install-plugins-local`, `install-plugins-reinstall-fails`, `install-plugins-stale-cache`, `install-plugins-stale-other-workflow`, `install-plugins-uninstall` | the installer run from a scratch clone against `scripts/e2e/fake-claude-plugin.mjs`, which keeps Claude Code's plugin cache by name and version (an `update` at the same version is a no-op): a first install fills the cache from the copy of the commit and ends with the note that open sessions keep their plugins; a second install after a new commit refreshes the cache (zodchi-core and a domain, user or local scope) by uninstall and install, never `update`, although the version is unchanged; a failed reinstall says the plugin is now not installed and gives the command; a cache that still differs from the copy is an error naming both files, and every workflow of the plugin is compared, not one probe file (a changed, new or removed workflow beside an identical `code-package.js` fails too); `--uninstall` removes the plugins, their cache and the copies and leaves another marketplace's plugin alone |

### Inventory of the tests this replaced, and where each behaviour went

Removed with this change: `gateway/crates/*/tests/`, the `#[cfg(test)]` modules of `gateway/crates/*/src/` (with the
test-only fail points of `job::submit`), `core/workflows/fixtures/` and the CI steps `cargo test` and "the gateway
lists the roles of this repository". "Dropped" means no scenario checks it any more; the reason follows.

Gateway, `zodchi-server/tests/server.rs`:
- `refuses_without_a_token_and_with_a_wrong_one`: 401 without or with a wrong token, `/health` open, only expert text and image roles offered, one server per data folder. -> `server-auth`.
- `two_users_have_their_own_jobs_and_their_own_codex_home`: idempotent repeat, 409, B gets 404 for A's key, each job on its own Codex home. -> `server-isolation`.
- `refuses_work_paid_inline_roles_and_too_many_images`: the 400 refusals store nothing. -> `server-results`.
- `stores_token_hashes_and_revokes_without_a_restart`: the SHA-256 of the token stored and the token not, token renewal and user removal without a restart, a removed user's folder stays, a broken registry is 500 without paths. -> `server-auth`.
- `admin_commands_racing_lose_no_user`: eight concurrent adds. -> `server-admin`.
- `admission_refuses_over_the_limit_and_leaves_the_key_free`: 429, key free, repeat not refused, 409 for an unfinished result. -> `server-admission`.
- `busy_answers_show_no_counts_and_no_limits`: fixed 429 texts, counts in the log. -> `server-admission`.
- `the_composed_prompt_limit_is_exact`: 512 KB at the limit, one over, trailing whitespace. -> `server-results`.
- `admission_counts_fail_closed`: an unreadable record counts, an unlistable folder is 500. -> `server-admission`.
- `finished_workers_are_reaped` (Unix): no zombie worker. -> `server-stop` (POSIX).
- `a_changed_role_does_not_turn_a_retry_into_a_conflict`: a retry after the role changed or went. -> `server-results`.
- `every_kind_of_result`: text, JSON, image manifest and bytes, 422 without the stored error. -> `server-results`.
- `a_worker_without_a_sign_in_reports_auth_required`. -> `server-results`, and for the CLI `cli-commands`.
- `device_code_sign_in`: late and early completion, one open sign-in, DELETE, sign-out per user. -> `server-sign-in`.
- `the_account_of_the_caller_only`. -> `server-sign-in`.
- `a_body_over_32_mb_is_refused`: the body limit while the bytes are read -> `server-results` (over HTTP, a chunked body with no announced length; the announced length too); `/health` needs nobody -> `server-auth`. Dropped: an identity outside `[a-z0-9-]` from a fork's `Authenticator` is refused (it needs a fork's authenticator in process; the default one only yields ids the registry made, and a bad id in the registry is covered by `server-auth`).
- `no_raw_diagnostic_reaches_a_client`. -> `server-diagnostics`.
- `one_http_thread_is_refused_and_two_leave_one_free`. -> `server-threads`.

Gateway, `zodchi-server/tests/login.rs` and `shutdown.rs`:
- `shutdown_waits_for_a_completed_attempt_to_stop`: shutdown returns only after a sign-in app-server that is stopping has exited. -> partly `server-stop` (after SIGTERM the sign-in's app-server is gone). Dropped: the exact race (a completion stopping the app-server at the moment of shutdown, with a 1.5 s exit) is a timing inside the server that no client can line up reliably.
- `an_expired_attempt_is_stopped_before_it_is_replaced`. Dropped: a device code expires after 15 minutes and the expiry can be shortened only in process; no one-minute suite reaches it.
- `shutdown_cancels_a_sign_in_whose_start_is_still_running`: the request in flight is answered, the attempt cancelled with its loginId, the lock free after. -> `server-stop` (POSIX). On Windows the server is stopped by Ctrl+C, which the suite cannot send; not checked there.

Gateway, `zodchi-core/tests/atomic.rs`:
- `concurrent_writes_of_one_file_stay_whole`. Dropped as an internal detail (`write_json_atomic`); what a user reads is whole in every scenario (each look-up parses the job as JSON), including four readers at once in `cli-dead-worker`.
- `settling_one_dead_job_from_many_threads_keeps_job_json_whole`: every settler gets the same end. -> `cli-dead-worker` (four processes at once).
- `a_tenant_is_only_its_own_folder`: a user's jobs and Codex home are their own. -> `server-isolation`. Dropped: refusing ids outside `[a-z0-9-]{1,40}` when the Config is built (internal; see the fork authenticator above).

Gateway, `zodchi-core/tests/breakaway.rs`:
- `stand_in`: the helper program of the other two, not a test.
- `the_worker_outlives_the_job_object_of_its_submitter` (Windows). -> `cli-worker-outlives-job-object`.
- `a_job_object_without_breakaway_still_gets_a_worker` (Windows): the fallback start. -> `cli-job-object-without-breakaway` (the submit succeeds, the worker runs inside the job object and dies when it closes).
- `worker_flags_ask_for_breakaway_and_the_fallback_drops_only_that`. Dropped: compile-time constants; their behaviour is the two scenarios above.

Gateway, `#[cfg(test)]` modules:
- `job.rs` `a_failed_submit_leaves_no_half_made_job`: a write that fails in the middle of a submit leaves no folder, the key stays free. Dropped: it needs a disk write that fails between two writes, which only the removed fail-point hook could make. The refusals before the folder is made leave the key free in `cli-image-job`, `server-results` and `server-admission`.
- `api.rs` `the_fingerprint_is_the_client_request`: field order and a default `credits` do not change the request, `effort` does. -> `server-isolation`.
- `api.rs` `refused_requests`. -> `server-results`.
- `api.rs` `output_files_stay_in_the_job_folder`. -> `server-results`: the stored manifest of a finished image job is given entries naming `request.json`, `job.json`, `codex-stderr.log` and `out-0.png/../request.json`, asked for by valid indexes; each is 404 `not_found` without the file's contents.
- `auth.rs` `bearer_is_read_in_any_case`. -> `server-auth`. Dropped: that the comparison takes constant time (not observable from outside).
- `lock.rs` `simultaneous_contenders_on_a_stale_lock_file`: exactly one of eight contenders takes a stale lock. -> `server-auth` (a second server is refused; after a crash the folder is free). Dropped: eight servers started at the same moment (a race of copies of one tool started together; see REVIEW.md).
- `public.rs` `a_failed_job_shows_a_code_and_a_fixed_message`. -> `server-diagnostics`.
- `public.rs` `every_final_status_has_its_code`, with no error for a job that is not final or succeeded. -> `server-diagnostics`, `server-isolation`.
- `public.rs` `resets_at_is_a_number_or_nothing`. -> `server-diagnostics`.
- `public.rs` `an_error_value_carries_only_what_it_is_given`. -> `server-diagnostics` (an error has code, message and field only).
- `registry.rs` `slug_keeps_letters_and_digits`. -> `server-auth`, `server-admin`.
- `registry.rs` `a_broken_registry_is_refused`. -> `server-auth`.

CI: "the gateway lists the roles of this repository" (`zodchi help`, `zodchi roles`, at least ten, none with an error). -> `cli-commands`.

Workflows, the old `core/workflows/fixtures/code-package/mock.mjs` (the workflow with fake agents; deleted in the
e2e move, its live parts are in `scripts/e2e/scenarios/code-package.mjs`):
- `verify-passes`: the cheap check before verify, both in the evidence, the stamp `Verified: checks exit 0; args.verify exit 0`, a new test file allowed, the writer and runner told the check rules. -> the release run (verdict, `verifiedBy`, the stamp of the tip, evidence order with logs, and the new test `test/clamp.test.mjs` the brief requires, committed and not refused). Dropped: the wording of the rules in the prompts.
- `nothing-to-run`: `verifiedBy` none, said in the result, the commit and the review. Dropped until the release run gets a second package.
- `stamp-no-commands`: no command string in the commit message. -> the release run (the tip's message holds no command).
- `no-evidence`: a runner that reports success without evidence verifies nothing. Open, for the owner: not checked by any gate now (see below).
- `branch-base`: base, REVIEW.md and verify skill read on an existing `args.branch`. Dropped: the release run makes a new branch from the baseline.
- `edits-test`: an edit of an existing test stops the package before review. Open, for the owner: not checked by any gate now; the release run only checks that the protected test is unchanged (see below).
- `nits-approve`: nit and pre-existing findings approve. Dropped until the fake Codex answers a scripted nit review in a second package.
- `review-md-from-base`: the review carries REVIEW.md of the base. -> the release run (the review turn holds the baseline REVIEW.md). Dropped: the variant where the package itself changes REVIEW.md.

Workflows, incident-triage: the old mock is now `scripts/e2e/scenarios/incident-triage.mjs` over the fixtures in
`scripts/e2e/fixtures/incident-triage/` (`product.mjs` and 24 cases: adapter checks
`bad-adapter`, `interpreter-flags`, `remote-launcher`, `loose-pattern`, `secret-param`; checks of the classifier's
answer `unknown-evidence-id`, `blank-brief`, `access-in-brief`, `access-in-gap`, `access-in-summary`,
`security-prohibitions`, `injection`; stale handling `stale`, `stale-no-deploy`, `stale-assertive`,
`stale-owner-mixed`; reply wording `plain-wait`, `no-retry-lead`, `repeat-in-facts`, `retry-in-facts`,
`retry-text-unflagged`; routes `blocked-release`, `agent-capability`, `skill-allowlist`), and three runs of the
workflow itself (scenario `incident-triage-runs`):
- `revisions`: a second run in the same folder makes `rev-2` and leaves `rev-1` byte for byte; a held lock refuses a
  run and makes no revision.
- `infra`: a gateway failure at Classify marks the revision failed, drafts nothing and releases the lock.
- `cleanup-faults`: a failed revision whose failed pointer is not verified (the runner left the file out, or reported
  another hash) keeps the lock, says so in the result, and runs no unlock step.

These run in `npm run e2e` and in CI with the rest of the suite (scenarios `incident-triage-*`), so the incident-triage
entries in the paragraph below are closed: only `no-evidence` and `edits-test` stay open.

Open, for the owner, and not a decision: `no-evidence` and `edits-test` are what a user sees (a weakened check
accepted, a success claimed without a receipt), not internal details, and no gate checks them now. Two ways out: the
owner drops these guarantees by name, or a bounded release run replaces them: `code-package` on a brief that asks to
edit the protected test (the package must stop with `protectedChanged`); a runner that reports success without
evidence (`no-evidence`) needs a fake agent, which no real run has, so for that case only the owner's decision is
left. The incident-triage cases, `revisions`, `infra` and `cleanup-faults` were in this list until the scenarios
`incident-triage-*` brought them back.
