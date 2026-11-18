# zodchi flow: model steps through a zodchi-server

**Experimental, like [zodchi flow](flow.md).** A person who has no Codex sign-in on their own machine, but an
account on a [zodchi-server](../gateway/README.md#server), runs `zodchi flow code-package` on their machine as
usual. The engine, Git, the claim, the checks, the commit and the journal stay on that machine; only the model steps
(the writer's patch and the review) go to the server, and each runs there on that person's own ChatGPT subscription.

## Setting it up

1. The server's admin adds you (`zodchi-server user add "<name>"`) and hands you the token, once.
2. Put the token in a file only you can read (`chmod 600` on Unix), for example `~/.zodchi/flow-token`.
3. Name the server and the token file in `~/.zodchi/flow.json` (`$ZODCHI_HOME/flow.json` when `ZODCHI_HOME` is set):

   ```json
   { "server": "https://zodchi.example.org", "tokenFile": "~/.zodchi/flow-token" }
   ```

   `tokenFile` may start with `~/`; a relative path is relative to the zodchi home folder. The token itself is never
   written into `flow.json`, the args, the journal, a log, a prompt or a commit.
4. Sign in to your subscription on the server once (the device code is shown by the server):

   ```sh
   curl -s -X POST https://zodchi.example.org/v1/login -H "Authorization: Bearer $(cat ~/.zodchi/flow-token)"
   # open verificationUrl, enter userCode; then this says "connected":
   curl -s https://zodchi.example.org/v1/login -H "Authorization: Bearer $(cat ~/.zodchi/flow-token)"
   ```

Without a `server` in `flow.json` the model steps go to the local gateway, as before. The server is `https://`;
plain `http://` is accepted only for a server on the same machine (`127.0.0.1`, `localhost`, `[::1]`), since the
token would otherwise travel in clear. A URL with a user, a query or a fragment is refused.

The server must have the roles of this zodchi version installed: `flow-patch` and `code-review`.

## What a model step does

The prompt is built locally exactly as for the local gateway: the brief, the rules, the claimed files with their blob
ids, and for a review the diff, `REVIEW.md` of the base commit and the claimed files, all inlined as attachments. The
server's limit on a prompt is the gateway's 512 KB, so the engine's rules apply unchanged: optional copies of claimed
files in a review are dropped, the largest first, and named in a "Not attached for size" line; when the required part
does not fit, the step stops with `context too large at <step>` before anything is submitted.

Then, for each step:

1. **Before the intent.** `GET /v1/roles`: the roles of code-package (`flow-patch`, `code-review`) must be installed
   and be text roles; `GET /v1/account`: your subscription there must be signed in and have limit left. A failure
   stops the step before its intent is journaled, so nothing is submitted and a plain `--resume` later goes on.
2. **Intent.** The request is journaled as for the local gateway: the role name, the pinned model and effort, the
   output schema of this workflow version, the server's URL and the prompt. Never the token.
3. **Submit.** `POST /v1/jobs` with `{key, role, prompt, model, effort, schema}`, the key being the step's journaled
   key (`flow-<run>-<step>`). `201` is a new job, `200` the existing job of the same request: asking again never
   spends again. A request journaled for one server is never sent to another one named later in `flow.json`.
4. **Wait.** `GET /v1/jobs/{key}?waitSec=60` until the job is final (a poll that cannot reach the server is tried
   three times, five seconds apart, then the step stops; a poll only reads).
5. **Result.** For `succeeded`, `GET /v1/jobs/{key}/result`; the engine validates the JSON against the step's schema
   locally, as it does for the local gateway. Of the server's answer only this result goes on: the final job the
   engine sees carries the status, the time the model turn started, and an error text written by the engine from the
   public error code. Nothing else of the server's answers enters the journal's results, the commit or the review.

HTTP goes through the system `curl` (present on Windows 10 and later, macOS and Linux), as the Decisions API of the
gateway does, so the engine carries no TLS stack: the token reaches curl on its standard input as a header, never on
a command line; the request body is a temporary file of the run's process, removed when curl has ended. No curlrc of
the user takes part (`--disable`) and redirects are not followed.

## Resume

A run cut at any point is resumed with `zodchi flow code-package --resume <run-id>`, as with the local gateway. A
step with a journaled intent is never submitted again: its key is looked up on the server (`GET /v1/jobs/{key}`) and
waited for. A key the server does not know (`404`) is an unknown outcome, never a new submission: the job may have
run and been removed after the server's seven days, or the token may now be another user's. Look, then run the step
again with `--rerun "<step>"` under a new key. A job that failed before its model turn started is asked again under
the next key (`-r2`, `-r3`), as with the local gateway.

## Errors

| The server says | The run |
|---|---|
| `auth_required`, `sign_in_failed` (a job, or `GET /v1/account` not connected) | stops and asks you to sign in on the server (`POST /v1/login`); nothing was spent. Sign in, then `--resume` (or `--rerun "<step>"` when a job had been submitted) |
| `busy` (429) | the same request is posted again under the same key (the server leaves the key free), after 2, 4, 8, 16, 30, 30 ... seconds, for at most 10 minutes; then `infrastructure at <step>` |
| `key_conflict` (409) | `infrastructure at <step>`: the key belongs to a different request on the server |
| `unauthorized` (401) | `infrastructure at <step>`, naming the token file: check it or ask the admin for a new token |
| `role_not_found`, a role missing from `GET /v1/roles` | stops before the intent, naming the role: the admin installs the roles of this zodchi version |
| `limited` | `gateway limited at <step>` (or a stop before the intent when `GET /v1/account` shows no limit left) |
| `unknown` | `unknown outcome at <step>` |
| `timeout`, `job_failed` and any other code | `gateway <status> at <step>` or `infrastructure at <step>`, with the code |

Only the public code (and the HTTP status) is repeated in the result; the server's own words are not.

## The server side

`POST /v1/jobs` takes an optional `schema`: a JSON Schema of an object (`"type": "object"`), at most 64 KB and 32
levels deep, `properties` an object and `required` a list of names when present. It replaces the installed role's
output schema for that job, so the engine's own version of the patch and review schemas is what the model answers
by, whatever schema the installed role has. It is accepted for a text role only (`400 bad_request`, `field: schema`
otherwise). It enters the request's idempotency hash only when it is sent: a request without a schema keeps the hash
it always had, and the same key with another schema is a `409`.

## Known limits

- **The gate still checks locally.** The gate of `code_package` checks that the roles load from the local roles
  folder and that the local Codex subscription is signed in before it claims; it does not ask the server yet. So
  today a run through a server still needs the roles installed locally (the installer does that) and a local Codex
  sign-in that the gate accepts, and a role missing on the server or a signed-out server subscription stops the run
  at its first model step, after the claim (with the claim open and nothing submitted), instead of refusing it before
  the claim. The executor offers the check the gate needs: `executor::server::Server::preflight(&[roles])`.
- **No `server` in the args.** The server is named in `flow.json` only; `args.server` is refused as an unknown
  option of this version.
- A cut while the engine waits out a `busy` answer leaves an intent with no job on the server: the resume stops with
  an unknown outcome, and `--rerun "<step>"` asks again.
- The token in `flow.json`'s token file is whoever's it is: a resumed run asks the server with the token it finds
  then; a job of another user's key is not found (`404`), so it is never read or asked again under the other user.

## Verification

`node scripts/e2e.mjs` starts a real `zodchi-server` on `127.0.0.1` with `scripts/e2e/fake-codex-flow.mjs` as its
users' Codex and runs `zodchi flow` against it from the fixture repository (`scripts/e2e/scenarios/flow-server.mjs`):

| Scenario | What a user would see |
|---|---|
| `flow-server-approve` | the writer and the reviewer run on the server, in the user's Codex home, each once, with the flow's own patch and review schemas; apply, checks, one commit and the claim stay local; the token is in no journal file, output or commit |
| `flow-server-resume` | a cut right after `POST /v1/jobs` of the write step: `--resume` looks the key up and waits; one model turn, one intent and one job per step |
| `flow-server-missing-role` | a server without `flow-patch`: stopped naming the role, nothing submitted, no model turn, nothing applied |
| `flow-server-signed-out` | a signed-out subscription on the server: stopped with the sign-in message, nothing submitted; after signing in, `--resume` runs to approval |
| `flow-server-busy` | a `429 busy` on the write job: the run waits and posts the same key again; one job, one intent, approval |
