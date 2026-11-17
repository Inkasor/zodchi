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
- `crates/zodchi-server`: the same gateway over HTTP for several people (below).

Building on Windows with the GNU toolchain needs no Visual Studio: the gateway has no C or TLS dependencies.

## Server

`zodchi-server` lets several people call Codex models by role through one machine. Each person signs in to
**their own** ChatGPT subscription by device code, and every job of a person runs only on that person's
subscription: nobody's job spends another person's limit.

```
cargo build --release                        # target/release/zodchi-server
zodchi-server user add "Anna"                # prints Anna's id and token, once
zodchi-server serve                          # http://127.0.0.1:8787 until Ctrl+C or SIGTERM
```

Hand the token to the person. They sign in to their subscription (`POST /v1/login`, open `verificationUrl`,
enter `userCode`) and then call roles with `Authorization: Bearer <token>`:

```
curl -s -X POST localhost:8787/v1/login -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8787/v1/jobs -H "Authorization: Bearer $TOKEN" \
  -d '{"key": "review-1", "role": "code-review", "prompt": "..."}'
curl -s "localhost:8787/v1/jobs/review-1?waitSec=60" -H "Authorization: Bearer $TOKEN"
curl -s localhost:8787/v1/jobs/review-1/result -H "Authorization: Bearer $TOKEN"
```

The server speaks plain HTTP on `127.0.0.1:8787` (`--listen <addr>`); TLS and a public name belong to a reverse
proxy in front of it. Options of `serve`: `--threads <n>` (default 16, at least 2: the server refuses to start with fewer), `--max-user-jobs <n>` (4),
`--max-jobs <n>` (16). Roles are the installed ones (`~/.zodchi/roles`, or `$ZODCHI_ROLES`); Codex is found as
for `zodchi` (`ZODCHI_CODEX_BIN`, then `PATH`).

### Users (local admin commands, no HTTP admin API)

| Command | What it does |
|---|---|
| `zodchi-server user add <name>` | adds a user and prints a new token once |
| `zodchi-server user list` | the users, without tokens |
| `zodchi-server user remove <id>` | removes the user: their token fails on the next request |
| `zodchi-server user token <id>` | issues a new token; the user's earlier tokens stop working on the next request |

Every command takes `--data <dir>`. A removed user's jobs that were already accepted run to the end, and their
folder (jobs and sign-in) stays on disk until the admin deletes it; a new user never gets the id of a folder
that is still there.

### Storage

A data folder, `--data <dir>`, default `~/.zodchi/server` (`$ZODCHI_HOME/server` when `ZODCHI_HOME` is set):

- `server.json`: the users, `{id, name, tokenHashes[], createdAt}`. Only SHA-256 hashes of the tokens are stored.
  It is replaced atomically, every admin change runs under `server.json.lock`, and the server reads it on every
  authenticated request: a change takes effect without a restart, and a file that cannot be read lets nobody in
  (500).
- `users/<id>/codex-home/`: that user's Codex home, their sign-in.
- `users/<id>/jobs/`: that user's job folders, the same as the `zodchi` command's, so idempotency keys, the queue
  (two running jobs per user), workers, settling dead workers and `wait` are those of `zodchi-core`. The server
  starts each worker as `zodchi-server work --data <dir> --user <id> --key <key>`, with that user's jobs and that
  user's Codex home as its only account.
- `server.lock`: one serving process per data folder; a second `serve` on the same folder refuses to start.
  `server.lock` and `server.json.lock` are operating-system locks on the open file, held for as long as the owner
  runs; the system releases them when the owner exits or crashes, so there is no stale lock to clear by hand.

The plan named SQLite; it is replaced by files because the gateway builds without a C compiler (no bundled SQLite,
no `ring`, no OpenSSL), and the core is already synchronous and file based. HTTP is `tiny_http`, pure Rust, with
no async runtime.

### API

JSON in and out. Every route except `/health` needs authentication; another user's job is 404, never 403. Every error is a **public error**:
`{"error": {"code", "message", "field"?}}`, a stable code and a message that is fixed text (or composed from the
client's own request, as the 400 validation messages are), plus the `field` of the request it is about where that
helps. No part of it is a server value: no path, no text of an I/O error, of Codex, of a role file, and no stored job
error. The diagnostic goes to the server's standard error, and a job's own error also stays in its job folder. A job
is shown through a fixed list of its fields (never its folder, its Codex process or thread, the servers of its role),
with `error` mapped from its final status to `{code, message}` (`null` otherwise). The model's own answer (the job's
`result`, the result routes) is returned as the model gave it. There is no text filter: the contract is that an error
is built only from a code, a fixed message and a field name.

