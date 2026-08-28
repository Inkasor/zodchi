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

// `project` is a caller naming one in the moment: a `--project` argument typed by a person, or a caller
// that already resolved which project it means. It must never be filled in from the installation
// settings on the way here — passing the declaration in as if someone had stated it turns the check
// below into a check of the declaration against itself, which is how the first version of this let a
// hook fired in project B answer under project A while reporting the binding as deliberate.
//
// `registeredAt` answers whether a directory is itself a registered project. A message from a directory
// the declaration does not cover is not automatically an error: if that directory is a project of its
// own, it is the project the message belongs to, and binding it there is both correct and what the
// person meant. Refusal is for the remaining case, where nothing on record can say whose message it is.
export function bindProject({ settings = {}, origin = null, project = null, registeredAt = () => null }) {
  const declared = settings.project ? path.resolve(settings.project) : null;
  const working = origin ? path.resolve(origin) : null;
  if (project) return Object.freeze({ project, binding: "named", declared, origin: working });
  if (!working) return Object.freeze({ project: declared, binding: declared ? "installation" : "none", declared, origin: null });
  if (!declared) return Object.freeze({ project: working, binding: "origin", declared: null, origin: working });
  if (related(declared, working)) return Object.freeze({ project: declared, binding: "installation", declared, origin: working });
  const registered = registeredAt(working);
  if (registered) return Object.freeze({ project: registered, binding: "origin", declared, origin: working });
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
