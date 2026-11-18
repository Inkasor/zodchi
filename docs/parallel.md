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
  with its files and its branch) under a lock, and compares with the others. A claim is
  the file `<label>.json` whose `label` field is its own name and nothing else: a stray
  `x.json.bak-1` or `x.bak.json` is never read as a second open claim, and no agent makes a
  backup in that folder (a file is changed in place).
- **Stale claims.** A package finished by hand, outside `code-package`, leaves its claim open
  and would block later packages. The gate closes an open claim of another label when all
  of these hold: none of its files has an uncommitted change; it has commits after its recorded
  base that touch its files and every one of them is on the default branch; nothing was
  written to the claim file or the package's tmp folder for three hours (`claimStaleHours` in
  `~/.zodchi/config.json`), so that a package between two rounds, whose files are clean and
  committed too, is not closed under its own feet. The result names each closed claim and why
  (`closedClaims`, and a note); the open claims it kept are not touched. A claim whose files
  are dirty, whose commits are elsewhere, or that was written to recently stays.
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

## The gate: facts from one command

The gate of `code-package` (and of `branch-review`, `asset-round` and `incident-triage` where they need facts of
the machine) does not ask a runner to retell files and exit codes. It runs one small script,
`core/scripts/gate.mjs` of the plugin copy the session loaded, which prints one line of compact JSON: the role
table, the account, the Git state, the dirty list, the ignore rule (with its exit code), the verify skill,
`REVIEW.md`, the owner config, the brief's Review boundary and the claims. The runner returns that line and its
exit code as they are; the workflow parses the line and decides. A file that cannot be read or is not JSON
is a field of the line, apart from a file that does not exist. An exit code other than 0, a line that is not
JSON, an `api` that differs from the workflow's or no answer at all stops the run at the gate, before
anything is claimed.

## Which copy ran

Three copies of the plugin can exist on a machine: a checkout, the snapshot the installer made and the copy
Claude Code registered and cached. A workflow script cannot see its own file, so the gate looks the helper up
in the copy the session loaded, in this order: `args.pluginRoot`, `$ZODCHI_PLUGIN_ROOT`, `$CLAUDE_PLUGIN_ROOT`,
the install that `installed_plugins.json` names for `zodchi-core` (one made for this project first). It never
looks in a checkout. A copy without the helper stops the run with exit code 4 and the places it looked at; a copy
whose helper speaks another `api` than the workflow stops it with exit code 3. Every workflow result carries
`pluginCopy`: `{ path, commit, version, via }`, the copy the helper came from and how it was found.

## A gateway job that ended unknown

The gateway reports `unknown` when the request may already have run. No workflow submits it again under a new key:
the run stops with `stoppedAt: "unknown outcome at <step>"`, the key, the reason and the decision that is the
person's (look at `zodchi job --key <key>`, then take the result or pay once more by running the step again under
its rerun label). A `failed` job gets a new key only with evidence that the request was never sent: the job shows
neither `turnRequestedAt` nor `turnStartedAt`.

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
