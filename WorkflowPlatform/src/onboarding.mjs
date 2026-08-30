import path from "node:path";
import { openDb, now } from "./db.mjs";
import { registerImplicitResources, registerProjectResource } from "./project-resources.mjs";

const rows = (db, sql, values) => { const stmt = db.prepare(sql); for (const value of values) stmt.run(...value); };

export function registerProject(dbFile, project) {
  if (!project?.id || !project.name || !project.root_path || !path.isAbsolute(project.root_path)) throw new Error("register-project: id, name and absolute root_path are required");
  const normalized = { id: project.id, name: project.name, root_path: path.resolve(project.root_path) };
  const db = openDb(dbFile);
  try {
    const before = db.prepare("SELECT id,name,root_path FROM projects WHERE id=? OR name=? OR root_path=?").get(normalized.id, normalized.name, normalized.root_path);
    if (before && (before.id !== normalized.id || before.name !== normalized.name || path.resolve(before.root_path) !== normalized.root_path)) throw new Error("register-project: id, name or root_path belongs to another project");
    const timestamp = now();
    db.prepare("INSERT OR IGNORE INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(normalized.id, normalized.name, normalized.root_path, timestamp);
    db.prepare("INSERT OR IGNORE INTO project_roots(project_id,root_key,path,access,is_primary,created_at) VALUES(?,'primary',?,'write',1,?)").run(normalized.id, normalized.root_path, timestamp);
    registerImplicitResources(db, { projectId: normalized.id, rootPath: normalized.root_path });
    return { status: before ? "already_registered" : "registered", project: normalized };
  } finally { db.close(); }
}

// An additional root widens what a project's runs can see, and on a write root what they can change, so
// it is registered deliberately and never derived from a working directory. A second project's primary
// root is a legitimate target: that is how the consuming end of an integration is read without the
// integration owning it. Registering it as writable is refused, because a change to another project's
// files belongs to that project's own workflow, checks and review.
export function registerProjectRoot(dbFile, { project, key, path: rootPath, access = "read" }) {
  if (!project || !key || !rootPath || !path.isAbsolute(rootPath)) throw new Error("register-root: project, key and an absolute path are required");
  if (!["read", "write"].includes(access)) throw new Error("register-root: access must be read or write");
  if (key === "primary") throw new Error("register-root: the primary root is the project's own directory and is registered with the project");
  const resolved = path.resolve(rootPath);
  const db = openDb(dbFile);
  try {
    if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(project)) throw new Error(`register-root: unknown project ${project}`);
    const owner = db.prepare("SELECT id FROM projects WHERE lower(root_path)=lower(?)").get(resolved);
    if (owner && owner.id !== project && access === "write") throw new Error(`register-root: ${resolved} is the primary root of ${owner.id} and can only be registered for reading`);
    const existing = db.prepare("SELECT path,access FROM project_roots WHERE project_id=? AND root_key=?").get(project, key);
    if (existing && (path.resolve(existing.path) !== resolved || existing.access !== access)) throw new Error(`register-root: ${key} is already registered for ${project} with a different path or access`);
    db.prepare("INSERT OR IGNORE INTO project_roots(project_id,root_key,path,access,is_primary,created_at) VALUES(?,?,?,?,0,?)").run(project, key, resolved, access, now());
    return { status: existing ? "already_registered" : "registered", project, root: { key, path: resolved, access } };
  } finally { db.close(); }
}

