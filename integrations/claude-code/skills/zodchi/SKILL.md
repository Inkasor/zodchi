---
name: zodchi
description: Enter Zodchi mode for this Claude Code chat. Zodchi remains inactive in every chat until explicitly invoked.
disable-model-invocation: true
---

The installed conditional session router performs activation. Acknowledge that Zodchi mode is active and ask the user to describe the task. Do not expose internal commands or invent `/status`, `/execute`, `/exit`, or other public commands. Ordinary later messages in this same chat are routed by the session router; other chats remain ordinary Claude Code chats.

ZODCHI_SESSION_ACTIVATION_V1
