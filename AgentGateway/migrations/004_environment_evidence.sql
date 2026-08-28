-- What the ephemeral provider home gave the role, and what it withheld, changes the result of the call.
-- Until now none of it was recorded: a worker that ran without the MCP server or the skill its role
-- expects returned "cannot be done" indistinguishably from a worker that had everything and found the
-- work genuinely impossible. The report is written by the environment that built the home, so it states
-- the policy that decided each item rather than the absence that followed from it.
ALTER TABLE receipts ADD COLUMN environment_json TEXT;
