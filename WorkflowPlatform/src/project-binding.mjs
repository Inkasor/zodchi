import path from "node:path";
import { inside } from "./project-roots.mjs";

// Which project a message belongs to is decided by where the message came from, never by what the
// process happened to inherit. `WORKFLOW_PLATFORM_CONFIG` is exported once and then outlives the
// directory it was exported in: a terminal configured for one project starts a harness in another, the
// harness passes its whole environment to the hook, and the hook resolves that other project's runtime
// file. Every path in the installation follows from that one variable, so the message is then classified
// against the wrong documents, executed under the wrong workflow, written into the wrong database and
// charged to the wrong project, with nothing in the record saying it happened.
//
// The declaration is not thrown away: an installation configured for a project is exactly the explicit
// binding the owner made. It is checked instead of trusted.

export const ENVIRONMENT_VARIABLES = Object.freeze({
  configFile: "WORKFLOW_PLATFORM_CONFIG",
  project: "WORKFLOW_PROJECT",
  workflow: "WORKFLOW_ID",
  database: "WORKFLOW_DB",
  packageDefinitions: "ZODCHI_PACKAGE_DEFINITIONS"
});

// Naming what stated the value is the whole point of the error: "another project's runtime file" and
// "a variable left over in this shell" are different mistakes with different fixes.
export function declaredBy(settings, key) {
  return settings.sources?.[key] === "environment" ? ENVIRONMENT_VARIABLES[key] : settings.configFile ?? "the installation configuration";
}

// A session legitimately spans more than one directory: a harness opened at a repository root serves a
// project registered one level down, and a hook fired deep inside a project reports that subdirectory.
// Either containment is the same installation seen from a different depth. Two paths with no containment
// at all are two different projects, and that is the case that must never resolve silently.
function related(declared, working) {
  return inside(declared, working) || inside(working, declared);
}

export function bindProject({ settings = {}, origin = null, project = null }) {
  const declared = settings.project ? path.resolve(settings.project) : null;
  const working = origin ? path.resolve(origin) : null;
  // A project named on the command line is a person stating it in the moment, which is the one thing an
  // inherited environment can never be.
  if (project) return Object.freeze({ project, binding: "named", declared, origin: working });
  if (!working) return Object.freeze({ project: declared, binding: declared ? "installation" : "none", declared, origin: null });
  if (!declared) return Object.freeze({ project: working, binding: "origin", declared: null, origin: working });
  if (related(declared, working)) return Object.freeze({ project: declared, binding: "installation", declared, origin: working });
  throw new Error(`PROJECT_BINDING_MISMATCH: ${declaredBy(settings, "project")} binds ${declared}, the message came from ${working}`);
}

// The binding travels with the run so the record answers "which installation served this message" without
// anyone having to reconstruct the environment the hook happened to run under.
export function bindingEvidence(binding, settings = {}) {
  return Object.freeze({
    binding: binding.binding,
    origin: binding.origin,
    declared: binding.declared,
    declared_by: binding.declared ? declaredBy(settings, "project") : null,
    inherited: Object.entries(settings.sources ?? {}).filter(([, source]) => source === "environment").map(([key]) => ENVIRONMENT_VARIABLES[key]).sort()
  });
}
