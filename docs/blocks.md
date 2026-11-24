# Owner acceptance lists and decisions

This is the version 1 data contract for decision lists. The current Rust workflows accept owner input through `zodchi flow reply` and `zodchi flow remark`. See [the Flow guide](flow.md).

One run covers one round. Give the expert the current `decisions.md` and ask for proposals and assumptions in Russian. Run `list-build` and give the resulting `list.md` to the owner. A proposal that would cancel an earlier decision shows its id, current wording and state directly below the numbered line.

The owner answers between runs. Collect **everything** the owner says, including verdicts on assumptions, and submit it once with `list-reply`. Submitting even an empty batch closes the round. Nothing is accepted by silence. Unnamed lines stay open. A second, different reply for the same round is refused. The next round can decide an earlier open line by id. To change an earlier accepted decision, ask the expert for a new line whose `replaces` includes the old id. The owner sees the proposed cancellation before deciding.

## Files and gate protocol

The version 1 protocol used `api: 1` in each request. It returned one JSON line with `api`, `plugin` and `lineSha256`. The digest covered the UTF-8 serialization of the fields before it. A refusal returned `{ok: false, error: string}` in the same envelope and preserved the files. Usage and execution errors used exit 2. An API mismatch used exit 3.

`list-build` and `list-reply` take an existing absolute directory `tmp`; the remarks commands take it too (see "Owner remarks"). The expert's `answerFile` must be an absolute path to a regular file and can be outside the run. Neither path may have a `..` component with either slash style. The layout under `tmp` is:

```text
rounds/<round>/list.json    numbered list with build-time replacement snapshots
rounds/<round>/list.md      Russian list given to the owner
rounds/<round>/reply.json   immutable receipt of the closed batch
decisions.json             current ledger
decisions.md               Russian ledger attached to the next request
remarks.md                 owner remarks, created by the first remarks-add
```

Before writing, the helper checks the real path of the deepest existing ancestor of every destination, including each `<file>.tmp-<pid>`. All must be within the real `tmp`. An existing temporary destination refuses the call. Writes open the temporary exclusively, clean it up on write failure and rename it into place. Each round has one writer. The JSON authorities determine their Markdown renderings, with LF separators and one final newline. Invalid JSON, a different version and invalid fields in a required record cause refusal with its path and field.

In the formats below, `?` means an optional field. `id` is a string of two positive decimal numbers joined by a dot, with no leading zeros. `round` is an integer from 1 through 999. All file digests are lowercase SHA-256 hex of the exact bytes. Output file paths are absolute.

## Build the acceptance list

Spec and expert answer file:

```text
{api: 1, tmp: string, round: integer, answerFile: string, maxLines?: integer}

{items: [{text: string, group?: string, replaces?: [id]}],
 assumptions?: [{text: string, why?: string}]}
```

The answer is UTF-8 JSON, up to 256 KiB. At least one item is required. Items plus assumptions may total at most 200. A proposal can name up to 20 replacement ids. `maxLines` can range from 1 through 200 and defaults to 30. Exceeding this reporting threshold sets `tooLong` and still produces the full list.

Every text value, including owner corrections, must be a string. Trim it, then replace each whitespace run containing CR, LF, U+2028 or U+2029 with one space. Other internal whitespace stays as written. Control characters remaining after normalization are refused except for tab. Length is counted in Unicode code points after normalization. `text` takes 1–600, `group` takes 0–80 and `why` takes 0–300. An empty group or reason adds nothing to the rendering. The helper copies the canonical wording verbatim.

A new list requires applied rounds exactly `1..round-1`. Before the first reply an absent ledger represents `{version: 1, appliedRounds: [], entries: []}`. Number proposals in file order, followed by assumptions in file order, starting at 1.

```text
list.json
{version: 1, round, answerSha256, maxLinesAtBuild: integer,
 lines: [{n: integer, id, kind: "line" | "assumption", text, group?, why?,
          replaces?: [{id, text, state: "accepted" | "open"}]}],
 ignoredReplaces: [{line: id, id, reason: "unknown" | "this-round" | "superseded" | "rejected"}]}
```

