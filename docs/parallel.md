# Parallel packages

Several `code-package` runs at once, on one repository. Who runs them, and how,
is the owner's choice; this page says what the workflow supports and what each
way costs.

## Three ways

**One shared branch, one checkout, with claims.** Every package claims its own
files (`args.files`, extended as the work changes more; the gate refuses a package
whose files another open package claims). The packages work in the same folder,
on the same branch. Nothing to clean up afterwards. The packages must not touch
the same file: a lead prepares that (below).

**Worktrees.** One `git worktree` per package, each on its own branch. The
checkouts do not meet, so no claim, lock or branch rule matters; the branches
are merged afterwards, and a file both packages changed conflicts there. Cost:
every worktree must be removed after the package (`git worktree remove`), and an
agent may not be allowed to remove one (a sandbox that forbids deleting folders).

**Clones.** One clone per package. The same as worktrees, with more disk and a
push or fetch between the clones. Removing a clone is deleting a folder, which an
agent may not be allowed to do either. Nothing is shared, nothing is locked.

## What the workflow does on a shared branch

- **Claims.** Each package writes its claim (`~/.zodchi/packages/<repo>/<label>.json`,
  with its files and its branch) under a lock, and compares with the others.
- **Commits.** The commit step commits only the package's own paths
  (`git commit -- <paths>`); another package's staged or changed file stays out.
  A file that Git shows changed, that the writer did not report and that another
  open package claims, is left out of this package's claim and commits (the log says
  so). A file the writer itself reports and another package claims stops the run
  (`claim conflict`).
- **index.lock.** Git takes `.git/index.lock` for a moment while it works. A Git
  command of the commit step that meets a held lock waits 3 seconds and tries again,
  at most 10 times, and never deletes the lock; a lock still held ends the run with
  `commit (index.lock held)`.
- **Branches.** A package started while another open package of the same repository
  is on a different branch refuses with that reason: switching would pull the branch
  from under the other package. On the same branch it runs.
- **Review.** The review diffs only the package's paths against the base commit, so
  other packages' commits do not enter it.

## The owner setting

`~/.zodchi/config.json`:

```json
{ "parallel": "shared-branch" }
```

Unset by default; nothing changes without it. When set, the workflow adds to the
prompt of every agent of the run (and to the writer's task): "work in the checkout
you were given; do not create clones or worktrees and do not switch branches".
The agents' own files do not carry this line, because the checkout of a package is
not always shared. In this mode `args.branch` must be the branch already checked
out (the workflow does not switch it), or the run is refused with that reason.

## Preparing a shared branch

Two packages that would both change one file cannot run side by side: the second
is refused at the gate. Split the file first. A lead makes a small first commit
that moves what each package needs into a file of its own (a registry that lists
the pieces becomes one file per piece, a long test file one file per area), so
that each package adds a file instead of editing the shared one. The e2e suite is
laid out this way: `scripts/e2e/scenarios/<area>.mjs`, one file per package. Then
each package lists its own files in `args.files` and the claims never meet.
