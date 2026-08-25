import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { readProjectContext, compactProjectSnapshot } from "../src/document-context.mjs";
import { applyRegisteredPatch } from "../src/documentator.mjs";
import { projectRoots, writableRoots } from "../src/project-roots.mjs";
import { collectGitHistory, collectSourceFiles, expandTerms, searchSources, searchTerms, sourceInventory, sourceScope } from "../src/source-context.mjs";

function temporaryRoot(prefix) {
  const parent = process.env.WORKFLOW_PLATFORM_TEST_TEMP ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}

function fixture(prefix, { sources = [] } = {}) {
  const root = temporaryRoot(prefix);
  const producer = path.join(root, "producer");
  const consumer = path.join(root, "consumer");
  fs.mkdirSync(path.join(producer, "src"), { recursive: true });
  fs.mkdirSync(path.join(consumer, "src"), { recursive: true });
  const db = openDb(path.join(root, "workflow.sqlite"));
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('integration','Integration',?,?)").run(producer, now());
  db.prepare("INSERT INTO project_roots(project_id,root_key,path,access,is_primary,created_at) VALUES('integration','consumer',?,'read',0,?)").run(consumer, now());
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES('workflow','Workflow','integration','mvp','L2','active',?,4096)")
    .run(JSON.stringify({ git: false, sources }));
  return { root, producer, consumer, db };
}

const semanticDocument = id => `<document id="${id}" status="working" authority="owner" version="1.0" language="en" format="markdown+xml_semantic">\n\n# Contract\n\n</document>\n`;

