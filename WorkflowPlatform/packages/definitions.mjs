import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as builders from "./builders.mjs";

// Package definitions describe real projects: their documents, their checks, their thresholds. That is
// an installation's own material, not part of the product, so the source is a parameter and the
// repository ships only the builders beside this file and the example under `example/`.
//
// Which file is loaded is stated by the caller and never inherited from the environment. A repository
// check verifies that the generated packages committed here still match the definitions committed here;
// a variable left over in a shell that names another installation's definitions turns it into a check of
// something else entirely. That is not hypothetical: it passed against twelve private packages while the
// one package in this repository was stale, and the repository reported green.
export const repositoryPackageDefinitionsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "example", "definitions.mjs");

export async function loadPackageDefinitions(file = repositoryPackageDefinitionsFile) {
  const definitionsFile = path.resolve(file);
  const loaded = (await import(pathToFileURL(definitionsFile).href)).default;
  if (typeof loaded !== "function") throw new Error(`PACKAGE_DEFINITIONS_INVALID: ${definitionsFile} must default-export a function`);
  const value = loaded(builders);
  if (!Array.isArray(value?.packages) || !Array.isArray(value?.bundles)) throw new Error(`PACKAGE_DEFINITIONS_INVALID: ${definitionsFile} must return packages and bundles`);
  const aliases = value.aliases ?? [];
  if (!Array.isArray(aliases)) throw new Error(`PACKAGE_DEFINITIONS_INVALID: ${definitionsFile} aliases must be an array`);
  const packageKeys = new Set(value.packages.map(item => item.key)), aliasKeys = new Set();
  for (const alias of aliases) {
    if (!alias || typeof alias.key !== "string" || typeof alias.target !== "string" || alias.deprecated !== true || typeof alias.remove_after !== "string") throw new Error(`PACKAGE_ALIAS_INVALID: ${JSON.stringify(alias)}`);
    if (packageKeys.has(alias.key) || !packageKeys.has(alias.target) || aliasKeys.has(alias.key)) throw new Error(`PACKAGE_ALIAS_INVALID: ${alias.key} -> ${alias.target}`);
    aliasKeys.add(alias.key);
  }
  return Object.freeze({
    file: definitionsFile,
    packages: Object.freeze(value.packages),
    bundles: Object.freeze(value.bundles),
    aliases: Object.freeze(aliases),
    // Generated packages describe the projects the definitions declare, so they belong beside the source
    // that declares them rather than inside this repository.
    generatedDirectory: path.join(path.dirname(definitionsFile), "generated")
  });
}
