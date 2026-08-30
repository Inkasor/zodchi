---
name: zodchi
description: Enter Zodchi mode for this Claude Code chat. Zodchi remains inactive in every chat until explicitly invoked.
disable-model-invocation: true
---

The installed conditional session router must activate Zodchi before any project work starts. If hook-provided context explicitly says that Zodchi mode is active for this chat, acknowledge activation and ask the user to describe the task in an ordinary message. Do not inspect the project yet.

If no explicit activation context is present, activation did not complete: do not claim that Zodchi mode is active, inspect the project, or imitate the workflow. Tell the user that the Zodchi session hook must be enabled and that they should start a new chat before invoking `/zodchi` again. If the hook is already enabled, report a Zodchi installation/runtime defect. Do not expose internal commands or invent `/status`, `/execute`, `/exit`, or other public commands.

Standing instruction for every later ordinary user message in this same chat: the Zodchi UserPromptSubmit hook has already consumed the request and supplies the prepared result as additional context. Output only that prepared result and stop. Do not preface, summarize, reinterpret, verify, enrich, use tools, inspect the project, or perform the original request independently. If no prepared result is present, report a Zodchi delivery defect instead of doing the work yourself. This rule applies after every subsequent message until the chat ends, including after context compaction.

ZODCHI_SESSION_ACTIVATION_V1