Each line id is `<round>.<n>`. `group` and `replaces` belong to proposals and `why` belongs to assumptions. A replacement captures an earlier accepted or open entry's text and state at build time. Other targets are recorded in `ignoredReplaces` with the proposing line's id and the reason.

`list.json` is written first, then `list.md`. The list opens with the following two paragraphs, followed by a blank line.

```text
# Список для принятия, круг <round>

Ответьте номерами: «1, 2 — принять; 3 — поправить: <как верно>; 5 — убрать». Строка, которую вы не назвали, остаётся открытой, а не принятой. Ответ принимается один раз за круг: назовите всё сразу.
```

Lines use `<n>. <text>`, one per line. A nonempty group different from the previous line's group starts with `### <group>` and a blank line on each side of the heading. Each effective replacement follows its proposal on a line indented by three spaces:

```text
   Заменит прежнее решение <id>: «<text>» (сейчас: <принято|открыто>). Оно отменится, только если вы примете или поправите эту строку.
```

When there are assumptions, a blank line separates the proposals from this section. Numbering continues from the last proposal. A reason adds ` (почему: <why>)`.

```text
## Допущения эксперта

Эксперт решил это сам, потому что уточнить не мог. Каждое допущение тоже ждёт ваших слов.

<n>. <text>
```

```text
Build answer (plus gate envelope)
{ok: true, round, count: integer, items: integer, assumptions: integer,
 maxLines: integer, tooLong: boolean, listFile, mdFile, listSha256, mdSha256, answerSha256,
 replaces: [{line: id, id, text, state}], ignoredReplaces: [{line: id, id, reason}],
 already: boolean, repaired: [] | ["list.md"]}
```

An existing `list.json` is immutable. The same input digest returns the original build data, even after later decisions, with `already: true` and `tooLong` calculated using this call's `maxLines`. A missing `list.md` is regenerated and named in `repaired`. A differing Markdown file or a different answer digest is refused. A complete matching pair is left untouched.

## Close the round

```text
{api: 1, tmp: string, round: integer,
 reply: [{n?: integer, id?: id, verdict: string, text?: string}]}
```

Each entry has exactly one selector. Use `n` for a number on this round's list and `id` for an earlier open entry. Verdicts are trimmed and case-insensitive. `accept` / `принять`, `fix` / `поправить` and `drop` / `убрать` are stored as their English words. Only `fix` takes `text`, and it requires it. Entries resolve to target ids and sort by numeric round and number. Identical entries collapse. Conflicting verdicts or corrections for one id refuse the entire batch. `reply: []` leaves every new line open.

```text
decisions.json
{version: 1, appliedRounds: [integer],
 entries: [{id, round, n, kind, text, group?, why?,
            state: "accepted" | "rejected" | "open" | "superseded",
            was?: string, supersededBy?: id, decidedInRound?: integer}]}
```

`appliedRounds` runs consecutively from 1. Entry ids are unique and equal `<round>.<n>` in numeric order, with the round in `appliedRounds`. `accept` makes an entry accepted. `fix` accepts the owner's wording and keeps the previous wording in `was`. `drop` makes an entry rejected. Only accepted and rejected entries carry `decidedInRound`, the round of the owner's verdict. An unnamed proposal or assumption enters as open.

Before applying a batch, the helper checks every stored replacement against the current target text and state. It applies all explicit verdicts first. Then, in line-number order, each newly accepted proposal supersedes its displayed targets that are still accepted or open. The first such proposal wins if several name the same target. Only superseded entries carry `supersededBy`, the id of the later line. A rejected or unnamed proposal cancels nothing.

The ledger rendering begins with `# Список решений (после круга <round>)` and `Этот список главнее любых прежних ответов эксперта.` The sections in order are `## Принято`, `## Отклонено`, `## Открыто` and `## Отменено более поздним решением`, separated by blank lines. Entries use `- <id> <text>` in ledger order, with `(пусто)` in an empty section. A fixed accepted entry adds ` (владелец поправил; было: <was>)`, an open assumption adds ` [допущение эксперта]` and a superseded entry adds ` — заменено <supersededBy>`.

