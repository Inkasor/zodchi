# Unity check

Run a pinned sequence against a running Editor for the exact Unity project. The local Unity CLI and Pipeline package must expose the read-only state query and requested commands. Prepare the step list from the running Editor's command catalog.

```text
zodchi flow unity-check --args /absolute/path/unity-check.json --detach
zodchi flow status <run-id>
zodchi flow unity-check --resume <run-id> --detach
```

The arguments name an absolute Git `repo`, output directory `tmp` and JSON `steps` file. Optionally give the absolute Unity CLI executable path in `cli` and a note for the result. The gamedev-unity domain must be enabled.

The step file contains the absolute Unity `project` within that checkout and a `steps` array. Each step names an Editor `command`, its string `args` array, and `expect`, a map of JSON pointers to exact values from the command result. A capture step names a unique PNG filename in `capture` and uses one `{capture}` argument to select its generated path.

The workflow checks the project's Editor, Play mode, compilation and scene dirtiness before running the plan. An explicit `ownerRelease` object can name the exact scene and permit `dirty` or `playing`. It refreshes assets, waits for the same Editor and checks the error console before the first step. A mismatched expectation ends the run with the step and the mismatched JSON pointers.

Every step receipt identifies the Editor and contains the readback and any capture digest. A resumed process skips steps with durable results. An interrupted command with an uncertain effect remains visible for reconciliation.