export function onboardProject(dbFile, spec) {
  if (!spec?.project?.id || !spec.project.name || !spec.project.root_path) throw new Error("onboarding: project.id, name and root_path are required");
  if (!spec.workflow?.id) throw new Error("onboarding: workflow.id is required");
  for (const document of spec.documents ?? []) if (!document.id || !document.path || path.isAbsolute(document.path) || document.path.split(/[\\/]/).includes("..")) throw new Error(`onboarding: document path must be a registered relative path: ${document.path ?? "missing"}`);
  const db = openDb(dbFile);
  const normalizedPolicies = (spec.operational_levels ?? []).map(policy => {
    const defaults = Object.fromEntries(db.prepare("SELECT metric,limit_value FROM quality_contract_budgets WHERE level=?").all(policy.level).map(row => [row.metric, Number(row.limit_value)]));
    const strategy = policy.improvement_strategy ?? "standard";
    const budgets = strategy === "gauntlet" ? { ...defaults, ...(policy.budgets ?? {}) } : defaults;
    const correctionLimit = strategy === "gauntlet" ? Number(policy.correction_limit ?? budgets.correction_cycles ?? 0) : Number(defaults.correction_cycles ?? 0);
    budgets.correction_cycles = correctionLimit;
    return { ...policy, improvement_strategy: strategy, budgets, correction_limit: correctionLimit };
  });
  db.exec("BEGIN");
  try {
    rows(db, "INSERT OR IGNORE INTO projects (id,name,root_path,created_at) VALUES (?, ?, ?, ?)", [[spec.project.id, spec.project.name, spec.project.root_path, now()]]);
    // The primary root is the project's own directory and is always writable. Any further root is
    // declared in the package, with the access it grants stated there rather than inferred, so widening
    // what a run may touch is a reviewed change to the definition and not a runtime accident.
    rows(db, "INSERT OR IGNORE INTO project_roots (project_id,root_key,path,access,is_primary,created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [[spec.project.id, "primary", spec.project.root_path, "write", 1, now()],
        ...(spec.project.roots ?? []).map(x => [spec.project.id, x.key, x.path, x.access === "write" ? "write" : "read", 0, now()])]);
    // Aliases the installation binds to real authorities. The working tree is registered whether or not
    // anything declared it, because every project has one and a write-capable step holds it.
    registerImplicitResources(db, { projectId: spec.project.id, rootPath: spec.project.root_path });
    for (const resource of spec.resources ?? []) registerProjectResource(db, { projectId: spec.project.id, alias: resource.alias, kind: resource.kind, purpose: resource.purpose ?? null, declaration: resource.declaration ?? null });
    rows(db, "INSERT OR IGNORE INTO work_types (id,name,category) VALUES (?, ?, ?)", (spec.work_types ?? []).map(x => [x.id, x.name ?? x.id, x.category ?? "general"]));
    rows(db, "INSERT OR IGNORE INTO workflows (id,name,project_id,package_key,package_version,default_quality,default_level,status,discovery_json,history_budget_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [[spec.workflow.id, spec.workflow.name ?? spec.workflow.id, spec.project.id, spec.workflow.package_key ?? null, spec.workflow.package_version ?? null, spec.workflow.default_quality ?? "mvp", spec.workflow.default_level ?? "L2", "active", JSON.stringify(spec.workflow.discovery ?? { git: false }), spec.workflow.history_budget_bytes ?? 24000]]);
    rows(db, "INSERT OR IGNORE INTO domains (id,name) VALUES (?, ?)", (spec.domains ?? []).map(x => [x.id, x.name ?? x.id]));
    rows(db, "INSERT OR IGNORE INTO disciplines (id,name) VALUES (?, ?)", (spec.disciplines ?? []).map(x => [x.id, x.name ?? x.id]));
    rows(db, "INSERT OR IGNORE INTO quality_modes (id,name,ordinal) VALUES (?, ?, ?)", (spec.quality_modes ?? []).map(x => [x.id, x.name ?? x.id, x.ordinal ?? 0]));
    rows(db, "INSERT OR IGNORE INTO planning_levels (id,name,ordinal) VALUES (?, ?, ?)", (spec.planning_levels ?? []).map(x => [x.id, x.name ?? x.id, x.ordinal ?? 0]));
    rows(db, "INSERT OR IGNORE INTO artifact_types (id,name,category) VALUES (?, ?, ?)", (spec.artifact_types ?? []).map(x => [x.id, x.name ?? x.id, x.category ?? "general"]));
    rows(db, "INSERT OR IGNORE INTO roles (id,name) VALUES (?, ?)", (spec.roles ?? []).map(x => [x.id, x.name ?? x.id]));
    rows(db, "INSERT OR IGNORE INTO profiles (id,provider,name,role_id) VALUES (?, ?, ?, ?)", (spec.profiles ?? []).map(x => [x.id, x.provider, x.name ?? x.id, x.role_id ?? null]));
    rows(db, "INSERT OR IGNORE INTO semantic_statuses (id,name,category) VALUES (?, ?, ?)", (spec.semantic_statuses ?? []).map(x => [x.id, x.name ?? x.id, x.category ?? "general"]));
    rows(db, "INSERT OR IGNORE INTO evidence_types (id,name) VALUES (?, ?)", (spec.evidence_types ?? []).map(x => [x.id, x.name ?? x.id]));
    rows(db, "INSERT OR IGNORE INTO check_definitions (id,name,runner,kind,config_json,timeout_seconds) VALUES (?, ?, ?, ?, ?, ?)", (spec.checks ?? []).map(x => [x.id, x.name ?? x.id, x.runner ?? x.id, x.kind ?? "command", JSON.stringify(x.config ?? {}), x.timeout_seconds ?? 900]));
    rows(db, "INSERT OR IGNORE INTO project_checks (project_id,check_id,quality_mode_id,required,artifact_type_id) VALUES (?, ?, ?, ?, ?)", (spec.project_checks ?? []).map(x => [spec.project.id, x.check_id, x.quality_mode_id, x.required ? 1 : 0, x.artifact_type_id ?? null]));
    rows(db, "INSERT OR IGNORE INTO project_documents (id,project_id,path,root_key,document_type,authority,status,active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (spec.documents ?? []).map(x => [x.id, spec.project.id, x.path, x.root ?? "primary", x.document_type ?? "working", x.authority ?? null, x.status ?? "active", x.active === false ? 0 : 1]));
    rows(db, "INSERT OR IGNORE INTO role_documents (project_id,role_id,document_id,read_access,write_access,purpose,priority) VALUES (?, ?, ?, ?, ?, ?, ?)", (spec.role_documents ?? []).map(x => [spec.project.id, x.role_id, x.document_id, x.read_access === false ? 0 : 1, x.write_access ? 1 : 0, x.purpose ?? null, x.priority ?? 0]));
    rows(db, "INSERT OR IGNORE INTO workflow_routes (project_id,work_type_id,workflow_id,enabled,priority) VALUES (?, ?, ?, ?, ?)", (spec.routes ?? []).map(x => [spec.project.id, x.work_type_id, x.workflow_id ?? spec.workflow.id, x.enabled === false ? 0 : 1, x.priority ?? 0]));
    rows(db, `INSERT OR IGNORE INTO role_contracts
      (id,project_id,role_id,version,purpose,boundaries_json,allowed_work_types_json,allowed_artifact_types_json,allowed_tools_json,allowed_skills_json,required_checks_json,allowed_transitions_json,allowed_profiles_json,context_limit_bytes,max_calls,max_correction_cycles,timeout_seconds,result_schema_key,prompt_template_version,escalation_json,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, (spec.role_contracts ?? []).map(x => [
      x.id, spec.project.id, x.role_id, x.version ?? "1.0.0", x.purpose,
      JSON.stringify(x.boundaries ?? {}), JSON.stringify(x.allowed_work_types ?? []), JSON.stringify(x.allowed_artifact_types ?? []),
      JSON.stringify(x.allowed_tools ?? []), JSON.stringify(x.allowed_skills ?? []), JSON.stringify(x.required_checks ?? []),
      JSON.stringify(x.allowed_transitions ?? []), JSON.stringify(x.allowed_profiles ?? ["*"]), x.context_limit_bytes ?? 24000,
      x.max_calls ?? 1, x.max_correction_cycles ?? 0, x.timeout_seconds ?? 1800, x.result_schema_key,
      x.prompt_template_version ?? "1.0.0", JSON.stringify(x.escalation ?? {}), x.status ?? "active"
    ]));
    // An assignment declares which portable requirement the local profile fulfils. Where the spec does
    // not say, the requirement is derived from the role: a package declares one requirement per role, so
    // the link is unambiguous, and leaving it unset would make the role unloadable at runtime.
    const requirementForRole = new Map((spec.profile_requirements ?? []).map(x => [x.role_id, x.key]));
    rows(db, "INSERT OR IGNORE INTO role_profile_assignments(project_id,role_id,profile_id,operational_level,enabled,satisfies_profile_key) VALUES(?,?,?,?,?,?)", (spec.role_assignments ?? []).map(x => [spec.project.id, x.role_id, x.profile_id, x.operational_level ?? "mvp", x.enabled === false ? 0 : 1, x.satisfies_profile_key ?? requirementForRole.get(x.role_id) ?? null]));
    rows(db, "INSERT OR IGNORE INTO portable_profile_requirements(project_id,package_key,profile_key,role_id,provider_family,capabilities_json,operational_levels_json) VALUES(?,?,?,?,?,?,?)", (spec.profile_requirements ?? []).map(x => [spec.project.id, x.package_key ?? spec.workflow.package_key ?? spec.workflow.id, x.key, x.role_id, x.provider_family ?? null, JSON.stringify(x.capabilities ?? []), JSON.stringify(x.operational_levels ?? [])]));
    rows(db, "INSERT OR IGNORE INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,resources_json,correction_json,escalation_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (spec.workflow_steps ?? []).map(x => [spec.project.id, x.workflow_id ?? spec.workflow.id, x.key, x.ordinal, x.role_id ?? null, x.required === false ? 0 : 1, x.irreversible ? 1 : 0, x.input_schema_key, x.output_schema_key, JSON.stringify(x.artifact_type_keys ?? []), JSON.stringify(x.check_keys ?? []), JSON.stringify(x.resources ?? []), JSON.stringify(x.correction ?? {}), JSON.stringify(x.escalation ?? {})]));
    rows(db, "INSERT OR IGNORE INTO workflow_transition_templates(project_id,workflow_id,from_step_key,to_step_key,condition_json) VALUES(?,?,?,?,?)", (spec.workflow_transitions ?? []).map(x => [spec.project.id, x.workflow_id ?? spec.workflow.id, x.from, x.to, JSON.stringify(x.condition ?? {})]));
    rows(db, "INSERT OR IGNORE INTO workflow_questions(project_id,workflow_id,question_key,phase,prompt,answer_schema_json,required) VALUES(?,?,?,?,?,?,?)", (spec.workflow_questions ?? []).map(x => [spec.project.id, x.workflow_id ?? spec.workflow.id, x.key, x.phase, x.prompt, JSON.stringify(x.answer_schema ?? {}), x.required === false ? 0 : 1]));
    rows(db, "INSERT OR IGNORE INTO operational_level_policies(project_id,package_key,level,budgets_json,required_checks_json,correction_limit,escalation_json,improvement_strategy) VALUES(?,?,?,?,?,?,?,?)", normalizedPolicies.map(x => [spec.project.id, x.package_key ?? spec.workflow.package_key ?? spec.workflow.id, x.level, JSON.stringify(x.budgets), JSON.stringify(x.required_check_keys ?? []), x.correction_limit, JSON.stringify(x.escalation ?? {}), x.improvement_strategy]));
    const runProfileDefaults = spec.run_profile_defaults ?? normalizedPolicies.map(policy => ({
      quality_mode: policy.level,
      execution_mode: "standard",
      verification_mode: policy.improvement_strategy === "gauntlet" ? "gauntlet" : "baseline",
      planning_mode: "single",
      confirmed_by: "onboarding_legacy_default"
    }));
    rows(db, `INSERT INTO project_run_profile_defaults(project_id,quality_mode,execution_mode,verification_mode,planning_mode,confirmed_by,confirmed_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,quality_mode) DO UPDATE SET execution_mode=excluded.execution_mode,
      verification_mode=excluded.verification_mode,planning_mode=excluded.planning_mode,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at`,
      runProfileDefaults.map(profile => [spec.project.id, profile.quality_mode, profile.execution_mode, profile.verification_mode, profile.planning_mode, profile.confirmed_by, now()]));
    for (const policy of normalizedPolicies) {
      const packageKey = policy.package_key ?? spec.workflow.package_key ?? spec.workflow.id;
      const budgets = { ...(policy.budgets ?? {}), correction_cycles: policy.correction_limit ?? policy.budgets?.correction_cycles ?? 0 };
      for (const [metric, limit] of Object.entries(budgets)) rows(db, "INSERT OR IGNORE INTO operational_level_budget_limits(project_id,package_key,level,metric,limit_value) VALUES(?,?,?,?,?)", [[spec.project.id, packageKey, policy.level, metric, Number(limit)]]);
      let ordinal = 0;
      for (const [event, value] of Object.entries(policy.escalation ?? {})) {
        ordinal += 1;
        const numeric = typeof value === "number" ? value : null;
        const action = value === true ? "required" : value === false ? "disabled" : numeric !== null ? "threshold" : String(value);
        rows(db, "INSERT OR IGNORE INTO operational_level_escalation_rules(project_id,package_key,level,event_key,action_key,threshold_value,ordinal) VALUES(?,?,?,?,?,?,?)", [[spec.project.id, packageKey, policy.level, event, action, numeric, ordinal]]);
      }
    }
    rows(db, "INSERT OR IGNORE INTO prompt_templates(id,project_id,package_key,template_key,version,role_id,result_schema_key,template_text,content_hash,status) VALUES(?,?,?,?,?,?,?,?,?,?)", (spec.prompt_templates ?? []).map(x => [x.id, spec.project.id, x.package_key ?? spec.workflow.package_key ?? spec.workflow.id, x.key, x.version, x.role_id, x.result_schema_key, x.template, x.content_hash, x.status ?? "active"]));
    rows(db, "INSERT OR IGNORE INTO package_test_scenarios(id,project_id,package_key,package_version,scenario_key,input_json,expected_json,anonymized) VALUES(?,?,?,?,?,?,?,?)", (spec.test_scenarios ?? []).map(x => [x.id, spec.project.id, x.package_key ?? spec.workflow.package_key ?? spec.workflow.id, x.package_version ?? spec.workflow.package_version ?? "1.0.0", x.key, JSON.stringify(x.input), JSON.stringify(x.expected), x.anonymized === false ? 0 : 1]));
    if (spec.package_release) rows(db, "INSERT OR IGNORE INTO workflow_package_releases(id,project_id,package_key,version,purpose,prompt_builder_version,manifest_hash,parent_version,change_json,status,created_at,domain_keys_json,discipline_keys_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [[spec.package_release.id, spec.project.id, spec.package_release.key, spec.package_release.version, spec.package_release.purpose, spec.package_release.prompt_builder_version ?? "1.0.0", spec.package_release.manifest_hash, spec.package_release.parent_version ?? null, JSON.stringify(spec.package_release.change ?? {}), spec.package_release.status ?? "active", now(), JSON.stringify(spec.package_release.domain_keys ?? (spec.domains ?? []).map(item => item.id)), JSON.stringify(spec.package_release.discipline_keys ?? (spec.disciplines ?? []).map(item => item.id))]]);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; } finally { db.close(); }
  return { project_id: spec.project.id, workflow_id: spec.workflow.id, status: "onboarded" };
}
