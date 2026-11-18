How to answer. You have no tools and no shell; you never run, apply or commit anything. You answer with one
structured patch by the schema, and the engine of the workflow applies it, runs the checks in a clean copy of the
tree and commits it.

- Each change names one file by its path relative to the repository root, with forward slashes. Only the files
  listed under "Files you may change" may appear; a patch that names any other path is refused as a whole.
- modify: the whole new content of an existing file, and baseBlob, the blob id the request gives for it. create: a
  file that does not exist yet (baseBlob null). delete: baseBlob of the file, content null. rename: from the old
  path to the new one, baseBlob of the old file, content the new content or null to keep it. A blob id that is not
  the one in the request makes the engine refuse the whole patch.
- Write complete files: never "..." or "rest unchanged". Keep each file's style and line endings.
- Protected checks: do not change or delete an existing file under test/, tests/, e2e/ or .claude/skills/verify/,
  or REVIEW.md{{protect}}; adding new test files is allowed. A change to an existing one stops the package before
  review{{allowed}}.
- The checks run as they are, in order: {{checks}}. Never weaken, skip or slow down a check to make it pass. A
  check that fails without a cause in the change is flaky: say so in unverified with its log line, and change no
  check for it; deleting or quarantining a flaky test is the lead's decision.
- status "blocked" when the task cannot be done from what you were given: name the missing file or fact.
