# Rewriting a service with a differential oracle

This note is for a developer who wants to rewrite a service and prove that the new engine behaves like the old one. It describes the part that exists now, the comparison module `domains/web-apps/scripts/oracle/compare.mjs`, and says what comes with the next packages. The CLI, the file formats and the adapter contract are NOT in this package: they arrive with packages 2 and 3, and nothing here is a promise about their final shape beyond what is written in the last section.

## Why

An earlier rewrite was declared equal after 361 scenarios and 0 differences. That run compared responses and start-up rows only. An independent architecture review found four holes in it, and the design below closes them:

- F1, isolation: each engine must run on its own store, fake state and call log from one versioned seed, so one engine can not feed the other and no request can leave the machine.
- F2, field-scoped binding: an opaque value (an id) is neutralized only at a location the scenario declares, never by "any string that looks like the id", because that hides a real difference.
- F3, differences as executable expectations: an accepted difference is a record that matches one step, one path, one old value and one new value, not a prose note or a pattern.
- F4, a protected coverage manifest: what must be compared is a list the port author does not edit.

F5 (switch and rollback) and F6 (traffic capture) are not part of this feature.

## What lives where

| Piece | Lives in zodchi | Lives in each service |
| --- | --- | --- |
| Comparison module (`compare.mjs`) | now (package 1) | |
| File loading, hashes, scenario selection | package 2 | |
| Runner, report, gate rules, fake server, CLI | package 3 | |
| Workflow that drives a rewrite | package 4 | |
| Adapter (starts an engine, resets it, projects effects) | | yes |
| Seed and fixtures | | yes |
| Scenarios and the coverage manifest | | yes |
| Effect projections (rows, outgoing calls, pending jobs) | | yes |
| Expectations, each with its approver | | yes |

## The contract of `compare.mjs`

The module is pure: it imports nothing, reads no file, starts no process and makes no request.

### The view

A step view is `{ response: { status, headers, body }, effects: { rows, calls, jobs } }`. `headers` holds only the lower-case names the adapter allows. `body` is the parsed JSON when the content type contains `json` (the text if parsing fails), the text otherwise, and `null` when empty. `rows` is `{ table: [row] }`, `jobs` the pending jobs, `calls` the outgoing calls made during this step only. A view is JSON data until `normalizeView` puts bound references into it.

### Paths

A path is the unit of every approval, so it is unambiguous. It is text: segments joined by `.`; a key may be followed by any number of `[n]` (a canonical non-negative integer) or `[*]` suffixes, and a path may start with a suffix. In a key a backslash escapes the next character, and `.`, `[`, `]` and the backslash must be escaped. So the key `a.b` is written `a\.b`, the key `a[0]` is `a\[0\]`, the key `0` is `0` and the array index 0 is `[0]`. The empty text is the root. `parsePath` returns typed segments (`{ key }`, `{ index }`, `{ any: true }`), `formatPath` returns the one canonical text, and two different segment lists never give the same text. A key that is the empty string has no text: `formatPath` and so `diffViews` throw on it, which is a refusal, not a silent merge. `readPaths` expands `[*]`, reads only own properties of plain objects and elements of arrays, and gives nothing for a path that does not exist.

### Binding at declared locations

A step may declare `bind` and `refs`:

- `bind` is `{ NAME: { at, pattern, unique? } }`. `at` is a concrete path starting with `response` or `effects`. The value there must be a string (else `bind-missing`) that matches the pattern as a full-string regular expression (else `bind-pattern`). A name bound already is `bind-rebound`. Unless `unique` is `false` the value must differ from every value bound earlier in the sequence under any name (else `bind-not-unique`). A bind with a violation stores nothing and leaves the raw value in place. A valid bind records the engine's value in the state and replaces the value with a bound reference.
- `refs` is `[{ at, to, template?, persist? }]`: at this location the contract requires the value bound under `to`. The expected text is the `template` (default `{value}`, which must contain `{value}` exactly once, else `ref-template`) with `{value}` replaced by the bound value. The location may use `[*]`; zero matches is `ref-missing`, an unbound `to` is `ref-unbound`, and each matched value must be EQUAL to the expected text (else `ref-mismatch`; never "contains"). An id field uses the default template; a composite field such as a `Location` header declares one, for example `/notes/{value}`.
- `persist: true` applies the same ref in every later step of the sequence, because cumulative effects repeat an earlier row. A persisted ref that matches nothing in a later step is a `ref-missing` violation, so a scenario that removes the row simply does not persist that ref.

