// The example this repository ships with. It exists so the package format, the builders and the
// generator can be built, validated and tested without any real project, and so a new installation
// has something complete to read before writing its own definitions.
//
// Point `packageDefinitions` in the runtime configuration at your own file to replace it. That file
// exports the same default function and receives the same builder module, so it needs no import path.
export default function definePackages(b) {
  const { accessManagement, activityOperations, backupRestore, browserSentinelCheck, checkBinding, capabilityCheck, composedPackage, configureRoleInputs, contentProduction, coreLifecycle, dataChange, disabledCheck, documentationCapability, domainAdapter, experiment, externalRuntime, externalToolCheck, incidentCapability, ownerAcceptance, projectBootstrap, releaseCapability, securityChecks, securityReview, sourceChange, sqliteCheck } = b;

  const webChecks = [
    capabilityCheck("web_lint", "Web application lint", "node.package_manager", ["run", "lint"], [checkBinding("prototype", null), checkBinding("mvp", "code"), checkBinding("production", "release_package")], 900),
    capabilityCheck("web_tests", "Web application tests", "node.package_manager", ["test"], [checkBinding("mvp", "code"), checkBinding("production", "release_package")], 1800),
    capabilityCheck("web_build", "Web application production build", "node.package_manager", ["run", "build"], [checkBinding("production", "release_package")], 1800),
    ...securityChecks("web").filter(item => item.kind !== "secret_scan")
  ];

  const webPrefix = "software_web_application";
  const webEvidenceFlow = {
    key: "typescript.api_to_ui",
    claim_type: "cross_layer_chain",
    subject: "server-produced application value",
    target: "rendered UI consumer",
    workflow_keys: [`${webPrefix}.change`, `${webPrefix}.runtime`],
    nodes: [
      { key: "producer", step_keys: ["work"], path_hints: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"], anchor_terms: ["return", "select", "calculate"] },
      { key: "api", step_keys: ["work"], path_hints: ["**/api/**", "**/routes/**", "**/controllers/**"], anchor_terms: ["json", "response", "schema"] },
      { key: "client_mapping", step_keys: ["work"], path_hints: ["**/client/**", "**/services/**", "**/api/**"], anchor_terms: ["map", "response", "data"] },
      { key: "state_model", step_keys: ["work"], path_hints: ["**/store/**", "**/state/**", "**/models/**"], anchor_terms: ["setState", "reducer", "model"] },
      { key: "ui_consumer", step_keys: ["work"], path_hints: ["**/components/**", "**/pages/**", "**/*.tsx", "**/*.jsx"], anchor_terms: ["render", "props", "row"] }
    ],
    required_edges: ["producer->api", "api->client_mapping", "client_mapping->state_model", "state_model->ui_consumer"],
    material_symbols: [],
    transition: { adapter: "typescript-compiler", method: "assignment_continuity" },
    status: "active"
  };
  const software = composedPackage(
    coreLifecycle({
      key: "software.web-application", version: "1.6.0", purpose: "Portable Web application workflow for bounded source and data changes, evidence-grounded API-to-UI review, incidents, access and approved release.", rolePreset: "full",
      domains: ["software"], disciplines: ["software"], checks: webChecks,
      documents: []
    }),
    domainAdapter({ key: "typescript", domains: ["software"], disciplines: ["software"], materialClaims: true, evidenceFlows: [webEvidenceFlow] }),
    sourceChange({ checkKeys: ["web_lint", "web_tests"] }),
    dataChange({ checkKeys: ["web_tests"] }),
    contentProduction({ checkKeys: ["web_lint"] }),
    releaseCapability({ checkKeys: webChecks.map(item => item.key) }),
    incidentCapability({ checkKeys: ["web_tests"] }),
    externalRuntime({ checkKeys: ["web_tests"], browser: true }),
    accessManagement({ checkKeys: ["web_lint"] }),
    projectBootstrap({ checkKeys: ["web_lint", "web_tests"] }),
    documentationCapability({ checkKeys: ["web_lint"] }),
    securityReview({ checkKeys: ["web_gitleaks", "web_osv"] })
  );
  // Every Web check above is platform-owned. Keep model-side skills and MCP explicit and empty instead
  // of making an ordinary worker depend on a browser profile for unrelated implementation routes.
  for (const roleKey of ["researcher", "worker", "reviewer"]) configureRoleInputs(software, roleKey, { skills: [], mcpServers: [] });
  const bslCheck = {
    key: "bsl_language_server", name: "BSL Language Server policy against the accepted diagnostic baseline",
    runner: "requires_local_bsl_language_server", kind: "disabled", config: { reason: "requires_local_bsl_binding" }, timeout_seconds: 1800,
    bindings: [checkBinding("mvp", "code"), checkBinding("production", "release_package")]
  };
  const oneCSkillValidation = externalToolCheck("one_c_skill_validation", "Pinned cc-1c-skills structural validators", "cc-1c-skills-validate", { operation: "validate" }, [checkBinding("mvp", "code"), checkBinding("production", "release_package")], 1800);
  const oneCPrefix = "one_c_development";
  const oneCEvidenceFlow = {
    key: "bsl.source_to_ui",
    claim_type: "cross_layer_chain",
    subject: "1C source calculation",
    target: "form or report consumer",
    workflow_keys: [`${oneCPrefix}.change`, `${oneCPrefix}.runtime`],
    nodes: [
      { key: "source", step_keys: ["work"], path_hints: ["**/*.bsl", "**/*.xml"], anchor_terms: ["Функция", "Процедура"] },
      { key: "calculation", step_keys: ["work"], path_hints: ["**/*.bsl"], anchor_terms: ["Возврат", "Результат"] },
      { key: "structure_attribute", step_keys: ["work"], path_hints: ["**/*.bsl", "**/*.xml"], anchor_terms: ["Структура", "Реквизит", "Attribute"] },
      { key: "form_report", step_keys: ["work", "verify"], path_hints: ["**/Forms/**", "**/Reports/**", "**/*.xml"], anchor_terms: ["Форма", "Отчет", "Form", "Report"] }
    ],
    required_edges: ["source->calculation", "calculation->structure_attribute", "structure_attribute->form_report"],
    material_symbols: [],
    transition: { adapter: "bsl-structural", method: "source_anchor_continuity" },
    status: "active"
  };
  const oneC = composedPackage(
    coreLifecycle({
      key: "one-c.development", version: "1.6.0", purpose: "Support-grade 1C source diagnosis, change, integration, module build, functional verification and release with external evidence boundaries.", rolePreset: "reviewed",
      domains: ["one-c"], disciplines: ["one-c-development"], checks: [bslCheck, oneCSkillValidation],
      documents: []
    }),
    domainAdapter({ key: "bsl", domains: ["one-c"], disciplines: ["one-c-development"], materialClaims: true, evidenceFlows: [oneCEvidenceFlow] }),
    sourceChange({ workTypes: ["one-c.change", "one-c.integration", "one-c.module-build"], checkKeys: ["bsl_language_server", "one_c_skill_validation"] }),
    externalRuntime({ workTypes: ["one-c.resume", "one-c.diagnosis", "one-c.functional-test"], checkKeys: ["bsl_language_server"] }),
    releaseCapability({ workTypes: ["one-c.release"], checkKeys: ["bsl_language_server"] })
  );
  const oneCInfoSkills = ["cf-info", "form-info", "meta-info", "mxl-info", "role-info", "skd-info", "subsystem-info"];
  // Keep this list to source-tree transforms. Skills that mutate an information base or a web
  // publication need an external_mutation boundary and a registered external contour; this package
  // deliberately does not smuggle those actions in through a broadly capable worker.
  const oneCWorkerSkills = ["cf-edit", "cf-init", "cfe-borrow", "cfe-init", "cfe-patch-method", "epf-build", "epf-dump", "epf-init", "erf-build", "erf-dump", "erf-init", "form-add", "form-compile", "form-edit", "form-remove", "interface-edit", "meta-compile", "meta-edit", "meta-remove", "mxl-compile", "mxl-decompile", "role-compile", "skd-compile", "skd-edit", "subsystem-compile", "subsystem-edit"];
  configureRoleInputs(oneC, "researcher", { skills: oneCInfoSkills });
  configureRoleInputs(oneC, "worker", { skills: oneCWorkerSkills });
  configureRoleInputs(oneC, "reviewer", { skills: [] });

  const unityChecks = [
    disabledCheck("unity_csharp_boundary", "Pinned C# semantic provider and attested Unity solution boundary", "requires_local_csharp_provider_binding", [checkBinding("mvp", "code"), checkBinding("production", "release_package")]),
    disabledCheck("unity_batch", "Unity batch build and tests with process-tree guard", "requires_local_unity_batch_binding", [checkBinding("mvp", "test_report"), checkBinding("production", "release_package")]),
    disabledCheck("unity_checkpoint", "Git and LFS checkpoint before Unity evidence", "requires_local_unity_checkpoint_binding", [checkBinding("mvp", "test_report"), checkBinding("production", "release_package")])
  ];
  const unityPrefix = "game_unity";
  const unityEvidenceFlow = {
    key: "csharp.state_to_runtime_consumer",
    claim_type: "cross_layer_chain",
    subject: "C# state or lifecycle producer",
    target: "Unity runtime consumer",
    workflow_keys: [`${unityPrefix}.change`, `${unityPrefix}.runtime`],
    nodes: [
      { key: "producer", step_keys: ["work", "verify"], path_hints: ["**/*.cs"], anchor_terms: ["return", "new", "Build", "Create"] },
      { key: "state_model", step_keys: ["work", "verify"], path_hints: ["**/*.cs"], anchor_terms: ["state", "model", "snapshot", "save"] },
      { key: "runtime_consumer", step_keys: ["work", "verify"], path_hints: ["Assets/**/*.cs", "Packages/**/*.cs"], anchor_terms: ["Update", "OnEnable", "Handle", "Apply"] }
    ],
    required_edges: ["producer->state_model", "state_model->runtime_consumer"],
    material_symbols: [],
    transition: { adapter: "csharp-ls", method: "semantic_reference_or_verified_call" },
    status: "active"
  };
  const unity = composedPackage(
    coreLifecycle({
      key: "game.unity", version: "0.7.0", purpose: "Executable preview for bounded Unity design research, C# change, build and technical QA with separate visual, gameplay and owner acceptance.", rolePreset: "reviewed",
      domains: ["game-development"], disciplines: ["software", "game_design", "technical_art", "art_direction", "testing", "release"], checks: unityChecks,
      resources: [{ alias: "unity.project", kind: "project.worktree", purpose: "Explicit single-machine Unity project runtime boundary" }],
      documents: []
    }),
    domainAdapter({ key: "unity-csharp", domains: ["game-development"], disciplines: ["software", "game_design"], materialClaims: true, evidenceFlows: [unityEvidenceFlow] }),
    experiment({ workTypes: ["game.design-research"], checkKeys: ["unity_checkpoint"], resources: [{ alias: "unity.project", mode: "shared" }] }),
    sourceChange({ workTypes: ["game.change"], checkKeys: ["unity_csharp_boundary", "unity_checkpoint"], resources: [{ alias: "unity.project", mode: "exclusive" }] }),
    externalRuntime({ workTypes: ["game.build-test", "game.technical-qa", "game.pipeline-audit"], checkKeys: ["unity_batch", "unity_checkpoint"], resources: [{ alias: "unity.project", mode: "exclusive" }] }),
    ownerAcceptance({ workTypes: ["game.visual-acceptance", "game.product-acceptance", "game.release-readiness"], artifactKeys: ["visual_asset", "test_report"], checkKeys: ["unity_batch", "unity_checkpoint"], resources: [{ alias: "unity.project", mode: "exclusive" }] })
  );

  const gameWebChecks = [
    capabilityCheck("game_web_tests", "Browser game tests", "node.package_manager", ["test"], [checkBinding("mvp", "code"), checkBinding("production", "release_package")], 1800),
    capabilityCheck("game_web_build", "Browser game build", "node.package_manager", ["run", "build"], [checkBinding("production", "release_package")], 1800),
    browserSentinelCheck("game_web_browser_proof", "Deterministic browser state and screenshot capture", "playwright", [checkBinding("mvp", "test_report"), checkBinding("production", "release_package")])
  ];
  const gameWebPrefix = "game_web";
  const gameWebEvidenceFlow = {
    key: "game.feature_to_browser_proof",
    claim_type: "game_feature_trace",
    subject: "accepted game design decision",
    target: "deterministic browser proof",
    workflow_keys: [`${gameWebPrefix}.experiment`, `${gameWebPrefix}.change`, `${gameWebPrefix}.runtime`],
    nodes: [
      { key: "design_decision", step_keys: ["coordinate", "experiment"], path_hints: ["**/*.md", "**/*.json"], anchor_terms: ["decision", "acceptance", "hypothesis"] },
      { key: "technical_task", step_keys: ["coordinate", "work"], path_hints: ["src/**", "app/**", "game/**"], anchor_terms: ["feature", "state", "system"] },
      { key: "browser_proof", step_keys: ["verify"], path_hints: ["**/screenshots/**", "**/artifacts/**", "**/tests/**"], anchor_terms: ["screenshot", "state", "assert"] }
    ],
    required_edges: ["design_decision->technical_task", "technical_task->browser_proof"],
    material_symbols: [],
    transition: { adapter: "registered-browser-evidence", method: "objective_and_capture_provenance" },
    status: "active"
  };
  const gameWeb = composedPackage(
    coreLifecycle({
      key: "game.web", version: "0.7.0", purpose: "Executable preview for browser-game design, implementation and deterministic browser proof with separate technical and owner product acceptance.", rolePreset: "full",
      domains: ["game-development"], disciplines: ["software", "game_design", "content", "marketing"], checks: gameWebChecks,
      documents: []
    }),
    domainAdapter({ key: "web-game", domains: ["game-development"], disciplines: ["software", "game_design"], materialClaims: true, evidenceFlows: [gameWebEvidenceFlow] }),
    experiment({ workTypes: ["game.design-research"], checkKeys: ["game_web_tests"] }),
    sourceChange({ workTypes: ["game.change"], checkKeys: ["game_web_tests"] }),
    externalRuntime({ workTypes: ["game.build-test", "game.technical-qa", "game.pipeline-audit"], checkKeys: ["game_web_tests", "game_web_browser_proof"], browser: true }),
    contentProduction({ workTypes: ["content", "marketing"], checkKeys: ["game_web_tests"] }),
    ownerAcceptance({ workTypes: ["game.visual-acceptance", "game.product-acceptance", "game.release-readiness"], artifactKeys: ["visual_asset", "test_report"], checkKeys: ["game_web_browser_proof"] })
  );

  const dataChecks = [
    sqliteCheck("data_readonly_query", "Registered read-only SQLite query", "data.primary", "SELECT 1 AS readonly_probe", 1, [checkBinding("mvp", "test_report")]),
    sqliteCheck("data_invariant", "SQLite integrity invariant", "data.primary", "PRAGMA integrity_check", "ok", [checkBinding("mvp", "test_report"), checkBinding("production", "data_migration")]),
    disabledCheck("data_backup", "Backup or isolated-copy evidence before live mutation", "requires_local_data_backup_binding", [checkBinding("production", "data_migration")])
  ];
  const dataPrefix = "data_analytics";
  const dataEvidenceFlow = {
    key: "data.query_to_invariant",
    claim_type: "data_invariant",
    subject: "bounded query or transformation",
    target: "deterministic invariant result",
    workflow_keys: [`${dataPrefix}.runtime`, `${dataPrefix}.data`],
    nodes: [
      { key: "query_definition", step_keys: ["coordinate", "prepare", "verify"], path_hints: ["**/*.sql", "**/*.py"], anchor_terms: ["SELECT", "WITH", "assert", "reconcile"] },
      { key: "isolated_execution", step_keys: ["prepare", "verify"], path_hints: ["**/fixtures/**", "**/tests/**", "**/*.sql", "**/*.py"], anchor_terms: ["fixture", "temporary", "readonly", "transaction"] },
      { key: "invariant_result", step_keys: ["prepare", "verify"], path_hints: ["**/artifacts/**", "**/reports/**", "**/tests/**"], anchor_terms: ["0 rows", "count", "schema", "reconciliation"] }
    ],
    required_edges: ["query_definition->isolated_execution", "isolated_execution->invariant_result"],
    material_symbols: [],
    transition: { adapter: "registered-data-check", method: "query_hash_and_result_provenance" },
    status: "active"
  };
  const dataAnalytics = composedPackage(
    coreLifecycle({
      key: "data.analytics", version: "0.7.0", purpose: "Executable preview for read-only data discovery, deterministic invariants and approval-bound migration preparation without persisting source rows or prompts.", rolePreset: "reviewed",
      domains: ["data"], disciplines: ["data_engineering", "software", "testing"], checks: dataChecks,
      resources: [{ alias: "data.primary", kind: "db", purpose: "Registered database or isolated analytical copy" }],
      documents: []
    }),
    domainAdapter({ key: "sql-python", domains: ["data"], disciplines: ["data_engineering"], materialClaims: true, evidenceFlows: [dataEvidenceFlow] }),
    externalRuntime({ workTypes: ["data.discovery", "data.verification"], checkKeys: ["data_readonly_query", "data_invariant"], resources: [{ alias: "data.primary", mode: "shared" }] }),
    dataChange({ workTypes: ["data_change"], checkKeys: ["data_invariant", "data_backup"], resources: [{ alias: "data.primary", mode: "exclusive" }] }),
    documentationCapability({ checkKeys: ["data_invariant"] })
  );

  const infraChecks = [
    disabledCheck("infra_health", "Registered infrastructure health and read-only inventory", "requires_local_infra_health_binding", [checkBinding("mvp", "test_report"), checkBinding("production", "deployment_evidence")]),
    disabledCheck("infra_backup_restore", "Backup and restore drill with target verification", "requires_local_backup_restore_binding", [checkBinding("production", null)]),
    disabledCheck("infra_delivery", "Registered CI or deployment verification", "requires_local_delivery_binding", [checkBinding("production", "release_package")])
  ];
  const infraPrefix = "infra_operations";
  const infraEvidenceFlow = {
    key: "infra.change_to_health",
    claim_type: "operational_change_trace",
    subject: "registered infrastructure target and proposed change",
    target: "post-change health evidence",
    workflow_keys: [`${infraPrefix}.backup_restore`],
    nodes: [
      { key: "observed_state", step_keys: ["verify_backup"], path_hints: ["**/*.yml", "**/*.yaml", "**/*.tf", "**/*.json", "**/*.md"], anchor_terms: ["health", "inventory", "backup"] },
      { key: "approved_action", step_keys: ["restore_approval"], path_hints: ["**/artifacts/**", "**/plans/**"], anchor_terms: ["approval", "hash", "target", "rollback"] },
      { key: "applied_action", step_keys: ["restore"], path_hints: ["**/artifacts/**", "**/receipts/**"], anchor_terms: ["applied", "restored"] },
      { key: "health_result", step_keys: ["verify_health"], path_hints: ["**/artifacts/**", "**/reports/**"], anchor_terms: ["healthy", "ready", "restored", "passed"] }
    ],
    required_edges: ["observed_state->approved_action", "approved_action->applied_action", "applied_action->health_result"],
    material_symbols: [],
    transition: { adapter: "registered-infra-command", method: "action_hash_and_receipt_provenance" },
    status: "active"
  };
  const infra = composedPackage(
    coreLifecycle({
      key: "infra.operations", version: "0.7.0", purpose: "Executable preview for read-only operations, incident diagnosis and approval-bound access, restore and delivery changes with redacted receipts.", rolePreset: "reviewed",
      domains: ["infrastructure"], disciplines: ["devops", "security", "access_administration"], checks: infraChecks,
      resources: [{ alias: "infra.target", kind: "project.worktree", purpose: "Registered infrastructure configuration and local execution boundary" }],
      documents: []
    }),
    // Release and access post-action truth is owned by approval binding, the signed result, the
    // registered verification gate and its verified artifact. Backup/restore still has explicit
    // before, approval, application and health steps, so its evidence flow remains meaningful.
    domainAdapter({ key: "infra-command", domains: ["infrastructure"], disciplines: ["devops"], materialClaims: true, evidenceFlows: [infraEvidenceFlow] }),
    externalRuntime({ workTypes: ["infra.inventory"], checkKeys: ["infra_health"], resources: [{ alias: "infra.target", mode: "shared" }] }),
    incidentCapability({ workTypes: ["incident"], checkKeys: ["infra_health"], resources: [{ alias: "infra.target", mode: "shared" }] }),
    sourceChange({ workTypes: ["implementation", "fix"], checkKeys: ["infra_health"], resources: [{ alias: "infra.target", mode: "exclusive" }] }),
    accessManagement({ workTypes: ["access_management"], checkKeys: ["infra_health"], resources: [{ alias: "infra.target", mode: "exclusive" }] }),
    backupRestore({ workTypes: ["infra.backup-restore"], checkKeys: ["infra_backup_restore", "infra_health"], resources: [{ alias: "infra.target", mode: "exclusive" }], readResources: [{ alias: "infra.target", mode: "shared" }] }),
    releaseCapability({ workTypes: ["release", "deployment"], checkKeys: ["infra_delivery", "infra_health"], resources: [{ alias: "infra.target", mode: "exclusive" }] })
  );

  const marketingChecks = [
    disabledCheck("marketing_rules", "Project claims, style and document rules", "requires_local_marketing_rules_binding", [checkBinding("mvp", "content_asset")]),
    disabledCheck("marketing_dedupe", "Outreach target and activity deduplication", "requires_local_marketing_dedupe_binding", [checkBinding("mvp", null)]),
    disabledCheck("marketing_activity_receipt", "Scheduled, executed and measured activity receipt", "requires_local_activity_provider_binding", [checkBinding("mvp", null)])
  ];
  const marketingPrefix = "marketing_content_operations";
  const marketingEvidenceFlow = {
    key: "marketing.claim_to_measured_activity",
    claim_type: "activity_execution_trace",
    subject: "project-grounded marketing claim",
    target: "measured activity result",
    workflow_keys: [`${marketingPrefix}.content`, `${marketingPrefix}.activity`],
    nodes: [
      { key: "claim", step_keys: ["coordinate", "produce"], path_hints: ["CLAIMS.md", "**/research/**", "**/*.md"], anchor_terms: ["claim", "source", "proof", "hypothesis"] },
      { key: "edited_content", step_keys: ["produce", "edit", "owner_acceptance"], path_hints: ["**/content/**", "**/drafts/**", "**/*.md"], anchor_terms: ["draft", "editor", "accepted"] },
      { key: "scheduled_activity", step_keys: ["schedule", "execution_approval"], path_hints: ["ACTIVITY_STATE.md", "**/calendar/**"], anchor_terms: ["planned", "scheduled", "channel"] },
      { key: "execution_receipt", step_keys: ["execute"], path_hints: ["ACTIVITY_STATE.md", "**/receipts/**"], anchor_terms: ["executed", "message_id", "published"] },
      { key: "measurement", step_keys: ["measure"], path_hints: ["ACTIVITY_STATE.md", "**/reports/**"], anchor_terms: ["measured", "response", "conversion", "result"] }
    ],
    required_edges: ["claim->edited_content", "edited_content->scheduled_activity", "scheduled_activity->execution_receipt", "execution_receipt->measurement"],
    material_symbols: [],
    transition: { adapter: "registered-activity-ledger", method: "claim_and_activity_receipt_provenance" },
    status: "active"
  };
  const marketing = composedPackage(
    coreLifecycle({
      key: "marketing.content-operations", version: "0.7.0", purpose: "Executable preview for grounded research, edited content and planned-to-measured marketing activity without multiplying permanent roles or documents.", rolePreset: "full",
      domains: ["marketing", "content"], disciplines: ["marketing", "content", "documentation"], checks: marketingChecks,
      resources: [{ alias: "marketing.state", kind: "project.worktree", purpose: "Canonical project claims, content and activity-state boundary" }],
      documents: []
    }),
    domainAdapter({ key: "marketing-activity", domains: ["marketing", "content"], disciplines: ["marketing", "content"], materialClaims: true, evidenceFlows: [marketingEvidenceFlow] }),
    experiment({ workTypes: ["marketing.research"], checkKeys: ["marketing_rules"], resources: [{ alias: "marketing.state", mode: "shared" }] }),
    contentProduction({ workTypes: ["content", "marketing"], checkKeys: ["marketing_rules", "marketing_dedupe"], ownerAcceptance: true, resources: [{ alias: "marketing.state", mode: "exclusive" }] }),
    activityOperations({ workTypes: ["marketing.activity"], checkKeys: ["marketing_activity_receipt", "marketing_dedupe"], resources: [{ alias: "marketing.state", mode: "exclusive" }], readResources: [{ alias: "marketing.state", mode: "shared" }] }),
    documentationCapability({ workTypes: ["documentation"], checkKeys: ["marketing_rules"], resources: [{ alias: "marketing.state", mode: "exclusive" }] })
  );

  const packages = [software, oneC, gameWeb, unity, dataAnalytics, infra, marketing];
  return {
    packages,
    bundles: [],
    aliases: [{ key: "example.web-app", target: "software.web-application", deprecated: true, remove_after: "0.6.x" }],
    statuses: { "software.web-application": "support-grade", "one-c.development": "support-grade", "game.web": "preview", "game.unity": "preview", "data.analytics": "preview", "infra.operations": "preview", "marketing.content-operations": "preview" }
  };
}
