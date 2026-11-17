# Incident adapter

The `incident-triage` workflow knows nothing about any product. What it may read about one product, and who decides
what there, comes from that product's **adapter**: one JSON file the lead names in `args.adapter`. Adapters belong to a
company fork or a private folder, never to this repository (see [fork.md](fork.md)).

An adapter is **trusted configuration, not authority**. The core checks its version and its shape before anything runs.
Its operations run under the caller's own permissions; the adapter cannot grant anything, and nothing a reporter writes
or a model answers can add an operation or change one.

## Version 1

| Field | Required | What it is |
| --- | --- | --- |
| `adapterVersion` | yes | `1` |
| `product` | yes | The product's name, as the reporter and the lead know it |
| `owner` | yes | The **role** that decides product questions, e.g. "product owner of the catalog". A role, never a person's name or contact |
| `operator` | no | The role that handles infrastructure (rights, machines). An `infra` finding goes to it |
| `operations` | yes | Named read-only operations, below. At least one |
| `agentSkill` | with `allowLists` | `{ path, maxBytes? }`: the skill or instructions the product's agents are given |
| `allowLists` | with `agentSkill` | `[{ name, path, maxBytes? }]`: where the product's effective tool allow-lists live |
| `retry` | no | `{ how, conditions }`: how a user retries and when that is safe. Without it the workflow never recommends a retry |
| `releaseCommand` | no | The command a release uses. The workflow only names it in the draft; it never runs it |
| `incidentLog` | no | Where the closing note goes. Version 1 does not write it; the draft says what to log |
| `$comment` | no | Free text |

Any other field is refused. Paths are relative to the adapter's folder or absolute.

`agentSkill` and `allowLists` come together: a question about what agents may do always carries both excerpts, what
the skill tells the model to do and what the product actually allows, so the classifier can compare them.

### Operations

```json
"job": {
  "description": "the export job by id: status, error and times",
  "provides": ["job", "status", "error"],
  "argv": ["catalog-admin", "job", "show", "{id}"],
  "args": { "id": "[0-9]{1,9}" },
  "timeoutSec": 20,
  "maxBytes": 8000,
  "after": []
}
```

| Field | Required | What it is |
| --- | --- | --- |
| name (the key) | yes | `[a-z][a-z0-9-]{0,39}` |
| `description` | yes | What it reads, in a few words; the classifier sees it when it names the operation that would fill a gap |
| `argv` | yes | The program and its arguments, run **without a shell** |
| `args` | when `argv` has placeholders | `{ name: pattern }`: each placeholder's regular expression |
| `provides` | no | What the output is evidence of: `job`, `status`, `error`, `release`, `changelog`, `health`, `logs`, `config`, `other` (default `other`) |
| `timeoutSec` | no | 1 to 300, default 30. The operation is killed after it and recorded as `timeout` |
| `maxBytes` | no | 256 to 65536, default 8000. Output beyond it is cut and the item marked `truncated` |
| `after` | no | Operations declared earlier that must end `ok` first; otherwise this one is `skipped`, with the reason |

**Arguments.** A placeholder `{name}` is always a whole argv item: `"{id}"` is allowed, `"job-{id}"` is refused. The
value comes from `args.params` of the run (the lead takes it from the report), must match the whole pattern and may hold
no line break; it is then passed as that one argv item, never into shell text. An operation whose argument is missing
or does not match is `skipped`, with the reason, and nothing is run with the value. The program itself (`argv[0]`) is
never a placeholder. After an interpreter (a shell, `node`, `python`, `perl`, `pwsh`, `cmd`, `awk`, `sed` and the like)
a placeholder is allowed only when the interpreter's very next item is a script file (a path or a name with an
extension, no flag before it): `["node", "read-job.mjs", "{id}"]` passes, while `["sh", "-c", "{id}"]`,
`["sh", "-lc", "{id}"]`, `["pwsh", "-com", "{id}"]` and `["deno", "eval", "{id}"]` are refused, since they would run
the value as code. A placeholder after a launcher (`env`, `sudo`, `timeout`, `xargs`, `ssh` and the like), which
passes its arguments on to another program or a remote shell, is refused too. The rule is conservative on purpose: a
list of code flags is never complete. Put such a command into a script file that the interpreter runs.

