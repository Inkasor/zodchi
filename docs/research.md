# Research round files

A round prepares a set of proposals for the owner's numbered list. The workflow in the next package runs `research-open`, the constraint check, `research-prompts`, the expert jobs, `research-collect`, the fact-check jobs, `research-verdicts` and finally `list-build`. Each helper call uses gate API 1 and returns one signed JSON line. A valid call that the helper refuses returns `ok: false` and a field-specific error with exit code 0.

| Command | Reads and checks | Writes and returns | Repeated call |
| --- | --- | --- | --- |
| `research-open` | Absolute `tmp` and `repo` directories, one request (100,000 bytes), one to five question files (50,000 bytes each), up to twelve distinct attachment files, and the private-words file. Checks the byte size of the received spec (2,997 maximum), the next round, absence of a pending list, and the previous reply's digests of both decision files. | Reserves the ID, stages the scrubbed inputs, and writes `open.json` last. Returns the run directory, key base, paths for the constraint check and experts, and scrub counts. | Allocates a fresh ID. A lost response leaves an unused run. |
| `research-prompts` | `open.json`, the local decision snapshot, staged inputs and `constraints.json`. Requires an explicit completion flag and at most 20 constraints. | An incomplete check stops with `incomplete`. A contradiction of an accepted or rejected entry stops with `contradicts` and reports the entry. Otherwise writes one prompt per question and `prompts.json` last. Returns the prompts, expected output paths, byte sizes, unconfirmed limits and notes. | Verifies the constraints digest and compares all output bytes. Matching files return `already: true`. |
| `research-collect` | `prompts.json` and every expert's `answer.json`. Each answer must fit 256 KiB and supply items, assumptions and facts. Checks the merged line count (200) and serialized size (256 KiB) before preparing fact batches. | Missing or invalid answers return `complete: false` with question IDs and fields. Success writes the merged `answer.json`, checker prompts, input digests and `facts.json` last. Returns the list input path and digest, line counts, mechanical fact count and batch descriptors. | Recomputes the files and compares their bytes, including the expert input digests. A difference refuses the call. |
| `research-verdicts` | `facts.json` and the current checker answers. Each checker file must fit 256 KiB and contain verdicts with an ID, verdict and note. | Returns counts, up to 20 entries per result list and the checked report path. A missing or malformed file leaves its batch unchecked. An absent or duplicate verdict leaves that fact unchecked. Extra IDs are reported and ignored. | Recomputes `facts-checked.json` from the current checker files. |

## Run layout

```text
<tmp>/research/
  runs/<runId>                  exclusive empty reservation
  r<round>/<runId>/
    in/request.md
    in/q1.md                    one file per question
    attach/0-decisions.md       from the second round onward
    attach/1-tools.md           numbered copy of each supplied attachment
    context.json                local scrub fingerprints and decision entries
    open.json
    constraints.json            supplied by the constraint check
    q1/prompt.md
    q1/answer.json              supplied by the expert
    prompts.json
    answer.json                 merged input for list-build
    answer-hashes.json
    f1/prompt.md
    f1/answer.json              supplied by the checker
    facts.json
    facts-checked.json
```

The key base is `<label>-<runId>-rd<round>`. The label allows 1–48 ASCII letters, digits, dots, underscores and hyphens. Open draws eight lowercase hex digits and looks for the prefix `<label>-<runId>-` among jobs in `<repo>/.agent-tmp/rust/`. A matching job could return an earlier answer. Reserving the ID exclusively under `tmp` also prevents a fresh run from sharing another run's files. The allocator tries up to 16 draws, skipping a draw when its ID, key base or derived paths contain sensitive text.

Round 1 starts with an empty ledger. Later rounds follow the consecutive `appliedRounds` in `decisions.json`. If either decision file differs from the last closed reply, replay `list-reply` for that round before opening the next. Each destination and temporary path is checked for links and junctions before writing. JSON files use two-space indentation and a final LF. The helper writes a temporary sibling and renames it into place.

## Privacy and model inputs

Open decodes strict UTF-8, rejects NUL, strips one initial BOM, and normalizes CRLF and CR to LF. It redacts secret-shaped values, then replaces private words case-insensitively with `[скрыто]`, longest match first. Set `ZODCHI_DENYLIST` to the private-words file or use `~/.zodchi/private-words.txt`. Each nonempty, trimmed line supplies a literal word. Lines starting with `#` after trimming are comments. A missing or empty file requires explicit `allowNoScrub: true` and produces a note. Secret redaction still runs.

