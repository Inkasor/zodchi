# Incident triage design

`incident-triage` and `ops-script` are native workflows in the shared catalog.

`incident-triage` takes a user's error report ("the job stopped", "the form asks me something I cannot answer", "a
release is blocked by a process nobody can identify") to a draft: a saved evidence bundle, a classification, the reply
for the reporter and, where code is needed, a fix brief for `code-package`.

Version 1 does **Facts → Classify → Draft** and stops. It starts no package, releases nothing, runs no `ops-script`
and sends no message. Fixing, releasing and closing are the lead's manual steps (below).

## Before the first run

Write the product's adapter: what the workflow may read about the product, who owns its decisions, where its agent
skill and allow-lists live. See [incident-adapter.md](incident-adapter.md). Keep it in the company's fork or a private
folder, not in this repository.

## Version 1 inputs

```json
{
  "incident": "catalog-2026-11-17-export",
  "tmp": "/path/to/incidents/catalog-2026-11-17-export",
  "adapter": "/path/to/adapters/catalog.json",
  "report": "<the reporter's text, verbatim>",
  "params": { "id": "4711" },
  "repo": "/path/to/a/repository/that/ignores/.agent-tmp"
}
```

- `params` are the values the adapter's operations take, read off the report by the lead. Each is checked against
  its pattern and refused when it holds a prohibited character or recognizable private material. Operations with
  missing placeholder values are skipped.
- `repo` is the Git checkout used by the local Codex gateway. The model is selected from the `architect` role by
  default. `role` selects another model role, and `models` can override the candidate lists by role. The shipped
  expert classifier frame is required.
- One folder per incident. A second run in the same folder is a new revision; it never edits an older one.

## Native invocation and recovery

Save the inputs as JSON, then run:

```sh
zodchi flow incident-triage --args incident.json
zodchi flow incident-triage --args incident.json --detach
zodchi flow status <run-id>
zodchi flow incident-triage --resume <run-id>
zodchi flow incident-triage --resume <run-id> --rerun "read E2"
zodchi flow incident-triage --resume <run-id> --rerun classify
```

Supply exactly one of `report` and `reportFile`. A detached run returns its run ID; resume does not need the input file. A stopped classifier is rerun only when explicitly requested. Otherwise its recorded key is reused; an unknown job outcome is not submitted again. The selected classifier and local executor configuration are checked against the values pinned at preparation.

The native runner validates the adapter and model before incident reads. It collects bounded local operations directly, without a shell, and redacts the report and outputs before storage or model input. The classifier receives the adapter and evidence as untrusted data. Each read is journaled before execution and has a receipt afterward. Resume uses any complete receipt from the journal. The incident lock prevents concurrent revisions and stays with the run during recovery. Published artifact bytes are reconciled against existing files and mismatches are refused.

The runner prepares a complete owner record in a per-run staging directory before publishing `.lock`. After the final result it moves its lock to a per-run release directory and records completion before cleaning it up. Resume can finish either interrupted transition without removing a later run's lock. Existing legacy locks, including empty or malformed ones, are never adopted or cleared.

The classifier answer is checked before a draft is written:
   - a private word, recognizable credential value or screened private path stops the run at classification.
     Ordinary wording such as "the API token expired" and "never paste credentials" passes this check;
   - an evidence id that is not in the bundle refuses the answer;
   - a finding about what agents may do must cite both the agent skill and an allow-list;
   - a text the lead acts on (the question for the owner, each gap's what and proposal, every
     field and list entry of the fix brief, the agent skill change) that asks for access, says someone has none or
     proposes working around a refusal refuses the answer; a prohibition ("the command must not grant access", "the
     test must not bypass the allow-list refusal") is not a proposal and passes;
   - the facts, the suggested reply, the line for the lead, the route's reason and each finding's summary pass the
     privacy check and are shown separately as wording for the lead. A finding is shown by
     the workflow's own text only (its kind, its confidence and its evidence ids with the source of each, such as
     `op:processes`, `agentSkill` or `allowList:<name>`), and the same text is the cause in the incident-log note and
     what the lead hands to the operator or owner. `classification.json` keeps the summaries apart from the findings
     (under `modelWording.findingSummaries`). An infra finding whose summary says "Grant the lead read access to the
     processes table." therefore appears in the draft only under the wording heading (case `access-in-summary`);
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
puts the reply into the reporter's language. The model's facts, its suggested reply, its line for the lead, the route's reason and the summary of each finding
are shown in the draft under "Model's wording (not checked, do not forward as is)". They pass privacy screening and
are available to the lead as reference.

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

`state` is `drafted`, `needs-evidence` or `failed`. `collecting` and `classified` are intermediate states.
Resume an interrupted run by its original ID. A lost or foreign lock stops the workflow.

When a read was interrupted without a usable receipt, `--resume` stops with `reason: "unresolved read"` and the
exact step name in `stoppedAt`, such as `read E2`. Follow the command in `next` to authorize the repeat with
`--resume <run-id> --rerun "read E2"`. The latest journal event must be that unresolved read stop. The runner records
a new attempt for that read, discards its incomplete pending receipt, and continues the same revision and plan.
It reuses every other saved receipt and releases the incident lock when the run finishes.

## After the draft: phases 4-6 by hand

**4. Fix** (`fix-brief`). Save the draft's fix brief as a brief file and use `zodchi flow code-package` with it. When
the draft has the section "Agent skill: a second package", the change alters what the product's agents can do or are
told: put the skill into the same package when it lives in the same repository, otherwise run a second package for it
and treat both as one change set: neither is released without the other, and the skill never before the capability
exists.

**5. Release.** Only with an explicit OK of the product's owner, for the exact reviewed revision. Hand the release
command from the adapter (`releaseCommand`) to whoever runs it and collect the operator's verification and execution receipt. A prepared release is not a
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