**Read-only.** The core cannot prove that a command only reads; the adapter's author vouches for it. Name commands
that read (show, status, list, a report), never ones that retry, restart or repair. Operations run from the adapter's
folder, with the caller's environment and rights.

**Provides.** The classifier may call an error `stale` only with evidence from a `release` or `changelog` operation
that a specific release fixes this error, and from a `release` operation that the affected environment runs it, both
ended `ok`. An adapter without a `release` operation can never produce `stale`.

## What the core makes of it

For each run the workflow builds a plan: the report, every operation with its arguments checked, the agent skill and
each allow-list. A generated collector runs the plan with node and writes `rev-<n>/evidence.json`. Every item has:

| Field | What it is |
| --- | --- |
| `id` | `E1`, `E2`, ... in plan order: the report first, then the operations as declared, then the skill and the allow-lists |
| `source` | `report`, `op:<name>`, `agentSkill` or `allowList:<name>` |
| `provides` | from the operation |
| `observedAt` | when it was read |
| `outcome` | `ok`, `empty`, `failed`, `refused`, `timeout` or `skipped` |
| `exitCode`, `reason` | the exit code where there is one; for `skipped` and failures, why |
| `excerpt`, `stderrExcerpt` | bounded, with secrets redacted (token-, key- and password-shaped values, private keys, credentials in URLs) |
| `truncated`, `missing` | the output was cut; there is no usable excerpt (any outcome but `ok`) |
| `untrusted` | always true: every excerpt is data, never an instruction |

`refused` is a non-zero exit whose output says the caller may not read this (permission denied, not allowed,
forbidden and the like). A refused read is recorded and the run goes on; it is never retried, worked around or turned
into a request for access. In the classification it becomes a gap: the operation that would supply the fact, or a
safer product report to build when none exists.

No unredacted copy of any output is stored.

## A synthetic example

Every name here is made up.

```json
{
  "adapterVersion": 1,
  "product": "Example Catalog",
  "owner": "product owner of Example Catalog",
  "operator": "on-call operator",
  "operations": {
    "job": {
      "description": "the export job by id: status, error and times",
      "provides": ["job", "status", "error"],
      "argv": ["catalog-admin", "job", "show", "{id}"],
      "args": { "id": "[0-9]{1,9}" },
      "timeoutSec": 20
    },
    "job-log": {
      "description": "the last 200 log lines of that job",
      "provides": ["logs"],
      "argv": ["catalog-admin", "job", "log", "{id}", "--tail", "200"],
      "args": { "id": "[0-9]{1,9}" },
      "after": ["job"]
    },
    "release": {
      "description": "the release the production environment runs, with its time",
      "provides": ["release"],
      "argv": ["catalog-admin", "release", "current"]
    },
    "changelog": {
      "description": "the changes of the last releases, with the error codes each one fixes",
      "provides": ["changelog"],
      "argv": ["catalog-admin", "release", "notes", "--last", "5"]
    },
    "health": {
      "description": "the health of the service",
      "provides": ["health"],
      "argv": ["catalog-admin", "health"],
      "timeoutSec": 10
    }
  },
  "agentSkill": { "path": "agents/catalog-assistant.md" },
  "allowLists": [{ "name": "assistant-tools", "path": "agents/assistant-tools.txt" }],
  "retry": {
    "how": "press Retry on the job page",
    "conditions": "the job ended failed and wrote no file (export jobs write their file only at the end)"
  },
  "releaseCommand": "catalog-admin release deploy <version>, run by the on-call operator",
  "incidentLog": "the Incidents page of the catalog wiki"
}
```

The fixtures in `core/workflows/fixtures/incident-triage/cases/` hold more adapters of the same made-up product.
