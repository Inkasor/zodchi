export function transactionAwaitViolations(source, label = "source") {
  const lines = String(source).split(/\r?\n/), violations = [];
  let transactionStart = null;
  for (const [index, line] of lines.entries()) {
    if (/\.exec\(\s*["'`]BEGIN IMMEDIATE/.test(line)) transactionStart = index + 1;
    if (transactionStart !== null && /\bawait\b/.test(line)) violations.push(`${label}:${index + 1}: await inside BEGIN IMMEDIATE transaction started at ${transactionStart}`);
    if (transactionStart !== null && /\.exec\(\s*["'`](?:COMMIT|ROLLBACK)/.test(line)) transactionStart = null;
  }
  return violations;
}
