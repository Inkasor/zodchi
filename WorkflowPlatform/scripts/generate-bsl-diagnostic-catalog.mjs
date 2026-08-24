import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [sourceArgument, outputArgument, versionArgument = "1.0.7"] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error("Usage: node scripts/generate-bsl-diagnostic-catalog.mjs <bsl-source-root> <output-file> [tool-version]");

const sourceRoot = path.resolve(sourceArgument);
const outputFile = path.resolve(outputArgument);
const diagnosticRoot = path.join(sourceRoot, "src", "main", "java", "com", "github", "_1c_syntax", "bsl", "languageserver", "diagnostics");
const resourceRoot = path.join(sourceRoot, "src", "main", "resources", "com", "github", "_1c_syntax", "bsl", "languageserver", "diagnostics");

function annotationBody(source) {
  const marker = "@DiagnosticMetadata(";
  const start = source.indexOf(marker);
  if (start < 0) return null;
  let depth = 1;
  for (let index = start + marker.length; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") depth -= 1;
    if (depth === 0) return source.slice(start + marker.length, index);
  }
  throw new Error("BSL_CATALOG_ANNOTATION_UNBALANCED");
}

function enumValue(body, field, enumName, fallback) {
  return body.match(new RegExp(`\\b${field}\\s*=\\s*${enumName}\\.([A-Z_]+)`))?.[1] ?? fallback;
}

function numberValue(body, field, fallback) {
  const value = body.match(new RegExp(`\\b${field}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)`))?.[1];
  return value === undefined ? fallback : Number(value);
}

function booleanValue(body, field, fallback) {
  const value = body.match(new RegExp(`\\b${field}\\s*=\\s*(true|false)`))?.[1];
  return value === undefined ? fallback : value === "true";
}

function tags(body) {
  const value = body.match(/\btags\s*=\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  return [...value.matchAll(/DiagnosticTag\.([A-Z_]+)/g)].map(match => match[1]).sort();
}

function property(file, key) {
  if (!fs.existsSync(file)) return "";
  const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find(value => value.startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(key.length + 1).replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function computedLspSeverity(type, severity, explicit) {
  if (explicit) return explicit[0].toUpperCase() + explicit.slice(1).toLowerCase();
  if (type === "CODE_SMELL") return ({ INFO: "Hint", MINOR: "Information", MAJOR: "Warning", CRITICAL: "Warning", BLOCKER: "Warning" })[severity];
  if (type === "SECURITY_HOTSPOT") return "Warning";
  return "Error";
}

const diagnostics = [];
for (const name of fs.readdirSync(diagnosticRoot).filter(value => value.endsWith("Diagnostic.java")).sort()) {
  const source = fs.readFileSync(path.join(diagnosticRoot, name), "utf8");
  const body = annotationBody(source);
  if (!body) continue;
  const code = name.slice(0, -"Diagnostic.java".length);
  const type = enumValue(body, "type", "DiagnosticType", "ERROR");
  const severity = enumValue(body, "severity", "DiagnosticSeverity", "MINOR");
  const explicitLsp = body.match(/\blspSeverity\s*=\s*"([^"]+)"/)?.[1] ?? "";
  diagnostics.push({
    code,
    name_ru: property(path.join(resourceRoot, `${code}Diagnostic_ru.properties`), "diagnosticName") || code,
    name_en: property(path.join(resourceRoot, `${code}Diagnostic_en.properties`), "diagnosticName") || code,
    type,
    severity,
    lsp_severity: computedLspSeverity(type, severity, explicitLsp),
    activated_by_default: booleanValue(body, "activatedByDefault", true),
    minutes_to_fix: numberValue(body, "minutesToFix", 0),
    tags: tags(body)
  });
}

if (diagnostics.length !== 186) throw new Error(`BSL_CATALOG_DIAGNOSTIC_COUNT: expected 186, found ${diagnostics.length}`);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8", windowsHide: true }).trim();
const catalog = {
  schema_version: 1,
  tool: {
    name: "BSL Language Server",
    version: versionArgument,
    source_revision: revision,
    source_url: `https://github.com/1c-syntax/bsl-language-server/tree/v${versionArgument}`,
    license: "LGPL-3.0-or-later"
  },
  diagnostics
};
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "generated", output: outputFile, version: versionArgument, source_revision: revision, diagnostics: diagnostics.length })}\n`);
