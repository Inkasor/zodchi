# The review boundary

Where a review stops. Without a line, each round of reviews finds new, deeper
"important" points (a double fault, a malicious agent, a hostile file system)
and a package can go on for an hour. `code-package` takes the line from the
brief, quotes it to the reviewer, and stops a run whose rounds only go deeper.

## In the brief

Every brief carries a section `## Review boundary` (the heading may continue,
for example `## Review boundary (for this package)`): what is important for
this package, and what is out of scope, with an example of each.

```markdown
## Review boundary
Important: a normal run loses or overwrites an export, writes a row twice, or
reports success that did not happen.
Out of scope: a second export started at the same instant by the same person;
a file system that changes under the export while it reads.
```

Write it for the package, not for the repository: the repository's own
`REVIEW.md` holds what holds for every package. The gate reads the section
(from its heading to the next `## ` line) and the review prompt quotes it
exactly, next to `REVIEW.md` as of the base commit. A point outside it is at
most a `nit` or `pre-existing` finding. A brief without the section is not
refused: the result carries a one-line note in `notes`, and the reviewer judges
by the brief alone.

## A round that only goes deeper

From round 2 on, the workflow compares the important findings of the round with
those of every earlier round. A finding is the same finding when its id and its
location (the file, without a line number: a fix moves lines) are the same; the
reviewer is told to keep the id of a finding that still holds and to number new
ones on. The run stops early when **every important finding of the round is new
and every earlier important finding is closed**: the round found nothing the
writer left open, only more to find. The workflow does not spend the next round.
It returns:

- `stoppedAt: "review went deeper"`;
- `boundary`: the new important findings, each as `{ finding, id, location,
  problem, decide: "fix | out of scope", ifOutOfScope }`. The lead sorts each into
  *fix* (a new package, or the writer again) or *out of scope*. `ifOutOfScope` is a
  proposed `REVIEW.md` line, "Do not flag: what. Why: ... Added: date", with the
  reason left for the lead to write;
- `question` and `next` saying so.

The workflow never edits `REVIEW.md`: it is a protected check, and what the
owner wants flagged is the owner's decision. The stop comes before the round
limit: a third round of three that only goes deeper is `review went deeper`, not
the stop rule. A finding that comes back (same id and location) keeps the run
going, as before.

## The ledger

`reviewLedger` is always present: one entry per finding of any review,
`{ id, severity, location, problem, firstRound, lastRound, status, closedInRound,
closedBy }`.

| status | meaning |
|---|---|
| `open` | the last review that looked at it still reports it |
| `closed` | it was sent to the writer and a later review no longer reports it; `closedBy` is `code change` or `answered without a code change` |
| `dropped` | a later review no longer reports it, and it was not sent to the writer (a nit, a pre-existing finding) |
| `to sort` | new at a boundary stop: the lead decides |

A lead reads it to see how much a review was worth: many findings `closed` by a
code change mean the rounds earned their time; findings `to sort` that the lead
rules out of scope mean `REVIEW.md` needs a line, or the brief a sharper
boundary.

To write the boundary of a package whose brief does not exist yet, see [design-brief.md](design-brief.md): the workflow `design-brief` drafts the brief with its `## Review boundary` section and has an independent reviewer check that the section fits the package.
