# Large work in packages

A `code-package` run carries one bounded change: an explicit list of files, a brief, checks and an independent review. A feature, a refactoring or a migration is larger than that. Run it as a series of packages that Zodchi plans and checks, instead of one long agent session.

## 1. Plan the work with design-brief

Describe the goal and let `design-brief` collect facts from the repository and draft the plan. Ask it to distribute the work into packages in the goal itself:

```json
{
  "label": "billing-split",
  "goal": "Split billing into an engine and per-provider modules without changing behaviour. Distribute the work into code-package packages: for each package its exact files (no two packages that may run at the same time claim the same file), what it changes, its checks, and which packages can run in parallel.",
  "repos": ["/abs/path/app"],
  "out": "/abs/path/private-notes/billing-split.md",
  "questions": [
    { "question": "Which modules call into another provider directly?", "files": ["src/billing/mod.rs"] }
  ]
}
```

```sh
zodchi flow design-brief --args plan.json --detach
zodchi flow status <run-id>
```

The run may stop with questions for you. Answer them and continue the same run:

```sh
zodchi flow reply <run-id> --file answer.txt --answered all
zodchi flow design-brief --resume <run-id> --detach
```

The finished brief has been reviewed by an independent architect model against the facts it collected. Read it before you start packages: you decide what is built. See [Design brief](design-brief.md).

## 2. Turn each planned package into a run

For every package in the plan write a brief (goal, files, what "done" means, checks, and a `## Review boundary`) and an arguments file with exactly its files:

```json
{
  "label": "billing-engine",
  "repo": "/abs/path/app",
  "brief": "/abs/path/app/.agent-tmp/flow/billing-engine-brief.md",
  "files": ["src/billing/engine.rs", "src/billing/mod.rs", "tests/billing_engine.rs"],
  "mode": "agent",
  "isolated": true
}
```

The file list is a claim. A second package that names one of the same files is refused while the first is open, and the refusal names the run that holds it. This is what keeps parallel packages from overwriting each other.

## 3. Run packages in the planned order

- **Independent packages** (no shared files) can run at the same time. Model work runs in parallel; heavy checks take a check slot one at a time, so builds and test suites do not pile up on one machine.
- **Dependent packages** wait for the package they build on to be applied.
- **One shared integration file** (a registry, a module list) belongs to one later package, not to several parallel ones.

With `"isolated": true` writing, checks and review happen on a private candidate; your branch does not move until you apply the approved result:

```sh
zodchi flow apply <run-id>
```

If the branch moved meanwhile (another package was applied first), `apply` refuses and explains the conflict. Packages with disjoint files can then be carried over onto the new branch tip; see [Parallel packages](parallel.md) and [Applying a private candidate](flow.md#applying-a-private-candidate).

## 4. When a package does not get approved

A package stops after its review rounds (three by default) without approval, or with a question. Then:

- read `zodchi flow status <run-id> --handoff` for the open findings and the checks that ran;
- if the remaining findings are refinements, not defects, you may accept the candidate and record them for later;
- otherwise correct it in a new package that starts from the same candidate: give `"sourceRun": "<run-id>"` and the same files. This works while your branch is still at the same base; after the branch moved, start a new package from the current tip and quote the earlier candidate's diff in the brief as data.

## 5. Verify the whole before you release

Each package was checked on its own. Before merging the series, verify the combined branch once: run `branch-review` with your full test suite as `verify` against the branch base, so an independent reviewer sees the whole diff together with the results. Run the platform-specific suites (Linux, macOS, Windows) in CI as well; a check that only runs on another operating system cannot be seen locally.

## Practical limits

- Keep a package to what one review can hold: a few files and one idea. Twenty small packages finish sooner and more reliably than three large ones.
- Write the plan's package list with exact files. A folder or a pattern cannot be claimed.
- Resume interrupted runs with `--resume <run-id>`; do not start a new run with the same arguments, it would pay for the same steps again.
