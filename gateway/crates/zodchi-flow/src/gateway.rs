//! Names of a step's job: the key and its slug, and the short summary of a final job for the journal. The calls
//! themselves are in `executor`.

use serde_json::{json, Value};

/// A step label as a part of a gateway key: "review 2" -> "review-2", "fix 1.1" -> "fix-1.1".
pub fn slug(step: &str) -> String {
    step.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '-' }).collect()
}

/// The base key of a step's attempt: `flow-<run>-<step>`, with `-a<n>` from the second attempt on.
pub fn base_key(run: &str, step: &str, attempt: u32) -> String {
    let key = format!("flow-{run}-{}", slug(step));
    if attempt > 1 { format!("{key}-a{attempt}") } else { key }
}

pub fn summary(final_job: &Value) -> Value {
    json!({ "key": final_job["key"], "status": final_job["status"], "error": final_job["error"], "account": final_job["account"] })
}