| code | status | meaning |
|---|---|---|
| `bad_request` | 400 | the request is wrong; the message names what (the body, a field, `waitSec`, an image, the model or effort sent) |
| `unauthorized` | 401 | no token, or a wrong one |
| `not_found` | 404 | no such route, job or image |
| `method_not_allowed` | 405 | the route does not take the method |
| `key_conflict` | 409 | the key belongs to another request (`field: key`) |
| `not_final` | 409 | the job has no final status yet |
| `busy` | 429 | over the limit of unfinished jobs; the key stays free |
| `role_not_found` | 400 | the role is not installed on the server (`field: role`) |
| `role_not_allowed` | 400 | a work or decisions role (`field: role`) |
| `role_invalid` | 400 | the role is installed but cannot be loaded (`field: role`) |
| `storage_error` | 500 | the server cannot read or write its own files; the key stays free |
| `unavailable` | 500 | the server cannot answer now: its registry or authenticator, or it is stopping |
| `codex_unavailable` | 200 or 500 | Codex cannot read or change the caller's sign-in (`error` of `/v1/account` and `/v1/login` with status 200, and of the sign-in calls with 500) |
| `sign_in_failed` | 200 | a device-code sign-in ended without a sign-in (`error` of `GET /v1/login`) |
| `auth_required` | job | the job found no ChatGPT sign-in |
| `limited` | job | the subscription's limit is used up |
| `timeout` | job, sign-in | the call ran out of time, or the device code expired |
| `job_failed` | job | the call failed |
| `unknown` | job | whether the model turn ran is not known |

The `unauthorized` text is the server's own; what an `Authenticator` of a fork says is not passed on.

| Route | Answer |
|---|---|
| `GET /health` | `{ok: true, version}` |
| `POST /v1/login` | starts a device-code sign-in of the caller's subscription: `{status: "pending", verificationUrl, userCode, loginId, expiresInSec}`. One open sign-in per user; a second start returns the open one |
| `GET /v1/login` | `{status: none, pending, connected or failed, verificationUrl?, userCode?, email?, plan?, error?: {code, message}}` |
| `DELETE /v1/login` | cancels an open sign-in and signs the caller's Codex home out |
| `GET /v1/account` | the caller's sign-in and limits, what `zodchi account` prints for that one account |
| `GET /v1/roles` | the roles a call may name: the installed expert roles of the kinds text and image |
| `POST /v1/jobs` | `{key, role, prompt, images?: [base64], model?, effort?, timeoutMin?, credits?}` -> `{job, created}`: 201 created, 200 the existing job of the same request, 409 the key belongs to another request, 429 over the limits |
| `GET /v1/jobs/{key}?waitSec=n` | `{job}` as it is after waiting up to `n` seconds (at most 60) for a final status |
| `GET /v1/jobs/{key}/result` | 409 `{status}` while not final; 422 `{status, error: {code, message}}` for a final status other than `succeeded`; for `succeeded`: the text (`text/plain`), the JSON of the role's schema (`application/json`), or for an image job a manifest `{images: [{index, contentType, bytes, url}]}` |
| `GET /v1/jobs/{key}/result/{index}` | the bytes of one image with its content type |

**Sign-in.** The app-server of an open sign-in lives in the caller's Codex home until `account/login/completed`
arrives for its `loginId`, or until the code expires after 15 minutes; then the attempt is cancelled and the
app-server stopped. A start after the code expired first cancels and stops the expired attempt. Stopping the server
first refuses new sign-ins, cancels every open one and waits until every sign-in app-server has exited (also one
that a completion or an expiry was stopping at that moment), then lets the HTTP threads finish the request at hand
(a long poll ends early) before it releases `server.lock`; no sign-in survives a restart. `connected` is reported only from `account/read` of the caller's Codex home (reused for at most 60
seconds), never from memory.

**Keys.** `role` is the name of an installed role. The idempotency check of a key is the hash of the client's
request as sent (role name, prompt, images, model, effort, timeoutMin, credits); the role is resolved and stored in
the job when it is created, so a later change of the installed role does not turn a retry into a 409. A key is
idempotent for as long as its job folder lives: a finished job is removed after seven days, and a repeat after that
is a new call that spends again.

**Capacity.** A fixed pool of at least two HTTP threads (`--threads 1` is refused at start); at most half of them
wait in long polls, and a long poll over that answers at once with the job as it is, so `/health` and short calls
always find a free thread.
Before a job is created the server checks, in one critical section, the key, the unfinished jobs of the caller
(at most `--max-user-jobs`) and of the server (at most `--max-jobs`), counted from the job folders on disk of every
user, removed users included. Over a limit the answer is 429 and the key stays free; a repeat of an existing key is
never refused by admission. The count fails closed: a job folder whose record cannot be read counts as unfinished,
and a folder that cannot be listed refuses the job with 500 (the key stays free). Each worker the server starts is
waited on, so finished workers do not pile up as zombie processes.

### What the server refuses (400, with the reason)

- A role in `work` mode: the server has no repository of the caller to work in.
- A decisions role and `paid`: they spend from the OpenAI API key, which on the server would be its owner's.
- `resume` and `keepThread`: they belong to a work call.
- A role file or an inline role (`role` as JSON): only the installed roles of the server run.
- A body over 32 MB; more than 8 images; unknown fields.

### Authorization in a fork

Who is calling is decided by one trait, `zodchi_server::auth::Authenticator` (request headers -> an `Identity`
or a refusal). The default, `TokenAuthenticator`, checks `Authorization: Bearer <token>` against the hashes in
`server.json` in constant time. A fork that signs people in through its own identity service implements the trait
and passes it to `zodchi_server::api::serve`; nothing else changes. The identity's `id` names the user's folder
and must be `[a-z0-9-]{1,40}`.
