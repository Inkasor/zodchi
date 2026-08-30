---
name: zodchi
description: Enter Zodchi mode for this Claude Code chat. Zodchi remains inactive in every chat until explicitly invoked.
disable-model-invocation: true
---

The installed conditional session router must perform activation before the model receives this skill. If these instructions reached the model, activation did not complete: do not claim that Zodchi mode is active, do not inspect the project, and do not imitate the workflow. Tell the user that the Zodchi session hook must be enabled and that they should start a new chat before invoking `/zodchi` again. If the hook is already enabled, report a Zodchi installation/runtime defect. Do not expose internal commands or invent `/status`, `/execute`, `/exit`, or other public commands.

ZODCHI_SESSION_ACTIVATION_V1
