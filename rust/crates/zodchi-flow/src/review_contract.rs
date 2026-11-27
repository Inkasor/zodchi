//! Review contract for workflows that use the shared review format.

use serde_json::Value;

pub(crate) const REVIEW_SCHEMA: &str = include_str!("../flows/shared-review.schema.json");

/// A review answer by the schema: a verdict and findings with their fields.
pub(crate) fn check_review(v: &Value) -> std::result::Result<(), String> {
    if !["approved", "changes_requested", "blocked"].contains(&v["verdict"].as_str().unwrap_or("")) {
        return Err("verdict is approved, changes_requested or blocked".into());
    }
    let Some(list) = v["findings"].as_array() else { return Err("findings is a list".into()) };
    for f in list {
        for k in ["id", "severity", "location", "problem"] {
            if !f[k].is_string() {
                return Err(format!("a finding has no {k}"));
            }
        }
    }
    Ok(())
}

pub(crate) fn blocking_findings(review: &Value) -> impl Iterator<Item = &Value> {
    review["findings"].as_array().into_iter().flatten().filter(|finding|
        !matches!(finding["severity"].as_str(), Some("nit" | "pre-existing")))
}
