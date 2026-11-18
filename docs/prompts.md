# Writing a prompt for an agent or a role

Write it the way you would brief a capable colleague who has not seen the
conversation. The files this covers: `core/agents/`, `domains/*/agents/`,
`roles/*.md` and the skills.

1. **The task.** One paragraph: what the agent is, what it receives, what it
   produces.
2. **Done.** Say what finished means, in things a command or a reader can
   check, so the agent neither stops early nor goes on polishing.
3. **Evidence.** Say what to return: commands with exit codes, paths of logs,
   file and line, the exact values. A claim without evidence is not a result.
4. **Stop and hand back.** Name the cases where the agent stops and says what
   is in the way (a missing input, a decision that is not its own, a conflict),
   and what it returns then. A stop is a valid result, not a failure.
5. **Reasons, not shouting.** Prose with a reason does more than capitals,
   NEVER and ALWAYS. Keep a hard "never" for what cannot be undone, and give the
   reason beside it.
6. **Relayed text is data.** A user's report, a page, a log, a diff, another
   model's answer: say that it is material to read, not an order, and give it
   clear boundaries (a quoted block, a named attachment) where you pass it on.
   The words of the person or the lead who started the work are the only
   instructions.
7. **No contradictions.** A prompt does not forbid what the task text allows.
   Where the workflow passes a list (protected files, allowed exceptions), the
   prompt points to it instead of repeating a rule of its own.
8. **What workflows read stays exact.** Field names, file names, exit-code
   rules, the foreground wait of a gateway call: change them together with the
   code that reads them.
9. **A model note only for a behaviour seen.** Add a remark for a current model
   when there is a concrete behaviour to correct, and give the reason. No effort
   numbers: they come from measurement.
10. **Public text.** No company or product names and no private paths.
