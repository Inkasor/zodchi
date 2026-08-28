import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runPlatformAcceptance } from "../platform-acceptance.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");

test("one command proves install explicit run update rollback and uninstall mechanics", () => {
  const work = path.join(os.tmpdir(), `zodchi-platform-acceptance-test-${process.pid}-${Date.now()}`);
  try {
    const report = runPlatformAcceptance({ repositoryRoot, work, keep: true });
    assert.equal(report.status, "passed");
    assert.equal(report.acceptance_class, "MECHANICS_ONLY");
    assert.equal(report.lifecycle.run.final_state, "completed");
    assert.equal(report.lifecycle.run.gate_status, "passed");
    assert.equal(report.lifecycle.explicit_skills.commands, 4);
    assert.equal(report.lifecycle.explicit_skills.scenarios, 2);
    assert.equal(report.lifecycle.update.skill_targets_updated, 4);
    assert.equal(report.lifecycle.rollback.skill_targets_restored, 4);
    assert.equal(report.lifecycle.uninstall.skills_removed, true);
    assert.equal(report.lifecycle.uninstall.project_hooks_absent, true);
    assert.equal(report.lifecycle.preset_catalog.presets, 15);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
