import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInputManifest, includedInstructionText } from "../src/input-inventory.mjs";
import { createProviderEnvironment } from "../src/ephemeral.mjs";

test("input manifests distinguish skills and suppress undeclared native instructions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-input-manifest-"));
  const project = path.join(root, "project"), skill = path.join(root, "skills", "bounded-skill");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(project, "AGENTS.md"), "ambient instruction");
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "declared instruction");
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nallowed-tools: Read\n---\nBounded skill");
  const profileConfig = { allowedSkills: [skill], nativeInstructionEnforcement: "technical" };
  const first = buildInputManifest({ projectRoot: project, profileConfig, requirements: { allowed_skills: ["bounded-skill"], native_instruction_files: ["CLAUDE.md"], external_tools: [] } });
  const second = buildInputManifest({ projectRoot: project, profileConfig, requirements: { allowed_skills: [], native_instruction_files: [], external_tools: [] } });
  assert.notEqual(first.manifest_hash, second.manifest_hash);
  assert.deepEqual(first.instruction_files.map(item => [item.path, item.status]), [["AGENTS.md", "suppressed"], ["CLAUDE.md", "included"]]);
  assert.match(includedInstructionText(first, project), /declared instruction/);
  assert.doesNotMatch(includedInstructionText(first, project), /ambient instruction/);
  assert.equal(first.skills[0].name, "bounded-skill");
  assert.match(first.skills[0].content_hash, /^[a-f0-9]{64}$/u);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Codex process execution does not implicitly enable localhost access", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-local-endpoint-")), source = path.join(root, "source"), temp = path.join(root, "temp");
  fs.mkdirSync(source, { recursive: true });
  const environment = createProviderEnvironment("codex", { tempRoot: temp, sourceHome: source, profileConfig: { readOnly: false, allowNetwork: false } });
  try {
    const config = fs.readFileSync(path.join(environment.directory, "config.toml"), "utf8");
    assert.match(config, /network_access = false/u);
  } finally { environment.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});
