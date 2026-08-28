import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const workflowFile = path.join(root, ".github", "workflows", "release.yml");

test("release workflow keeps assets draft until cross-platform provenance smoke passes", { skip: !fs.existsSync(workflowFile) && "source-only CI contract is not shipped in the product archive" }, () => {
  const workflow = fs.readFileSync(workflowFile, "utf8");
  assert.match(workflow, /actions\/attest@v4/);
  assert.match(workflow, /gh release create[^\r\n]+--draft/);
  assert.doesNotMatch(workflow, /gh release create[^\r\n]+--prerelease/);
  assert.match(workflow, /--allow-draft/);
  assert.match(workflow, /needs: draft_smoke/);
  assert.match(workflow, /Contains\('-'\)/);
  assert.match(workflow, /--prerelease=\$prerelease/);
  assert.match(workflow, /needs: post_publish_smoke/);
  assert.match(workflow, /gh release edit[^\r\n]+--draft=true/);
  assert.match(workflow, /No GitHub Release was created/);
});

test("release smoke cryptographically binds the archive to workflow and source commit", () => {
  const smoke = fs.readFileSync(path.join(root, "tools", "release-smoke.mjs"), "utf8");
  assert.match(smoke, /"attestation", "verify"/);
  assert.match(smoke, /"--signer-workflow"/);
  assert.match(smoke, /"--source-digest", releaseManifest\.commit/);
});

test("source scope implementation contains no literal control-byte sentinels", () => {
  const source = fs.readFileSync(path.join(root, "WorkflowPlatform", "src", "source-context.mjs"));
  assert.equal(source.includes(0), false);
  assert.equal(source.includes(1), false);
});

// The canary configurations themselves can never be committed: each one names an absolute path to a
// private project root. The committed template is the only thing that keeps a quoted canary run
// identifier traceable, so it has to stay in step with the keys the runner actually reads.
const canaryTemplate = path.join(root, "WorkflowPlatform", "scripts", "canary-config.example.json");
test("the canary configuration template states every key the evidence runner reads", { skip: !fs.existsSync(canaryTemplate) && "source-only reproduction aid is not shipped in the product archive" }, () => {
  const template = JSON.parse(fs.readFileSync(canaryTemplate, "utf8"));
  const runner = fs.readFileSync(path.join(root, "WorkflowPlatform", "scripts", "run-e2e-evidence.mjs"), "utf8");
  for (const key of ["output_root", "gateway_entry", "projects"]) {
    assert.ok(Object.hasOwn(template, key), `template omits ${key}`);
    assert.ok(runner.includes(`config.${key}`), `runner no longer reads config.${key}`);
  }
  const [project] = template.projects;
  for (const key of ["project_id", "name", "root_path", "package_key", "package_file", "workflow_key"]) {
    assert.ok(Object.hasOwn(project, key), `template project omits ${key}`);
    assert.ok(runner.includes(`item.${key}`), `runner no longer reads item.${key}`);
  }
  // A template that carried a real local path would be the leak the release lint exists to stop.
  assert.doesNotMatch(JSON.stringify(template), /\b[A-Za-z]:[\/]/);
});
