---
name: zodchi
description: Enter Zodchi mode from Claude Code or Cursor. Zodchi remains inactive until explicitly invoked.
disable-model-invocation: true
---

The installed conditional session router must activate Zodchi before any project work starts. Follow only the section for the current host.

## Cursor

Cursor supplies the exact marker `ZODCHI_CURSOR_SESSION_V1` at session start. In Cursor, keep this skill attached as the chat's Custom Mode.

For every submitted task, including the first one, run exactly this command before commentary, reasoning, project inspection, or any other tool:

`node "__ZODCHI_ROOT__/WorkflowPlatform/hooks/turn-result.mjs" --client cursor`

- If its JSON status is `ready`, output only its `response` value in `response_language` and stop.
- If its status is `active` with reason `result_not_ready` and the user only entered the mode, acknowledge activation and ask for the task. Do not inspect the project.
- For every other status, do not perform the request yourself. Report a Zodchi delivery defect with only the bounded `status` and `reason`.

If the Cursor marker is absent, do not use this section.

## Codex

If hook-provided context explicitly says that Zodchi mode is active for this chat, acknowledge activation and ask the user to describe the task in an ordinary message. Do not inspect the project yet.

Codex may omit non-blocking hook context. If no explicit activation context is present, run exactly:

`node "__ZODCHI_ROOT__/WorkflowPlatform/hooks/activation-status.mjs" --client codex`

- If its JSON status is `active`, acknowledge activation and ask for the task. Do not inspect the project yet.
- Otherwise do not claim activation or perform project work. Tell the user to open `/hooks`, approve both current Zodchi hooks, start a new chat, and invoke `/zodchi` again. If both hooks are already trusted, report a Zodchi installation/runtime defect.

For every later ordinary user message in the same Codex chat, before any other action run exactly:

`node "__ZODCHI_ROOT__/WorkflowPlatform/hooks/turn-result.mjs" --client codex`

- If its JSON status is `ready`, output only its `response` value in `response_language` and stop.
- For every other status, do not perform the request yourself. Report a Zodchi delivery defect with only the bounded `status` and `reason`.

## Claude Code

If hook-provided context explicitly says that Zodchi mode is active for this chat, acknowledge activation and ask the user to describe the task in an ordinary message. Do not inspect the project yet.

For every later ordinary user message, the Zodchi `UserPromptSubmit` hook has already consumed the request and supplies the prepared result as additional context. Output only that prepared result and stop. Do not preface, reinterpret, verify, enrich, use tools, inspect the project, or perform the request independently. If activation or a prepared result is absent, report a Zodchi delivery defect.

Do not expose internal verification commands or invent `/status`, `/execute`, `/exit`, or other public commands. These are standing session rules and still apply after context compaction.

ZODCHI_SESSION_ACTIVATION_V1
