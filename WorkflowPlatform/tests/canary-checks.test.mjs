import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { openDb } from "../src/db.mjs";
import { runOneCBslCheck } from "../src/one-c-bsl-check.mjs";
import { applyWorkflowImport, proposeWorkflowImport } from "../src/workflow-package.mjs";
import { registerImplicitResources } from "../src/project-resources.mjs";
import { registerCanaryChecks } from "../scripts/canary-checks.mjs";

const repositoryRoot = path.dirname(import.meta.dirname);
const PACKAGE_FILE = path.join(repositoryRoot, "packages", "example", "generated", "one-c.development.xml");

// A real BSL Language Server is a local binary a test can never carry, and a script standing in for one
// is not spawnable on every platform: Windows refuses a shell wrapper without a shell. So the analyzer
// here is the Node runtime itself, preloaded with a shim that answers the only two calls the runner
// makes, `version` and `analyze`, and exits before the missing entry point is ever resolved. The whole
// path around it stays real — the spawn, the JSON report contract, the database — so what this proves is
// the sequence rather than a re-implementation of it. The shim is reached through NODE_OPTIONS, which
// every spawned child inherits, so the caller restores the previous value once the run is over.
function fakeAnalyzer(root, diagnostics) {
  const shim = path.join(root, "bsl-shim.mjs"), findings = path.join(root, "diagnostics.json");
  fs.writeFileSync(findings, JSON.stringify(diagnostics), "utf8");
  fs.writeFileSync(shim, [
    `import fs from "node:fs";`,
    `import path from "node:path";`,
    `const argv = process.argv.slice(1);`,
    `// Node resolves the subcommand into an absolute entry path before the shim runs, so the call is`,
    `// recognised by its last segment rather than by the argument as it was passed.`,
    `if (path.basename(argv[0] ?? "") === "version") { process.stdout.write("version: 1.0.7\\n"); process.exit(0); }`,
    `const value = name => argv[argv.indexOf(name) + 1];`,
    `const source = value("--srcDir");`,
    `const diagnostics = JSON.parse(fs.readFileSync(${JSON.stringify(findings)}, "utf8"));`,
    `fs.writeFileSync(path.join(value("--outputDir"), "bsl-json.json"), JSON.stringify({ sourceDir: source, fileinfos: [{ path: path.join(source, "Module.bsl"), diagnostics }] }), "utf8");`,
    `process.exit(0);`,
    ""
  ].join("\n"), "utf8");
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ? `${previous} ` : ""}--import ${pathToFileURL(shim).href}`;
  return { executable: process.execPath, findings, restore: () => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; } };
}

function acceptedSource(root) {
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "Module.bsl"), "Процедура Пример()\nКонецПроцедуры\n", "utf8");
  const identity = ["-c", "user.email=canary@zodchi.invalid", "-c", "user.name=Zodchi Canary"];
  execFileSync("git", ["init", "--quiet"], { cwd: source, stdio: "pipe" });
  execFileSync("git", [...identity, "add", "."], { cwd: source, stdio: "pipe" });
  execFileSync("git", [...identity, "commit", "--quiet", "-m", "canary source"], { cwd: source, stdio: "pipe" });
  return { source, revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() };
}

function importedProject(root, projectRoot) {
  const dbFile = path.join(root, "workflow-evidence.sqlite");
  const db = openDb(dbFile);
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run("one-c-canary", "1C canary", projectRoot, new Date().toISOString());
  registerImplicitResources(db, { projectId: "one-c-canary", rootPath: projectRoot });
  db.close();
  const proposal = path.join(root, "import-proposal.json");
  proposeWorkflowImport(dbFile, PACKAGE_FILE, proposal, "one-c-canary");
  applyWorkflowImport(dbFile, proposal, "one-c-canary", { confirmedBy: "canary-reversible-local-import" });
  return dbFile;
}

// An import gives every package entity a local identity, so the check is addressed through the mapping
// the import recorded rather than through the semantic key the package used.
function importedCheck(dbFile) {
  const db = openDb(dbFile);
  const row = db.prepare(`SELECT d.id,d.kind,d.runner,d.config_json FROM package_import_mappings m
    JOIN check_definitions d ON d.id=m.local_id
    WHERE m.entity_type='check' AND m.semantic_key='bsl_language_server'`).get();
  db.close();
  return row;
}

test("the canary registers the owner baseline and binds the analyzer before the run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canary-checks-"));
  let restore;
  try {
    const { source, revision } = acceptedSource(root);
    const platformBin = path.join(root, "platform");
    fs.mkdirSync(platformBin);
    fs.writeFileSync(path.join(platformBin, "shcntx_ru.hbk"), "fixture", "utf8");
    let executable, findings;
    ({ executable, findings, restore } = fakeAnalyzer(root, [{ code: "DeprecatedCurrentDate", severity: "Error", message: "accepted debt" }] ));
    const dbFile = importedProject(root, source);

    // The package binds this check as required at mvp and ships it inert on purpose. This is the state
    // a canary that only imported would have run against: a green gate for a check nobody ran.
    const inert = importedCheck(dbFile);
    assert.equal(inert.kind, "disabled");

    const item = {
      project_id: "one-c-canary",
      checks: {
        one_c_bsl: {
          executable,
          source,
          platform_bin: platformBin,
          temp_root: path.join(root, "temp"),
          accepted_revision: revision,
          confirmed_by: "owner@example.invalid",
          minimum_severity: "Warning"
        }
      }
    };
    const receipt = registerCanaryChecks(dbFile, item);
    assert.equal(receipt.check_id, inert.id);
    assert.equal(receipt.baseline.status, "created");
    assert.equal(receipt.baseline.tool_version, "1.0.7");
    assert.equal(receipt.baseline.accepted_revision, revision);
    assert.equal(receipt.configuration.status, "configured");

    const bound = importedCheck(dbFile);
    assert.equal(bound.kind, "command");
    assert.equal(bound.runner, "one_c_bsl_policy");
    assert.equal(JSON.parse(bound.config_json).args.includes(path.resolve(dbFile)), true);

    const stored = openDb(dbFile);
    const baseline = stored.prepare("SELECT confirmed_by,accepted_revision,error_count FROM check_baselines WHERE project_id='one-c-canary' AND status='active'").get();
    const signatures = stored.prepare("SELECT COUNT(*) count FROM check_baseline_diagnostics WHERE baseline_id=?").get(receipt.baseline.baseline_id).count;
    const rules = stored.prepare("SELECT COUNT(*) count FROM diagnostic_rules WHERE tool_name='BSL Language Server' AND tool_version='1.0.7'").get().count;
    stored.close();
    assert.equal(baseline.confirmed_by, "owner@example.invalid");
    assert.equal(baseline.accepted_revision, revision);
    assert.equal(baseline.error_count, 1);
    assert.equal(signatures, 1);
    assert.equal(rules, 186);

    const analysis = { dbFile, projectId: "one-c-canary", executable, source, workspace: source, platformBin, tempRoot: path.join(root, "temp"), qualityLevel: "mvp" };

    // Accepted debt stays accepted: the same findings after the baseline are not a regression.
    const unchanged = runOneCBslCheck(analysis);
    assert.equal(unchanged.status, "passed");
    assert.equal(unchanged.added_count, 0);

    // A new maintainability finding is reported, not blocked. That is what signing a baseline over a
    // legacy configuration buys: the existing debt is frozen and only new critical defects fail.
    fs.writeFileSync(findings, JSON.stringify([{ code: "DeprecatedCurrentDate", severity: "Error", message: "accepted debt" }, { code: "DeprecatedCurrentDate", severity: "Error", message: "another module" }]), "utf8");
    const advisory = runOneCBslCheck(analysis);
    assert.equal(advisory.status, "passed");
    assert.equal(advisory.advisory_added_count, 1);
    assert.equal(advisory.blocking_added_count, 0);

    // A new critical defect fails the gate, which is only reachable because the check was bound.
    fs.writeFileSync(findings, JSON.stringify([{ code: "DeprecatedCurrentDate", severity: "Error", message: "accepted debt" }, { code: "ParseError", severity: "Error", message: "broken module" }]), "utf8");
    const blocked = runOneCBslCheck(analysis);
    assert.equal(blocked.status, "failed");
    assert.equal(blocked.blocking_added_count, 1);
    assert.equal(blocked.blocking_added[0].code, "ParseError");
  } finally {
    restore?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the canary never supplies owner acceptance of its own", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canary-checks-unsigned-"));
  try {
    const dbFile = path.join(root, "workflow.sqlite");
    assert.throws(() => registerCanaryChecks(dbFile, {
      project_id: "one-c-canary",
      checks: { one_c_bsl: { executable: "bsl", source: root, platform_bin: root, temp_root: root, accepted_revision: "abc123" } }
    }), /ONE_C_BSL_ARGUMENT_REQUIRED: confirmed-by/);
    assert.equal(registerCanaryChecks(dbFile, { project_id: "web-canary" }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
