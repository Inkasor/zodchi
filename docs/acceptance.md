# UI acceptance

`release-acceptance` checks a deployed web application. `candidate-acceptance` runs committed project tests against a local candidate. `player-acceptance` runs a project's prepared Windows player scenario. They use the local Rust executor and the same run journal from Codex, Claude Code or another terminal.

```text
zodchi flow release-acceptance --args <file.json> --detach
zodchi flow candidate-acceptance --args <file.json> --detach
zodchi flow player-acceptance --args <file.json> --detach
zodchi flow status <run-id> --handoff
zodchi flow <workflow> --resume <run-id> --detach
```

Start the workflow on the machine that can run the browser or player. A Windows private desktop requires the local interactive user session. The executor records whether the input desktop stayed the same. A completed run exits 0 on `pass` and 2 on `fail`, `blocked` or `unclear`. Status displays the completed scenarios and evidence path. Resuming reuses recorded tool and model receipts. If a tool ran and lost its receipt, the run stops at the uncertain effect. Inspect its log and use a new run if a repeat is appropriate.

All workflows take an absolute Git `repo`, a `label` and a `scenarios` array. Supply `head` to pin a commit SHA. The player workflow uses the repository's HEAD when it is omitted. All scenarios run in order unless `choose` supplies a goal. In that case the `acceptor` chooses a subset of the declared IDs from their labels. The engine runs the selected scenarios in plan order. Add `review` with a visual criterion to let the `acceptor` assess the final frames after the scripted checks pass. Include only material that the project permits sending to the model. Selection and visual review default to Terra 6.1 `medium` via Codex. Use the usual `models.acceptor` role table to override it. Runs with neither `choose` nor `review` execute with zero model calls.

## Local candidate

```json
{
  "repo": "/projects/dashboard", "head": "<candidate-commit>", "label": "Local candidate",
  "setup": ["npm ci"],
  "browser": { "executable": "/tools/chromium", "variable": "WB_TEST_CHROME" },
  "review": "Check both screens",
  "scenarios": [
    { "id": "overview", "label": "Overview", "test": "tests/overview.mjs", "frames": ["overview.png"] },
    { "id": "details", "test": "tests/details.mjs", "timeoutSeconds": 120, "frames": ["details.png"] }
  ]
}
```

The required `head` identifies the exact commit; tests must be regular files committed at explicit repo-relative paths. Flow creates a private checkout with that commit as HEAD and verifies its tree and tracked state before setup, each test and each result. Setup is an optional list of shell commands, run once in order with the bounded checks runner; dependencies and generated files must be ignored or written to the supplied output folder. A lost setup or test receipt after execution stops the run rather than replaying an uncertain effect.

`browser.executable` names the dedicated Chromium executable; `browser.node` optionally names Node, otherwise Node is found on PATH. Tests receive the Chromium path in `ZODCHI_ACCEPTANCE_CHROMIUM`, or in the uppercase environment variable named by `browser.variable`, and a unique scenario output directory in `ZODCHI_ACCEPTANCE_FRAMES`. Only the reduced tool environment and these paths are passed. Flow invokes Node with `--test --test-reporter=tap`; a successful exit must include passed tests. Each `frames` entry is a distinct direct image filename in that output directory. Visual review requires at least one verified image per selected scenario, supports up to six selected scenarios and reports omitted frames.

These are trusted project programs: they start their own headless browser and local fixture server. They are not network or filesystem sandboxes. Do not use a production browser profile or an external production site. This local candidate evidence does not establish which commit is deployed; use release acceptance for that check.

## Managed local browser fixture

For declarative browser steps against a local candidate, commit a Node fixture which listens on loopback and writes exactly one readiness line to stdout, for example `ZODCHI_FIXTURE_READY http://127.0.0.1:4321`. The port must be explicit and nonzero; it may be allocated dynamically. A fresh fixture starts for each scenario in the pinned checkout and is stopped after the browser completes. Fixture scripts are trusted programs, not sandboxes.

```json
{
  "repo": "/projects/dashboard", "head": "<candidate-commit>", "label": "Local browser candidate",
  "browser": { "executable": "/tools/chromium", "module": "/tools/playwright/index.js" },
  "setup": ["npm ci", "npm run build"],
  "fixture": { "script": "tests/fixture.mjs", "timeoutSeconds": 30,
    "allowedWrites": [{ "method": "POST", "path": "/api/dashboard-runtime" }] },
  "scenarios": [{ "id": "overview", "steps": [{ "id": "open", "open": "/", "expect": { "selector": "#summary" } }] }]
}
```

