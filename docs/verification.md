# Verification

How `code-package` decides that a change works, and how a repository tells it
what matters. Running the real thing matters more than tests, one reviewer
with a written focus beats stacked reviewers, and a change must not edit the
checks that judge it.

## What the workflow does

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
