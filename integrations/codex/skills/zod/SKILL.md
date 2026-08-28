---
name: zod
description: Short explicit alias for the installed Zodchi workflow command. Never invoke implicitly.
---

This is the short alias of `/zodchi` and `$zodchi`.

Run exactly one task through Zodchi. Do not inspect the repository or solve the task yourself.

1. Use the text supplied with this explicit skill invocation. If none was supplied, use the immediately preceding substantive user request. If that request is ambiguous, ask the user to run `/zod <task>` or `$zod <task>` and stop.
2. Write the exact task as UTF-8 to a fresh temporary file using a file-writing tool. Do not interpolate the task into a shell command.
3. Run `node "__ZODCHI_ROOT__/WorkflowPlatform/scripts/explicit-invoke.mjs" --client codex --origin "<project-root>" --message-file "<message-file>"` with absolute paths.
4. Deliver only the returned `response` naturally and expose none of the receipt metadata.

