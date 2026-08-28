import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { assertProjectBaselineUnchanged, captureProjectBaseline } from "../scripts/project-baseline.mjs";

function root(prefix) { return fs.mkdtempSync(path.join(process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(), prefix)); }
function git(directory, args) { return execFileSync("git", args, { cwd: directory, windowsHide: true, encoding: "utf8" }); }

test("evidence baseline detects further edits to an already dirty tracked file", () => {
  const directory = root("workflow-project-baseline-git-");
  git(directory, ["init", "-q"]); git(directory, ["config", "user.name", "Fixture"]); git(directory, ["config", "user.email", "fixture@example.invalid"]);
  const file = path.join(directory, "working.txt"); fs.writeFileSync(file, "accepted\n"); git(directory, ["add", "working.txt"]); git(directory, ["commit", "-qm", "baseline"]);
  fs.writeFileSync(file, "foreign dirty work\n"); const before = captureProjectBaseline(directory), porcelain = git(directory, ["status", "--porcelain=v1"]);
  fs.writeFileSync(file, "foreign dirty work changed by canary\n"); const after = captureProjectBaseline(directory);
  assert.equal(git(directory, ["status", "--porcelain=v1"]), porcelain);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.throws(() => assertProjectBaselineUnchanged(before, after, "dirty-fixture"), /PROJECT_CHANGED_DURING_EVIDENCE/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("non-Git evidence baseline is deterministic and detects source changes", () => {
  const directory = root("workflow-project-baseline-files-"); fs.mkdirSync(path.join(directory, "docs")); fs.writeFileSync(path.join(directory, "docs", "plan.md"), "first\n");
  const before = captureProjectBaseline(directory), same = captureProjectBaseline(directory); assertProjectBaselineUnchanged(before, same);
  fs.writeFileSync(path.join(directory, "docs", "plan.md"), "second\n");
  assert.notEqual(captureProjectBaseline(directory).fingerprint, before.fingerprint);
  fs.rmSync(directory, { recursive: true, force: true });
});
