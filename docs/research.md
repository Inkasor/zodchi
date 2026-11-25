# Native research

Run `zodchi flow research --args <file.json>` to prepare an owner decision list. Add `--detach` to run in the background, inspect with `zodchi flow status <run-id>`, and resume with `zodchi flow research --resume <run-id>`. Record an owner response with `zodchi flow reply <run-id> --file <reply.json>` and resume the round.

The native workflow uses a local Codex executor. Its JSON arguments require `repo` (Git checkout), `tmp` (research state directory), `label`, `request` (text file), and `questions` (one to five objects with `file` and optional `title`). Use `attachments` for additional files. The round allows 30 proposal and assumption lines by default. Set `maxLines` to change that limit.

Use the `constraintChecker`, `researchExpert` and `factChecker` entries in the model table or in `args.models` to choose the models and efforts. The run records the effective selections and reuses them on resume.

Before model submission, the workflow scrubs input using the configured private-words file. A missing or empty file requires explicit `allowNoScrub: true`. Opening private words, newly configured words and private paths are also scrubbed from owner remarks before each new request is saved.

After the constraint check, the workflow submits up to two question jobs before waiting for their answers. It merges answers in question order, then checks the cited facts in batches of up to 15, splitting earlier when the next excerpt would exceed the prompt size. Up to two batches can run at once. A failed wave finishes collecting its started jobs and stops the round. The fact report keeps each valid unique verdict, marks unresolved facts as unchecked and lists unexpected checker IDs under `extraIds`. A contradiction also stops the round before the owner list.

On resume, the workflow reads completed answers from the journal and reattaches to running jobs by their recorded keys. Fact batches with a recorded request keep their original boundaries. The remaining batches are sized to include current owner remarks. If a job ended with an unknown outcome, the stop result identifies its key. An intent with neither a submission receipt nor a job also stays unresolved. Resuming a stopped round returns its saved result.

The workflow collects each started peer by key and checks its answer under the current privacy rules. After collection, a failed job with evidence that the turn was neither requested nor started qualifies for up to two retries. Each retry checks the saved prompt against the current privacy rules before submitting it with a new key.

Inspect the unconfirmed limits and fact report before replying. For example, `[{"n":1,"verdict":"accept"}]` accepts the first proposal. The workflow records the reply in the run journal and applies it once to `decisions.json` in the research state directory.

A reply can include a `fix` of up to 600 characters for each line. This limit applies to the owner's text before privacy markers are inserted. The JSON file limit is 2 MiB. Omitted lines stay open. Accepting an earlier open proposal by ID also supersedes the targets recorded when it was proposed.
