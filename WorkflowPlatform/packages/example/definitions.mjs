// The example this repository ships with. It exists so the package format, the builders and the
// generator can be built, validated and tested without any real project, and so a new installation
// has something complete to read before writing its own definitions.
//
// Point `packageDefinitions` in the runtime configuration at your own file to replace it. That file
// exports the same default function and receives the same builder module, so it needs no import path.
export default function definePackages(b) {
  const { checkBinding, capabilityCheck, completeSoftwareChecks, companyWebPackage } = b;

  const checks = completeSoftwareChecks([
    capabilityCheck("example_lint", "Example lint", "node.package_manager", ["run", "lint"], [checkBinding("prototype", null)], 900),
    capabilityCheck("example_tests", "Example tests", "node.package_manager", ["test"], [checkBinding("mvp", "code")], 1800),
    capabilityCheck("example_build", "Example production build", "node.package_manager", ["run", "build"], [checkBinding("production", "release_package")], 1800)
  ], "example_lint", "example");

  const packages = [companyWebPackage({
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
  })];
  return { packages, bundles: [] };
}
