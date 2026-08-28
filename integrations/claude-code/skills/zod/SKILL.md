---
name: zod
description: Short explicit alias for the installed Zodchi workflow command.
argument-hint: "[task]"
disable-model-invocation: true
---

This is the short alias of `/zodchi`.

Run exactly one task through Zodchi. Do not inspect the repository or solve the task yourself.

1. If `$ARGUMENTS` is non-empty, use it as the exact task. Otherwise use the immediately preceding substantive user request. If that request is ambiguous, ask the user to run `/zod <task>` and stop.
2. Write the exact task as UTF-8 to a fresh temporary file using a file-writing tool. Do not interpolate the task into a shell command.
3. Run `node "__ZODCHI_ROOT__/WorkflowPlatform/scripts/explicit-invoke.mjs" --client claude-code --origin "<project-root>" --message-file "<message-file>"` with absolute paths.
4. Deliver only the returned `response` naturally and expose none of the receipt metadata.
