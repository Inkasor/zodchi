import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runRegisteredExternalCheck, runSqliteCheck } from "../src/external-check-runner.mjs";

test("registered HTTP checks fail unavailable on transport and pinned-version mismatch", async () => {
  const unavailable = await runRegisteredExternalCheck({ external_tool: { transport: "http", endpoint: "http://127.0.0.1:1", pinned_version: "1.0.0" }, config: {}, timeout_seconds: 1 }, { project: process.cwd() });
  assert.equal(unavailable.status, "unavailable");
  const server = http.createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status: "passed", version: "2.0.0" })); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const mismatch = await runRegisteredExternalCheck({ external_tool: { transport: "http", endpoint: `http://127.0.0.1:${address.port}`, pinned_version: "1.0.0" }, config: {}, timeout_seconds: 2 }, { project: process.cwd() });
    assert.equal(mismatch.status, "unavailable");
    assert.match(mismatch.failure, /version mismatch/u);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("SQLite checks open the registered database read-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-sqlite-check-")), file = path.join(root, "fixture.sqlite");
  const db = new DatabaseSync(file); db.exec("CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES ('ok')"); db.close();
  const before = fs.statSync(file).size;
  const passed = runSqliteCheck({ sqlite_database: file, config: { sql: "SELECT value FROM facts", expected: "ok" } });
  assert.equal(passed.status, "passed");
  assert.equal(fs.statSync(file).size, before);
  const weakMatch = runSqliteCheck({ sqlite_database: file, config: { sql: "SELECT value FROM facts UNION ALL SELECT 'ok'", expected: "ok" } });
  assert.equal(weakMatch.status, "failed");
  const mutation = runSqliteCheck({ sqlite_database: file, config: { sql: "DELETE FROM facts" } });
  assert.equal(mutation.status, "unavailable");
  fs.rmSync(root, { recursive: true, force: true });
});