The label, visible temporary path and attachment basenames must pass the scrub unchanged. The gateway includes staged paths in its request. Attachment names use a sequence number followed by up to 64 characters of sanitized basename. Each staged attachment is capped at 200,000 bytes after numbering. Starting at 1, each source line receives its number, a colon and a space. An empty file has zero lines. A final line terminator does not add another numbered line.

Give the constraint checker the staged request, questions and decision attachment. Give each expert its generated prompt and the staged attachments in manifest order. Give the fact checker only its batch prompt. The helper keeps a local snapshot of the scrubbed decision entries and salted private-word fingerprints for later constraints and citations. Later helpers also read the current private-words file using the same resolution as open; the opening fingerprints and those captured when prompts are first prepared remain effective if words are removed or the file disappears. Current reading and decoding errors refuse the call. Derived text is scrubbed again, but staged attachments are immutable: if their content or visible names or paths become sensitive, the helper refuses with a fresh-round remedy rather than handing them to a model. Ready outputs are not restaged on replay; changed output bytes cause replay to refuse. Question titles remain limited to 80 Unicode code points after renewed masking. The workflow must select model inputs by the paths returned by the helper.

## Expert prompt

A confirmed constraint needs an accepted decision ID. A contradiction needs an accepted or rejected ID. Ineligible references become unconfirmed limits and produce notes. The limits section appears only when there are such limits. The attachments section appears when the round has attachments. The line allowance is the round budget (default 30) divided by the number of questions, rounded down, with a minimum of one. The prompt and all its staged attachments together must fit 500,000 bytes.

For one question with its default title, an unconfirmed wood-only limit and one tools attachment, the expert receives the following text, including the final newline.

```text
# Round 1, question 1 of 1: Вопрос 1

## Request
Мастерская [скрыто]: нужен план полки.

## Question
Из чего делать полку?

## Limits the owner has not confirmed
Do not take them as given: propose without them, or name the choice as an assumption.
- только дерево

## Answer size
Give at most 30 lines in items and assumptions together and at most 12 facts.

## Attachments
Each line of an attachment starts with its number and ": ". Cite a fact as <name>:<line> or <name>:<from>-<to>.
- 1-tools.md
```

Each expert returns `items` (at least one), `assumptions` and up to 12 `facts`. Each item supplies `text`, `group` and `replaces`. An empty group takes the question title. Each assumption supplies `text` and `why`. The merge retains question order within both arrays. Text and claims allow 1–600 code points, groups up to 80, reasons up to 300, and replacement lists up to 20 decimal decision IDs.

## Fact-check prompt

A fact supplies `claim` and `source`. Cite `<name>:<line>` or `<name>:<from>-<to>` using a staged attachment name and positive decimal numbers without leading zeros. A staged path or `attach/` prefix is accepted with either slash direction. The source is scrubbed both before and after slash normalization, and the claim is scrubbed before it enters the report. Each checkable fact receives up to two context lines on either side. Each batch fits 15 facts and 500,000 bytes. Blocks appear in answer order separated by one empty line.

For the second line of the four-line tools attachment, the complete batch is

```text
# Facts, round 1, batch 1 of 1

## F1.1
Claim: В мастерской есть клещи
Source: 1-tools.md:2
Lines 1-4 of 1-tools.md (cited: 2):
1: Молоток
2: Клещи
3: 
4: [скрыто] пила
```

| Mechanical reason | Meaning |
| --- | --- |
| `malformed source` | Invalid citation syntax or a reversed range. |
| `no such attachment` | The name does not identify a staged attachment. |
| `outside the file` | The cited end exceeds the file's line count. |
| `range over 40 lines` | The inclusive range exceeds 40 lines. |

Mechanical failures receive `not found` and their reason without a checker call. For every other fact, only one verdict from its assigned checker can establish `supported`, `contradicted` or `not found`. The helper always evaluates verdicts, including rounds with zero batches. Any unchecked fact makes the round incomplete. The workflow stops before building a list on an unchecked or contradicted fact and reports not-found facts alongside an otherwise eligible list.

On `complete: false`, `research-verdicts` rewrites only `facts-checked.json`. It records every unchecked ID and the reason, even when the returned list reaches its 20-entry limit. If a checker answer changes or disappears, the next call reflects its current contents. A previously supported fact can become unchecked.

