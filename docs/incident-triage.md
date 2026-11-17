# Incident triage

`incident-triage` takes a user's error report ("the job stopped", "the form asks me something I cannot answer", "a
release is blocked by a process nobody can identify") to a draft: a saved evidence bundle, a classification, the reply
for the reporter and, where code is needed, a fix brief for `code-package`.

Version 1 does **Facts → Classify → Draft** and stops. It starts no package, releases nothing, runs no `ops-script`
and sends no message. Fixing, releasing and closing are the lead's manual steps (below).

## Before the first run

Write the product's adapter: what the workflow may read about the product, who owns its decisions, where its agent
skill and allow-lists live. See [incident-adapter.md](incident-adapter.md). Keep it in the company's fork or a private
folder, not in this repository.

## Run it

```
/zodchi-core:incident-triage
args: {
  "incident": "catalog-2026-11-17-export",
  "tmp": "/path/to/incidents/catalog-2026-11-17-export",
  "adapter": "/path/to/adapters/catalog.json",
  "report": "<the reporter's text, verbatim>",
  "params": { "id": "4711" },
  "repo": "/path/to/a/repository/that/ignores/.agent-tmp"
}
```

- `params` are the values the adapter's operations take, read off the report by the lead. Each is checked against
  its pattern and refused when it holds a character a shell gives meaning to.
- `repo` is where the gateway runs when the classifier is a Codex model (the role `architect` by default; `role` picks
  another). Without it, or without a Codex limit, the first Claude candidate of the role classifies.
- One folder per incident. A second run in the same folder is a new revision; it never edits an older one.

## What happens

1. **Open** (runner). Takes the lock `<tmp>/.lock` (one run per incident), reads the adapter and its SHA-256, the role
   table and `incident.json`. The core checks the adapter's version and shape; a bad adapter stops the run before
   anything is executed.
2. **Facts** (runner). The core builds the plan: the report (its secrets redacted before it reaches any file or
   prompt), each operation with its arguments checked, the agent skill and the allow-lists. A generated collector runs it with node, without a shell, each operation with its time limit
   and output cap, from the adapter's folder, under your own permissions. A failed, refused or timed-out operation is
   recorded and the others go on; one that depends on it is skipped with the reason. Nothing is retried or worked
   around, and a refused read never turns into a request for access. The result is `rev-<n>/evidence.json`: one item
   per source, each with an evidence id, its outcome, a bounded excerpt with secrets redacted, and the truncated and
   missing marks.
3. **Classify** (one call of a strong model, no tools). The request is built from the adapter and fixed text only; the
   report and every product output reach the model as the attached bundle, marked as data. The answer: findings (each
   with a kind and the evidence ids it rests on), gaps (missing evidence and the operation that would supply it, or the
   product report to build when none exists), one route, plain facts for the reporter, and the model's own wording (a
   suggested reply, a line for the lead, the route's reason).
