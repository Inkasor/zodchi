# Rubric probe

Use this workflow to check how each Decisions question behaves on frames with known defects and on frames already judged sound. The report shows which questions pass every sound frame and catch every frame marked defective for that question.

```text
zodchi flow rubric-probe --args /absolute/path/probe.json --detach
zodchi flow status <run-id>
zodchi flow rubric-probe --resume <run-id> --detach
```

| Argument | Value |
| --- | --- |
| repo | The absolute path to the Git checkout with the gamedev-unity domain enabled |
| tmp | The absolute output directory |
| label | A short name suitable for a gateway key |
| role | The name or absolute path of an expert Decisions role with rated questions |
| frames | Objects with an absolute file path, a note, a sound boolean and optional defects containing question names |
| paid | Set to true after the owner approves this batch of paid calls |

The local Decisions gateway uses the caller's OpenAI API key for one call per frame. The workflow checks the whole batch before starting. It saves the checked PNG, JPEG or WebP bytes and the rubric in the run journal. Resume keeps the same frames, inputs and keys. Additional spend after an unknown result requires a decision from the owner before explicitly retrying that frame.

A complete result is written to the requested output directory under a run-specific folder as `verdicts.json`. The report includes each frame's outcome and available input-token counts.
