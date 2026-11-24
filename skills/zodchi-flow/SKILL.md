---
name: zodchi-flow
description: Start, continue or inspect a task using the shared Zodchi CLI and journal.
---

# Run a Zodchi workflow

Run `zodchi` from PATH so both clients share the selected build. Use `zodchi release current` to inspect the local executable and its revision. A DEV run records its `buildCommit` in `flow status` and continues on that build.

Use `zodchi flow list --repo "<project>"` to find a workflow for a Git project. Use `zodchi flow list` for the full installed catalog. Tell the user which workflow and roles the task will use. Collect its input from the project and write an arguments JSON file.

For UI acceptance, use `release-acceptance` for a deployed browser application and `player-acceptance` for a prepared Windows player. Use the project's approved scenarios and the [acceptance contract](../../docs/acceptance.md). The local executor runs the scenario without taking the active desktop. Use `choose` to let the acceptor pick prepared scenarios and `review` for allowed frames. Terra 6.1 `medium` is the default for those calls.

For a code package, write a brief with the goal, exact writable paths, acceptance criteria and review boundary. Place it and the argument file in the project's ignored `.agent-tmp/` directory. The arguments name an absolute `repo` and `brief`, a unique `label` of at most 40 characters, and the relative `files`. Use the project verification plan or provide scoped `checks` and `verify` commands. Use a list of exact approved paths for protected check changes, for example `"allowCheckChanges": ["tests/math.mjs"]`.

When review depends on committed code outside the write claim, list those paths in `reviewContext`. Flow reads them from the candidate commit.

Use the default expert mode for a focused patch. Use `"mode": "agent"` when the writer needs to inspect the project and use local tools. Continuations get the same private workspace and the previous summary in a new ephemeral thread. Set `continuations` to the allowed number of extra turns per writing step (0–32, default 2). For example, `"continuations": 16` gives one long step up to 17 turns. An explicit package `budget` replaces this per-step cap.

For a package that must stay separate from the working checkout before approval, pass `"isolated": true`. Report the candidate SHA and application status. Apply an approved candidate on the recorded branch and base with `zodchi flow apply <run-id>` when the task calls for integrating it. For a budgeted package, inspect `flow status` for a budget decision and add calls or time with `zodchi flow budget <run-id> --add-calls <n>` or `--add-minutes <n>` before resuming.

Start with `zodchi flow <workflow> --args "<file>" --detach`. Save the returned run ID. Use `zodchi flow status <run-id>` to get the phase and evidence. The same commands work in another chat and use the same local journal.

For `design-brief`, use [the brief arguments](../../docs/design-brief.md) with absolute source checkout paths and an output path. Use `zodchi flow design-brief --args "<file>" --detach` in either client. Resume the same run ID after an interruption to reuse accepted facts. The engine stores local jobs in the Zodchi home directory.

When the owner chooses a model or provider, set the workflow roles in `args.models` before the start. The same [model overrides](../../docs/model-roles.md) work from both clients. Use the recorded pair when resuming a run.

Resume with `zodchi flow <workflow> --resume <run-id> --detach`. Reuse the recorded run after a chat or shell interruption. If a step has an unknown outcome, present the evidence and use the workflow's explicit retry command only after the owner's decision.

When the owner adds context, capture the text in a file and use `zodchi flow remark <run-id> --file "<file>"`. When the run waits for an answer, use `zodchi flow reply <run-id> --file "<file>"` before resuming. To accept a proposed set of additional paths, get explicit approval for the exact list, write it as a JSON array, and use `zodchi flow reply <run-id> --allow-files "<file.json>"`.

A start receipt confirms submission. Report the final verdict, actual models, commits or artifacts, check exit codes and outstanding decisions from the journal status.

For video, follow the project's media index and [the video workflow](../../docs/flow-video.md). Run native video Flow from the directory chosen for the video, including a directory outside Git. Show the owner each pending scenario, probe or final file from status. Record their actual decision for the displayed variant or render. Use the same run ID for follow-ups, publication receipts and measured statistics.

For a private YouTube upload after acceptance, use [`youtube-publish`](../../docs/youtube-publish.md). Show the plan and record the owner's approval before resuming the upload run.

To re-review a committed correction, use [branch-review](../../docs/flow.md#branch-review) with the finished code package's `sourceRun` and an explicit `head`. Follow a completed branch review with `previousReview` set to its run ID. Use the same tree for the review and its verification evidence. To write corrections on a retained private candidate, start an isolated `code-package` with `sourceRun`, the same target base and a claim covering the inherited changes.