```text
counts  = {accepted: integer, rejected: integer, open: integer, superseded: integer}
outcome = {counts, thisRound: {accepted: integer, fixed: integer, dropped: integer, unnamed: integer},
           earlier: [{id, verdict}], unnamed: [id], superseded: [{id, by: id, text}],
           decisionsSha256, decisionsMdSha256}

rounds/<round>/reply.json
{version: 1, round, listSha256, entries: [{id, verdict, text?}], outcome}

Reply answer (plus gate envelope)
{ok: true, round, already: boolean, repaired: [] | ["decisions.md"], outcome,
 current: {appliedRounds: [integer], counts, decisionsSha256, decisionsMdSha256},
 replyFile, decisionsFile, decisionsMdFile}
```

`outcome` records the whole-ledger counts and file digests immediately after this round. `thisRound` counts only its own proposals and assumptions, with `accepted` counting plain accepts and `fixed` counting fixes. `earlier` lists older entries explicitly decided in the batch. `unnamed` lists the new open ids. `superseded` gives each cancelled id, the proposal that cancelled it and the text shown to the owner. `current` describes the ledger on disk, including any later rounds.

| State before the reply | Result for the canonical batch |
|---|---|
| Next round, no receipt | Compute the outcome, then write `reply.json`, `decisions.json`, `decisions.md` in order. |
| Receipt exists, round still pending | Require the same batch, recompute from the previous ledger and verify the recorded outcome before completing the ledger writes. |
| Receipt exists, round applied | Require the same batch. Return its recorded outcome and the current ledger, with `already: true`. Regenerate missing or stale `decisions.md` and name it in `repaired`. A matching rendering receives no write. |
| Round applied, receipt missing | Refuse the inconsistent history. |

## Owner remarks

The owner can say something while a round waits. A remark is a thought, never a verdict: it accepts, fixes or drops nothing, and it never touches a list, a reply or the ledger. The verdicts go only through `list-reply`. `remarks-add` appends one remark to `remarks.md` in `tmp`; `remarks-read` returns the remarks the caller has not used yet. Neither calls a model.

`remarks.md` is UTF-8 with LF line ends and no BOM. It holds zero or more records of exactly three lines, and the file ends with the line break of the last text line:

```text
---
<n>
<text>
```

`n` is the decimal number of the remark: 1, 2, 3 and so on, without gaps, in file order. A dash line is a line made only of three or more `-`; the read splits the file on dash lines. A text is never a dash line, and the helper refuses such a remark instead of escaping it, because escaping would change the owner's words. The check looks at the original text before trimming or folding: if any line of it (split on CRLF, CR, LF, U+2028 or U+2029, spaces and tabs around it removed) is three or more dashes and nothing else, the add is refused. A dash run inside a sentence is fine.

The stored text is the canonical text of the owner's words, as for the list texts (trimmed, a whitespace run with a line break becomes one space, control characters other than tab refused, length in code points after that), then with every secret-shaped value replaced by the redaction token. A quoted or unquoted assignment (`label=value`) is redacted before the shared token rule, so a label such as `token KEY="..."` cannot hide its value. The `text` an add answers is the text every later read returns. The text is one line of 1 to 500 code points (`MAX_REMARK_CHARS`). The original may hold up to 2000 code points (`MAX_RAW_CHARS`, counted before trimming and folding) and must be well-formed Unicode. A run holds at most 100 remarks (`MAX_REMARKS`), and the file at most 262144 bytes (`MAX_REMARKS_BYTES`); an add that would pass either limit is refused and writes nothing. A file that is not valid (not UTF-8, a BOM, a carriage return, no final line break, a line count that is not a multiple of three, too many records or bytes, or a record that is not as above) is refused by both commands, with its first bad record number when the problem is in a record, and is never repaired or appended to. A valid file with a record that still holds a secret-shaped value (written by hand) is refused by `remarks-add` with `remarks.md record <k>: text: holds a secret-shaped value; remove it by hand before adding`, the text not quoted and nothing written, because the add copies the old bytes; `remarks-read` still returns that record redacted and never changes the file.

