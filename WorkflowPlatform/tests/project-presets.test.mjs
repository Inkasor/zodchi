import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { defaultProjectPresetCatalogFile, defaultPublicPackageCatalogFile, loadDefaultProjectPresetCatalog, validateProjectPresetCatalog } from "../src/project-presets.mjs";

const packageCatalog = JSON.parse(fs.readFileSync(defaultPublicPackageCatalogFile, "utf8"));

test("all fifteen research profiles have installable recipes without private paths or task identities", () => {
  const catalog = loadDefaultProjectPresetCatalog();
  assert.equal(catalog.presets.length, 15);
  assert.equal(new Set(catalog.presets.map(item => item.key)).size, 15);
  assert.deepEqual([...new Set(catalog.presets.flatMap(item => item.package_keys))].sort(), [
    "data.analytics", "game.unity", "game.web", "infra.operations", "marketing.content-operations", "one-c.development", "software.web-application"
  ]);
  assert.equal(catalog.presets.filter(item => item.private_acceptance.status === "OWNER_READ_REQUIRED").length, 4);
  assert.equal(catalog.presets.every(item => item.public_fixture.status === "MECHANICS_ONLY"), true);
  assert.equal(catalog.presets.every(item => item.private_acceptance.real_repository_required), true);
  const source = fs.readFileSync(defaultProjectPresetCatalogFile, "utf8");
  assert.equal(/[A-Za-z]:[\\/]/.test(source), false);
  assert.equal(/UT-\d{8}-\d{6}-/i.test(source), false);
});

test("donor-specific guarantees survive as adapters and substitution metrics, not role copies", () => {
  const presets = new Map(loadDefaultProjectPresetCatalog().presets.map(item => [item.key, item]));
  assert.deepEqual(presets.get("unity-production-pipeline").horizontal_bundles, ["external-control-plane"]);
  assert.equal(presets.get("unity-production-pipeline").adapters.some(item => item.capability === "git.lfs-checkpoint"), true);
  assert.equal(presets.get("one-c-large-corpus").adapters.some(item => item.capability === "corpus.authoritative-scan"), true);
  assert.equal(presets.get("infra-devops-generator-safe").adapters.some(item => item.capability === "config-generator.ownership"), true);
  assert.equal(presets.get("marketing-manager-activity").substitution_metric.includes("calendar"), true);
  assert.equal(presets.get("one-c-isolated-gui-runtime").horizontal_bundles.includes("external-control-plane"), true);
});

test("preset lint rejects unknown packages, unrouted scenarios and synthetic domain claims", () => {
  const original = JSON.parse(fs.readFileSync(defaultProjectPresetCatalogFile, "utf8"));
  const unknown = structuredClone(original); unknown.presets[0].package_keys = ["missing.package"];
  assert.throws(() => validateProjectPresetCatalog(unknown, packageCatalog), /PRESET_PACKAGE_UNKNOWN/);
  const unrouted = structuredClone(original); unrouted.presets[0].first_value.work_type = "one-c.release";
  assert.throws(() => validateProjectPresetCatalog(unrouted, packageCatalog), /PRESET_WORK_TYPE_UNROUTED/);
  const overclaim = structuredClone(original); overclaim.presets[0].public_fixture.does_not_prove = ["product_fit"];
  assert.throws(() => validateProjectPresetCatalog(overclaim, packageCatalog), /PRESET_PUBLIC_FIXTURE_OVERCLAIMS/);
  const privatePath = structuredClone(original); privatePath.presets[0].migration_notes = [`Use ${["C:", "Private", "repo"].join("\\")}`];
  assert.throws(() => validateProjectPresetCatalog(privatePath, packageCatalog), /private identity forbidden/);
});