Save this as `candidate.json`, replace the paths and commit SHA, then run `zodchi flow candidate-acceptance --args candidate.json`. The fixture may instead name an absolute caller-owned regular script, pinned by digest before and after execution. Optional `args` is an array of strings; `readyPrefix` replaces the default `ZODCHI_FIXTURE_READY ` prefix, and `timeoutSeconds` is 1 to 120 seconds. `ZODCHI_FIXTURE_OUTPUT` names a unique owned output directory. Optional `storageState` is a direct filename that the fixture writes there before readiness; the browser screens its contents as described below. Do not supply `baseUrl` or `health` in fixture mode. The browser is headless and blocks writes by default. `allowedWrites` optionally lists up to 32 exact method and pathname pairs (POST, PUT, PATCH or DELETE); no query, percent escapes, dot segments or wildcards are allowed in the declaration. Only these same-origin requests are permitted, and redirects remain blocked. This allowance exists only for managed fixtures, never deployed or separately launched endpoints. Setup can install dependencies and build the UI: a healthy API alone does not guarantee `dist/index.html` exists. Local checkout evidence does not prove deployment; release acceptance still requires its health SHA checks.

## Browser

Set `baseUrl`, `health` and optional `storageState` at the top level of the arguments file. The top-level `choose` and `review` each take one string. Keep Chromium settings in `browser`.

```json
{
  "repo": "/projects/dashboard",
  "head": "<deployed-commit>",
  "label": "Dashboard release",
  "baseUrl": "https://dashboard.example.test",
  "health": { "path": "/api/health", "pointer": "/release/commit" },
  "storageState": "/private/dashboard-session.json",
  "browser": { "executable": "/tools/chromium" },
  "choose": "Check the dashboard rollout.",
  "review": "Confirm the selected account and its total are visible.",
  "scenarios": [
    { "id": "overview", "steps": [{ "id": "open", "open": "/analytics", "expect": { "selector": "#summary" } }] }
  ]
}
```

Pass an HTTPS `baseUrl` containing only the product origin, or HTTP on loopback for a local fixture. Give the deployed `head` and a `health` endpoint with a JSON pointer to its release SHA. The script checks the SHA before and after each scenario. Supply `browser.executable` for a separate Chromium for Testing binary. `browser.isolation` defaults to `headless`. On Windows `private-desktop` launches the rendered browser on its own inactive desktop. Both use a fresh browser context with the declared viewport. `browser.node` can select Node by path, otherwise the executor finds it on PATH. Install Playwright 1.48 or later into `<zodchi-home>/acceptance-browser` or set `browser.module` to the absolute Playwright module entry point. Use the Playwright installer to install the matching dedicated Chromium binary.

The product can publish its deployed revision at `GET /api/health` as `{"release":{"commit":"<sha>"}}`. Then use `"health": {"path":"/api/health","pointer":"/release/commit"}`.

`storageState` can point to a locally prepared Playwright state file for a read-only product identity. The adapter keeps site storage for the configured origin and cookies scoped to its host. This includes parent-domain cookies with a leading dot, such as `.example.test` for `dashboard.example.test`. A host-only cookie belongs to its exact host. Cookies, passwords, headers and full API payloads stay out of model requests. Screenshots and matched numeric values are local artifacts. The browser blocks write methods, WebSockets, redirects, cross-origin requests and service workers. Use the product's ordinary read-only permissions and a prepared session for pages that require authentication.

Every scenario contains `id`, an optional `label`, and `steps`. Start with `open`, a path on the product origin. Later steps can use `click`, `select` with `{ "selector": "…", "value": "…" }`, or `check` with `{ "selector": "…", "checked": true }` or `false`. Each step has one action and an `expect`. A condition needs exactly one visible element matching `selector` and, if supplied, exact `text`.

Additional actions use `"fill": {"selector":"#date", "value":"2026-11-25"}`, `"hover":"#menu"`, and `"press":{"selector":"#search", "value":"Enter"}`. Fill and press values are strings of at most 4096 bytes (fill can be empty). Action locators must identify one element. A managed fixture click can declare `"click":{"selector":"#open", "popup":true}` to continue in a same-origin popup, or `"click":{"selector":"#export", "download":"download-report.csv"}` to capture a download. Download names must start with `download-`, contain only ASCII letters, digits, dots, hyphens and underscores, be at most 100 bytes, and be unique without colliding with frames. A file must actually be saved and is pinned in the evidence. Popup and download are mutually exclusive.

