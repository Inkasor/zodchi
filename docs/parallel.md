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
- **Who compares.** Lists of paths are never compared by a model. The claim step and every
  extension of the claim after a write (`claim <label>`, `claim more <step>`) run one command of
  the gate helper, `gate.mjs claim` or `gate.mjs claim-more`, which takes the claims lock (the
  folder `.lock`; a lock still held after two minutes is reported as the conflict `lock busy`,
  never broken), reads every claim, compares the paths as the workflow keys them (lower case,
  slashes forward, relative to the repository) and writes the claim atomically (a temp file
  renamed over it). The runner returns the printed line and the exit code; the conflicts, the
  files of other packages (`others`) and what was added come only from that line. An open claim
  of the same label is reused on a resume, its branch set to the one the resumed run asks for
  (after the same branch check against the others). A claim the earlier run closed `stopped` (not
  `done`) of the same `tmp` folder is the claim of the package that goes on: the claim command
  opens it again (with its recorded `base` and what it recorded at the start), and so does
  `claim-more` when it finds the claim closed `stopped`. This is needed because a resumed run
  (`resumeFromRunId`) takes the finished `claim` step from the journal and does not run it
  again, so the first helper call that does run finds the claim closed; it is opened again unless
  another open claim now lists one of its files (then the run stops with that conflict). The claim
  records the package's base commit (`claim-base` updates it after a switch to `args.branch`
  or an ignore commit): a package that goes on reviews `base..HEAD` from that recorded base,
  with every file its claim lists, not only what this run wrote. The helper keeps claims, and takes the lock,
  in the folder under the shell's `$HOME`, the one every version of the workflow uses; where Node's
  home folder is another one (Windows), the claim step refuses while open claims written there by
  an earlier build lie in it, and `claim more` counts them as other packages. Until the helper's
  answer confirms the claim file, the run marks and closes no claim; an answer it cannot read
  stops the run with `claimUnknown`, for a person to look at the claims folder.
  (Seen on 2026-11-19: a runner asked to compare 45
  changed paths with two other claims answered that none were theirs, and its package committed
  all 45.)
- **Stale claims.** A package finished by hand, outside `code-package`, leaves its claim open
  and would block later packages. The gate closes an open claim of another label when all
  of these hold: none of its files has an uncommitted change; it has commits after its recorded
  base that touch its files and every one of them is on the default branch; nothing was
  written to the claim file or the package's tmp folder for three hours (`claimStaleHours` in
  `~/.zodchi/config.json`), so that a package between two rounds, whose files are clean and
  committed too, is not closed under its own feet. The result names each closed claim and why
  (`closedClaims`, and a note); the open claims it kept are not touched. A claim whose files
  are dirty, whose commits are elsewhere, or that was written to recently stays. So does a claim
  marked `"awaiting"`: a package that stops until a person decides (a gateway job that ended
  `unknown`, an infrastructure failure to fix) writes that field into its own claim, and no age
  or clean tree closes it; a person closes it. When `git status` itself fails, the gate answers
  with `dirty: null` and `dirtyError`, the workflow stops, and no claim is examined.
- **Commits.** The commit step commits only the package's own paths
  (`git commit -- <paths>`); another package's staged or changed file stays out.
  After a write, `claim-more` leaves changed files listed by another label's
  open or stopped claim with that package. Its unreported files stay out of
  this package's claim, protected-check guard and commits. A file reported by
  both the writer and another package's claim stops the run (`claim conflict`).
  Clean paths in a stopped claim are ignored. Only open claims can block
  opening or reopening a package.
- **index.lock.** Git takes `.git/index.lock` for a moment while it works. A Git
  command of the commit step that meets a held lock waits 3 seconds and tries again,
  at most 10 times, and never deletes the lock; a lock still held ends the run with
  `commit (index.lock held)`.
- **Branches.** A package started while another open package of the same repository
  is on a different branch refuses with that reason: switching would pull the branch
  from under the other package. On the same branch it runs.
- **Review.** The review diffs only the package's paths against the base commit, so
  other packages' commits do not enter it. For a package that goes on (a new run of the same
  label after a stop, or a resume) the base is the one its claim recorded, so the earlier
  rounds' commits are in the review too.
- **Gateway keys.** Every gateway key of `code-package` is `<label>-<base7>-<run>-<kind>-<n>` (for
  example `export-csv-1a2b3c4-9f8e7d6c-review-1`): `<base7>` is the first seven characters of the
  package base commit, `<run>` an id of eight hex digits that the gate helper allocates at the gate of
  each run. Two runs of one label never share a key, even at the same base and HEAD. A resume of the
  same run (whose gate, claim and base answers come back from the journal, the run id with them)
  builds the same keys, so the gateway's idempotency holds for it. A rerun after an infrastructure
  failure keeps its own `-a<n>` suffix.
- **A base that left the branch.** When the base the claim recorded is no longer an ancestor of HEAD
  (the branch was rebased or reset), the run stops at `base` before any work and leaves the claim's
  base as it was: HEAD would be no stand-in, the review would miss the package's earlier commits.
  Set `base` of the claim to the commit the package began at on the branch now and start again.
  The files of the earlier rounds are read with `git diff --name-only --no-renames`, so a renamed
  file is in the review with both its old and its new path.

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
the install that `installed_plugins.json` names for `zodchi-core` for the project the session runs in (the folder the
runner starts in, which the command passes; the most specific project install, else the user install). It picks one
copy and never falls through to another, and it never looks in a checkout. A copy without the helper stops the run
with exit code 4 and the place it looked at; a copy
whose helper speaks another `api` than the workflow stops it with exit code 3. Every workflow result carries
`pluginCopy`: `{ path, commit, version, via }`, the copy the helper came from and how it was found.

## The script and the copy must be one

Never point `scriptPath` at a checkout's `core/workflows/code-package.js` while that workflow is
changed on the branch: the new script sends commands to the helper of the older plugin copy, which
answers in ways nobody can read (seen: "spec is not JSON" on a `b64:` spec). `code-package` checks it
itself: the script carries a line `const WORKFLOW_BUILD = '<stamp>'` (the first 16 hex digits of the
SHA-256 of the file, line ends as LF, the stamp emptied), sends it to the helper, and the helper stamps
the `code-package.js` of its own copy. Different stamps, or a copy too old to report one, refuse the run at the gate, before anything
is claimed: `refused` names both stamps, the copy's commit and what to do (take the workflow from the
copy, `git show main:core/workflows/code-package.js` saved outside the checkout, or run the installer). A
checkout whose script equals the copy's passes. The result carries `workflow`: `{ build, copyBuild, copyCommit }`.
After editing the workflow, run `node core/scripts/gate.mjs workflow-build core/workflows/code-package.js --write`;
the e2e suite fails when the stamp is not current.

## A gateway job that ended unknown

The gateway reports `unknown` when the request may already have run. The workflow stops with
`stoppedAt: "unknown outcome at <step>"`, the key and the reason. A plain resume stops at the same unknown job.
Within the step, a retry under `-r2` or `-r3` requires a `failed` job with both `turnRequestedAt` and
`turnStartedAt` unset.

Inspect the job with `zodchi job --key <key>`. You can use its result or authorize another call by naming the
step in `args.rerun`. Attempt N first reuses any submission it already recorded. Otherwise it waits for an
earlier job that is still running. If the earlier job is already final with any status, including `unknown`,
or there is no earlier job, it submits under `<key>-aN`.

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
