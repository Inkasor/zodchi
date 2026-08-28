// The example this repository ships with. It exists so the package format, the builders and the
// generator can be built, validated and tested without any real project, and so a new installation
// has something complete to read before writing its own definitions.
//
// Point `packageDefinitions` in the runtime configuration at your own file to replace it. That file
// exports the same default function and receives the same builder module, so it needs no import path.
export default function definePackages(b) {
  const { accessManagement, checkBinding, capabilityCheck, composedPackage, contentProduction, coreLifecycle, dataChange, disabledCheck, documentationCapability, domainAdapter, experiment, externalRuntime, incidentCapability, ownerAcceptance, projectBootstrap, releaseCapability, securityChecks, securityReview, sourceChange } = b;

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
      key: "software.web-application", version: "1.0.0", purpose: "Portable Web application workflow for bounded source and data changes, evidence-grounded API-to-UI review, incidents, access and approved release.", rolePreset: "full",
      domains: ["software"], disciplines: ["software"], checks: webChecks,
      documents: [{ key: "repo_rules", path: "AGENTS.md", type: "authority", authority: "project" }, { key: "readme", path: "README.md", type: "authority", authority: "project" }, { key: "package", path: "package.json", type: "reference", authority: "project" }]
    }),
    domainAdapter({ key: "typescript", domains: ["software"], disciplines: ["software"], materialClaims: true, evidenceFlows: [webEvidenceFlow] }),
    sourceChange({ checkKeys: ["web_lint", "web_tests"] }),
    dataChange({ checkKeys: ["web_tests"] }),
    contentProduction({ checkKeys: ["web_lint"] }),
    releaseCapability({ checkKeys: webChecks.map(item => item.key) }),
    incidentCapability({ checkKeys: ["web_tests"] }),
    externalRuntime({ checkKeys: ["web_tests"] }),
    accessManagement({ checkKeys: ["web_lint"] }),
    projectBootstrap({ checkKeys: ["web_lint", "web_tests"] }),
    documentationCapability({ checkKeys: ["web_lint"] }),
    securityReview({ checkKeys: ["web_gitleaks", "web_osv"] })
  );
  const bslCheck = {
    key: "bsl_language_server",
    name: "BSL Language Server policy against the accepted diagnostic baseline",
    runner: "requires_local_bsl_language_server",
    kind: "disabled",
    config: { reason: "requires_local_bsl_binding" },
    timeout_seconds: 1800,
    bindings: [checkBinding("mvp", "code"), checkBinding("production", "release_package")]
  };
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
      key: "one-c.development", version: "1.0.0", purpose: "Support-grade 1C source diagnosis, change, integration, module build, functional verification and release with external evidence boundaries.", rolePreset: "reviewed",
      domains: ["one-c"], disciplines: ["one-c-development"], checks: [bslCheck],
      documents: [{ key: "project_rules", path: "AGENTS.md", type: "authority", authority: "project" }, { key: "readme", path: "README.md", type: "reference", authority: "project" }]
    }),
    domainAdapter({ key: "bsl", domains: ["one-c"], disciplines: ["one-c-development"], materialClaims: true, evidenceFlows: [oneCEvidenceFlow] }),
    sourceChange({ workTypes: ["one-c.change", "one-c.integration", "one-c.module-build"], checkKeys: ["bsl_language_server"] }),
    externalRuntime({ workTypes: ["one-c.resume", "one-c.diagnosis", "one-c.functional-test"], checkKeys: ["bsl_language_server"] }),
    releaseCapability({ workTypes: ["one-c.release"], checkKeys: ["bsl_language_server"] })
  );

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
      key: "game.unity", version: "0.1.0", purpose: "Executable preview for bounded Unity design research, C# change, build and technical QA with separate visual, gameplay and owner acceptance.", rolePreset: "reviewed",
      domains: ["game-development"], disciplines: ["software", "game_design", "technical_art", "art_direction", "testing", "release"], checks: unityChecks,
      resources: [{ alias: "unity.project", kind: "project.worktree", purpose: "Explicit single-machine Unity project runtime boundary" }],
      documents: [{ key: "project_rules", path: "AGENTS.md", type: "authority", authority: "project" }, { key: "game_design", path: "GDD.md", type: "strategy", authority: "project" }]
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
    disabledCheck("game_web_browser_proof", "Deterministic browser state and screenshot capture", "requires_local_browser_evidence_binding", [checkBinding("mvp", "test_report"), checkBinding("production", "release_package")])
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
      key: "game.web", version: "0.1.0", purpose: "Executable preview for browser-game design, implementation and deterministic browser proof with separate technical and owner product acceptance.", rolePreset: "editorial",
      domains: ["game-development"], disciplines: ["software", "game_design", "content", "marketing"], checks: gameWebChecks,
      documents: [{ key: "project_rules", path: "AGENTS.md", type: "authority", authority: "project" }, { key: "game_design", path: "GDD.md", type: "strategy", authority: "project" }]
    }),
    domainAdapter({ key: "web-game", domains: ["game-development"], disciplines: ["software", "game_design"], materialClaims: true, evidenceFlows: [gameWebEvidenceFlow] }),
    experiment({ workTypes: ["game.design-research"], checkKeys: ["game_web_tests"] }),
    sourceChange({ workTypes: ["game.change"], checkKeys: ["game_web_tests"] }),
    externalRuntime({ workTypes: ["game.build-test", "game.technical-qa", "game.pipeline-audit"], checkKeys: ["game_web_tests", "game_web_browser_proof"] }),
    contentProduction({ workTypes: ["content", "marketing"], checkKeys: ["game_web_tests"] }),
    ownerAcceptance({ workTypes: ["game.visual-acceptance", "game.product-acceptance", "game.release-readiness"], artifactKeys: ["visual_asset", "test_report"], checkKeys: ["game_web_browser_proof"] })
  );

  const packages = [software, oneC, gameWeb, unity];
  return {
    packages,
    bundles: [],
    aliases: [{ key: "example.web-app", target: "software.web-application", deprecated: true, remove_after: "0.6.x" }],
    statuses: { "software.web-application": "support-grade", "one-c.development": "support-grade", "game.web": "preview", "game.unity": "preview" }
  };
}
