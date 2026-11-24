# Method question

Use this workflow to prepare a method before the first round of a new kind of game asset. It asks about the real object and game implementations, then drafts an options sheet with findings, inferences and gaps.

Run it from any terminal with the shared Zodchi installation.

```text
zodchi flow method-question --args /absolute/path/method.json --detach
zodchi flow status <run-id>
zodchi flow method-question --resume <run-id> --detach
```

| Argument | Value |
| --- | --- |
| repo | The absolute path to the Git checkout with the gamedev-unity domain enabled |
| tmp | The absolute output directory |
| label | A short title suitable for a gateway key |
| context | The asset, camera, budget, visual goal and what needs to change |
| realLife | An array of questions about the physical object |
| games | An array of questions about how game teams build it |
| models | Optional overrides for the researcher and methodEditor roles |

Supply at least one question. The research role reads public sources and the local project in a read-only Codex workspace. Each answer saves a public URL or an exact read-only tool command, an excerpt and unresolved questions. The synthesis role receives each question with its answer. A completed sheet covers each requested side and gives a conclusion or a gap. The sheet includes source excerpts, citations and unresolved research questions. It describes the costs, strengths and limits of each supported construction and names any lack of alternatives. The output records a missing side when the request supplies only one.

The shared journal records the model and gateway key for each question and the synthesis. Resume uses the original material and completed answers. Ask the owner before retrying a stopped model call with `--rerun <step>`. After completion the requested output directory contains a run-specific folder with `options.md`. The owner uses that sheet to choose the method for the ledger.
