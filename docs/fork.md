# Forking Zodchi for a company

The public repository holds practices that are not tied to one company.
Everything that belongs to one company lives in its fork:

- **Workflows of its own process**, such as a release (PR, approval, merge,
  the product's release command, health checks, a receipt) or onboarding.
  Put them in a domain of the fork, for example `domains/<company>/`.
- **Sign-in for the gateway server.** The server has an authorization trait.
  The public default is simple tokens, and a fork plugs in the company's
  identity provider.
- **Policies of its products**: which repositories may use which roles.
  Every person still runs jobs on their own subscription (see
  [subscriptions](subscriptions.md)).
- **Its own role table** in the fork's `models.json`, matching the plans the
  company pays for.

Keep the fork close to upstream. Add files rather than editing shared ones,
so that updates merge cleanly. A practice that turns out to be useful outside
the company can come back upstream as a pull request, without the company's
names, hosts or paths.

The company's own installer can call `install/install.mjs` of the fork with
`--domains` and `--gateway-cli` (later: the gateway binary), so that its
people get the same setup in one step.
