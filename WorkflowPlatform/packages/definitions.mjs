import path from "node:path";
import { pathToFileURL } from "node:url";
import * as builders from "./builders.mjs";
import { resolveWorkflowSettings } from "../src/paths.mjs";

// Package definitions describe real projects: their documents, their checks, their thresholds. That is
// an installation's own material, not part of the product, so the source is configurable and the
// repository ships only the builders above and the example beside this file.
export const packageDefinitionsFile = resolveWorkflowSettings().packageDefinitions;

const loaded = (await import(pathToFileURL(packageDefinitionsFile).href)).default;
if (typeof loaded !== "function") throw new Error(`PACKAGE_DEFINITIONS_INVALID: ${packageDefinitionsFile} must default-export a function`);
const value = loaded(builders);
if (!Array.isArray(value?.packages) || !Array.isArray(value?.bundles)) throw new Error(`PACKAGE_DEFINITIONS_INVALID: ${packageDefinitionsFile} must return packages and bundles`);

export const PACKAGE_DEFINITIONS = Object.freeze(value.packages);
export const PACKAGE_BUNDLES = Object.freeze(value.bundles);
// Generated packages describe the configured projects, so they belong beside the source that declares
// them rather than inside the repository.
export const generatedPackagesDirectory = path.join(path.dirname(packageDefinitionsFile), "generated");
