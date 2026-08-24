import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openDb } from "../src/db.mjs";
import { buildDiagnosticSnapshot, classifyDiagnosticChanges, compareDiagnosticSnapshots, configureOneCBslCheck } from "../src/one-c-bsl-check.mjs";

function report(root, diagnostics) {
  return { sourceDir: root, fileinfos: [{ path: pathToFileURL(path.join(root, "Module.bsl")).href, diagnostics }] };
}

test("BSL baseline comparison ignores accepted debt and blocks only new warning or error signatures", () => {
  const root = path.resolve("fixture");
  const warning = { code: "WarningRule", severity: "Warning", message: "old warning" };
  const baseline = buildDiagnosticSnapshot(report(root, [warning, { code: "InfoRule", severity: "Information", message: "noise" }]));
  const unchanged = buildDiagnosticSnapshot(report(root, [warning]));
  assert.equal(compareDiagnosticSnapshots(unchanged, baseline).status, "passed");
  const changed = buildDiagnosticSnapshot(report(root, [warning, { code: "ErrorRule", severity: "Error", message: "new error" }]));
  const comparison = compareDiagnosticSnapshots(changed, baseline);
  assert.equal(comparison.status, "failed");
  assert.equal(comparison.added_count, 1);
  assert.equal(comparison.added[0].code, "ErrorRule");
});

test("BSL policy blocks critical correctness defects but reports maintainability findings", () => {
  const rules = new Map([
    ["ParseError", { code: "ParseError", name_ru: "Ошибка разбора", type: "ERROR", severity: "CRITICAL" }],
    ["CognitiveComplexity", { code: "CognitiveComplexity", name_ru: "Когнитивная сложность", type: "CODE_SMELL", severity: "CRITICAL" }],
    ["UsingHardcodeSecretInformation", { code: "UsingHardcodeSecretInformation", name_ru: "Секрет в коде", type: "VULNERABILITY", severity: "CRITICAL" }]
  ]);
  const changes = [
    { path: "Module.bsl", severity: "Error", code: "ParseError", message_hash: "1", count: 1 },
    { path: "Module.bsl", severity: "Warning", code: "CognitiveComplexity", message_hash: "2", count: 2 },
    { path: "Module.bsl", severity: "Error", code: "UsingHardcodeSecretInformation", message_hash: "3", count: 1 }
  ];
  const normal = classifyDiagnosticChanges(changes, { rules, policies: [{ type: "ERROR", minimum_severity: "CRITICAL", disposition: "block" }] });
  assert.deepEqual(normal.blocking.map(item => item.code), ["ParseError"]);
  assert.deepEqual(normal.advisory.map(item => item.code), ["CognitiveComplexity", "UsingHardcodeSecretInformation"]);
  const security = classifyDiagnosticChanges(changes, { rules, policies: [{ type: "ERROR", minimum_severity: "CRITICAL", disposition: "block" }, { type: "VULNERABILITY", minimum_severity: "INFO", disposition: "block" }, { type: "SECURITY_HOTSPOT", minimum_severity: "INFO", disposition: "block" }] });
  assert.deepEqual(security.blocking.map(item => item.code), ["ParseError", "UsingHardcodeSecretInformation"]);
});

test("1C BSL configuration activates only the registered project check", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-c-bsl-config-"));
  const dbFile = path.join(root, "workflow.sqlite"), projectRoot = path.join(root, "project"), platformBin = path.join(root, "platform"), runner = path.join(root, "runner.mjs"), executable = path.join(root, "bsl.exe"), tempRoot = path.join(root, "temp");
  fs.mkdirSync(projectRoot); fs.mkdirSync(platformBin); fs.writeFileSync(path.join(platformBin, "shcntx_root.hbk"), "fixture"); fs.writeFileSync(executable, "fixture"); fs.writeFileSync(runner, "fixture");
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run("one-c", "1C", projectRoot, new Date().toISOString());
  db.prepare("INSERT INTO check_definitions(id,name,runner,kind,config_json,timeout_seconds) VALUES(?,?,?,?,?,?)").run("bsl_language_server", "BSL", "bsl", "disabled", "{}", 30);
  db.prepare(`INSERT INTO check_baselines(id,project_id,check_id,kind,tool_name,tool_version,accepted_revision,confirmed_by,minimum_severity,error_count,warning_count,information_count,hint_count,considered_count,file_count,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("baseline", "one-c", "bsl_language_server", "one-c-bsl-diagnostics", "BSL Language Server", "1.0.7", "abc123", "owner", "Warning", 0, 0, 0, 0, 0, 0, "active", new Date().toISOString());
  db.close();
  const result = configureOneCBslCheck(dbFile, { projectId: "one-c", executable, platformBin, runner, tempRoot });
  assert.equal(result.status, "configured");
  const verified = openDb(dbFile), check = verified.prepare("SELECT kind,runner,config_json,timeout_seconds FROM check_definitions WHERE id='bsl_language_server'").get();
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM diagnostic_rules WHERE tool_name='BSL Language Server' AND tool_version='1.0.7'").get().count, 186);
  assert.equal(verified.prepare("SELECT COUNT(*) count FROM project_diagnostic_policies WHERE project_id='one-c' AND check_id='bsl_language_server'").get().count, 6);
  verified.close();
  assert.equal(check.kind, "command"); assert.equal(check.runner, "one_c_bsl_policy"); assert.equal(check.timeout_seconds, 1800);
  const config = JSON.parse(check.config_json); assert.equal(config.command, process.execPath); assert.equal(config.args.includes("--platform-bin"), true); assert.equal(config.args.includes(dbFile), true); assert.equal(config.args.includes("one-c"), true); assert.equal(config.args.includes("{{quality_level}}"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