Why nothing else is replaced: a string that equals or contains a bound value at an undeclared location is a fact about the service, and an old-engine id there against a new-engine id there IS a difference. A value that merely looks like an id is not replaced either. A bound reference is a private value, not a string and not a plain object; two references are equal when name and template are equal, and the display text `<bound:NAME>` is never read by a comparison, so a literal string with that text is a difference against a real reference. `normalizeView` works on a deep copy, mutates only the state, and returns `{ view, violations }`.

`substitute(request, bound)` replaces `{{NAME}}` in the path, every header value and every body string (never in keys), throws on an unbound name, leaves text that is not of the name grammar alone, and does not scan replaced text again.

### Differences

`diffViews(oldView, newView)` returns `[{ path, old, new, oldAbsent, newAbsent }]` in a fixed order (keys in code-point order, indices ascending). Key order never matters, array order always does. Arrays of different length are one diff at the array path holding both arrays. A key missing on one side has the flag `true` and the value `null` on that side, so a present `null`, a present `{ "$absent": true }` and an absent key are three different things. A literal key `a.b` and a nested `a` then `b` give diffs at different canonical paths.

### Expectations

`createTracker(expectations, scenario)` returns `{ apply(diffs, step), unused() }`. An expectation is `{ id, scenario, step, at, old, new, oldAbsent?, newAbsent? }`. A diff is approved only by an expectation of this scenario whose step equals the step, whose canonical `at` equals the diff's path, whose presence flags equal the diff's and whose `old` and `new` deep-equal the diff's values. A parent path never approves a child diff and a child never a parent. An expectation approves at most one diff, and approves one step only: a cumulative effect that repeats in a later step needs its own expectation there, or the repeat is a mismatch. `apply` is called once per step with all diffs of the step, without deduplication or a cap; a second call for the same step throws. `unused()` lists the expectations that approved nothing, an expectation of a step never applied included.

### The display never decides

`summarizeDiffs(diffs, cap = 50)` drops repeats and cuts the list for DISPLAY only. The verdict of a sequence (any unapproved diff, any violation, any unused expectation) is computed from the full output of `apply`, with `unapproved(diffs)`, never from a displayed list. An approved and an unapproved diff with the same path and values are never merged.

### `targetUrl`

`targetUrl(baseUrl, path)` is called after `substitute` and before any request. The base must be exactly an origin written as `http://127.0.0.1:<port>` (port 1 to 65535, no path, query, fragment or user info; a trailing slash is allowed). The path must start with one `/` and not `//`. The result is the URL built from them, and the function throws unless its protocol, host and port equal the base's; this catches the backslash form, an absolute URL and a scheme-relative one. The runner of package 3 keeps redirects manual and never follows one to another origin.

### `validateEffects`

`validateEffects(effects, seenCalls)` returns `null` for a well-formed projection and the fixed text `effects malformed` otherwise. Well formed: a plain object with exactly `rows`, `calls` and `jobs`; `rows` a plain object whose values are arrays of plain objects; `calls` an array of plain objects with at least `seenCalls` entries; `jobs` an array of plain objects; every value anywhere JSON data (string, finite number, boolean, `null`, array, plain object). A cycle, an `undefined`, a function, `NaN`, a bigint or a symbol is malformed, and the function never throws and never hangs. A projection malformed for both engines is still malformed for each: equal garbage is not equal behavior.

## Constraints on the later packages

- `approver` is free text naming a role, with no expiry and a free-text review condition. It is a record, not proof. A hash pin only shows which bytes CI used. Until the service names one role that alone may change the accepted pin, through a review outside the port author's control, the approvals are not an approval gate, and the docs of package 2 must say so.
- The reusable CLI lives in `domains/web-apps/scripts/`, in the web-apps plugin. Before its invocation is published as a service CI contract, package 3 or later must prove that an installed copy finds the CLI of the matching revision.
- A service's CI runs the CLI from a zodchi checkout pinned to an exact commit; the commit and the CLI call stay in one CI step.
- A service keeps its oracle files in an `oracle/` folder of its own repository, relocatable as a unit. A separate repository is promised only after adapter and fixture resolution is checked too.

## The five packages and what version 1 does not do

1. Package 1 (this one): `compare.mjs` and one in-memory scenario of the e2e suite.
2. Package 2: file loading and the file formats (scenario, manifest, expectations), hashes and scenario selection.
3. Package 3: runner, report, CLI, fake server and a synthetic example service with a planted bug.
4. Package 4: the workflow that inventories a service's contract, drafts the manifest and the harness, and gates each port on the oracle.
5. Package 5: switch and rollback rehearsal, and measured latency and memory budgets, apart from the exact comparison.

Version 1 does not do generators, traffic capture, engines of other languages beyond the Node adapter, several route groups in one report beyond a list of groups, numeric opaque values (only strings are bound), a time-tolerance rule, or a selection of the affected group computed from changed files. It does not verify the identity of an approver.
