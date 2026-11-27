use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::ErrorKind,
    path::Path,
    process::Command,
};

const FACADE: &str = "zodchi-flow";
const ENGINE: &str = "zodchi-flow-engine";

fn package_name(package: &Value) -> &str {
    package["name"].as_str().expect("package name")
}

fn flow_dependencies(package: &Value) -> impl Iterator<Item = &Value> {
    // Manifest dependencies include all targets and dependency kinds.
    package["dependencies"]
        .as_array()
        .expect("package dependencies")
        .iter()
        .filter(|dependency| package_name(dependency).starts_with(FACADE))
}

#[test]
fn workflow_crates_depend_on_the_engine_without_siblings() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let output = match Command::new("cargo")
        .args(["metadata", "--locked", "--format-version", "1", "--manifest-path"])
        .arg(manifest)
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            eprintln!("Skipping workflow dependency graph check because cargo is not on PATH");
            return;
        }
        Err(error) => panic!("Cannot run cargo metadata: {error}"),
    };
    assert!(
        output.status.success(),
        "cargo metadata failed with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );

    let metadata: Value = serde_json::from_slice(&output.stdout).expect("cargo metadata JSON");
    let members: BTreeSet<_> = metadata["workspace_members"]
        .as_array()
        .expect("workspace members")
        .iter()
        .map(|id| id.as_str().expect("workspace member id"))
        .collect();
    let packages: BTreeMap<_, _> = metadata["packages"]
        .as_array()
        .expect("metadata packages")
        .iter()
        .filter(|package| members.contains(package["id"].as_str().expect("package id")))
        .map(|package| (package_name(package), package))
        .collect();

    let engine_dependencies: Vec<_> = flow_dependencies(packages[ENGINE]).map(package_name).collect();
    assert!(
        engine_dependencies.is_empty(),
        "{ENGINE} depends on flow crates: {engine_dependencies:?}",
    );

    let workflows: BTreeSet<_> = packages
        .keys()
        .copied()
        .filter(|&name| name.starts_with("zodchi-flow-") && name != ENGINE)
        .collect();
    assert_eq!(workflows.len(), 15, "expected 15 workflow crates: {workflows:?}");
    for &workflow in &workflows {
        let mut has_engine = false;
        for dependency in flow_dependencies(packages[workflow]) {
            assert_eq!(
                package_name(dependency),
                ENGINE,
                "{workflow} has a forbidden flow dependency: {dependency}",
            );
            has_engine |= dependency["kind"].is_null();
        }
        assert!(has_engine, "{workflow} needs a normal dependency on {ENGINE}");
    }

    let mut expected = workflows;
    expected.insert(ENGINE);
    let facade_dependencies: BTreeSet<_> = flow_dependencies(packages[FACADE])
        .filter(|dependency| dependency["kind"].is_null())
        .map(package_name)
        .collect();
    assert_eq!(facade_dependencies, expected, "{FACADE} workflow dependencies");
}
