import fs from "node:fs";
import path from "node:path";
import { escapeXml, exactAttributes, exactChildren, parseLimitedXml } from "./limited-xml.mjs";
import { inspectWorkflowPackage } from "./workflow-package.mjs";

const KEY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ACTIVATION = new Set(["activate-first", "prepare-only", "available"]);

function relativeFile(value) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.replaceAll("\\", "/").split("/").includes("..")) throw new Error("WORKFLOW_BUNDLE_FILE_INVALID");
  return value.replaceAll("\\", "/");
}

export function validateWorkflowBundle(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("WORKFLOW_BUNDLE_INVALID");
  if (value.schema_version !== 1 || !KEY.test(value.key) || !VERSION.test(value.version) || typeof value.purpose !== "string" || !value.purpose.trim()) throw new Error("WORKFLOW_BUNDLE_METADATA_INVALID");
  if (!Array.isArray(value.packages) || !value.packages.length) throw new Error("WORKFLOW_BUNDLE_PACKAGES_REQUIRED");
  const seen = new Set();
  for (const item of value.packages) {
    if (!item || Object.keys(item).sort().join(",") !== "activation,file,hash,key,version") throw new Error("WORKFLOW_BUNDLE_PACKAGE_FIELDS_INVALID");
    if (!KEY.test(item.key) || !VERSION.test(item.version) || !/^sha256:[0-9a-f]{64}$/.test(item.hash) || !ACTIVATION.has(item.activation)) throw new Error(`WORKFLOW_BUNDLE_PACKAGE_INVALID: ${item.key ?? "unknown"}`);
    item.file = relativeFile(item.file);
    if (seen.has(item.key)) throw new Error(`WORKFLOW_BUNDLE_PACKAGE_DUPLICATE: ${item.key}`);
    seen.add(item.key);
  }
  return value;
}

export function serializeWorkflowBundle(value) {
  const valid = validateWorkflowBundle(structuredClone(value));
  const packages = valid.packages.map(item => `    <package key="${escapeXml(item.key)}" version="${escapeXml(item.version)}" file="${escapeXml(item.file)}" hash="${item.hash}" activation="${item.activation}"/>`).join("\n");
  return `<workflow_bundle key="${escapeXml(valid.key)}" version="${escapeXml(valid.version)}" schema_version="1" status="accepted">\n  <purpose>${escapeXml(valid.purpose)}</purpose>\n  <packages>\n${packages}\n  </packages>\n</workflow_bundle>\n`;
}

export function parseWorkflowBundle(source) {
  const root = parseLimitedXml(source);
  if (root.name !== "workflow_bundle") throw new Error("WORKFLOW_BUNDLE_ROOT_INVALID");
  const attributes = exactAttributes(root, ["key", "version", "schema_version", "status"]);
  if (attributes.schema_version !== "1" || attributes.status !== "accepted") throw new Error("WORKFLOW_BUNDLE_ENVELOPE_INVALID");
  const [purpose, packagesNode] = exactChildren(root, ["purpose", "packages"]);
  exactAttributes(purpose, []); exactAttributes(packagesNode, []);
  if (purpose.children.length || packagesNode.text.trim()) throw new Error("WORKFLOW_BUNDLE_CONTENT_INVALID");
  const packages = packagesNode.children.map(node => {
    if (node.name !== "package" || node.children.length || node.text.trim()) throw new Error("WORKFLOW_BUNDLE_PACKAGE_NODE_INVALID");
    const item = exactAttributes(node, ["key", "version", "file", "hash", "activation"]);
    return { key: item.key, version: item.version, file: item.file, hash: item.hash, activation: item.activation };
  });
  return validateWorkflowBundle({ schema_version: 1, key: attributes.key, version: attributes.version, purpose: purpose.text, packages });
}

export function inspectWorkflowBundle(file) {
  try {
    const bundle = parseWorkflowBundle(fs.readFileSync(file, "utf8"));
    const base = path.dirname(path.resolve(file));
    const packages = bundle.packages.map(item => {
      const packageFile = path.resolve(base, item.file);
      if (packageFile !== base && !packageFile.startsWith(`${base}${path.sep}`)) throw new Error(`WORKFLOW_BUNDLE_PACKAGE_OUTSIDE_ROOT: ${item.file}`);
      const result = inspectWorkflowPackage(packageFile);
      if (result.status !== "passed") throw new Error(`WORKFLOW_BUNDLE_PACKAGE_LINT_FAILED: ${item.key}`);
      if (result.package.key !== item.key || result.package.version !== item.version || result.package_hash !== item.hash) throw new Error(`WORKFLOW_BUNDLE_PACKAGE_MISMATCH: ${item.key}`);
      return { key: item.key, version: item.version, file: packageFile, activation: item.activation, status: "passed" };
    });
    return { status: "passed", errors: [], bundle, packages };
  } catch (error) { return { status: "failed", errors: [String(error.message)] }; }
}
