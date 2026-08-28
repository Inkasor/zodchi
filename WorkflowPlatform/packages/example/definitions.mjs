// The example this repository ships with. It exists so the package format, the builders and the
// generator can be built, validated and tested without any real project, and so a new installation
// has something complete to read before writing its own definitions.
//
// Point `packageDefinitions` in the runtime configuration at your own file to replace it. That file
// exports the same default function and receives the same builder module, so it needs no import path.
export default function definePackages(b) {
  const { checkBinding, capabilityCheck, completeSoftwareChecks, companyWebPackage, composedPackage, coreLifecycle, domainAdapter, externalRuntime, releaseCapability, sourceChange } = b;

  const checks = completeSoftwareChecks([
    capabilityCheck("example_lint", "Example lint", "node.package_manager", ["run", "lint"], [checkBinding("prototype", null)], 900),
    capabilityCheck("example_tests", "Example tests", "node.package_manager", ["test"], [checkBinding("mvp", "code")], 1800),
    capabilityCheck("example_build", "Example production build", "node.package_manager", ["run", "build"], [checkBinding("production", "release_package")], 1800)
  ], "example_lint", "example");

  const example = companyWebPackage({
    key: "example.web-app",
    version: "3.0.0",
    purpose: "Example company web workflow: bounded change, reversible data change, verified release, incident, access, security review and traceable content.",
    checks,
    content: true,
    codeChecks: ["example_tests", "example_build"],
    dataChecks: ["example_tests", "example_build"],
    releaseChecks: checks.map(item => item.key),
    documents: [
      { key: "repo_rules", path: "AGENTS.md", type: "authority", authority: "example" },
      { key: "readme", path: "README.md", type: "authority", authority: "example" },
      { key: "package", path: "package.json", type: "reference", authority: "example" }
    ]
  });
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
  const packages = [example, oneC];
  return { packages, bundles: [] };
}