A condition can specify `"count":0` for absence or a bounded count up to 10000; the default is one visible element. `text` requires count one. `"normalizeWhitespace":true` collapses whitespace, including NBSP, before text comparison.

Both `expect` and the optional scenario-level `ready` take one condition or an array of up to eight conditions, all required. Flow checks `ready` before evaluating a step's expectations and before reading the API comparison. Use a readiness selector that reflects the completion of the current load or filter change. `maxSeconds` measures from action to readiness and expectations. It accepts whole seconds from 1 to 60 and defaults to 5.

The local receipt records captured frames, unmet conditions with selector counts, console error counts and screened first lines, and network paths without queries or fragments. `causedByAdapter` is true for a console load error matched to a request the adapter deliberately blocked. A console line without this evidence is left unattributed.

One scenario fragment

```json
{
  "id": "ad-spend",
  "label": "Read the amount for 28 days",
  "ready": { "selector": "#dashboard[aria-busy=false]" },
  "steps": [
    { "id": "overview", "open": "/analytics", "expect": { "selector": "#summary" } },
    { "id": "period", "click": "#last-28-days", "expect": { "selector": "#period", "text": "28 days loaded" } },
    { "id": "account", "check": { "selector": "#account-a", "checked": true }, "expect": [{ "selector": "#account-a:checked" }, { "selector": "#amount" }] }
  ],
  "apiCheck": { "path": "/api/amount?days=28&account=a", "pointer": "/coverage/spend", "selector": "#amount", "decimal": ",", "extract": "first-number", "tolerance": 0.01 }
}
```

Set the API path and matching filters together. `apiCheck` reads the numeric text from the selector and the scalar at the pointer. The comparison uses the measured difference and declared tolerance. For elements containing a label or currency, set `"extract": "first-number"` to use the first number in the displayed text. With `"decimal": ","`, a value such as `1 234,50 ₽` reads as `1234.5`. The extractor accepts regular and nonbreaking spaces as thousand separators. Without `extract`, supply a selector whose full text is the amount.

The comparison requires a single visible element. `apiCheck` in the receipt shows the match count, visibility and bounded screened element text, alongside the compared numbers. A missing, hidden or ambiguous amount fails the comparison. A numeric zero needs visible evidence, just like any other amount.

The Playwright adapter is the browser driver. The Rust executor owns the scenario plan, local process, model routing, evidence hashes and journal.

## Visual review

`review` is an optional, top-level criterion string for either workflow.

```json
{ "review": "Confirm the filtered total is visible on the final frame." }
```

The model returns `{"verdict":"pass","reason":"The filtered total is visible."}`. Allowed verdicts are `pass`, `fail` and `unclear`. A nonempty `reason` explains the verdict from the attached frames. Find the response at `result.review.answer`.

## Windows player

Each scenario has an `id`, optional `label` and a sequence of trusted `steps`. Each step selects a native `program` and a separate `args` array. List scripts, assemblies and other important files in `inputs` to pin their bytes alongside the executable. `{runDir}` expands to the scenario's private state directory and `{stepDir}` expands to a fresh evidence directory for that step. A save and a resume step can use the same test slot in `{runDir}`. The executor starts each step in a separate inactive desktop and verifies its real exit code. The player test harness supplies input inside the game and writes its observations.

Set `receipt` to a JSON file the tool writes inside `{stepDir}`. `expect` maps JSON pointers to exact values. `match` can name an earlier step and list pointers whose observed values must match. List screenshots or additional receipts in `artifacts`. The executor records their hashes and decodes images before they are available for review. `timeoutSeconds` is per step and defaults to 120.

One resume step fragment

```json
{
  "id": "resume",
  "program": "/local/qa/PlayableYard.exe",
  "args": ["--solo-save", "{runDir}/slot.save", "--yard-evidence", "{stepDir}", "--ui-acceptance", "resume"],
  "inputs": ["/local/qa/PlayableYard_Data/Managed/Assembly-CSharp.dll"],
  "receipt": "after-resume.json",
  "expect": { "/paused": true },
  "match": { "step": "save", "pointers": ["/checkpoint", "/tick", "/position", "/crate"] },
  "artifacts": ["resume-screen.png", "result.png", "result.json"]
}
```

Choose the program and its arguments from a trusted project test plan. Keep game saves and evidence in the allocated directories. This route runs an already prepared player and test harness. `unity-check` remains available for commands against a running Editor.
