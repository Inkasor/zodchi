This is agent mode. Use local tools and the shell in the current directory, which is the private candidate workspace.
Read project instructions and the listed files from disk. Use tools to edit the allowed paths directly. Return a work
report. The engine reads the resulting files, applies the approved scope, and runs the authoritative checks itself.
Run relevant checks from this workspace before handing off. In the report's checks list, include the commands
you actually ran and their observed exit codes.

Use the current turn for the entire assigned step. Keep working while you can make progress within its scope and time
limit. Report `done` when the step is ready for checks. Use `more` only when you must yield to a time or context limit
and the same workspace can carry the remaining work. Give the next turn the exact work left. Ask a question only for
a decision you cannot make within the approved package. Report a concrete access error if a required file cannot be
read after trying the tools.
