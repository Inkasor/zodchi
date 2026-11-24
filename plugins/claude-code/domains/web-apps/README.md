# web-apps

Web applications: services, dashboards and internal tools that ship often and
are changed by several agents at once.

Install the shared client plugin following the [package instructions](../../../../docs/flow.md#client-packages).
Run `zodchi flow branch-review --args <file.json>` for a branch review.

## Workflows

| Workflow | When |
| --- | --- |
| `branch-review` | A branch is finished: an independent reviewer reads it in the checkout through the gateway, and an architect reviews it too when it moves boundaries, contracts, storage or authority |

Use `code-package` for implementation and `release-acceptance` for browser checks on a deployed candidate.

## Lessons this domain is built on

- **Packages that touch the same file collide.** Three packages editing one
  file meant rebase conflicts every time. `code-package` now refuses to start
  while another open package claims one of its files.
- **Reviews need a stop rule.** One change went five review rounds. Three
  rounds without approval now return the question to a human.
- **Write the applier brief once.** Describing the same Haiku applier by hand
  for each package was the reason `applier` and `code-package` exist.

Release and onboarding workflows depend on the company's release commands
and identity provider, so they live in company forks (see
[docs/fork.md](../../../../docs/fork.md)).
