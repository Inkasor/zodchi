# What a review of zodchi looks for

zodchi is workflows (prompts plus a little control code), agent definitions, roles and a Rust gateway. The people
who run it are its owner and colleagues on their own machines. The writers, runners and reviewers inside a
workflow are our own agents, not attackers.

## Flag (important)
- A normal run does the wrong thing: loses or overwrites work, commits files it should not, skips a step it claims
  to have done, reports success that did not happen, or stops for a reason that is not real.
- A secret, a private path or a company or product name can reach the public repository, a log or a model prompt.
- A gateway call can spend money or a subscription in a way the owner did not ask for.
- A change that silently stops something from being checked (a check removed or weakened, a step that no longer
  runs).
- The Rust gateway: wrong job state, a lost or duplicated job, a broken idempotency key, a worker that outlives or
  dies with the wrong process, one user reaching another user's job.

## Do not flag
- Ways a deliberately malicious agent inside the workflow could bypass a guard (path tricks, quoting games, editing
  its own evidence). Guards in prompts are for honest mistakes.
- Races between two copies of the same tool started at the same moment by the same person.
- Hostile file systems (bind mounts, reparse points swapped mid-read) unless the code is a scanner of other
  people's data.
- Prompt wording, unless it is likely to make an agent do the wrong thing.
- Missing tests for internal details no user can observe.

## The flow engine (`gateway/crates/zodchi-flow`)
- important: after ONE cut at any point (process killed, machine off), `--resume` loses work, repeats a model call
  or a commit, commits unclaimed or unchecked content, or reports success that did not happen.
- nit: double faults (a cut during the recovery of a cut, a disk that fills during a journal write, a file swapped
  for a link between steps by someone else), and anything that needs a second process editing the checkout during
  a run.

- nit for the flow executors (2026-11-18, the lead after two rounds): a server that answers 409 for a key and later
  finds it; an account binding by organization without a per-user id; directory flushes that Windows does not
  confirm; a path of another package re-checked after that package's claim closed.

- nit (2026-11-18, the lead): the installer seeing the same Codex skill path in two letter cases on Windows.

- nit (2026-11-18, the lead): a stale-claim cleanup after the step that marks a claim as awaiting a person failed too (a double fault).

## Severity
`important` blocks. `nit` and `pre-existing` never block. When unsure whether something is important, ask: would
the owner stop a release for it?

- nit for design-brief (2026-11-19, the lead after two rounds): machine paths of the lead's own args (out, tmp) in what
  our own gateway reviewer sees; a secret inside a source file a researcher reads reaching a runner's output; args.out
  pointed at one of the workflow's own artifacts; Git fetching objects in a partial clone. The briefs and the gateway
  are ours; what matters is that the brief itself carries no secret and, in a public repository, no private name.
- nit for the installer (2026-11-19): a missing installed_plugins.json read as "Claude Code keeps no such file"; the
  hand-refresh hint when two scopes share one cache folder.
