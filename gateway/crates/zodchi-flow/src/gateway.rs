//! Model calls of a run through the local gateway (zodchi-core): a role, the pinned model and effort, the output
//! schema of this workflow version, and a key per step. The same key with the same stored request is always the same
//! job, so a resumed run polls the job it submitted and never submits it again.

use serde_json::{json, Value};
use std::time::Duration;
use zodchi_core::config::Config;
use zodchi_core::job::{self, is_terminal, Request};
use zodchi_core::role::{check_role, load_role, Overrides};
use zodchi_core::util::Result;

use crate::models::Pick;

/// The role as the job gets it: the installed role, with the pinned model and effort and the schema of this version.
pub fn role(cfg: &Config, name: &str, pick: &Pick, schema: &Value) -> Result<Value> {
    let mut role = load_role(cfg, name, &Overrides { model: Some(pick.model.clone()), effort: Some(pick.effort.clone()), ..Default::default() })?;
    role["outputSchema"] = schema.clone();
    check_role(&role)
}

pub fn request(key: &str, role: &Value, prompt: &str) -> Request {
    Request {
        key: key.to_string(),
        role: role.clone(),
        prompt: prompt.to_string(),
        images: vec![],
        credits: false,
        paid: false,
        resume: None,
        keep_thread: None,
        fingerprint: None,
    }
}

/// A step label as a part of a gateway key: "review 2" -> "review-2", "fix 1.1" -> "fix-1.1".
pub fn slug(step: &str) -> String {
    step.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '-' }).collect()
}

/// The base key of a step's attempt: `flow-<run>-<step>`, with `-a<n>` from the second attempt on.
pub fn base_key(run: &str, step: &str, attempt: u32) -> String {
    let key = format!("flow-{run}-{}", slug(step));
    if attempt > 1 { format!("{key}-a{attempt}") } else { key }
}

/// Whether the job folder of a key holds a job.
pub fn exists(cfg: &Config, key: &str) -> bool {
    job::job_dir(cfg, key).map(|d| d.join("job.json").exists() || d.join("final.json").exists()).unwrap_or(false)
}

/// Waits in the foreground until the job is final; the job has its own time limit, so this ends.
pub fn wait_final(cfg: &Config, key: &str) -> Result<Value> {
    loop {
        let current = job::wait(cfg, key, Duration::from_secs(540))?;
        if is_terminal(current["status"].as_str().unwrap_or("")) {
            return Ok(current);
        }
    }
}

/// A job that failed before its model turn started: nothing was asked, a new key may ask again. Any other end
/// (succeeded, unknown, a timeout, a limit, a sign-in) is never asked again by itself.
pub fn died_before_turn(final_job: &Value) -> bool {
    final_job["status"] == json!("failed") && final_job.get("turnStartedAt").is_none_or(Value::is_null)
}

pub fn summary(final_job: &Value) -> Value {
    json!({ "key": final_job["key"], "status": final_job["status"], "error": final_job["error"], "account": final_job["account"] })
}
