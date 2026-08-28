import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import { configureOneCBslCheck, createOneCBslBaseline } from "../src/one-c-bsl-check.mjs";

const ONE_C_BSL_RUNNER = fileURLToPath(new URL("../src/one-c-bsl-check.mjs", import.meta.url));

// The 1C package binds bsl_language_server as required at mvp and production but ships it disabled:
// the analyzer is a local binary and the accepted debt it compares against is the owner's signature,
// so a portable package can carry neither. Importing therefore leaves the gate inert, and a canary
// that only imported would report a passing gate while never running the check it exists to prove.
// Baseline first, binding second: configuration reads the active baseline to learn which tool version
// its policies belong to, and refuses to bind an analyzer that has nothing to compare against.
export function registerCanaryChecks(dbFile, item) {
  const declaration = item.checks?.one_c_bsl;
  if (!declaration) return null;
  const local = {
    dbFile,
    projectId: item.project_id,
    executable: declaration.executable,
    platformBin: declaration.platform_bin,
    tempRoot: declaration.temp_root,
    catalogFile: declaration.catalog_file
  };
  // confirmed_by is passed through untouched. createOneCBslBaseline refuses a missing value, and a
  // canary that supplied one would turn owner acceptance into a runner default.
  const baseline = createOneCBslBaseline({
    ...local,
    source: declaration.source,
    workspace: declaration.workspace ?? declaration.source,
    acceptedRevision: declaration.accepted_revision,
    confirmedBy: declaration.confirmed_by,
    minimumSeverity: declaration.minimum_severity,
    timeoutSeconds: declaration.timeout_seconds
  });
  const configuration = configureOneCBslCheck(dbFile, { ...local, runner: path.resolve(declaration.runner ?? ONE_C_BSL_RUNNER) });
  const db = openDb(dbFile);
  const check = db.prepare("SELECT kind,runner FROM check_definitions WHERE id=?").get(configuration.check_id);
  db.close();
  if (check?.kind !== "command") throw new Error(`CANARY_CHECK_STILL_INERT: ${configuration.check_id}: ${check?.kind ?? "missing"}`);
  return { check: "one_c_bsl", check_id: configuration.check_id, kind: check.kind, runner: check.runner, baseline, configuration };
}
