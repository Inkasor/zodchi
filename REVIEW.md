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
- nit for the e2e fakes (2026-11-19, the lead after three rounds): a fake agent that checks a step's instructions by
  the presence of each command and path, not by parsing every write group in order with duplicates; absolute
  scratch and checkout paths in the traces of a local or CI run (local traces stay in .agent-tmp/, CI traces carry
  only the runner's paths). The parity that matters is that each old assertion still runs and a dropped instruction
  fails a scenario.
- nit for the io helper (2026-11-19, the lead after two rounds): claim-more reading the worktree status but not a
  diff against the package base (a package's own commits are claimed when it writes them); the whole redacted report
  passed as one command argument (reports are short; the collector caps the excerpt); part limits counted in code
  points by the workflow and UTF-16 units by the helper, and an 803-character field cap.
- nit for code-package resume and the workflow stamp (2026-11-20, owner decision after two rounds): the claim step
  coming back from the journal on a resume, with the reopen done by the next live helper call (a workflow script cannot
  force one step to run live; making it do so is a runtime change); the gate comparing the copy's file with a content
  stamp embedded in the running script rather than a hash of the loaded source or its Git commit (the script cannot
  read itself; the e2e check of a stale stamp is what keeps the stamp honest).
- nit for the code-package gate (2026-11-20, owner decision): a new workflow run against an older helper copy closing
  stale claims of finished packages before it refuses the mismatch (that cleanup is the gate's normal work on every
  run and touches only claims of finished packages).
- nit for code-package gateway keys (2026-11-20, owner decision): a key over the gateway's 96-character limit only at
  call or attempt counts no real package reaches (thousands of calls, dozens of retries); the label cap covers the
  counts a run actually has.
- nit for design-brief material batches (2026-11-20, the lead after two rounds): a run cut inside a batch sending the
  whole batch again on resume (brief-material rewrites a part file, so a resend is safe and costs a few runner
  commands); a wrong or conflicting receipt for a part (the preflight joins the parts and checks the whole hash, so a
  damaged part stops the run with "run again" before anything reaches a reviewer).