4. **Draft** (the workflow, then a runner publishes). The workflow checks the answer before anything is written as a
   draft:
   - an evidence id that is not in the bundle refuses the answer;
   - a finding about what agents may do must cite both the agent skill and an allow-list;
   - a text the lead acts on (the question for the owner, each gap's what and proposal, every
     field and list entry of the fix brief, the agent skill change) that asks for access, says someone has none or
     proposes working around a refusal refuses the answer; a prohibition ("the command must not grant access", "the
     test must not bypass the allow-list refusal") is not a proposal and passes;
   - the facts, the suggested reply, the line for the lead and the route's reason are not checked: they are shown apart,
     as wording not to forward;
   - a fix brief with an empty or blank entry in files, done or checks refuses the answer;
   - a retry recommendation without a retry in the adapter refuses the answer;
   - `stale` without evidence that a specific release fixes the error and that the environment runs it becomes
     `unknown` (hypothesis `stale`), and the whole answer goes with it, since any of its text may rest on the fix being
     out: the facts, the model's wording, the route's question, the gaps, the fix brief and every finding's summary are
     discarded and the retry recommendation is dropped. The route becomes `needs-evidence`, and the gaps are the
     workflow's own: the missing evidence (the fix, or its deployment in the affected environment) and the adapter
     operation that supplies it, or a product report to build when none does. The raw answer stays in
     `classification.raw.json` for audit only;
   - a refused read the answer left out is added as a gap; a gap that names an operation the adapter does not have
     loses it (nothing the model says adds an operation);
   - a route the findings do not carry becomes `needs-evidence`.

### The reply and the model's wording

Version 1 hands the reply to the lead, never to the reporter. The workflow assembles it with no text of the model in it: the
product's retry in the adapter's own words (`retry.how`, in a fixed sentence) only when the answer recommends a retry
and the adapter documents one, then a fixed text for the route:

| Route | Fixed text |
| --- | --- |
| `reply` | If anything is still unclear, answer this message. |
| `fix-brief` | We found a fault in the product and are fixing it. We will write to you when the fix is out. |
| `awaiting-owner` | This needs a decision of the people responsible for the product. We will write to you once it is made. |
| `awaiting-operator` | This needs a change on the product's servers. We will write to you once it is done. |
| `needs-evidence` | We are looking into the error and will write to you with what we find. |

No text of the model is in it, so retry wording reaches the reply only through a recommended retry. The lead
puts the reply into the reporter's language. The model's facts, its suggested reply, its line for the lead and the route's reason
are shown in the draft under "Model's wording (not checked, do not forward as is)": they are not checked, and nothing
is copied from them to the reporter as it stands.

### Kinds and routes

| Kind | Meaning | Route |
| --- | --- | --- |
| `stale` | the error predates the release that fixed it, and the environment runs that release | `reply` |
| `user-action` | the reporter should do something, or waits for someone | `reply` |
| `product-bug` | the code or the agent skill is wrong | `fix-brief` |
| `missing-tool` | nobody had a sanctioned way to learn or do something | `fix-brief` |
| `infra` | rights, ACL, sudoers, resources | `awaiting-operator` |
| `owner-decision` | a product choice | `awaiting-owner` (with the owner's role and the question) |
| `unknown` | the evidence does not settle it | `needs-evidence` |

## What you get

```
<tmp>/incident.json          { id, revision, state, adapterHash, revisions: [{ n, state }] }
<tmp>/rev-<n>/evidence.json  the bundle (immutable)
<tmp>/rev-<n>/classification.json  the checked answer, or the refused one with the reasons
<tmp>/rev-<n>/draft.md       reply, findings, gaps, next step, fix brief, note for the log, the model's wording
<tmp>/rev-<n>/adapterHash    the SHA-256 of the adapter this revision used
```

`state` is `drafted`, `needs-evidence` or `failed` (`collecting` and `classified` only while a run works). A run that
was cut off leaves its revision incomplete and its lock in place: make sure no run works on the incident, then run
again with `breakLock: true`; the new run starts the next revision. A run that fails marks its revision `failed` in
`incident.json` and checks that write before it removes the lock; when the write cannot be verified, the lock stays and
the result says so (`persistError`, `lockLeft`): set the state by hand, then remove the lock.

## After the draft: phases 4-6 by hand

**4. Fix** (`fix-brief`). Save the draft's fix brief as a brief file and run `/zodchi-core:code-package` with it. When
the draft has the section "Agent skill: a second package", the change alters what the product's agents can do or are
told: put the skill into the same package when it lives in the same repository, otherwise run a second package for it
and treat both as one change set: neither is released without the other, and the skill never before the capability
exists.

**5. Release.** Only with an explicit OK of the product's owner, for the exact reviewed revision. Hand the release
command from the adapter (`releaseCommand`) to whoever runs it; a step that needs root goes through
`/zodchi-core:ops-script` with `fixes: 0`, so a reviewed script is not edited on the way. A prepared release is not a
done one: wait for its receipt before you tell anyone it is out.

**6. Close.** Send the reporter the draft's reply, in their language, with what was done since. Never "I have no
access": say what will be done and when they act. Add the note from the draft to the incident log (`incidentLog`): cause, change,
release, and who verifies. When the draft recommends the product's retry, the reporter verifies by it: remind yourself
to check that the retry worked; otherwise name who verifies and how when closing.

For `awaiting-owner` ask the owner's role the draft's question and decide nothing meanwhile; for `awaiting-operator`
hand the draft's findings and gaps to the operator's role; for `needs-evidence` collect what the gaps name (a missing
operation is a product report to build, never wider access) and run again. In each case the reporter gets the draft's
reply meanwhile.

## Rules

- Never ask a human for data access before checking for a sanctioned way; no way is `missing-tool`: fix the product.
- No merge and no release without an explicit OK.
- Product decisions are marked for the owner, never taken silently.
- An allow-list refusal names what is allowed ([patterns.md](patterns.md)); a product that refuses without saying so
  is a `product-bug` of its own.

## Checks

`node core/workflows/fixtures/incident-triage/mock.mjs` runs the workflow over the synthetic cases with a fake agent:
the facts are collected for real from a made-up product, only the model's answer is a saved file. It prints the
verdict of each case and exits 0 when all pass.
