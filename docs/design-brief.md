# Design brief

`design-brief` takes a goal to a brief that `code-package` can run. Researchers read the repositories and record facts
with their sources, one writer drafts the brief and checks every fact it relies on, an independent reviewer judges the
brief through the gateway, and the writer fixes it once. Today a lead writes every brief by hand and reads the
repositories itself; nobody checks the design before `code-package` spends a writer and up to three review rounds on it.

It starts no package and answers no owner decision. The lead reads the brief and the owner decisions first, then runs
`code-package` on it.

## When to use it

- The brief is not written yet, and the work touches code the lead has not read in this session.
- The goal is bigger than one package and needs cutting.
- A wrong fact in the brief would cost a whole package (a name, a file, a format, a limit).

Do not use it for a one-file change the lead already understands: write the brief by hand.

## Run it

```
/zodchi-core:design-brief
args: {
  "label": "export-resume",
  "goal": "The nightly export must resume where it stopped, because a cut run loses an hour.",
  "repos": ["/path/to/app", "/path/to/library"],
  "out": "/path/to/app/.agent-tmp/export-resume/brief.md",
  "tmp": "/path/to/app/.agent-tmp/export-resume",
  "questions": ["How does the export write its rows today?", { "question": "Where is the progress kept?", "repo": "/path/to/app", "files": ["/path/to/app/src/state.js"] }],
  "context": ["/path/to/app/docs/plan.md"],
  "publicRepo": true
}
```

| arg | meaning |
|---|---|
| `label` | short name; also the prefix of the gateway key |
| `goal` | what the package must achieve and why |
| `repos` | absolute paths the researchers and the writer may read. The first one is also where the gateway runs from: it must be a Git work tree that ignores `.agent-tmp/` (`gatewayRepo` names another) |
| `out` | absolute path of the brief. It starts with the line `<!-- design-brief: <label> -->`; a file that carries it is replaced, any other existing file is never overwritten |
| `tmp` | absolute folder for progress files, the facts and the review |
| `questions` | optional list of research questions (a string, or `{ question, repo, files }`). Without it a planner proposes 3 to 5, each naming the repository and the files to read |
| `context` | optional documents the writer reads first (a plan, an earlier brief) |
| `template` | optional brief to imitate. Default: the section list below |
| `publicRepo` | `true` when the brief is for a public repository: the review also looks for company, product and person names and machine paths |
| `models`, `pluginRoot`, `rerun` | as in `code-package` |

## What runs where

The workflow assigns one slot per question in question order, starting at 1. Each researcher writes its own
UTF-8 JSON file at `<tmp>/facts/<slot>.json`. It reports the path, the number of facts and the SHA-256 of the
exact file bytes. The file holds `{ facts: [{ claim, source }], unknowns: [string] }`.

The helper in `core/scripts/io.mjs` owns the manifest under `<tmp>/manifest/`. Its header, `input/entry.json`, binds
the goal, ordered questions and file hints, repositories and disclosure settings to a single SHA-256.
The workflow sends those inputs to `brief-manifest` in one base64 argument of at most 4000 characters. It
stops before research if the argument exceeds that limit and resends once if it cannot verify the response.
The helper checks the input digest before creating the run folders.
Runners carry receipt metadata and helper summaries. The workflow verifies the helper's `lineSha256`
before using its slot statuses, reasons, totals and manifest hash.

For each accepted slot the helper publishes an immutable `<slot>/entry.json` receipt in the manifest folder. The manifest
hash covers the input digest and all receipts in question order, including empty positions in a partial run.
A second rejection stops the invocation. To recover, start a fresh run with the same `args.tmp` and research
inputs. The helper hashes the live files, reuses accepted slots and asks only the questions whose receipts are
missing or rejected. Using `resumeFromRunId` with unchanged calls would replay the same stop. If accepted bytes changed or vanished,
restore the accepted bytes or choose a fresh run folder. Changing the questions or run settings also requires
a fresh folder.

## The stages

1. **Gate.** One command of the loaded plugin copy (`core/scripts/gate.mjs roles`) prints the role table, the account
   and whether the gateway repository ignores `.agent-tmp/`; the result names the copy (`pluginCopy`). The writer is the
   first Claude candidate of the role `writer`. The reviewer is the first Codex candidate of the role `architect`. When
   there is none (no limit left, not connected, a role table with Claude only) the run is refused before any agent is
   spent: a review that does not go through the gateway is not independent of the writer, so there is no fallback.
2. **Facts.** A read-only planner proposes questions when none were supplied. The workflow redacts the goal and
   questions before sharing them. Researchers work in parallel on the cheap model and write only their assigned
   slot. Each reads the repository using read-only commands, including `git --no-optional-locks log|show|diff|grep`.
   The helper checks the assigned path, file type, UTF-8 JSON schema, raw fact count and byte digest. It drops
   citations outside the allowed repositories, citations without a line or line range, and secret-file references.
   It reports the drop count, redacts secret-shaped values and deduplicates claims with the same source. When
   every slot is accepted it writes `<tmp>/facts.json` with the original repository paths for local verification.
