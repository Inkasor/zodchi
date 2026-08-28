---
name: zodchi
description: Explicitly route exactly one user task through the installed Zodchi workflow platform. Never invoke implicitly.
---

Run exactly one task through Zodchi. Do not inspect the repository or solve the task yourself.

1. Use the text supplied with this explicit skill invocation. If none was supplied, use the immediately preceding substantive user request. If that request is ambiguous, ask the user to run `/zodchi <task>` or `$zodchi <task>` and stop.
2. Write the exact task as UTF-8 to a fresh temporary file using a file-writing tool. Do not interpolate the task into a shell command.
3. Run this command, passing the current project's absolute root as `<project-root>` and the temporary file as `<message-file>`:

   `node "__ZODCHI_ROOT__/WorkflowPlatform/scripts/explicit-invoke.mjs" --client codex --origin "<project-root>" --message-file "<message-file>"`

4. The command deletes the temporary message file. Deliver only the returned `response` naturally. Do not expose the JSON receipt, run identifier, route, hashes, roles, prompts, or internal workflow details.
