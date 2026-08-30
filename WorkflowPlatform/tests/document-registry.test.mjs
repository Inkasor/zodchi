import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { documentLint } from "../src/lint.mjs";
import { listControlledDocuments, registerControlledDocument, registerProjectDocumentVocabulary, unregisterControlledDocument } from "../src/document-registry.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir(), "workflow-document-registry-"));
  const db = openDb(path.join(root, "workflow.sqlite"));
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run("project", "Project", root, now());
  for (const role of ["classifier", "editor"]) {
    db.prepare("INSERT OR IGNORE INTO roles(id,name) VALUES(?,?)").run(role, role);
    db.prepare(`INSERT INTO role_contracts(id,project_id,role_id,version,purpose,boundaries_json,allowed_work_types_json,allowed_artifact_types_json,allowed_tools_json,allowed_skills_json,required_checks_json,allowed_transitions_json,allowed_profiles_json,context_limit_bytes,max_calls,max_correction_cycles,timeout_seconds,result_schema_key,prompt_template_version,escalation_json,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`role-${role}`, "project", role, "1", role, "{}", "[]", "[]", "[]", "[]", "[]", "[]", "[]", 65536, 1, 0, 60, role === "editor" ? "documentator.v1" : "classification.v1", "1", "{}", "active");
  }
  return { root, db };
}

test("controlled documents are owner opt-in and can be removed without touching the file", () => {
  const { root, db } = fixture();
  const file = path.join(root, "docs", "State.md");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, "# Existing project state\n");
  const registered = registerControlledDocument(db, { projectId: "project", path: "docs/State.md", documentType: "reference", authority: "owner", readRoles: "classifier,editor", writeRoles: "editor" });
  assert.equal(registered.status, "registered");
  assert.deepEqual(listControlledDocuments(db, "project").filter(item => item.active).map(item => ({ path: item.path, read: item.read_roles, write: item.write_roles })), [{ path: "docs/State.md", read: ["classifier", "editor"], write: ["editor"] }]);
  assert.equal(unregisterControlledDocument(db, { projectId: "project", path: "docs/State.md" }).status, "unregistered");
  assert.equal(fs.readFileSync(file, "utf8"), "# Existing project state\n");
  assert.equal(listControlledDocuments(db, "project").filter(item => item.active).length, 0);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("project-local lint vocabulary does not leak into another project", () => {
  const { root, db } = fixture();
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run("other", "Other", path.join(root, "other"), now());
  registerProjectDocumentVocabulary(db, { projectId: "project", kind: "status", key: "accepted-for-implementation", category: "decision" });
  registerProjectDocumentVocabulary(db, { projectId: "project", kind: "evidence", key: "local-run-receipt" });
  const text = '<document id="d" status="accepted-for-implementation" evidence="local-run-receipt"></document>';
  assert.equal(documentLint(text, "doc.md", db, { projectId: "project" }).status, "passed");
  assert.match(documentLint(text, "doc.md", db, { projectId: "other" }).errors.join(";"), /unknown status/);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
