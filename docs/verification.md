# Verification

How `code-package` decides that a change works, and how a repository tells it
what matters. Model review alone does not converge: a reviewer that does not
know what the owner cares about finds a new hypothetical edge case every
round, and a package judged only by its unit tests can pass while the program
does not start. Teams that hand most of their code to agents settled on a few
rules, and the workflow follows them:

- running the real thing end to end matters more than tests;
- one reviewer with a written focus beats several stacked reviewers;
- a change must not be able to edit the checks that judge it;
- a review judges a fixed commit;
- every commit records how it was verified.

## What the workflow does

1. **Cheap checks first.** After each write the runner runs the brief's cheap
   checks (`args.checks` without `e2e`): build, lint, fast tests. A failure
   goes back to the writer without spending the slow run.
2. **Then the real thing.** The end-to-end run is the repository's own
   verification, the first that exists: the commands in `args.verify`, else
   the repository's skill `.claude/skills/verify/SKILL.md` as of the base
   commit (the runner follows it), else the brief's checks marked
   `{ "e2e": true }`. Its evidence (each command, its exit code, where its
   trace, screenshot or log is) is part of the Checks result and of the
   package result, `verification.evidence`.
3. **Not verified is said plainly.** When the repository has no way to run the
   change, the result says "not verified by running" and carries
   `verifiedBy: "none"`. It is never reported as verified.
4. **Protected checks.** After each write the workflow compares the package's
   files with the base commit. Existing tests and end-to-end scenarios
   (`test/`, `tests/`, `e2e/`, `*.test.*`, `*_test.*`, `*.spec.*`, and paths in
   `args.protect`), `REVIEW.md`, the `verify` skill and the files the check
   commands name may not change. New test files are allowed. A changed or
   deleted existing one stops the package before review with the list
   (`protectedChanged`), unless `args.allowCheckChanges` names the path with a
   reason; the result records those in `checkChanges`. The writer is told
   this rule up front.
5. **One reviewer with a written focus.** The review request carries
   `REVIEW.md` read from the base commit (`git show <base>:REVIEW.md`), never
   from the package's changes. Findings are `important` (blocks), `nit` (does
   not block) or `pre-existing` (was there before the change; does not
   block). Only `important` findings block approval and count against the
   stop rule; the rest go to `openFindings`. Older reviews are still read:
   `blocking` as `important`, `should_fix` and `note` as `nit`.
6. **A fixed commit.** The runner commits each round, and the review names the
   commit it judged. When the review names another commit, or the branch has
   moved since, the review is stale: it is not counted and the package stops.
7. **A stamp on every commit.** The round's commit message ends with one line
   `Verified: <how>`, for example `Verified: e2e npm run e2e exit 0; checks 2 passed`
   or `Verified: none; checks 2 passed`. `git log --grep "Verified: none"`
   lists the commits nothing ran. The review comes after the commit, so its
   verdict and the commit it judged are in the package result
   (`verification.review`, `verification.reviewedCommit`).
8. **Flaky checks.** Neither the runner nor the writer may skip a check, add a
   sleep or run it again until it passes. A check that fails without a cause
   in the change is reported as flaky with its log, and the package stops
   (`flaky`). Deleting or quarantining a flaky test is the lead's decision,
   recorded by running again with `args.allowCheckChanges`.

## Writing REVIEW.md

`REVIEW.md` sits at the root of the repository. It is the owner's voice in
every review: what the owner would flag in a pull request, and what not.
Keep it short, one line per rule, each with its reason:

```markdown
# Review focus

Flag:
- A database query inside a loop over request items: the list pages time out (PR 214).
- A new endpoint without the permission check the router applies elsewhere: data of other users leaks.
- Money as a float: totals drift by a cent (incident 2026-03).

Do not flag:
- Naming and formatting: the formatter owns them.
- Missing tests for generated code under gen/.
- Edge cases of inputs the API layer already rejects.
```

- Write what the owner would flag, not general good practice: the reviewer
  knows that already.
- The "Do not flag" list is as important: it is what stops a review from
  finding a new hypothetical case every round.
- The package cannot change it for its own review: the copy from the base
  commit is the one attached, and a change to it stops the package as a
  protected check.

## Writing a verify skill

`.claude/skills/verify/SKILL.md` tells the runner how to start the app and
drive one real flow. It is a skill like any other, with a short frontmatter.
Make it:

- **Fast.** One real flow that touches what most changes touch, in a minute
  or two, not the whole end-to-end suite.
- **Reliable.** No sleeps: wait for a port, a log line or a page element.
  Fixed test data, a fresh database or a temporary folder, a port of its own.
- **Exact.** The commands to run, in order, and what success looks like
  ("prints `ready on :4100`", "the page shows the order number").
- **Evidence-making.** Each command writes a log; a browser flow saves a
  trace or a screenshot. The runner reports where they are.
- **Self-cleaning.** It stops what it started, also when a step fails.

For example:

```markdown
---
name: verify
description: Start the app on a fresh database and place one order through the browser.
---

1. `npm run build` (exit 0).
2. `npm run db:fresh -- --seed test/seed.sql` (exit 0).
3. `npm run start -- --port 4100 > $LOG_DIR/app.log 2>&1 &`; wait until `curl -s localhost:4100/health` prints `ok`.
4. `npx playwright test e2e/order.spec.ts --trace on --output $LOG_DIR/trace` (exit 0).
5. Stop the app.
```

A repository without a skill can pass the same commands as `args.verify`.

## Misses become rules

When a review or a check missed a real bug, the fix is not another reviewer:

- add one line to `REVIEW.md`: what to look for, why, and the incident or PR
  it came from; or
- add a scenario to the end-to-end suite that would have caught it.

Prune as well: a `REVIEW.md` rule that has not fired in months, or a scenario
that only duplicates another, costs every review and every run. Remove it,
and say so in the commit message.
