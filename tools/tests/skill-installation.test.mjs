import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installClientSkills, removeClientSkills, restoreClientSkills, snapshotClientSkills } from "../skill-installation.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zodchi-skills-"));
  const application = path.join(root, "app"), roots = { "claude-code": path.join(root, "claude"), codex: path.join(root, "codex") };
  fs.mkdirSync(application); fs.cpSync(path.join(repositoryRoot, "integrations"), path.join(application, "integrations"), { recursive: true });
  return { root, applicationRoot: application, roots };
}

test("client skills install only the canonical Zodchi mode command for both hosts", () => {
  const value = fixture();
  try {
    const result = installClientSkills(value);
    assert.equal(result.length, 2);
    for (const client of ["claude-code", "codex"]) for (const name of ["zodchi"]) {
      const directory = path.join(value.roots[client], name), text = fs.readFileSync(path.join(directory, "SKILL.md"), "utf8");
      assert.match(text, /session router/);
      assert.doesNotMatch(text, /__ZODCHI_ROOT__/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory, ".zodchi-skill.json"), "utf8")).owner, "zodchi");
    }
    for (const client of ["claude-code", "codex"]) assert.equal(fs.existsSync(path.join(value.roots[client], "zod")), false);
    assert.equal(fs.existsSync(path.join(value.roots.codex, "zodchi", "agents", "openai.yaml")), true);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("skill updates and rollback restore exact bytes", () => {
  const value = fixture();
  try {
    installClientSkills(value);
    const snapshots = snapshotClientSkills({ roots: value.roots });
    const before = fs.readFileSync(path.join(value.roots.codex, "zodchi", "SKILL.md"));
    installClientSkills(value);
    fs.writeFileSync(path.join(value.roots.codex, "zodchi", "extra.txt"), "concurrent", "utf8");
    restoreClientSkills(snapshots);
    assert.deepEqual(fs.readFileSync(path.join(value.roots.codex, "zodchi", "SKILL.md")), before);
    assert.equal(fs.existsSync(path.join(value.roots.codex, "zodchi", "extra.txt")), false);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("update retires only the unchanged short alias owned by the same installation", () => {
  const value = fixture();
  try {
    installClientSkills(value);
    for (const client of ["claude-code", "codex"]) {
      const canonical = path.join(value.roots[client], "zodchi"), legacy = path.join(value.roots[client], "zod");
      fs.cpSync(canonical, legacy, { recursive: true });
      const markerFile = path.join(legacy, ".zodchi-skill.json"), marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
      marker.name = "zod";
      fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    }
    installClientSkills(value);
    for (const client of ["claude-code", "codex"]) assert.equal(fs.existsSync(path.join(value.roots[client], "zod")), false, client);

    const edited = path.join(value.roots.codex, "zod");
    fs.cpSync(path.join(value.roots.codex, "zodchi"), edited, { recursive: true });
    const markerFile = path.join(edited, ".zodchi-skill.json"), marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    marker.name = "zod";
    fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    fs.appendFileSync(path.join(edited, "SKILL.md"), "\nowner edit\n", "utf8");
    installClientSkills(value);
    assert.equal(fs.existsSync(edited), true);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

test("foreign or edited skills are never overwritten or removed", () => {
  const value = fixture();
  try {
    const foreign = path.join(value.roots.codex, "zodchi"); fs.mkdirSync(foreign, { recursive: true }); fs.writeFileSync(path.join(foreign, "SKILL.md"), "foreign", "utf8");
    assert.throws(() => installClientSkills(value), /SKILL_TARGET_NOT_OWNED/);
    fs.rmSync(foreign, { recursive: true, force: true });
    installClientSkills(value);
    fs.appendFileSync(path.join(value.roots["claude-code"], "zodchi", "SKILL.md"), "\nchanged\n");
    assert.throws(() => removeClientSkills({ roots: value.roots }), /SKILL_APPLICATION_ROOT_REQUIRED/);
    const removed = removeClientSkills({ applicationRoot: value.applicationRoot, roots: value.roots });
    assert.equal(removed.find(item => item.client === "claude-code" && item.name === "zodchi").status, "changed");
    assert.equal(removed.filter(item => item.status === "removed").length, 1);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

// Two installations may share one home. Neither may take the other's explicit commands over, and
// neither may delete them: a command that silently starts pointing elsewhere is worse than a refusal.
test("skills owned by another installation are never taken over or removed", () => {
  const value = fixture(), other = path.join(value.root, "other-app");
  try {
    fs.cpSync(value.applicationRoot, other, { recursive: true });
    installClientSkills({ applicationRoot: other, roots: value.roots });
    const directory = path.join(value.roots.codex, "zodchi"), before = fs.readFileSync(path.join(directory, "SKILL.md"));
    assert.throws(() => installClientSkills(value), /SKILL_OWNED_BY_OTHER_INSTALLATION/);
    assert.deepEqual(fs.readFileSync(path.join(directory, "SKILL.md")), before);
    const kept = removeClientSkills({ applicationRoot: value.applicationRoot, roots: value.roots });
    assert.equal(kept.filter(item => item.status === "different_installation").length, 2);
    assert.equal(fs.existsSync(path.join(directory, "SKILL.md")), true);
    const removed = removeClientSkills({ applicationRoot: other, roots: value.roots });
    assert.equal(removed.filter(item => item.status === "removed").length, 2);
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});

// Removal has to say on whose behalf it removes. A call that omits the installation would otherwise
// bypass the ownership check entirely and delete whatever it found.
test("removal without a named installation fails closed and changes nothing", () => {
  const value = fixture();
  try {
    installClientSkills(value);
    const before = Object.fromEntries(Object.entries(value.roots).map(([client, root]) => [`${client}:zodchi`, fs.readFileSync(path.join(root, "zodchi", "SKILL.md"))]));
    for (const invalid of [undefined, { roots: value.roots }, { applicationRoot: "", roots: value.roots }]) assert.throws(() => removeClientSkills(invalid), /SKILL_APPLICATION_ROOT_REQUIRED/);
    for (const [key, content] of Object.entries(before)) {
      const [client, name] = key.split(":");
      assert.deepEqual(fs.readFileSync(path.join(value.roots[client], name, "SKILL.md")), content, key);
    }
  } finally { fs.rmSync(value.root, { recursive: true, force: true }); }
});
