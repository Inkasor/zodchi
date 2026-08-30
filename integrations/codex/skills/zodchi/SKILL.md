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

ZODCHI_SESSION_ACTIVATION_V1
