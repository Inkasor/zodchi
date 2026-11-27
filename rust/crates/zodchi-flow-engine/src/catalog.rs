use crate::git::Git;
use serde_json::Value;
use std::path::Path;
use zodchi_core::util::{fail, GatewayError, Result};

pub const PROJECT: &str = ".zodchi/workflows.json";
pub const SHIPPED: &str = include_str!("../../../../workflows/catalog.json");

pub type ProjectGate = fn(&Git, &str, &str) -> Result<()>;

fn configured_domains(git: &Git, base: &str) -> Result<Option<Vec<String>>> {
    let Some(bytes) = git.show(base, PROJECT)? else {
        if git.exists_at(base, PROJECT)? {
            return fail(format!("{PROJECT} must be a regular file."));
        }
        return Ok(None);
    };
    let config: Value = serde_json::from_slice(&bytes)
        .map_err(|error| GatewayError(format!("{PROJECT}: {error}")))?;
    let domains = config["domains"]
        .as_array()
        .filter(|domains| {
            domains
                .iter()
                .all(|domain| domain.as_str().is_some_and(|text| !text.is_empty()))
        })
        .ok_or_else(|| GatewayError(format!("{PROJECT} needs a domains array of names.")))?;
    if config
        .as_object()
        .is_none_or(|fields| fields.keys().any(|key| key != "domains"))
    {
        return fail(format!("{PROJECT} accepts the domains field."));
    }
    Ok(Some(
        domains
            .iter()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect(),
    ))
}

fn enabled(domains: Option<&[String]>, domain: &str) -> bool {
    domain == "core" || domains.is_none_or(|names| names.iter().any(|name| name == domain))
}

pub fn project(root: &Path, compiled: impl FnOnce() -> Value) -> Result<Value> {
    let git = Git::new(root);
    let head = git.rev("HEAD^{commit}")?;
    let domains = configured_domains(&git, &head)?;
    let mut catalog = compiled();
    let entries = catalog["workflows"].as_array_mut().expect("workflows");
    entries.retain(|item| {
        enabled(
            domains.as_deref(),
            item["domain"].as_str().expect("workflow domain"),
        )
    });
    Ok(catalog)
}

pub fn require(git: &Git, base: &str, workflow: &str, catalog: &Value) -> Result<()> {
    let workflow_entry = catalog["workflows"]
        .as_array()
        .expect("workflows")
        .iter()
        .find(|item| item["name"] == workflow)
        .ok_or_else(|| GatewayError(format!("Workflow {workflow} is not installed.")))?;
    let domain = workflow_entry["domain"].as_str().expect("workflow domain");
    let domains = configured_domains(git, base)?;
    if !enabled(domains.as_deref(), domain) {
        return fail(format!(
            "Workflow {workflow} requires the {domain} domain in {PROJECT}."
        ));
    }
    Ok(())
}
