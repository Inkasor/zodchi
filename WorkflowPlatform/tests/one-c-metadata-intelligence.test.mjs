import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodeIntelligence } from "../src/code-intelligence.mjs";

test("1C XML metadata contributes form, attribute and command anchors with source provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-c-xml-intelligence-"));
  try {
    fs.mkdirSync(path.join(root, "Forms"));
    fs.mkdirSync(path.join(root, "InformationRegisters"));
    fs.writeFileSync(path.join(root, "Forms", "ФормаЗаказа.xml"), `<MetaDataObject xmlns:mdclass="urn:1C.ru:V8.Metadata">\n<mdclass:Form>\n<Properties><Name>ФормаЗаказа</Name></Properties>\n<Attribute name="Цена"/><Command name="Пересчитать"/>\n</mdclass:Form>\n</MetaDataObject>\n`);
    fs.writeFileSync(path.join(root, "InformationRegisters", "Себестоимость.xml"), `<MetaDataObject xmlns:mdclass="urn:1C.ru:V8.Metadata">\n<mdclass:InformationRegister><Properties><Name>Себестоимость</Name></Properties></mdclass:InformationRegister>\n</MetaDataObject>\n`);
    fs.writeFileSync(path.join(root, "Module.bsl"), `Функция ПолучитьСебестоимость()\n  Возврат РегистрыСведений.Себестоимость;\nКонецФункции\n`);
    const result = buildCodeIntelligence([{ key: "primary", path: root, primary: true }], { matches: () => true }, ["Себестоимость", "ФормаЗаказа"], { files: [] }, { maxNodes: 30, maxEdges: 40, primaryTerms: ["Себестоимость"] });
    const adapter = result.adapters.find(item => item.name === "one-c-xml-metadata");
    assert.equal(adapter.files, 2);
    assert.equal(result.nodes.some(item => item.language === "one-c-xml" && item.kind === "attribute" && item.name === "Цена"), true);
    assert.equal(result.nodes.some(item => item.language === "one-c-xml" && item.kind === "form" && item.name === "ФормаЗаказа"), true);
    assert.equal(result.edges.some(item => item.type === "resolves_metadata" && item.evidence?.source?.path === "Module.bsl" && item.evidence?.target?.path === "InformationRegisters/Себестоимость.xml"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an ambiguous 1C metadata name remains unresolved instead of becoming an observed edge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-c-xml-ambiguous-"));
  try {
    fs.mkdirSync(path.join(root, "one")); fs.mkdirSync(path.join(root, "two"));
    const metadata = `<MetaDataObject><InformationRegister name="Себестоимость"/></MetaDataObject>\n`;
    fs.writeFileSync(path.join(root, "one", "register.xml"), metadata);
    fs.writeFileSync(path.join(root, "two", "register.xml"), metadata);
    fs.writeFileSync(path.join(root, "Module.bsl"), `Процедура Прочитать()\n  РегистрыСведений.Себестоимость.СоздатьНаборЗаписей();\nКонецПроцедуры\n`);
    const result = buildCodeIntelligence([{ key: "primary", path: root, primary: true }], { matches: () => true }, ["Себестоимость"], { files: [] }, { maxNodes: 30, maxEdges: 40, primaryTerms: ["Себестоимость"] });
    assert.equal(result.edges.some(item => item.type === "resolves_metadata"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