test("a project reads both ends of an integration and can write only its own", () => {
  const { root, producer, consumer, db } = fixture("workflow-roots-");
  fs.writeFileSync(path.join(producer, "contract.md"), semanticDocument("contract"));
  fs.writeFileSync(path.join(consumer, "contract.md"), semanticDocument("consumer-contract"));
  db.prepare("INSERT INTO project_documents(id,project_id,path,root_key,document_type,authority,status,active) VALUES('own','integration','contract.md','primary','plan','owner','active',1)").run();
  db.prepare("INSERT INTO project_documents(id,project_id,path,root_key,document_type,authority,status,active) VALUES('far','integration','contract.md','consumer','reference','owner','active',1)").run();
  for (const document of ["own", "far"]) db.prepare("INSERT INTO role_documents(project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES('integration','documentator',?,1,1,'record',10)").run(document);

  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const own = discovery.documents.find(item => item.root === "primary");
  const far = discovery.documents.find(item => item.root === "consumer");

  // The same relative path in two roots stays two documents, and the one on the read root is never
  // offered as writable however the role bindings were registered.
  assert.equal(own.path, "contract.md");
  assert.equal(far.path, "consumer/contract.md");
  assert.deepEqual(own.write_roles, ["documentator"]);
  assert.deepEqual(far.write_roles, []);
  assert.equal(discovery.roots.length, 2);
  assert.deepEqual(compactProjectSnapshot(discovery).roots.map(item => `${item.key}:${item.access}`), ["primary:write", "consumer:read"]);
  assert.deepEqual(writableRoots(projectRoots(db, "integration")).map(item => item.key), ["primary"]);

  const proposal = { document_id: "far", operation: "append_decision", authority: "owner", expected_version: null, content: "no", section_id: null, decision_id: null, evidence_id: null, status_value: null, target_tag: null, target_id: null, replacement_id: null };
  assert.throws(() => applyRegisteredPatch({ db, runId: "run", projectId: "integration", projectRoot: producer, roleId: "documentator", proposal }), /DOCUMENT_ROOT_IS_READ_ONLY/);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a declared source scope narrows collection on every root", () => {
  const { root, producer, consumer, db } = fixture("workflow-scope-", { sources: ["src/**"] });
  fs.writeFileSync(path.join(producer, "src", "export.mjs"), "export const avgCost = 1;\n");
  fs.writeFileSync(path.join(producer, "secret.env"), "TOKEN=must-not-be-collected\n");
  fs.writeFileSync(path.join(consumer, "src", "import.mjs"), "const cost = row.avgCost;\n");

  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const inventory = Object.fromEntries(discovery.sources.map(entry => [entry.root, entry.files.map(file => file.path)]));

  // The inventory covers both roots but only the declared scope, so a file the owner never offered is
  // not named to anyone; the read root's paths carry its key so a plan cannot confuse the two ends.
  assert.deepEqual(inventory.primary, ["src/export.mjs"]);
  assert.deepEqual(inventory.consumer, ["consumer/src/import.mjs"]);
  assert.equal(JSON.stringify(discovery.sources).includes("secret.env"), false);

  const scope = sourceScope(discovery.source_scope);
  const collected = collectSourceFiles(discovery.roots, ["src/export.mjs", "consumer/src/import.mjs", "secret.env"], scope, 4096);
  assert.deepEqual(collected.files.map(file => `${file.path}:${file.status}`), ["src/export.mjs:read", "consumer/src/import.mjs:read", "secret.env:outside_scope"]);
  assert.equal(collected.files[0].text.includes("avgCost"), true);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("large files contribute relevant line windows and later planned paths keep a fair share", () => {
  const { root, producer, consumer, db } = fixture("workflow-source-excerpts-", { sources: ["src/**"] });
  const lines = Array.from({ length: 4500 }, (_, index) => `Строка${index + 1} = "обычный код";`);
  lines[2799] = "СебестоимостьМаркер2800 = Источник.Себестоимость;";
  lines[4399] = "СебестоимостьМаркер4400 = Строка.Себестоимость;";
  fs.writeFileSync(path.join(producer, "src", "ObjectModule.bsl"), lines.join("\n"));
  fs.writeFileSync(path.join(consumer, "src", "FormModule.bsl"), "Процедура ЗапуститьВыгрузку()\n  Сервер.Выгрузить();\nКонецПроцедуры\n");
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, ["src/ObjectModule.bsl", "consumer/src/FormModule.bsl"], sourceScope(discovery.source_scope), 6000, {
    query: "Проследи СебестоимостьМаркер2800 в строках 2750–2850 и СебестоимостьМаркер4400 в строках 4380–4460"
  });
  assert.ok(collected.bytes <= 6000);
  assert.match(collected.files[0].text, /СебестоимостьМаркер2800/);
  assert.match(collected.files[0].text, /СебестоимостьМаркер4400/);
  assert.doesNotMatch(collected.files[0].text, /Строка1 =/);
  assert.equal(collected.files[0].selection, "requested_ranges_and_objective_matches");
  assert.match(collected.files[1].text, /ЗапуститьВыгрузку/);
  assert.equal(collected.files[1].selection, "complete_file");
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing output paths do not reserve source budget", () => {
  const { root, producer, db } = fixture("workflow-source-existing-share-", { sources: ["src/**", "docs/**"] });
  fs.writeFileSync(path.join(producer, "src", "large.bsl"), "ПолезнаяСтрока = 1;\n".repeat(1000));
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, ["src/large.bsl", "docs/not-created-yet.md"], sourceScope(discovery.source_scope), 6000, { query: "ПолезнаяСтрока" });
  assert.ok(collected.files[0].supplied_bytes > 5000);
  assert.equal(collected.files[1].status, "missing");
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("path-bound Git history proves the commits of an allowed source without diff bodies", () => {
  const { root, producer, db } = fixture("workflow-source-history-", { sources: ["src/**"] });
  fs.writeFileSync(path.join(producer, "src", "history.bsl"), "Версия = 1;\n");
  execFileSync("git", ["init"], { cwd: producer, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: producer });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: producer });
  execFileSync("git", ["add", "src/history.bsl"], { cwd: producer });
  execFileSync("git", ["commit", "-m", "tracked history"], { cwd: producer, env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-11T12:00:00Z", GIT_COMMITTER_DATE: "2026-08-11T12:00:00Z" }, stdio: "ignore" });
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const history = collectGitHistory(discovery.roots, ["src/history.bsl", "outside.txt"], sourceScope(discovery.source_scope));
  assert.equal(history.status, "available", JSON.stringify(history));
  assert.equal(history.files.length, 1);
  assert.match(history.files[0].commits[0], /2026-08-11T12:00:00(?:Z|\+00:00)\ttracked history$/);
  assert.equal(JSON.stringify(history).includes("Версия = 1"), false);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("the identifiers in a request find the files that carry them", () => {
  const { root, producer, consumer, db } = fixture("workflow-search-", { sources: ["src/**"] });
  fs.writeFileSync(path.join(producer, "src", "unrelated.mjs"), "export const total = 0;\n");
  fs.writeFileSync(path.join(producer, "src", "cost.mjs"), "// avgCost is read here\nconst avgCost = row.avgCost;\n");
  fs.writeFileSync(path.join(consumer, "src", "view.mjs"), "render(avgCost);\n");

  const terms = searchTerms("# Files mentioned by the user:\nattachment-path/AppData/codex-clipboard.png\n\n## My request:\nОткуда берётся avgCost по артикулу 620008 и чем он отличается от unit.cost?");
  // Prose is not a search term: only names that look like code, and identifiers long enough to be one.
  assert.deepEqual(terms, ["avgCost", "620008", "unit.cost"]);

  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const found = searchSources(discovery.roots, sourceScope(discovery.source_scope), terms);
  // The file mentioning a term most often comes first, both roots are searched, and a file that mentions
  // nothing does not appear at all.
  assert.deepEqual(found.files.map(file => file.path), ["src/cost.mjs", "consumer/src/view.mjs"]);
  assert.equal(found.files[0].matches.length, 2);
  assert.equal(found.files[0].matches[0].line, 1);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("git inventory keeps Cyrillic paths literal and balances a capped inventory across project areas", () => {
  const root = temporaryRoot("workflow-unicode-git-");
  fs.mkdirSync(path.join(root, ".codex"));
  fs.mkdirSync(path.join(root, "Конфигурация", "ОбщиеМодули"), { recursive: true });
  for (let index = 0; index < 5; index += 1) fs.writeFileSync(path.join(root, ".codex", `${index}.md`), "DataPath metadata\n");
  fs.writeFileSync(path.join(root, "Конфигурация", "ОбщиеМодули", "Себестоимость.bsl"), "avgCost = unit.cost;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  execFileSync("git", ["add", "."], { cwd: root, windowsHide: true });

  const [inventory] = sourceInventory([{ key: "primary", path: root, access: "write", primary: true }], sourceScope([]), { maxFilesPerRoot: 2 });
  assert.equal(inventory.total_files, 6);
  assert.deepEqual(inventory.directories, { ".codex": 5, "Конфигурация": 1 });
  assert.equal(inventory.files.some(file => file.path === "Конфигурация/ОбщиеМодули/Себестоимость.bsl"), true);
  assert.equal(inventory.files.some(file => file.path.startsWith('"')), false);
  const found = searchSources([{ key: "primary", path: root, access: "write", primary: true }], sourceScope([]), ["avgCost", "DataPath"], { maxFiles: 2 });
  assert.equal(found.files[0].path, "Конфигурация/ОбщиеМодули/Себестоимость.bsl");
  assert.equal(found.truncated, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("collection covers the project by default and never its credentials", () => {
  const root = temporaryRoot("workflow-default-scope-");
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const db = openDb(path.join(root, "workflow.sqlite"));
  db.prepare("INSERT INTO projects(id,name,root_path,created_at) VALUES('project','Project',?,?)").run(project, now());
  db.prepare("INSERT INTO workflows(id,name,project_id,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES('workflow','Workflow','project','mvp','L2','active','{\"git\":false}',4096)").run();
  fs.writeFileSync(path.join(project, "plan.md"), semanticDocument("plan"));
  fs.writeFileSync(path.join(project, "notes.md"), "ordinary project file");
  fs.writeFileSync(path.join(project, ".env"), "TOKEN=secret-value");
  fs.writeFileSync(path.join(project, "auth.json"), "{\"token\":\"secret-value\"}");
  db.prepare("INSERT INTO project_documents(id,project_id,path,document_type,authority,status,active) VALUES('plan','project','plan.md','plan','owner','active',1)").run();

  const discovery = readProjectContext("project", db, [], { workflowId: "workflow" });
  const listed = discovery.sources[0].files.map(file => file.path).sort();

  // Registering the project registered its directory, so its files are collectable without a second
  // permission; a file that is not a registered document is still only a name and a size here.
  assert.deepEqual(listed, ["notes.md", "plan.md"]);
  assert.equal(JSON.stringify(discovery.sources).includes("ordinary project file"), false);

  // A credential-shaped name is refused whatever the scope says, and its contents never reach anyone.
  const scope = sourceScope(discovery.source_scope);
  const collected = collectSourceFiles(discovery.roots, [".env", "auth.json", "notes.md"], scope, 4096);
  assert.deepEqual(collected.files.map(file => `${file.path}:${file.status}`), [".env:outside_scope", "auth.json:outside_scope", "notes.md:read"]);
  assert.equal(JSON.stringify(collected).includes("secret-value"), false);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
test("a request written in prose finds the code through the project's own wording", () => {
  const { root, producer, db } = fixture("workflow-two-pass-", { sources: ["src/**"] });
  // The project pairs the word with the name itself, in a label, and that pairing is the translation:
  // nothing here is guessed, every name searched for in the second pass was read out of this project.
  fs.writeFileSync(path.join(producer, "src", "labels.mjs"), `export const labels = {
  avgCost: "Средняя себестоимость",
  salesTotal: "Сумма продаж"
};
`);
  fs.writeFileSync(path.join(producer, "src", "report.mjs"), `const value = row.avgCost * row.quantity;\n`);
  fs.writeFileSync(path.join(producer, "src", "unrelated.mjs"), `export const colour = "red";\n`);

  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const scope = sourceScope(discovery.source_scope);
  const message = "Резко выросла себестоимость, надо понять откуда она берётся";

  // The request carries no identifier at all, so the single-pass reading of it finds nothing.
  assert.deepEqual(searchTerms(message), []);

  const expanded = expandTerms(discovery.roots, scope, message);
  assert.deepEqual(expanded.subject, ["себестоимо"]);
  assert.equal(expanded.harvested.includes("avgCost"), true);

  const found = searchSources(discovery.roots, scope, expanded.terms);
  // Both the label that carried the word and the code that uses the name come back; a file that has
  // neither does not.
  assert.deepEqual(found.files.map(file => file.path).sort(), ["src/labels.mjs", "src/report.mjs"]);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
