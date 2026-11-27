- Protected checks include existing tests, REVIEW.md, .zodchi/verify.json, and verify instructions under skills/,
  .agents/skills/ and .claude/skills/{{protect}}. Adding new test files is allowed. Changes to protected files stop
  the package before review{{allowed}}.
- The engine runs the configured checks in order: {{checks}}. Preserve their assertions, coverage and time limits.
  Report unrelated failures with the relevant log evidence. The lead decides whether to quarantine a flaky check.
