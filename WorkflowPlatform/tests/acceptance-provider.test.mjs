import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const provider = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "deterministic-workflow-provider.mjs");

test("acceptance provider follows an explicit registered-route scenario instead of its Web default", () => {
  const prompt = "ROLE: classifier\n<result_contract schema=\"classifier.v1\"/>\nSCENARIO_WORK_TYPE=one-c.diagnosis SCENARIO_ARTIFACT=test_report SCENARIO_DOMAIN=one-c SCENARIO_DISCIPLINE=one-c-development\n";
  const lines = execFileSync(process.execPath, [provider], { input: prompt, encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
  const result = JSON.parse(JSON.parse(lines.at(-1)).result);
  assert.equal(result.work_type, "one-c.diagnosis");
  assert.equal(result.artifact_type, "test_report");
  assert.equal(result.domain, "one-c");
  assert.equal(result.discipline, "one-c-development");
  assert.equal(result.quality_mode, "mvp");
});
