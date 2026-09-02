import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb, now } from "../src/db.mjs";
import { readProjectContext, compactProjectSnapshot } from "../src/document-context.mjs";
import { applyRegisteredPatch } from "../src/documentator.mjs";
import { projectRoots, writableRoots } from "../src/project-roots.mjs";
import { collectGitHistory, collectSourceFiles, expandTerms, listFiles, scanSourceCorpus, searchSources, searchTerms, sourceInventory, sourceScope } from "../src/source-context.mjs";
import { buildCodeIntelligence, mergeGraphMatches } from "../src/code-intelligence.mjs";
import { fitSourceEvidence } from "../src/work-executor.mjs";

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

test("the primary planned source receives priority and calendar dates do not become line ranges", () => {
  const { root, producer, consumer, db } = fixture("workflow-source-priority-", { sources: ["src/**"] });
  const primary = Array.from({ length: 4500 }, (_, index) => `Строка${index + 1} = "основной код";`);
  primary[3019] = "СредняяСебестоимость = Источник.Себестоимость;";
  primary[3020] = "Код = КодСхемыРаботы(СхемаРаботы);";
  primary[4199] = "Функция КодСхемыРаботы(СхемаРаботы)";
  primary[4200] = "Если СхемаРаботы = FBO Тогда Возврат \"FBO\"; КонецЕсли;";
  primary[4201] = "КонецФункции";
  fs.writeFileSync(path.join(producer, "src", "ObjectModule.bsl"), primary.join("\n"));
  fs.writeFileSync(path.join(consumer, "src", "FormModule.bsl"), "Процедура Выгрузить()\n  Сервер.Выгрузить();\nКонецПроцедуры\n");
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, ["src/ObjectModule.bsl", "consumer/src/FormModule.bsl"], sourceScope(discovery.source_scope), 24_000, {
    query: "На версии 0.4.8-2026-08-26 и task 01a03a1a-8a72-7493-8723 проверь среднюю себестоимость и схемы около строк 2990–3050, а также историю за 15–22 августа 2026 года"
  });
  assert.ok(collected.files[0].supplied_bytes > collected.files[1].supplied_bytes);
  assert.match(collected.files[0].text, /СредняяСебестоимость/);
  assert.match(collected.files[0].text, /Функция КодСхемыРаботы/);
  assert.equal(collected.files.flatMap(file => file.segments).some(segment => segment.reason === "requested_lines:15-22"), false);
  assert.equal(collected.files.flatMap(file => file.segments).some(segment => segment.reason === "requested_lines:8-2026" || segment.reason === "requested_lines:7493-8723"), false);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("a form entry point follows bounded calls regardless of planned file order", () => {
  const { root, producer, consumer, db } = fixture("workflow-source-call-chain-", { sources: ["src/**"] });
  const form = Array.from({ length: 360 }, (_, index) => `FormLine${index + 1} = 0;`);
  form.splice(39, 5, "Procedure Export(Command)", "  Result = RunExportOnServer();", "EndProcedure", "", "");
  form.splice(199, 5, "Function RunExportOnServer()", "  Return Handler.ExportMain();", "EndFunction", "", "");
  const object = Array.from({ length: 1200 }, (_, index) => `ObjectLine${index + 1} = 0;`);
  object.splice(99, 5, "Function ExportMain()", "  Return ExportLegacy();", "EndFunction", "", "");
  object.splice(299, 5, "Function ExportLegacy()", "  Return ExportDay();", "EndFunction", "", "");
  object.splice(499, 6, "Function ExportDay()", "  Packet = BuildNDJSONPacket();", "  Return SendNDJSON(Packet);", "EndFunction", "", "");
  object.splice(699, 3, "Function BuildNDJSONPacket()", "  Return \"packet\";", "EndFunction");
  object.splice(899, 3, "Function SendNDJSON(Packet)", "  Return Packet;", "EndFunction");
  fs.writeFileSync(path.join(producer, "src", "FormModule.bsl"), form.join("\n"));
  fs.writeFileSync(path.join(consumer, "src", "ObjectModule.bsl"), object.join("\n"));
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  // The implementation deliberately comes first: planner path priority must not be mistaken for call
  // direction when the later form invokes this earlier object module.
  const collected = collectSourceFiles(discovery.roots, ["consumer/src/ObjectModule.bsl", "src/FormModule.bsl"], sourceScope(discovery.source_scope), 18_000, {
    query: "Trace the export entry point through the server scenario to NDJSON packet formation and sending."
  });
  const evidence = collected.files.map(file => file.text).join("\n");
  for (const name of ["RunExportOnServer", "ExportMain", "ExportLegacy", "ExportDay", "BuildNDJSONPacket", "SendNDJSON"]) assert.match(evidence, new RegExp(name));
  assert.ok(collected.files[0].segments.some(segment => segment.reason.startsWith("referenced_call_chain:")));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("the page before the best explicit-range hit keeps its query setup", () => {
  const { root, producer, db } = fixture("workflow-source-range-predecessor-", { sources: ["src/**"] });
  const lines = Array.from({ length: 400 }, (_, index) => `Строка${index + 1} = "обычный код";`);
  lines[104] = "QuerySetupMarker = \"поля и параметры запроса\";";
  lines[159] = "RegisterHitMarker = Источник.Себестоимость;";
  lines[219] = "RangeTailMarker = Истина;";
  fs.writeFileSync(path.join(producer, "src", "query.bsl"), lines.join("\n"));
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, ["src/query.bsl"], sourceScope(discovery.source_scope), 3000, {
    query: "Trace RegisterHitMarker in lines 101–220"
  });
  assert.match(collected.files[0].text, /RegisterHitMarker/);
  assert.match(collected.files[0].text, /QuerySetupMarker/);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("every explicit range is represented before long call chains consume a tight source budget", () => {
  const { root, producer, db } = fixture("workflow-source-range-reservation-", { sources: ["src/**"] });
  const lines = Array.from({ length: 4600 }, (_, index) => `Строка${index + 1} = "обычный код";`);
  lines[2749] = "FirstRangeMarker = Регистр.Себестоимость;";
  lines[3499] = "SecondRangeMarker = Регистр.СтоимостьПериода;";
  lines[4389] = "ThirdRangeMarker = JSON.Себестоимость;";
  for (let definition = 0; definition < 6; definition += 1) {
    const start = 100 + definition * 140;
    lines[start] = `Функция TraceCost${definition}()`;
    lines[start + 1] = definition < 5 ? `  Возврат TraceCost${definition + 1}();` : "  Возврат 1;";
    lines[start + 104] = "КонецФункции";
  }
  fs.writeFileSync(path.join(producer, "src", "large.bsl"), lines.join("\n"));
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, ["src/large.bsl"], sourceScope(discovery.source_scope), 12_000, {
    query: "TraceCost0",
    supplementalQuery: "Проверь FirstRangeMarker в строках 2700–2800, SecondRangeMarker в строках 3450–3550 и ThirdRangeMarker в строках 4350–4450"
  });
  const evidence = collected.files[0].text;
  assert.match(evidence, /FirstRangeMarker/);
  assert.match(evidence, /SecondRangeMarker/);
  assert.match(evidence, /ThirdRangeMarker/);
  assert.ok(collected.files[0].segments.some(segment => segment.reason.startsWith("referenced_call_chain:")));
  assert.deepEqual(collected.files[0].exact_term_scan, {
    scope: "complete_file",
    match: "literal_case_insensitive",
    occurrences: [
      { term: "TraceCost0", count: 1, matched_lines: 1, locations: [{ line: 101, text: "Функция TraceCost0()" }], locations_truncated: false },
      { term: "FirstRangeMarker", count: 1, matched_lines: 1, locations: [{ line: 2750, text: "FirstRangeMarker = Регистр.Себестоимость;" }], locations_truncated: false },
      { term: "SecondRangeMarker", count: 1, matched_lines: 1, locations: [{ line: 3500, text: "SecondRangeMarker = Регистр.СтоимостьПериода;" }], locations_truncated: false },
      { term: "ThirdRangeMarker", count: 1, matched_lines: 1, locations: [{ line: 4390, text: "ThirdRangeMarker = JSON.Себестоимость;" }], locations_truncated: false }
    ]
  });
  assert.ok(collected.files[0].supplied_bytes <= 12_000);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("a complete-file exact term scan proves that a requested identifier is absent outside excerpts", () => {
  const { root, producer, db } = fixture("workflow-source-absent-term-", { sources: ["src/**"] });
  fs.writeFileSync(path.join(producer, "src", "large.bsl"), "unitCost = 42;\n".repeat(2000));
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, ["src/large.bsl"], sourceScope(discovery.source_scope), 2000, {
    query: "Trace avgCost and unitCost"
  });
  assert.equal(collected.files[0].truncated, true);
  const [absent, present] = collected.files[0].exact_term_scan.occurrences;
  assert.deepEqual(absent, { term: "avgCost", count: 0, matched_lines: 0, locations: [], locations_truncated: false });
  assert.equal(present.count, 2000);
  assert.equal(present.matched_lines, 2000);
  assert.ok(present.locations.length > 4 && present.locations.length <= 12);
  assert.equal(present.locations_truncated, true);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("a corpus exact scan records complete deterministic coverage separately from bounded excerpts", () => {
  const { root, producer, db } = fixture("workflow-corpus-exact-scan-", { sources: ["src/**"] });
  fs.writeFileSync(path.join(producer, "src", "producer.bsl"), "Результат.avgCost = 42;\n");
  fs.writeFileSync(path.join(producer, "src", "consumer.ts"), "const unitCost = row.avgCost;\n");
  fs.writeFileSync(path.join(producer, "README.md"), "avgCost is prose outside source scope\n");
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const scan = scanSourceCorpus(discovery.roots, sourceScope(discovery.source_scope), ["avgCost", "missingField"]);
  assert.equal(scan.scope, "complete_corpus");
  assert.equal(scan.completeness, "complete");
  assert.equal(scan.boundary.eligible_files, 2);
  assert.equal(scan.boundary.scanned_files, 2);
  assert.equal(scan.covered_files.length, 2);
  assert.ok(scan.covered_files.every(file => file.content_hash));
  assert.equal(scan.occurrences.find(item => item.term === "avgCost").count, 2);
  assert.equal(scan.occurrences.find(item => item.term === "avgCost").matched_files, 2);
  assert.equal(scan.occurrences.find(item => item.term === "avgCost").by_partition.find(item => item.partition === ".bsl").count, 1);
  assert.equal(scan.occurrences.find(item => item.term === "avgCost").by_partition.find(item => item.partition === ".ts").count, 1);
  assert.ok(scan.boundary.partitions.every(item => item.completeness === "complete"));
  assert.equal(scan.occurrences.find(item => item.term === "missingField").count, 0);
  assert.match(scan.scan_id, /^scan_corpus_/);
  assert.equal(scan.provenance.inventory_hash.length, 64);
  const repeated = scanSourceCorpus(discovery.roots, sourceScope(discovery.source_scope), ["avgCost", "missingField"]);
  assert.equal(repeated.scan_id, scan.scan_id);
  assert.equal(repeated.provenance.inventory_hash, scan.provenance.inventory_hash);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("corpus completeness follows authoritative enumeration and scan identity ignores machine paths", () => {
  const left = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-corpus-left-"));
  const right = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-corpus-right-"));
  try {
    for (const root of [left, right]) {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "a.bsl"), "avgCost = 1;\n");
      fs.writeFileSync(path.join(root, "src", "b.bsl"), "unitCost = 2;\n");
    }
    const root = directory => [{ key: "primary", path: directory, access: "read", primary: true }];
    const scope = sourceScope(["src/**"]);
    const truncated = scanSourceCorpus(root(left), scope, ["avgCost"], { maxFiles: 1 });
    assert.equal(truncated.completeness, "incomplete");
    assert.equal(truncated.boundary.enumeration_complete, false);
    assert.equal(truncated.boundary.listings[0].truncated, true);
    const completeLeft = scanSourceCorpus(root(left), scope, ["avgCost"]);
    const completeRight = scanSourceCorpus(root(right), scope, ["avgCost"]);
    assert.equal(completeLeft.completeness, "complete");
    assert.equal(completeLeft.boundary.listings[0].source, "walk");
    assert.equal(completeLeft.scan_id, completeRight.scan_id);
    fs.rmSync(path.join(left, "src", "b.bsl"));
    const multiRoot = scanSourceCorpus([
      { key: "primary", path: left, access: "read", primary: true },
      { key: "secondary", path: right, access: "read", primary: false }
    ], scope, ["avgCost"], { maxFiles: 1 });
    assert.equal(multiRoot.boundary.partitions.find(item => item.root === "primary" && item.partition === ".bsl").completeness, "complete");
    assert.equal(multiRoot.boundary.partitions.find(item => item.root === "secondary" && item.partition === ".bsl").completeness, "incomplete");
  } finally {
    fs.rmSync(left, { recursive: true, force: true }); fs.rmSync(right, { recursive: true, force: true });
  }
});

test("delegation routing metadata cannot displace exact domain anchors from worker source", () => {
  const { root, producer, db } = fixture("workflow-source-delegated-anchor-", { sources: ["src/**"] });
  const lines = Array.from({ length: 2600 }, (_, index) => `ОбщаяСебестоимость${index} = 0;`);
  lines[2300] = "Источник = РегистрСведений.мпКалькуляцияЮнитЭкономики.СрезПоследних();";
  fs.writeFileSync(path.join(producer, "src", "large.bsl"), lines.join("\n"));
  const delegated = `<codex_delegation><source_thread_id>01a039bb-6e38-7e61-be6d-3c2edf0449e0</source_thread_id><input>Проследи avgCost от мпКалькуляцияЮнитЭкономики до unit.cost</input></codex_delegation>`;
  assert.deepEqual(searchTerms(delegated), ["avgCost", "мпКалькуляцияЮнитЭкономики", "unit.cost"]);
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, ["src/large.bsl"], sourceScope(discovery.source_scope), 2200, {
    query: "Проследить источник себестоимости до строки выгрузки",
    supplementalQuery: delegated
  });
  assert.match(collected.files[0].text, /мпКалькуляцияЮнитЭкономики/);
  assert.ok(collected.files[0].segments.some(segment => segment.reason === "supplemental_objective_match"));
  assert.equal(collected.files[0].exact_term_scan.occurrences.find(item => item.term === "мпКалькуляцияЮнитЭкономики").count, 1);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("many allowed files share one exact-location evidence budget instead of starving all source text", () => {
  const { root, producer, db } = fixture("workflow-source-shared-exact-budget-", { sources: ["src/**"] });
  const paths = [];
  for (let index = 0; index < 24; index += 1) {
    const relative = `src/cost-${index}.mjs`;
    paths.push(relative);
    fs.writeFileSync(path.join(producer, relative), Array.from({ length: 180 }, (_, line) => `export const avgCost${line} = ${line};`).join("\n"));
  }
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, paths, sourceScope(discovery.source_scope), 40_000, { query: "avgCost" });
  assert.equal(collected.files.filter(file => file.status === "read").length, 24);
  assert.ok(collected.files.every(file => file.status !== "budget_exhausted"));
  assert.ok(collected.files.reduce((total, file) => total + file.exact_term_scan.occurrences[0].locations.length, 0) <= 96);
  assert.ok(Buffer.byteLength(JSON.stringify(collected)) < 80_000);
  assert.ok(collected.bytes > 20_000);
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("many allowed files spend source bytes on content relevance instead of inventory width", () => {
  const { root, producer, db } = fixture("workflow-source-ranked-allocation-", { sources: ["src/**"] });
  const paths = [];
  for (let index = 0; index < 20; index += 1) {
    const relative = `src/file-${index}.mjs`;
    paths.push(relative);
    const subject = index < 4 ? `export function avgCost${index}(row) {\n${"  const retainedContext = row.value;\n".repeat(120)}  return row.product_unit_economics_by_scheme;\n}\n` : "";
    fs.writeFileSync(path.join(producer, relative), `${subject}${"const unrelatedValue = 1;\n".repeat(500)}`);
  }
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, paths, sourceScope(discovery.source_scope), 40_000, { query: "Trace avgCost through product_unit_economics_by_scheme" });
  const supplied = collected.files.map(file => file.supplied_bytes);
  assert.ok(Math.min(...supplied.slice(0, 4)) > Math.max(...supplied.slice(12)) * 5);
  assert.ok(collected.files.slice(0, 4).every(file => file.text.includes("product_unit_economics_by_scheme")));
  assert.ok(collected.files.every(file => file.status === "read"));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("a JavaScript evidence window keeps a complete medium-sized enclosing function", () => {
  const { root, producer, db } = fixture("workflow-source-js-function-", { sources: ["src/**"] });
  const body = Array.from({ length: 190 }, (_, index) => `  const calculation${index} = row.avgCost + ${index};`);
  body.push("  const completedFallback = row.product_unit_economics_by_scheme;");
  fs.writeFileSync(path.join(producer, "src", "cost.mjs"), `export function calculateAvgCost(row) {\n${body.join("\n")}\n  return completedFallback;\n}\n${"const unrelatedDashboardValue = 1;\n".repeat(1000)}`);
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, ["src/cost.mjs"], sourceScope(discovery.source_scope), 20_000, { query: "Trace calculateAvgCost and product_unit_economics_by_scheme" });
  assert.match(collected.files[0].text, /completedFallback/);
  assert.ok(collected.files[0].segments.some(segment => segment.reason === "referenced_call_chain:calculateAvgCost" && segment.complete), JSON.stringify(collected.files[0].segments));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test("dispersed exact identifiers survive generic helper call chains in one large source", () => {
  const { root, producer, db } = fixture("workflow-source-dispersed-chain-", { sources: ["src/**"] });
  const lines = Array.from({ length: 900 }, (_, index) => `const unrelated${index} = ${index};`);
  lines[20] = "export function bootstrap() { return sqliteExec(sqlString('schema')); }";
  lines[390] = "const normalized = { avgCost: Number(unit.cost) || 0 };";
  lines[401] = "const focusedExpected = { avgCost: 3025.24 };";
  lines[710] = "await sqliteExec(`INSERT INTO dashboard_rows_v2 (avgCost) VALUES (${normalized.avgCost})`);";
  fs.writeFileSync(path.join(producer, "src", "importer.mjs"), lines.join("\n"));
  fs.writeFileSync(path.join(producer, "src", "caller.mjs"), `export function callImporter(value) {\n${Array.from({ length: 16 }, (_, index) => `  value.genericHelper${index}();`).join("\n")}\n  return value.importRows();\n}\n`);
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" });
  const collected = collectSourceFiles(discovery.roots, ["src/importer.mjs", "src/caller.mjs"], sourceScope(discovery.source_scope), 12_000, { query: "Trace unit.cost to avgCost write into dashboard_rows_v2 with focused expected value" });
  assert.match(collected.files[0].text, /Number\(unit\.cost\)/);
  assert.match(collected.files[0].text, /avgCost: 3025\.24/);
  assert.match(collected.files[0].text, /INSERT INTO dashboard_rows_v2/);
  assert.ok(collected.files[0].segments.some(segment => segment.reason.startsWith("exact_term_anchor:")));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
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
  const found = searchSources(discovery.roots, sourceScope(discovery.source_scope), terms, { indexedTerms: ["avgCost", "unit.cost"] });
  // The file mentioning a term most often comes first, both roots are searched, and a file that mentions
  // nothing does not appear at all.
  assert.deepEqual(found.files.map(file => file.path), ["src/cost.mjs", "consumer/src/view.mjs"]);
  assert.equal(found.files[0].matches.length, 2);
  assert.equal(found.files[0].matches[0].line, 1);
  assert.deepEqual(found.exact_term_index.find(item => item.term === "avgCost"), {
    term: "avgCost", matched_files: 2, matched_lines: 3, paths: ["src/cost.mjs", "consumer/src/view.mjs"], paths_truncated: false
  });
  assert.equal(found.completeness.file_scan_truncated, false);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("code research excludes prose documents and prefers project-affine source paths", () => {
  const root = temporaryRoot("workflow-source-code-ranking-");
  fs.mkdirSync(path.join(root, "WorkflowPlatform", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "Architecture.md"), "WorkflowPlatform WorkflowPlatform WorkflowPlatform\n", "utf8");
  fs.writeFileSync(path.join(root, "WorkflowPlatform", "src", "workflow-app.mjs"), "export const WorkflowPlatform = 'research';\n", "utf8");
  fs.writeFileSync(path.join(root, "unrelated.mjs"), "export const WorkflowPlatform = 'other';\n", "utf8");
  const found = searchSources([{ key: "primary", path: root, access: "read", primary: true }], sourceScope([]), ["WorkflowPlatform"], {
    maxFiles: 8, indexedTerms: ["WorkflowPlatform"], sourceCodeOnly: true, preferSourceCode: true
  });
  assert.deepEqual(found.files.map(file => file.path), ["WorkflowPlatform/src/workflow-app.mjs", "unrelated.mjs"]);
  assert.equal(found.completeness.eligible_files, 2);
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
  assert.equal(found.completeness.result_files_truncated, true);
  assert.equal(found.completeness.file_scan_truncated, false);
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

test("Russian prose uses bilingual corpus terms to rank the relevant implementation sources", () => {
  const root = temporaryRoot("workflow-cross-language-source-ranking-");
  fs.mkdirSync(path.join(root, "docs", "ru"), { recursive: true });
  fs.mkdirSync(path.join(root, "WorkflowPlatform", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "ru", "CHANGELOG.md"), [
    "Проверка внешних операций после одобрения владельца описана в следующей строке.",
    "Implementation: external control plane, approval binding и payload сверяются до записи результата."
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(root, "docs", "ru", "Unity.md"), "Проверка владельца для постороннего продукта Unity описана отдельно.\n", "utf8");
  fs.writeFileSync(path.join(root, "WorkflowPlatform", "src", "external-control-plane.mjs"), "export function validateExternalPayload(payload) { return payload.status; }\n", "utf8");
  fs.writeFileSync(path.join(root, "WorkflowPlatform", "src", "approval-binding.mjs"), "export function assertApprovalBinding(approval) { return approval.binding; }\n", "utf8");
  fs.writeFileSync(path.join(root, "WorkflowPlatform", "src", "work-executor.mjs"), "export function continueExternalOperation(payload, approval) { return payload.status && approval; }\n", "utf8");
  fs.mkdirSync(path.join(root, "WorkflowPlatform", "packages", "example", "generated"), { recursive: true });
  fs.writeFileSync(path.join(root, "WorkflowPlatform", "packages", "example", "generated", "external-control-plane.xml"), "<package>external control plane approval payload</package>\n", "utf8");
  for (let index = 0; index < 8; index += 1) fs.writeFileSync(path.join(root, "WorkflowPlatform", "src", `noise-${index}.mjs`), "export const status = 'completed'; export const message = 'owner';\n", "utf8");

  const roots = [{ key: "primary", path: root, access: "read", primary: true }];
  const scope = sourceScope([]);
  const objective = "Как устроена проверка внешних операций после одобрения владельца?";
  assert.deepEqual(searchTerms(objective), []);
  const expanded = expandTerms(roots, scope, objective);
  assert.equal(expanded.harvested.includes("external"), true);
  assert.equal(expanded.harvested.includes("control"), true);
  const found = searchSources(roots, scope, [...new Set([...expanded.terms, ...expanded.subject])], {
    maxFiles: 8, indexedTerms: expanded.code, sourceCodeOnly: true, preferSourceCode: true
  });
  assert.equal(found.files[0].path, "WorkflowPlatform/src/external-control-plane.mjs");
  assert.equal(found.files.slice(0, 3).some(file => file.path === "WorkflowPlatform/src/approval-binding.mjs"), true);
  assert.equal(found.files.slice(0, 3).some(file => file.path === "WorkflowPlatform/src/work-executor.mjs"), true);
  assert.equal(found.files.some(file => file.path.includes("/generated/")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Russian prose source ranking stays useful on the real repository corpus", () => {
  const repository = path.resolve(import.meta.dirname, "..", "..");
  const roots = [{ key: "primary", path: repository, access: "read", primary: true }];
  const scope = sourceScope([]);
  const cases = [
    {
      objective: "Как устроена проверка внешних операций после одобрения владельца?",
      expected: ["WorkflowPlatform/src/external-control-plane.mjs"],
      top: 5
    },
    {
      objective: "Как WorkflowPlatform передаёт исследователю содержимое исходников?",
      expected: ["WorkflowPlatform/src/workflow-app.mjs"],
      top: 8
    },
    {
      objective: "В каком состоянии оказывается прогон, если исследование недостаточно?",
      expected: ["WorkflowPlatform/src/workflow-app.mjs", "WorkflowPlatform/src/state-machine.mjs"],
      top: 8
    }
  ];
  for (const item of cases) {
    const expanded = expandTerms(roots, scope, item.objective);
    const found = searchSources(roots, scope, [...new Set([...expanded.terms, ...expanded.subject])], {
      maxFiles: item.top,
      indexedTerms: expanded.code,
      sourceCodeOnly: true,
      preferSourceCode: true
    });
    assert.equal(found.files.some(file => item.expected.includes(file.path)), true, `${item.objective}\n${found.files.map(file => file.path).join("\n")}`);
  }
});

test("long workflow wording does not displace the domain terms at the end of the request", () => {
  const { root, producer, db } = fixture("workflow-long-search-request-", { sources: ["src/**"] });
  fs.writeFileSync(path.join(producer, "src", "labels.mjs"), `export const labels = { avgCost: "Средняя себестоимость" };\n`);
  fs.writeFileSync(path.join(producer, "src", "report.mjs"), `${"// daily workflow helper\n".repeat(12)}export const value = row.avgCost;\n`);
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" }), scope = sourceScope(discovery.source_scope);
  const message = "Повтори полное исследование на установленном Zodchi с новым специализированным поиском. Проследи, откуда передаётся средняя себестоимость avgCost";
  const expanded = expandTerms(discovery.roots, scope, message);
  assert.equal(expanded.subject.some(term => term.startsWith("себесто")), true);
  assert.equal(expanded.harvested.includes("avgCost"), true);
  const found = searchSources(discovery.roots, scope, ["avgCost", "daily"], { maxMatchesPerFile: 2 });
  assert.equal(found.files.find(file => file.path === "src/report.mjs").matches.some(match => match.term === "avgCost"), true);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("source evidence keeps exact lexical and graph anchors under a shared byte budget", () => {
  const lexical = { terms: ["avgCost", "unit.cost", "Register.Cost"], files: [
    { path: "docs/analysis-avg-cost.md", matches: [{ line: 1, term: "avgCost", text: "x" }, { line: 2, term: "unit.cost", text: "x" }] },
    { path: "metadata/Register.Cost.xml", matches: [{ line: 1, term: "Register.Cost", text: "x" }] },
    ...Array.from({ length: 12 }, (_, index) => ({ path: `docs/noise-${index}.md`, matches: [{ line: 1, term: "avgCost", text: "x" }] }))
  ] };
  const intelligence = {
    primary_terms: ["avgcost", "unit.cost", "register.cost"],
    ranked_files: ["src/dashboard.ts", "src/report.ts", "src/cost.ts", "src/api.ts"].map((file, index) => ({ path: file, score: 900 - index * 50 })),
    nodes: ["src/dashboard.ts", "src/report.ts", "src/cost.ts", "src/api.ts"].map((file, index) => ({ id: String(index), path: file, kind: "function", name: `symbol${index}`, start_line: 1, reasons: ["exact_identifier"] })),
    edges: []
  };
  const merged = mergeGraphMatches(lexical, intelligence);
  const context = { source_matches: merged };
  fitSourceEvidence(context, 4200);
  const paths = context.source_matches.files.map(file => file.path);
  assert.equal(paths.includes("docs/analysis-avg-cost.md"), true);
  assert.equal(paths.includes("src/dashboard.ts"), true);
  assert.equal(paths.includes("src/report.ts"), true);
  assert.equal(Buffer.byteLength(JSON.stringify(context)) <= 4200, true);
});

test("planner locator fitting removes duplicate adapter catalogs before losing the best path", () => {
  const context = { source_inventory: [{ root: "primary", access: "write", total_files: 400, truncated: false, directories: { src: 400 }, files: Array.from({ length: 400 }, (_, index) => ({ path: `src/${index}.ts`, bytes: 100 })) }], source_matches: {
    terms: Array.from({ length: 64 }, (_, index) => `term_${index}`),
    files: [{ path: "src/relevant.ts", matches: [{ line: 7, term: "avgCost", text: "model.avgCost = response.avgCost" }] }],
    exact_term_index: Array.from({ length: 24 }, (_, index) => ({ term: `term_${index}`, paths: Array.from({ length: 80 }, (_, pathIndex) => `src/${pathIndex}.ts`) })),
    derived_from: { request_words: Array.from({ length: 64 }, (_, index) => `request_${index}`), identifiers: Array.from({ length: 64 }, (_, index) => `identifier_${index}`) },
    code_intelligence: { nodes: [], edges: [], ranked_files: [], adapters: [{ name: "typescript-compiler", transitions: Array.from({ length: 300 }, (_, index) => ({ id: `transition_${index}`, path: "src/relevant.ts", symbol_from: "avgCost", symbol_to: "avgCost", expression_from: "response.avgCost", expression_to: "model.avgCost" })) }] }
  } };
  fitSourceEvidence(context, 4096);
  assert.equal(Buffer.byteLength(JSON.stringify(context)) <= 4096, true);
  assert.equal(context.source_matches.files[0].path, "src/relevant.ts");
  assert.equal(context.source_matches.files[0].matches[0].term, "avgCost");
});

test("planner fitting preserves proven exact-term paths before duplicate AST transitions", () => {
  const relevantPaths = Array.from({ length: 18 }, (_, index) => `src/feature-${index}.ts`);
  const context = { source_matches: {
    terms: ["avgCost", "profit"], files: relevantPaths.map(pathValue => ({ path: pathValue, matches: [{ line: 1, term: "avgCost", text: "row.avgCost" }] })),
    exact_term_index: [{ term: "avgCost", matched_files: 18, matched_lines: 42, paths: [...relevantPaths], paths_truncated: false }],
    code_intelligence: { nodes: [], edges: [], ranked_files: [], adapters: [{ name: "typescript-compiler", transitions: Array.from({ length: 500 }, (_, index) => ({ id: `transition_${index}`, path: relevantPaths[index % relevantPaths.length], kind: "property_mapping", symbol_from: "avgCost", symbol_to: "avgCost", expression_from: `response.items[${index}].avgCost`, expression_to: `model.items[${index}].avgCost` })) }] }
  } };
  fitSourceEvidence(context, 65536, value => 30_000 + Buffer.byteLength(JSON.stringify(value)));
  assert.deepEqual(context.source_matches.exact_term_index[0].paths, relevantPaths);
  assert.equal(context.source_matches.code_intelligence.adapters[0].transitions_truncated, true);
  assert.equal(30_000 + Buffer.byteLength(JSON.stringify(context)) <= 65536, true);
});

test("BSL intelligence expands lexical evidence through procedures and metadata", () => {
  const { root, producer, db } = fixture("workflow-bsl-graph-", { sources: ["src/**"] });
  fs.writeFileSync(path.join(producer, "src", "labels.bsl"), `Процедура СформироватьОтчет()\n  Себестоимость = ПолучитьСебестоимость();\nКонецПроцедуры\n`);
  fs.writeFileSync(path.join(producer, "src", "cost.bsl"), `Функция ПолучитьСебестоимость()\n  Возврат РегистрыСведений.мпКалькуляцияЮнитЭкономики.СрезПоследних();\nКонецФункции\n`);
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" }), scope = sourceScope(discovery.source_scope);
  const lexical = searchSources(discovery.roots, scope, ["СформироватьОтчет"]);
  const graph = buildCodeIntelligence(discovery.roots, scope, ["СформироватьОтчет"], lexical);

  assert.equal(graph.adapters.some(adapter => adapter.name === "bsl-structural" && adapter.definitions === 2), true);
  assert.equal(graph.edges.some(edge => edge.type === "calls"), true);
  assert.equal(graph.ranked_files.some(file => file.path === "src/cost.bsl"), true);
  assert.equal(graph.completeness.file_scan_truncated, false);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("data analytics locates SQL and Python evidence without claiming a semantic graph", () => {
  const { root, producer, db } = fixture("workflow-data-locators-", { sources: ["sql/**", "python/**"] });
  fs.mkdirSync(path.join(producer, "sql"), { recursive: true });
  fs.mkdirSync(path.join(producer, "python"), { recursive: true });
  fs.writeFileSync(path.join(producer, "sql", "unikey_check.sql"), "WITH cleaned_unikey AS (SELECT unikey FROM sales WHERE is_valid = 1)\nSELECT count(*) FROM cleaned_unikey;\n");
  fs.writeFileSync(path.join(producer, "python", "verify.py"), "def validate_unikey(rows):\n    return [row for row in rows if row['is_valid']]\n\nresult = validate_unikey(source_rows)\n");
  fs.writeFileSync(path.join(producer, "outside.txt"), "cleaned_unikey validate_unikey must stay outside the declared data scope\n");
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" }), scope = sourceScope(discovery.source_scope);
  const found = searchSources(discovery.roots, scope, ["cleaned_unikey", "validate_unikey"], { indexedTerms: ["cleaned_unikey", "validate_unikey"] });

  assert.deepEqual(found.files.map(item => item.path).sort(), ["python/verify.py", "sql/unikey_check.sql"]);
  assert.equal(found.files.every(item => item.matches.every(match => Number.isInteger(match.line) && match.line > 0 && match.text.includes(match.term))), true);
  assert.equal(found.completeness.enumeration_complete, true);
  assert.equal(found.completeness.file_scan_truncated, false);
  assert.deepEqual(found.exact_term_index.map(item => [item.term, item.matched_files]), [["cleaned_unikey", 1], ["validate_unikey", 1]]);
  assert.equal(found.code_intelligence, undefined);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("TypeScript compiler intelligence resolves JavaScript calls across files", t => {
  const { root, producer, db } = fixture("workflow-ts-graph-", { sources: ["src/**"] });
  fs.writeFileSync(path.join(producer, "package.json"), JSON.stringify({ type: "module", dependencies: { typescript: "*" } }));
  let localTypeScript;
  try { localTypeScript = path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")); }
  catch { db.close(); fs.rmSync(root, { recursive: true, force: true }); t.skip("TypeScript is supplied by the analyzed project, not bundled with Zodchi"); return; }
  fs.mkdirSync(path.join(producer, "node_modules"), { recursive: true });
  fs.symlinkSync(localTypeScript, path.join(producer, "node_modules", "typescript"), "junction");
  fs.writeFileSync(path.join(producer, "src", "cost.mjs"), `export function calculateAverageCost(unit) { return unit.cost; }\n`);
  fs.writeFileSync(path.join(producer, "src", "report.mjs"), `import { calculateAverageCost } from "./cost.mjs";\nimport * as ts from "typescript";\nexport function buildReport(unit, callback) {\n  const avgCost = unit.avgCost;\n  [unit.cost].map(value => value);\n  ts.createProgram([], {});\n  callback();\n  unit.computeDynamicCost();\n  return calculateAverageCost(unit);\n}\n`);
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" }), scope = sourceScope(discovery.source_scope);
  const lexical = searchSources(discovery.roots, scope, ["buildReport"]);
  const graph = buildCodeIntelligence(discovery.roots, scope, ["buildReport", "avgCost"], lexical);

  assert.equal(graph.adapters.some(adapter => adapter.name === "typescript-compiler" && adapter.compiler_available), true);
  assert.equal(graph.edges.some(edge => edge.type === "calls"), true);
  assert.equal(graph.ranked_files.some(file => file.path === "src/cost.mjs"), true);
  const adapter = graph.adapters.find(item => item.name === "typescript-compiler");
  assert.equal(Object.values(adapter.unresolved_call_categories).reduce((total, count) => total + count, 0), adapter.unresolved_calls);
  assert.ok(adapter.unresolved_call_categories.standard_library > 0);
  assert.ok(adapter.unresolved_call_categories.external_dependency > 0);
  assert.ok(adapter.unresolved_call_categories.dynamic_or_untyped > 0);
  assert.ok(adapter.unresolved_call_categories.project_internal_unmapped > 0);
  assert.ok(adapter.unresolved_call_samples.dynamic_or_untyped.some(item => item.expression.includes("computeDynamicCost")));
  assert.ok(adapter.transitions.some(item => item.method === "typescript_ast" && item.kind === "field_assignment" && item.symbol_from === "avgCost" && item.symbol_to === "avgCost"));
  const merged = mergeGraphMatches(lexical, graph);
  assert.equal(merged.files.some(file => file.path === "src/cost.mjs"), true);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a version-only TypeScript package is unavailable evidence instead of a crashed run", () => {
  const { root, producer, db } = fixture("workflow-ts-incompatible-", { sources: ["src/**"] });
  const dependency = path.join(producer, "node_modules", "typescript"); fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "typescript", version: "7.0.2", main: "version.cjs" }));
  fs.writeFileSync(path.join(dependency, "version.cjs"), "module.exports = { version: '7.0.2', versionMajorMinor: '7.0' };\n");
  fs.writeFileSync(path.join(producer, "src", "feature.ts"), "export function verifyFeature() { return true; }\n");
  const discovery = readProjectContext("integration", db, [], { workflowId: "workflow" }), scope = sourceScope(discovery.source_scope);
  const lexical = searchSources(discovery.roots, scope, ["verifyFeature"]), graph = buildCodeIntelligence(discovery.roots, scope, ["verifyFeature"], lexical);
  const adapter = graph.adapters.find(item => item.name === "typescript-unavailable");
  assert.ok(adapter);
  assert.equal(adapter.compiler_available, false);
  assert.equal(graph.nodes.some(item => item.language === "typescript"), false);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

// The enumeration cap used to be applied before the scope, which made Git's listing order decide what
// the scope was allowed to contain. On a repository of thousands of paths a file the scope named
// directly was never enumerated, and the answer came back as absence rather than as an unread corpus.
function largeRepositoryFixture(prefix, { noise = 600 } = {}) {
  const root = temporaryRoot(prefix);
  fs.mkdirSync(path.join(root, "aaa-noise"), { recursive: true });
  fs.mkdirSync(path.join(root, "zzz-target"), { recursive: true });
  for (let index = 0; index < noise; index += 1) fs.writeFileSync(path.join(root, "aaa-noise", `note-${String(index).padStart(5, "0")}.md`), "unrelated project noise\n");
  fs.writeFileSync(path.join(root, "zzz-target", "Себестоимость.bsl"), "Функция РассчитатьСебестоимость()\n  avgCost = unit.cost;\nКонецФункции\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  execFileSync("git", ["add", "."], { cwd: root, windowsHide: true });
  return root;
}

const primaryRoot = root => [{ key: "primary", path: root, access: "write", primary: true }];

test("a scoped target past the enumeration cap is found instead of reported absent", () => {
  const root = largeRepositoryFixture("workflow-scope-cap-");
  const scope = sourceScope(["zzz-target/**"]);

  const found = searchSources(primaryRoot(root), scope, ["avgCost"], { maxEnumeratedFiles: 50, maxOpenedFiles: 50 });
  assert.equal(found.files.length, 1);
  assert.equal(found.files[0].path, "zzz-target/Себестоимость.bsl");
  assert.equal(found.completeness.file_scan_truncated, false);
  assert.equal(found.completeness.enumeration_complete, true);
  assert.equal(found.completeness.listings[0].scope_pushdown, true);
  assert.equal(found.completeness.listings[0].matched_files, 1);

  // The unscoped search over the same repository is genuinely capped, and says so rather than
  // presenting the first fifty paths as the whole corpus.
  const wide = searchSources(primaryRoot(root), sourceScope([]), ["avgCost"], { maxEnumeratedFiles: 50, maxOpenedFiles: 50 });
  assert.equal(wide.completeness.file_scan_truncated, true);
  assert.equal(wide.completeness.enumeration_complete, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a scoped corpus scan stays complete where the same scan over the whole repository is truncated", () => {
  const root = largeRepositoryFixture("workflow-scope-corpus-");

  const scoped = scanSourceCorpus(primaryRoot(root), sourceScope(["zzz-target/**"]), ["avgCost"], { maxFiles: 50 });
  assert.equal(scoped.completeness, "complete");
  assert.equal(scoped.boundary.enumeration_complete, true);
  assert.equal(scoped.boundary.listings[0].scope_pushdown, true);
  assert.equal(scoped.occurrences[0].count, 1);

  // Absence may be claimed here because the boundary is complete: the term is simply not in scope.
  const absent = scanSourceCorpus(primaryRoot(root), sourceScope(["zzz-target/**"]), ["НетТакогоТермина"], { maxFiles: 50 });
  assert.equal(absent.completeness, "complete");
  assert.equal(absent.occurrences[0].count, 0);

  // The same absence over a truncated corpus is not an absence, and the boundary reports it.
  const truncated = scanSourceCorpus(primaryRoot(root), sourceScope([]), ["НетТакогоТермина"], { maxFiles: 50 });
  assert.equal(truncated.completeness, "incomplete");
  assert.equal(truncated.boundary.enumeration_complete, false);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a pattern git glob cannot express uses a bounded non-authoritative fallback", () => {
  const root = largeRepositoryFixture("workflow-scope-pushdown-", { noise: 20 });
  // A character class is a literal for this scope and a class for git, so pushing it down would select
  // a different set of files. The fallback may find positive evidence, but it cannot certify absence.
  const scope = sourceScope(["zzz-target/[unusual].bsl", "zzz-target/**"]);

  const scan = scanSourceCorpus(primaryRoot(root), scope, ["avgCost"], { maxFiles: 500 });
  assert.equal(scan.boundary.listings[0].scope_pushdown, false);
  assert.equal(scan.boundary.listings[0].source, "walk_scope_fallback");
  assert.equal(scan.boundary.listings[0].authoritative, false);
  assert.match(scan.boundary.listings[0].scope_pushdown_reason, /^pattern_not_representable:/);
  assert.equal(scan.occurrences[0].count, 1);
  assert.equal(scan.completeness, "incomplete");

  fs.rmSync(root, { recursive: true, force: true });
});

test("an unreadable filesystem branch makes fallback enumeration non-authoritative", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-scope-read-error-"));
  fs.mkdirSync(path.join(root, "visible"));
  fs.mkdirSync(path.join(root, "blocked"));
  fs.writeFileSync(path.join(root, "visible", "source.bsl"), "avgCost = 1;\n");
  const listing = listFiles(root, {
    maxFiles: 50,
    scope: sourceScope([]),
    readDirectory(directory, options) {
      if (path.basename(directory) === "blocked") throw Object.assign(new Error("denied"), { code: "EACCES" });
      return fs.readdirSync(directory, options);
    }
  });
  assert.equal(listing.authoritative, false);
  assert.equal(listing.read_errors, 1);
  assert.equal(listing.files.includes("visible/source.bsl"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a plain non-Git corpus remains authoritative when the Git executable is unavailable", () => {
  const root = temporaryRoot("workflow-no-git-corpus-");
  fs.writeFileSync(path.join(root, "brief.md"), "No repository is required for content work.\n");
  const listing = listFiles(root, {
    maxFiles: 50,
    scope: sourceScope([]),
    runGit() { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); }
  });
  assert.equal(listing.source, "walk");
  assert.equal(listing.authoritative, true);
  assert.equal(listing.files.includes("brief.md"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a Git working tree is non-authoritative when Git cannot establish its ignored boundary", () => {
  const root = temporaryRoot("workflow-missing-git-boundary-");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "brief.md"), "Tracked status is unknown.\n");
  const listing = listFiles(root, {
    maxFiles: 50,
    scope: sourceScope([]),
    runGit() { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); }
  });
  assert.equal(listing.source, "walk_after_git_error");
  assert.equal(listing.authoritative, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a tracked file deleted from the working tree is not enumerated and costs no per-file stat", () => {
  const root = largeRepositoryFixture("workflow-scope-deleted-", { noise: 5 });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, windowsHide: true });
  execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root, windowsHide: true, stdio: "ignore" });
  fs.rmSync(path.join(root, "zzz-target", "Себестоимость.bsl"));

  const [inventory] = sourceInventory(primaryRoot(root), sourceScope([]), { maxFilesPerRoot: 100 });
  assert.equal(inventory.files.some(file => file.path.includes("Себестоимость")), false);
  assert.equal(inventory.total_files, 5);
  assert.equal(inventory.enumeration_complete, true);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a scope narrowed to one root does not enumerate the other", () => {
  const first = largeRepositoryFixture("workflow-scope-roots-a-", { noise: 30 });
  const second = largeRepositoryFixture("workflow-scope-roots-b-", { noise: 30 });
  const roots = [{ key: "primary", path: first, access: "write", primary: true }, { key: "second", path: second, access: "read", primary: false }];

  const scan = scanSourceCorpus(roots, sourceScope(["zzz-target/**"]), ["avgCost"], { maxFiles: 500 });
  assert.equal(scan.occurrences[0].count, 2);
  assert.deepEqual(scan.boundary.listings.map(item => item.matched_files), [1, 1]);
  assert.equal(scan.boundary.listings.every(item => item.scope_pushdown), true);
  assert.equal(scan.completeness, "complete");

  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
});
