# web-apps

Web applications: services, dashboards and internal tools that ship often and
are changed by several agents at once.


Install: `/plugin install zodchi-web-apps --marketplace Inkasor/zodchi` in Claude Code, or from a clone
`./install/install.sh --project <repo> --domains web-apps` to turn it on in one project. It needs `zodchi-core`.
Workflows run as `/zodchi-web-apps:<name>`.

## Workflows

| Workflow | When |
| --- | --- |
| `branch-review` | A branch is finished: an independent reviewer reads it in the checkout through the gateway, and an architect reviews it too when it moves boundaries, contracts, storage or authority |

`code-package` and `ops-script` come from `zodchi-core` and are the everyday
tools here.

## Lessons this domain is built on

- **Packages that touch the same file collide.** Three packages editing one
  file meant rebase conflicts every time. `code-package` now refuses to start
  while another open package claims one of its files.
- **Reviews need a stop rule.** One change went five review rounds. Three
  rounds without approval now return the question to a human.
- **A script that needs a password gets a dry run first.** Every broken sudo
  script cost a human another password prompt. `ops-script` checks it without
  root on a copy first.
- **Write the applier brief once.** Describing the same Haiku applier by hand
  for each package was the reason `applier` and `code-package` exist.

Release and onboarding workflows depend on the company's release commands
and identity provider, so they live in company forks (see
[docs/fork.md](../../docs/fork.md)).
