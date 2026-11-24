---
name: verify
description: Run the current project's declared checks when accepting a code change or preparing a Zodchi package, and report actual evidence.
---

# Verify a project

Read the current project's `.zodchi/verify.json`. It declares the cheap `checks`, the targeted `verify` commands, and an optional full-suite policy. For a package, use the repository base and its declared checks. The lead can supply commands for the changed feature in `args.checks` and `args.verify`; name the affected scenarios.

For ordinary work in the checkout, run the checks in order and collect exit codes and any logs or traces. For a Flow package, use the run's recorded evidence. Run the full local commands once at acceptance if `full.run` is `local`. If it is `ci`, report CI as pending until the candidate's CI result is available.

Projects with the older `.claude/skills/verify/SKILL.md` can keep those project instructions. Read that file and pass its verification commands in `args.verify` for Flow. If neither declaration exists, use the verification commands specified by the project and task, and report which checks actually ran.
