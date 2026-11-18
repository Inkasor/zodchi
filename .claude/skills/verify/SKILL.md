---
name: verify
description: Build the zodchi gateway and run its end-to-end suite (the real zodchi and zodchi-server against a fake Codex, no model spend); read the per-scenario traces.
---

# Verify zodchi

One command, from the root of the repository; it needs Node 20+, Git and Cargo:

1. `node scripts/e2e.mjs --out "$LOG_DIR/e2e"` (exit 0). Without a log folder of your own, `npm run e2e` writes the
   traces to `.agent-tmp/e2e-traces/`.

It builds the release binaries once (`cargo build --release --locked`; the line `build <s> s` is the build time),
then runs every scenario against those binaries with `scripts/e2e/fake-codex.mjs` in place of Codex. Nothing is spent
and nothing leaves 127.0.0.1. A warm build takes seconds; the scenarios take about half a minute.

## Reading the output

- One line per scenario: `PASS <name> (<ms> ms) trace <file>`, `FAIL <name> (<ms> ms): <the failed assertion>` with
  its trace, or `SKIP <name>: <reason>` for a scenario that does not run on this system (`server-stop` needs POSIX
  signals; `cli-worker-outlives-job-object` is Windows only, and skips when a job object around the shell forbids
  breakaway). A skip is not a failure.
- The last line counts passed, failed and skipped, with the scenario time apart from the build time.
- Each trace (`<out>/<scenario>.log`) lists every command and HTTP call with its exit code or status and what it
  printed (tokens redacted), and an `ok:` or `FAILED:` line per assertion. Evidence for a report: the command, its
  exit code and the trace folder.
- After a failure the scratch folder (fixture repositories, data folders, Codex homes with the fake's
  `fake-turns.jsonl`) is kept and its path printed.

## Options

- `node scripts/e2e.mjs <scenario> ...` runs only those scenarios (names as printed).
- `--no-build` uses the binaries already in `gateway/target/release` (CI builds them in the step before).
- `--keep` keeps the scratch folder after a pass too.

## Not part of this skill

`npm run e2e:release` (`scripts/e2e-release.mjs`) runs the real `code-package` workflow in a headless Claude Code
session and spends model tokens. It is run by hand before a release, on a disposable machine, never by this skill.
