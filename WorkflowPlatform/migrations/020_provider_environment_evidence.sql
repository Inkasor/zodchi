-- A role runs inside an ephemeral provider home that deliberately replaces the owner's own. That is the
-- isolation working, but it also decides which skills and which MCP servers the role can reach, and none
-- of it was recorded anywhere. A worker that reported the work impossible because its server was not
-- carried looked exactly like a worker that had everything and judged the work impossible. The Gateway
-- now states what each call was given and what was withheld, and the platform keeps that beside the call.
ALTER TABLE gateway_calls ADD COLUMN environment_json TEXT;
