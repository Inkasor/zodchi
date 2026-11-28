import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDurations, selectChanges, shardCount, shardPlan, shardScenarios, versionOnlyChange } from "./ci-select.mjs";

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

test("duration sharding is deterministic, complete and balanced", () => {
  const seconds = { a: 30, b: 20, c: 10, d: 10, e: 5, f: 2, g: 1 };
  const names = Object.keys(seconds);
  const shards = shardScenarios(names, 3, seconds);
  assert.equal(shards.length, 3);
  assert.deepEqual(shards, shardScenarios([...names].reverse(), 3, seconds));
  assert.deepEqual(shards.flat().sort(), [...names].sort());
  const totals = shards.map(shard => shard.reduce((sum, name) => sum + seconds[name], 0));
  assert.ok(Math.max(...totals) <= Math.min(...totals) + Math.max(...Object.values(seconds)));
  assert.deepEqual(shardScenarios(["d", "c", "b", "a"], 2, { a: 1, b: 1, c: 1, d: 1 }), [["a", "c"], ["b", "d"]]);
});

test("committed durations provide the numeric map used by the CLI", () => {
  const seconds = loadDurations();
  assert.ok(seconds && typeof seconds === "object" && !Array.isArray(seconds));
  const entries = Object.entries(seconds);
  assert.ok(entries.length > 0);
  for (const [name, value] of entries) {
    assert.ok(name.length > 0 && Number.isFinite(value) && value >= 0, name);
  }
  const names = entries.map(([name]) => name);
  assert.deepEqual(shardScenarios(names, 4, seconds).flat().sort(), names.sort());
});

test("missing scenario durations use the median of the whole file", () => {
  assert.deepEqual(shardScenarios(["unknown", "known"], 2, { known: 6.5, low: 4, high: 10, extra: 10 }), [["unknown"], ["known"]]);
  assert.deepEqual(shardScenarios(["unknown", "known"], 2, { known: 6.5, low: 4, high: 10 }), [["known"], ["unknown"]]);
});

test("selected plans shard only above eight scenarios", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const seconds = Object.fromEntries(names.map(name => [name, 1]));
  assert.deepEqual(shardPlan("selected", names.slice(0, 8), 2, seconds), [names.slice(0, 8)]);
  assert.deepEqual(shardPlan("selected", names, 2, seconds), [["a", "c", "e", "g", "i"], ["b", "d", "f", "h"]]);
  assert.deepEqual(shardPlan("full", names.slice(0, 2), 2, seconds), [["a"], ["b"]]);
});

test("a repeated selected name runs once", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const seconds = { ...Object.fromEntries(names.map(name => [name, 1])), a: 50 };
  const shards = shardPlan("selected", [...names, "a"], 2, seconds);
  assert.deepEqual(shards.flat().sort(), names);
  assert.deepEqual(shardPlan("selected", ["a", "a", "b"], 2, seconds), [["a", "b"]]);
});

test("shard count uses cores or validates the CI override", () => {
  assert.equal(shardCount(undefined, 1), 2);
  assert.equal(shardCount(undefined, 4), 3);
  assert.equal(shardCount(undefined, 20), 4);
  for (const value of ["1", "2", "8"]) assert.equal(shardCount(value, 4), Number(value));
  for (const value of ["", "0", "9", "-1", "1.5", " 2", "2x"]) {
    assert.throws(() => shardCount(value, 4), /CI_E2E_SHARDS/);
  }
});
