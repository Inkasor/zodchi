import assert from "node:assert/strict";
import { test } from "node:test";
import { selectChanges, shardScenarios, versionOnlyChange } from "./ci-select.mjs";

const skip = { mode: "skip", scenarios: [] };
const full = { mode: "full", scenarios: [] };
const researchFile = "scripts/e2e/scenarios/flow-research.mjs";
const researchScenarios = [
  "flow-research-config-pin",
  "flow-research-contradicted",
  "flow-research-legacy",
  "flow-research-lock-cuts",
  "flow-research-owner-resume",
  "flow-research-unchecked",
  "flow-research-unknown",
];

test("documentation and release notes keep only the repository checks", async () => {
  assert.deepEqual(await selectChanges(["docs/verification.md", "README.ru.md", "install/release-notes.json"]), skip);
});

test("a workflow crate selects the e2e scenarios covering that workflow", async () => {
  const files = ["rust/crates/zodchi-flow-research/src/research.rs", "docs/research.md"];
  assert.deepEqual(await selectChanges(files), {
    mode: "selected",
    scenarios: [...researchScenarios, "flow-research-claude", "flow-research-deferred-fixes",
      "flow-research-drain-failed-peer", "flow-research-mixed-batch"].sort(),
  });
  const prompt = await selectChanges(["rust/crates/zodchi-flow-code-package/flows/code-package/v1/write.md"]);
  assert.equal(prompt.mode, "selected");
  assert.ok(prompt.scenarios.includes("flow-entry-local"));
  assert.ok(prompt.scenarios.includes("flow-protected"));
});

test("a scenario file selects its own registered scenarios and combines with other changes", async () => {
  assert.deepEqual(await selectChanges([researchFile]), { mode: "selected", scenarios: researchScenarios });
  const mixed = await selectChanges([researchFile, "rust/crates/zodchi-flow-unity-check/src/lib.rs"]);
  assert.deepEqual(mixed, { mode: "selected", scenarios: [...researchScenarios, "flow-unity-check-resume"] });
  const incident = await selectChanges(["scripts/e2e/scenarios/flow-incident-triage.mjs"]);
  assert.ok(incident.scenarios.includes("flow-incident-triage-fixture-bad-adapter"), "include names registered in loops");
});

test("shared code, harness inputs and unknown paths select the full suite", async () => {
  for (const file of [
    "rust/crates/zodchi-flow-engine/src/lib.rs", "rust/crates/zodchi-flow/src/lib.rs",
    "rust/crates/zodchi-core/src/lib.rs", "rust/crates/zodchi-cli/src/main.rs", "rust/crates/zodchi-server/src/main.rs",
    "rust/crates/zodchi-flow-new/src/lib.rs", "rust/Cargo.lock", "scripts/e2e.mjs", "scripts/e2e/fake-codex.mjs",
    "scripts/e2e/fixtures/incident-triage/cases/stale/skill.md", "roles/incident-classify.md",
    "scripts/e2e/scenarios/flow-missing.mjs", ".github/workflows/ci.yml",
  ]) {
    assert.deepEqual(await selectChanges([researchFile, file]), full, file);
  }
  assert.deepEqual(await selectChanges([]), full);
});

test("version-only recognition preserves all other manifest and lockfile changes", async () => {
  const manifest = '[workspace.package]\nversion = "1.0.3"\n[workspace.dependencies]\nhex = "0.4"\n';
  const json = '{\n  "name": "zodchi",\n  "version": "1.0.3",\n  "private": true\n}\n';
  const lock = [
    'version = 4\n',
    '[[package]]\nname = "zodchi-cli"\nversion = "1.0.3"\ndependencies = ["hex"]\n',
    '[[package]]\nname = "hex"\nversion = "0.4.3"\n',
  ].join("\n");
  const versions = new Set();
  for (const [file, contents, otherChange] of [
    ["rust/Cargo.toml", manifest, ['hex = "0.4"', 'hex = "0.5"']],
    ["rust/Cargo.lock", lock, ['"0.4.3"', '"0.4.4"']],
    ["package.json", json, ['"private": true', '"private": false']],
    ["plugins/claude-code/core/.claude-plugin/plugin.json", json, ['"name": "zodchi"', '"name": "other"']],
  ]) {
    const bump = contents.replace("1.0.3", "1.0.4");
    assert.ok(versionOnlyChange(file, contents, bump), file);
    assert.ok(!versionOnlyChange(file, contents, contents.replace("1.0.3", "invalid")), file);
    assert.ok(!versionOnlyChange(file, contents, bump.replace(...otherChange)), file);
    versions.add(file);
  }
  assert.deepEqual(await selectChanges([...versions, "README.md"], versions), skip);
  assert.deepEqual(await selectChanges([...versions, "rust/crates/zodchi-core/src/lib.rs"], versions), full);
});

test("sharding is stable and covers every scenario once", () => {
  const names = [...researchScenarios, "flow-workspace-audit-copies", "flow-unity-check-resume"];
  const shards = shardScenarios(names, 2);
  assert.equal(shards.length, 2);
  assert.deepEqual(shards, shardScenarios([...names].reverse(), 2));
  assert.deepEqual(shards.flat().sort(), [...names].sort());
  const added = "flow-entry-local";
  assert.deepEqual(shardScenarios([...names, added], 2).map(shard => shard.filter(name => name !== added)), shards);
});
