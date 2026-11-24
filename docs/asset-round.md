# Asset round

Run one blockout or look round for an asset with an accepted method in its ledger. The native workflow records each step and leaves the resulting frames and evidence with the owner for a verdict.

```text
zodchi flow asset-round --args /absolute/path/asset.json --detach
zodchi flow status <run-id>
zodchi flow reply <run-id> --file /absolute/path/owner-verdict.txt
zodchi flow asset-round --resume <run-id>
```

Supply an absolute Git `repo`, a `ledger` JSON file within it, an absolute scratch folder `tmp`, a short `label`, a round `summary` and `stage` 1 or 2. Choose one or more of these stages in the arguments.

| Argument | Value |
| --- | --- |
| package | Absolute args file for a scoped native code-package on this repository |
| check | An explicit command and its cwd within the repository |
| export | An explicit export command and cwd, with expected FBX paths under tmp in files |
| unity | Absolute args file for unity-check on the same repository |
| rubric | A named Decisions role and paid true for the frames from unity-check |

The ledger accepts `method` at blockout and `lookMethod` at the look stage. An unjudged preceding round stops a new run. After three rounds without acceptance under the selected method, record a new method before continuing. The workflow uses the same run ID to recover each child. Owner questions in a child workflow are answered on that child's journal.

At the end it records one round, including any failed step and all captured frames. The owner replies with the exact one-line verdict. Use `accepted` at the start of the verdict for acceptance, or configure the prefix with `accepted` in the round args. Accepting the owner decision closes that round. The legacy free-form apply instructions can be expressed as a scoped code package before use with the native workflow.