3. **Draft.** One writer reads the assembled facts and unknowns from that file and writes the brief to `out`.
   It reads each repository's `AGENTS.md` or `CLAUDE.md` and verifies every
   fact it relies on by reading the cited file (a fact that does not hold is not used and is reported), cuts the scope to
   one package and says what is left for later, and lists the **owner decisions** apart, each with a marked default,
   instead of inventing an answer. A runner then checks that the file exists, starts with the workflow's line and has a
   title, a `## Review boundary` and a `## Checks` section (the helper's `brief-inspect`); a brief without them is not
   reviewed.
4. **Review.** An independent review through the gateway, role `architect`, the same way `code-package` reviews a change:
   a runner calls `zodchi run` in the foreground. Before anything is sent, the helper (`brief-preflight`, run by a runner)
   reads the brief and the lines the facts cite and screens the brief: a brief that holds a secret-shaped value (in a
   public repository also a machine path) is not sent and nothing is written for the gateway, and the run stops naming the
   lines (not the values) for you to correct. The screening mode is never defaulted: the helper refuses a command without
   `publicRepo` (true or false) and names the mode it used, and the workflow stops when that is not its own. Preflight verifies the complete manifest hash, re-reads each slot against its
   accepted receipt and checks that the assembled facts still match the digest given to the writer. Only then
   does it produce the review request in `<tmp>/review/`. The brief, the screened facts
   file and one excerpts file are attached: the cited lines with three lines around them, redacted, never a whole source
   file. With `publicRepo` the facts, excerpts and prompt show `<repo1>/path` instead of machine paths (the attachment
   names are the paths of `out` and `tmp`: name them neutrally). Every attachment is required; the exact list is recorded
   per key, and a missing attachment is reported as a failure, never answered by another submission (the model turn may have
   run). The reviewer looks for: wrong facts, places where the writer of the code would have to
   guess, a scope bigger than one package, a missing or vague review boundary, checks that would pass with the goal
   unmet, secrets or private names, and owner decisions that are answered instead of listed. Findings are `blocker`,
   `important` or `minor`. The answer is checked before it counts: the helper reads it with its hash, and it must be a review
   with a verdict and findings, and the verdict must agree with them (the helper judges the shape and counts the severities
   over every finding, not only the 40 it lists): `approved` with a blocker or important finding, or
   `changes_requested` with only minor ones, stops the run instead of becoming an approval.
5. **Fix.** When there is a blocker or an important finding, the writer fixes the brief once. It verifies each finding
   first; a wrong one is left, with the reason. There is no second review round. A changed file hash shows only that the
   file changed, not which finding was fixed: fixes are listed (as what the writer says it did) only when the file changed
   and the writer said the fix was done; otherwise they are attempts and the finding is left. Without a change the owner
   decisions stay those of the draft, and `next` says that nothing was fixed.

A gateway job that ends `unknown` is never submitted again by the workflow (the request may already have run): the result
carries `unknown` with the key and `next` says how to decide.

## The brief

Unless `template` names another brief, the writer uses these sections:

| section | content |
|---|---|
| `# <title>` | what the package does, in a few words |
| `## Repository, branch, files` | the repository, the branch and the files the package may touch, and the ones it must not |
| `## State` | what is there today, with the facts it rests on |
| `## Goal` | what must be true when the package is done, and why |
| `## What to build` | numbered, concrete steps; the coder never has to guess a name, a file or a format |
| `## Left for later` | what the package does not do |
| `## Owner decisions` | only what the owner must answer, each with its options and `Default: ...` |
| `## Review boundary` | `Important: ...` and `Out of scope: ...` with an example of each, see [review-boundary.md](review-boundary.md) |
| `## Checks` | the cheap checks and the `verify` commands that run the real program |

## The result

```
{ label, path, ownerDecisions, facts, reviewFindings, fixed, left, reviewedBy, writtenBy, pluginCopy, notes,
  stoppedAt, refused, next, unknown, review }
```

- `path`: the brief, `""` when none was written.
- `ownerDecisions`: each `<question> (default: <default>)`. Read these first: the default is what the coder uses unless
  you say otherwise.
- `facts`: how many facts passed the helper's checks.
- `reviewFindings`: every finding of the review as `<id> <severity> <location>: <problem>`; `[]` when a review ran and
  found nothing, `null` when no review answered. A review that did not answer, was unreadable or ended `unknown` is never
  reported as a review.
- `fixed` and `left`: the blocker and important findings the writer fixed (and what it did) and the ones it left (and why);
  minor findings are left.
- `notes`: dropped facts, facts the writer found wrong or could not verify, what the reviewer could not judge, a decision
  without a default.

## Example

A lead wants the nightly export to resume. It runs the workflow with the goal and two repositories. Three researchers
return 14 facts; two cite a file outside `repos` and are dropped. The writer finds that one fact is stale (the file now
says otherwise), does not use it, and lists "Keep a copy of the old export?" as an owner decision with the default "No".
The review returns one blocker (the check `node test.js` passes whether or not the export resumes) and one minor finding.
The writer fixes the blocker by naming a check that cuts the export and runs it again. The result: `fixed` holds the
blocker, `left` the minor finding, `ownerDecisions` the one question. The lead answers it, then runs `code-package` with
`path` as the brief.