```text
remarks-add   {api: 1, tmp: string, text: string}
  -> {ok: true, n, text, redacted: bool, count, remarksFile, previousSha256, fileSha256}

remarks-read  {api: 1, tmp: string, after?: integer, limit?: integer}
  -> {ok: true, exists: bool, remarksFile, fileSha256, count, after, through, more: bool,
      remarks: [{n, text}]}
```

`tmp`, `text`, `after` and `limit` are the command's own fields. For an add, `count` is the number of remarks in the file now, `redacted` is true when a secret-shaped value was replaced, and the two digests are the SHA-256 of the file bytes before and after. A retried `remarks-add` appends again: it has no idempotency key, so after a lost answer read the file with `remarks-read` before retrying.

A `tmp` path that holds a secret-shaped value is refused (`tmp: the path holds a secret-shaped value`) before anything touches the path, and neither the path nor the value appears in the answer. Like the list commands, the remarks commands refuse a `remarks.md` that is a link pointing outside `tmp`, and write nothing outside it.

`after` is the number of the last remark the caller has used (0 to 100, default 0) and `limit` is how many to return (1 to 20, default 20; `DEFAULT_READ_LIMIT`, `MAX_READ_LIMIT`). A read writes nothing, not even a cursor. It returns the first `limit` remarks with `n` above `after`, in order, none twice and none skipped. `through` is the `n` of the last remark returned, or `after` when none is returned; `more` is true when remarks above `through` exist, and the next call takes `after: through`. An `after` above the number of remarks in the file is refused, because remarks are only ever appended and such a file was replaced or lost. `fileSha256` is the SHA-256 of the file bytes; a missing file reads as `exists: false`, `count: 0`, no remarks and the digest of zero bytes (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`), which is also the digest of an existing empty file.

Replay: on an unchanged file, the same `tmp`, `after` and `limit` return a byte-identical answer, so a step that runs again after a cut sees what it saw, not an empty list. When remarks were appended in between, `count`, `fileSha256` and possibly `more` change, but the records returned are still the first `limit` above `after`: a page with room gains the new ones after the old ones, and a full page keeps its records and sets `more` so that the next call reaches the new ones.

For the lead and the callers:

- Add a remark as soon as the owner says it. Do not hold it in memory.
- Read with the `after` of the last step that used remarks, and remember the `through` of the step that used them.
- Measure your complete serialized spec against the transport you use; the helper's limits count code points and do not bound the spec's size.
- The helper's redaction removes secret-shaped values only. It does not know the owner's private words. Send a remark on to a model only through a path that scrubs them.

## Shared workflow blocks

| Block | Implementation | Package |
|---|---|---|
| 3. Numbered Russian acceptance list | `list-build`, `list-reply` | 1 · Lists and decisions |
| 4. Decisions and open assumptions | `list-reply` | 1 · Lists and decisions |
| 1. Ask independent questions and collect answers | Research workflow, as many concurrent jobs as the gateway allows (no limit by default) | 2 · Research |
| 2. Check each fact against its source | Cited line excerpts and a verifier verdict per fact | 2 · Research |
| 6. Check the assumptions in a request | Compare constraints with owner-confirmed decisions before asking the expert | 2 · Research |
| 5. Owner remarks between steps | `remarks-add`, `remarks-read` | 3 · Remarks |

Marketing mode and caller integration follow remarks. Game design and video follow those callers.

Game design uses 1, 3, 4, 5 and 6, uses 2 for its source sheets, and checks expert answers against the decisions and the canon.

Video uses 2 for artifact-backed claims, 3 and 4 for creative choices and approvals, 5 for remarks, and a video-specific form of 6 before an expensive render.
