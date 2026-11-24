# Parallel packages

Give each `code-package` run an explicit list in `args.files`. The Rust engine compares those paths with the open claims in the target repository. If a path is occupied, the refusal identifies the other package and run ID.

In a shared checkout, use `isolated: true` for each package. The writer and checks run against a private candidate. Before applying an approved candidate, Flow checks the target branch, its recorded base and overlapping local changes. If the branch advanced, inspect the application refusal and reconcile the candidate with the new base. See [Applying a private candidate](flow.md#applying-a-private-candidate).

For overlapping packages, finish one before starting the other. For independent packages, assign the shared integration file to a later package. When a writer needs an extra path, review the scope request before extending the claim.

Use `zodchi flow status <run-id> --handoff` for the current step, candidate and checks. If a job outcome is unknown, read its recorded key with `zodchi job --key <key>`. Resume the same run to reuse its job and receipts. Follow [the workflow's retry rules](flow.md) when deciding whether to repeat a failed step.
