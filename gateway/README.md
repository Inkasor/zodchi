# zodchi gateway

The `zodchi` command calls Codex models by role. It is a Rust port of the Node gateway the workflows grew up
with, and keeps its commands, options, exit codes and job folder, so workflows do not notice the replacement.

```
cargo build --release          # target/release/zodchi
zodchi roles                   # roles this repository can name
zodchi account                 # every subscription: sign-in, limits, credits (no model call)
zodchi run --role code-review --key my-review-1 --prompt review.md --attach change.diff --out review.json
```

## Subscriptions

List your Codex homes in `~/.zodchi/accounts.json`, in the order you want them used:

```json
{ "accounts": [
  { "name": "work", "codexHome": "~/.codex-work" },
  { "name": "personal", "codexHome": "~/.codex" }
] }
```

Sign each one in yourself: `CODEX_HOME=~/.codex-work codex login`. A job takes the first account that is
signed in and has limit left; every account it passed over is written into the job (`accountsSkipped`), with
the reason. Without the file the gateway uses `$CODEX_HOME` or `~/.codex`. Which subscription you use for what
is yours to decide; see [docs/subscriptions.md](../docs/subscriptions.md).

## Layout

- `crates/zodchi-core`: roles, jobs (idempotency keys, queue of two per repository with one writer, worker with
  heartbeat, settling dead workers by pid and start time), the Codex app-server protocol, the subscription pool,
  and the Decisions API (through the system `curl`, the key passed on stdin).
- `crates/zodchi-cli`: the `zodchi` command.
- The server (`zodchi-server`) comes next.

Building on Windows with the GNU toolchain needs no Visual Studio: the gateway has no C or TLS dependencies.
