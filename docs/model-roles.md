# Choosing models for a Flow run

The same CLI runs from Codex, Claude Code and other terminals. The client that starts it supplies the arguments.
The workflow reads its effective model table in this order, with each later source replacing the roles it lists.

1. The shipped `models.json`.
2. `$ZODCHI_HOME/models.json` (normally `~/.zodchi/models.json`).
3. `.zodchi/models.json` in the chosen repository.
4. The `models` object in that run's argument JSON.

Flow records the selected models, effort and skipped candidates with the run. Continue with the same run ID to reuse
those selections. Use `zodchi flow status <run-id>` to check the run's picks.

## Default OpenAI roles

| Use | Role | Default |
| --- | --- | --- |
| Code package with tools and brief writing | `writer` | Terra 6.1 `xhigh` |
| Scenario selection and visual acceptance | `acceptor` | Terra 6.1 `medium` |
| One-shot patch | `expertWriter` | Astra 6.2 `high` |
| Independent package review | `reviewer` | Sol 6.2 `medium` |
| Research | `researcher` | Luna 6 `max` |
| Architectural review | `architect` | Astra 6.2 `high` |

`design-brief` uses `reviewer` for its independent review by default. Set `models.architect` in its run arguments
for a particular review model. A direct gateway job uses the selected role file and its `--model` and `--effort` overrides.

## A mixed Claude and Codex run

Enable `"claude": true` in the user `flow.json` to use Claude for Flow model steps. Use the following `models` object
in the arguments of a brief or package. Select `opus` in the writer entries when the task calls for it.

```json
{
  "models": {
    "researcher": { "candidates": [{ "provider": "claude", "model": "haiku", "effort": "high" }] },
    "writer": { "candidates": [{ "provider": "claude", "model": "sonnet", "effort": "medium" }] },
    "expertWriter": { "candidates": [{ "provider": "claude", "model": "sonnet", "effort": "medium" }] },
    "reviewer": { "candidates": [{ "provider": "codex", "model": "gpt-6.2-sol", "effort": "medium" }] }
  }
}
```

In `design-brief`, Haiku receives the pinned research material, Sonnet writes the draft and Sol reviews it. Each
model step is a one-shot call. In `code-package` with `"mode": "expert"`, Sonnet or Opus proposes the patch and Sol
reviews it. The engine applies the patch and captures the declared checks. Claude sign-in and the ability to answer
the selected model are checked at the gate. Each listed candidate is tried in order when selecting the roles.

`code-package` with `"mode": "agent"` uses the local Codex worker workspace. For a Claude worker that needs tools,
run the work in the project with Claude Code, then use `zodchi flow branch-review --args <file>` for the one-shot Sol
review of the chosen commits. See [Claude as an executor](flow-claude.md) for the tool-free CLI contract.

To call Sol `max` for a one-shot architectural opinion, choose `--role architecture-review --model gpt-6.2-sol
--effort max` on the direct gateway command. For routine architectural review, the role file already selects Astra
6.2 `high`.

## Project worker windows

Set context and auto-compaction for workers in project agent profiles or in the `config` of a project's work role.
A project can extend the installed `flow-work` role in `.zodchi/roles/flow-work.json`.

```json
{
  "extends": "flow-work",
  "config": {
    "model_context_window": 272000,
    "model_auto_compact_token_limit": 244800,
    "model_auto_compact_token_limit_scope": "total"
  }
}
```

Flow resolves that role from the project and uses the private export for the worker's files. The selected role
settings are saved in the request journal. Expert role files use the client's context and compaction defaults.
