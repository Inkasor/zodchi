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
