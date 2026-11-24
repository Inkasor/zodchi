# Design brief

`design-brief` turns a goal and source evidence into a reviewed brief for `code-package`. Codex, Claude Code
and other terminal clients use the same Rust engine and local journal.

## Run a brief

Write a UTF-8 JSON file with your project paths.

```json
{
  "label": "export-resume",
  "goal": "Define how the nightly export resumes after an interruption.",
  "repos": ["/path/to/app"],
  "out": "/path/to/private-notes/export-resume.md",
  "questions": [
    { "question": "Where is export progress recorded?", "files": ["src/state.js"] }
  ],
  "context": ["/path/to/app/docs/plan.md"],
  "publicRepo": true
}
```

```sh
zodchi flow design-brief --args <file.json> --detach
zodchi flow status <run-id>
```

If the run asks for an owner decision, record the answer and continue the same run.

```sh
zodchi flow reply <run-id> --file <answer.txt>
zodchi flow design-brief --resume <run-id> --detach
```

Use `--answered 1,3` on `flow reply` to mark the first and third displayed questions as answered. Use
`--answered all` if the reply covers every displayed question. Flow keeps unmarked questions pending and removes
repeated answered questions from later drafts. A reply exactly matching an option in a single-question round
also records that question as answered. Free-text replies still reach the writer.

To close the decision round for the run, add `--no-new-decisions` to the reply. Flow carries open choices into
the brief as assumptions for review.

Resume an interruption with the same run ID. Flow reuses accepted research and completed jobs from that run.
If a call has an unknown outcome, inspect its recorded job and get a decision before an explicit retry.
`flow reply <run-id> --file <text>` also records a clarification for a stopped run. The stopped step stays in place.
Use `--resume <run-id>` to recheck a saved result, or add `--rerun <step>` to request a fresh answer with the
clarification. The clarification follows earlier owner answers in the next request.
The retired Claude workflows have a different journal format. Use their approved documents as context for a new brief.

## Arguments

| Argument | Meaning |
| --- | --- |
| `label` | Short identifier for the brief and journal. |
| `goal` | What the brief must accomplish. |
| `repos` | Absolute paths to Git checkout roots. Flow pins their commits and reads sources under aliases. |
| `out` | Absolute Markdown output path. Choose a private or ignored path to keep the brief outside Git. |
| `questions` | Optional questions as strings or objects with `question`, optional `repo`, and `files`. The first repository is the default. Flow plans file hints if needed. |
| `context`, `template` | Optional absolute paths to text documents. Supply a string or an array. |
| `publicRepo` | Set to true to screen public brief material for private text and local paths. |
| `allowPrivateWords` | For a private brief, list exact deny-list entries to allow in this run. For example, `["ExampleCompany"]` lets the brief name its tracked `docs/examplecompany-id.md`. Screening still covers all other private entries, credential patterns and local paths. |
| `gatewayRepo` | Optional Git checkout root for gateway configuration. Defaults to the first source repository. |
| `models` | Optional [role overrides](model-roles.md) for Codex or the opted-in Claude CLI executor. The default reviewer comes from the independent `reviewer` role. Set `models.architect` to choose a specific reviewer. |

Flow reads arguments directly from the file. A source or input document can occupy up to one third of the gateway
prompt limit (174,762 bytes). An explicit hint above that limit reports its file alias and byte count. The planner
receives only eligible Git files and `context-N.md` aliases for the supplied context documents. For a large
generated file, attach a focused extract in `context` and name the source and revision used to prepare it. Facts
from the extract cite its alias and visible lines.

If a research question has no readable input, Flow waits before calling the researcher. Use `flow reply <run-id>
--file <extract.txt>` with a screened extract of up to 2,000 characters and resume the same run. The reply is cited
as `owner-source.md`. The assembled goal and screened context must fit within half of the gateway prompt limit
before a model call. Local expert jobs and the run journal live under the Zodchi home directory.

## What the engine verifies

1. The researcher supplies the line number and a verbatim excerpt for each fact. Flow checks the excerpt against that
   visible line of the pinned source and records the whole line with the fact. The researcher can report withheld lines
   in `unknowns`. Flow keeps the verified facts and records the position and reason of each rejected citation in the
   journal. If no citation can be verified, the evidence gap goes into `unknowns`. Private unresolved points are
   withheld individually, and the journal records their count.
2. The writer drafts Markdown with a title and the `## Review boundary` and `## Checks` headings.
   Flow also recognizes the Russian headings `## Границы ревью` and `## Проверки` and emits the canonical headings.
   In an owner decision, `default` is the verbatim text of one option. An unmatched recommendation is shown as
   `null`, and Flow keeps the decision open for the owner to answer.
3. An independent reviewer judges the draft and reviews the revision when changes are requested. Flow writes the approved
   Markdown with a single ownership marker and records the SHA-256. A file owned by another label is protected.

Model calls and their selected roles are recorded by step. The engine handles sources, validation, storage and publication locally.
Start a separate `code-package` run when the brief is ready.
