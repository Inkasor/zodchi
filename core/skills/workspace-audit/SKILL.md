---
name: workspace-audit
description: Tidy a cluttered work folder without losing anything - read-only researchers in parallel return one verdict table each, the lead folds them into a few groups, the human decides in one batch, and only then one worker acts. Use when someone asks to clean up, sort out or audit a folder of loose files, caches and repositories.
---

# Workspace audit

A recipe, not a program: the lead runs it with ordinary subagents. It worked on a real folder of hundreds of loose
files, heavy service folders and repositories in mixed states.

## 1. Survey (read-only, in parallel)

Split the folder into slices that do not overlap, for example: loose files in the root; service, cache and heavy
folders; repositories. Start one read-only researcher per slice (an Explore agent or `zodchi-core:runner` on a small
model). Each returns one table, one row per item:

| path | what it is | referenced by | size | last change | verdict | risk | reason |
|---|---|---|---|---|---|---|---|

Verdicts: `DELETE`, `ARCHIVE`, `KEEP`, `ASK`. Rules for every researcher:

- **Change nothing.** No delete, move, rename, commit, `git status` refresh tricks or installs.
- **A sole copy is never `DELETE`.** If no second copy is found (and the item is not in Git), say `ASK` and why.
- **In use is never `DELETE`.** Report a process whose executable, working folder or open files are inside the item.
  If that cannot be checked, the item counts as in use.
- **Repositories:** branch, uncommitted files, commits not on the upstream, stashes. Do not fetch.
- **Secrets by value, not by name.** A field named `password` with a reminder text, `changeme`, `<...>` or an empty
  value is not a secret; any other value in a secret-named field is, and so is a key-, token- or private-key-shaped
  value anywhere. Never copy a value anywhere - not into the table, a message, a command's output or a log: path,
  line and kind only.
- **Say what was not covered:** a folder too big to walk, an unreadable file, a check that could not run.

## 2. Fold (the lead)

Merge the tables into a few groups (for example: junk to delete, archives, keep, questions),
each with its count, size and full item list. Every `ASK`, every risk and every gap stays visible.

## 3. Decide (the human, once)

One question set, one choice per group, the safe choice first, each group with the exact item list it covers. The
answers are the plan. Nothing happens before it. A group without a clear answer is skipped, not guessed.

## 4. Act (one worker, only after the answers)

Exactly the chosen actions on exactly the listed items, nothing else. A move into an archive counts as a removal.
Right before each removal or move, check again: the item is unchanged since the survey, it is not in use, and another
copy of it exists outside everything being removed or moved in this run. If any check fails or cannot run, skip the
item and report it. Never print a secret value, in the log or anywhere else.

**Repositories are reported, never acted on.** No commit, push, stash, reset or folder removal for anything inside
a repository: the report lists each repository's state, and committing or removing one is a separate task for the
human or a code package. Keep a log of every action with how to undo it (archive path). Anything the answers did
not cover is skipped and reported.

## 5. Report

What was done, what was skipped and why, and what is left for the human.
