# Subscriptions: what the terms allow

Zodchi calls Codex models on a ChatGPT plan through the Codex CLI. This page
sums up what OpenAI's published terms say about that, checked on 2026-11-17.
It is not legal advice. Read the sources yourself; they change.

## One plan, one person

- **Personal plans (Free, Go, Plus, Pro).** The
  [Terms of Use](https://openai.com/policies/row-terms-of-use/) say: "You may
  not share your account credentials or make your account available to anyone
  else". They also forbid leasing or selling the service and getting around
  rate limits.
- **Business and Enterprise.** The
  [Services Agreement](https://openai.com/policies/services-agreement/)
  (3.1–3.3) forbids sharing login credentials "between multiple users". Each
  End User Account is "used by, a single End User". It also forbids
  configuring the services "to avoid Usage Limits".
- **Apps that run on users' plans.** The
  [Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/)
  forbid "Using one user's subscription to fulfill another user's requests",
  pooling or sharing plan usage or tokens, and "rotating accounts, or
  otherwise bypassing usage limits". They also require tokens to stay "local
  and under the user's control".
- **Codex app-server sign-in** "has never been permitted for commercial or
  hosted services" ([Codex app-server docs](https://learn.chatgpt.com/docs/app-server)).

So in Zodchi everyone signs in with their own plan. A gateway server may run
jobs for several people only when each job runs on the plan of the person who
asked for it, under the rules for hosted apps. One person's plan never serves
another person's requests.

## Automation on your own plan

- Codex docs recommend an API key for CI and other unattended jobs
  ([auth](https://learn.chatgpt.com/docs/auth),
  [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)).
- Using a ChatGPT sign-in on trusted private infrastructure is documented as
  an advanced option, with "one auth.json per runner".
- Enterprise workspaces can issue Codex access tokens for "trusted scripts,
  schedulers, and private CI runners".
- Keep `~/.codex/auth.json` like a password: never commit or share it.

## Work and personal plans

- One login can hold a ChatGPT Business workspace and a personal workspace.
  If you keep them separate, "any personal subscription continues"
  ([help article](https://help.openai.com/en/articles/8801890)).
- Enterprise with a verified company domain may require you to move or close
  the personal workspace of a work e-mail. OpenAI recommends a separate
  account on an e-mail address you own for personal use
  ([help article](https://help.openai.com/en/articles/10479654)).
- In the Codex CLI each account or workspace is one `CODEX_HOME` with its own
  `auth.json`. An admin can pin the workspace with
  `forced_chatgpt_workspace_id`.

Zodchi does not decide which of your plans a job may use. You list your
subscriptions, each in its own `CODEX_HOME`, in the order you want them used,
and you decide what goes on which. Terms and employer rules change, so check
them yourself.
