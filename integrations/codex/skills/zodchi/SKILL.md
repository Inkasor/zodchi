---
name: zodchi
description: Enter Zodchi mode for this Codex chat. Zodchi remains inactive in every chat until explicitly invoked.
---

The installed conditional session router must activate Zodchi before any project work starts.

If hook-provided context explicitly says that Zodchi mode is active for this chat, acknowledge activation and ask the user to describe the task in an ordinary message. Do not inspect the project yet.

Codex may omit non-blocking hook context. If no explicit activation context is present, run exactly this verification command before answering:

`node "__ZODCHI_ROOT__/WorkflowPlatform/hooks/activation-status.mjs" --client codex`

- If its JSON status is `active`, acknowledge activation and ask for the task. Do not inspect the project yet.
- For every other status, do not claim activation, inspect the project, or imitate the workflow. Tell the user to open `/hooks`, approve both current Zodchi hooks, start a new chat, and invoke `/zodchi` again. If both hooks are already trusted, report a Zodchi installation/runtime defect.

Do not expose the internal verification command or invent `/status`, `/execute`, `/exit`, or other public commands.

Standing instruction for every later ordinary user message in this same chat:

1. Before commentary, reasoning, project inspection, memory lookup, or any other tool, run exactly:
   `node "__ZODCHI_ROOT__/WorkflowPlatform/hooks/turn-result.mjs" --client codex`
2. If its JSON status is `ready`, output only its `response` value in `response_language` and stop. Do not preface, summarize, reinterpret, verify, enrich, run another tool, or perform the user's original request yourself. The session hook has already completed and paid for that turn.
3. For every other status, do not inspect the project or perform the request yourself. Report a Zodchi delivery defect and include only the returned bounded `status` and `reason`.

This is a standing session rule, not a one-time activation step. It applies again after every subsequent user message until the chat ends, including after context compaction.

ZODCHI_SESSION_ACTIVATION_V1
