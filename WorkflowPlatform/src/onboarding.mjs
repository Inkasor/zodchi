import path from "node:path";
import { openDb, now } from "./db.mjs";

const rows = (db, sql, values) => { const stmt = db.prepare(sql); for (const value of values) stmt.run(...value); };

export function registerProject(dbFile, project) {
  if (!project?.id || !project.name || !project.root_path || !path.isAbsolute(project.root_path)) throw new Error("register-project: id, name and absolute root_path are required");
  const normalized = { id: project.id, name: project.name, root_path: path.resolve(project.root_path) };
  const db = openDb(dbFile);
  try {
    const before = db.prepare("SELECT id,name,root_path FROM projects WHERE id=? OR name=? OR root_path=?").get(normalized.id, normalized.name, normalized.root_path);
    if (before && (before.id !== normalized.id || before.name !== normalized.name || path.resolve(before.root_path) !== normalized.root_path)) throw new Error("register-project: id, name or root_path belongs to another project");
    db.prepare("INSERT OR IGNORE INTO projects(id,name,root_path,created_at) VALUES(?,?,?,?)").run(normalized.id, normalized.name, normalized.root_path, now());
    return { status: before ? "already_registered" : "registered", project: normalized };
  } finally { db.close(); }
}

export function onboardProject(dbFile, spec) {
  if (!spec?.project?.id || !spec.project.name || !spec.project.root_path) throw new Error("onboarding: project.id, name and root_path are required");
  if (!spec.workflow?.id) throw new Error("onboarding: workflow.id is required");
  for (const document of spec.documents ?? []) if (!document.id || !document.path || path.isAbsolute(document.path) || document.path.split(/[\\/]/).includes("..")) throw new Error(`onboarding: document path must be a registered relative path: ${document.path ?? "missing"}`);
  const db = openDb(dbFile);
  db.exec("BEGIN");
  try {
    rows(db, "INSERT OR IGNORE INTO projects (id,name,root_path,created_at) VALUES (?, ?, ?, ?)", [[spec.project.id, spec.project.name, spec.project.root_path, now()]]);
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
    rows(db, "INSERT OR IGNORE INTO project_documents (id,project_id,path,document_type,authority,status,active) VALUES (?, ?, ?, ?, ?, ?, ?)", (spec.documents ?? []).map(x => [x.id, spec.project.id, x.path, x.document_type ?? "working", x.authority ?? null, x.status ?? "active", x.active === false ? 0 : 1]));
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
    rows(db, "INSERT OR IGNORE INTO workflow_step_templates(project_id,workflow_id,step_key,ordinal,role_id,required,irreversible,input_schema_key,output_schema_key,artifact_types_json,check_keys_json,correction_json,escalation_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (spec.workflow_steps ?? []).map(x => [spec.project.id, x.workflow_id ?? spec.workflow.id, x.key, x.ordinal, x.role_id ?? null, x.required === false ? 0 : 1, x.irreversible ? 1 : 0, x.input_schema_key, x.output_schema_key, JSON.stringify(x.artifact_type_keys ?? []), JSON.stringify(x.check_keys ?? []), JSON.stringify(x.correction ?? {}), JSON.stringify(x.escalation ?? {})]));
    rows(db, "INSERT OR IGNORE INTO workflow_transition_templates(project_id,workflow_id,from_step_key,to_step_key,condition_json) VALUES(?,?,?,?,?)", (spec.workflow_transitions ?? []).map(x => [spec.project.id, x.workflow_id ?? spec.workflow.id, x.from, x.to, JSON.stringify(x.condition ?? {})]));
    rows(db, "INSERT OR IGNORE INTO workflow_questions(project_id,workflow_id,question_key,phase,prompt,answer_schema_json,required) VALUES(?,?,?,?,?,?,?)", (spec.workflow_questions ?? []).map(x => [spec.project.id, x.workflow_id ?? spec.workflow.id, x.key, x.phase, x.prompt, JSON.stringify(x.answer_schema ?? {}), x.required === false ? 0 : 1]));
    rows(db, "INSERT OR IGNORE INTO operational_level_policies(project_id,package_key,level,budgets_json,required_checks_json,correction_limit,escalation_json) VALUES(?,?,?,?,?,?,?)", (spec.operational_levels ?? []).map(x => [spec.project.id, x.package_key ?? spec.workflow.package_key ?? spec.workflow.id, x.level, JSON.stringify(x.budgets ?? {}), JSON.stringify(x.required_check_keys ?? []), x.correction_limit ?? 0, JSON.stringify(x.escalation ?? {})]));
    for (const policy of spec.operational_levels ?? []) {
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
    if (spec.package_release) rows(db, "INSERT OR IGNORE INTO workflow_package_releases(id,project_id,package_key,version,purpose,prompt_builder_version,manifest_hash,parent_version,change_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [[spec.package_release.id, spec.project.id, spec.package_release.key, spec.package_release.version, spec.package_release.purpose, spec.package_release.prompt_builder_version ?? "1.0.0", spec.package_release.manifest_hash, spec.package_release.parent_version ?? null, JSON.stringify(spec.package_release.change ?? {}), spec.package_release.status ?? "active", now()]]);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; } finally { db.close(); }
  return { project_id: spec.project.id, workflow_id: spec.workflow.id, status: "onboarded" };
}
