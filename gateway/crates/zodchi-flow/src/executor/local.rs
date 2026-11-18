//! Model calls of a run through the local gateway (zodchi-core): a role, the pinned model and effort, the output
//! schema of this workflow version, and a key per step. The same key with the same stored request is always the same
//! job, so a resumed run polls the job it submitted and never submits it again.

use serde_json::{json, Value};
use std::time::Duration;
use zodchi_core::config::Config;
use zodchi_core::job::{self, is_terminal, Request};
use zodchi_core::role::{check_role, load_role, Overrides};
use zodchi_core::util::Result;

use super::Executor;
use crate::models::Pick;

pub struct LocalGateway {
    cfg: Config,
}

impl LocalGateway {
    pub fn new(cfg: Config) -> LocalGateway {
        LocalGateway { cfg }
    }
}

fn request(key: &str, role: &Value, prompt: &str) -> Request {
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

impl Executor for LocalGateway {
    /// The role as the job gets it: the installed role, with the pinned model and effort and the schema of this version.
    fn role(&self, name: &str, pick: &Pick, schema: &Value) -> Result<Value> {
        let mut role = load_role(&self.cfg, name, &Overrides { model: Some(pick.model.clone()), effort: Some(pick.effort.clone()), ..Default::default() })?;
        role["outputSchema"] = schema.clone();
        check_role(&role)
    }

    fn submit(&self, key: &str, stored: &Value) -> Result<bool> {
        let req = request(key, &stored["role"], stored["prompt"].as_str().unwrap_or(""));
        let (_, created) = job::submit(&self.cfg, &req, true)?;
        Ok(created)
    }

    /// Whether the job folder of a key holds a job.
    fn exists(&self, key: &str) -> bool {
        job::job_dir(&self.cfg, key).map(|d| d.join("job.json").exists() || d.join("final.json").exists()).unwrap_or(false)
    }

    /// Waits in the foreground until the job is final; the job has its own time limit, so this ends.
    fn wait_final(&self, key: &str) -> Result<Value> {
        loop {
            let current = job::wait(&self.cfg, key, Duration::from_secs(540))?;
            if is_terminal(current["status"].as_str().unwrap_or("")) {
                return Ok(current);
            }
        }
    }

    /// A job that failed before its model turn started: nothing was asked, a new key may ask again. Any other end
    /// (succeeded, unknown, a timeout, a limit, a sign-in) is never asked again by itself.
    fn died_before_turn(&self, fin: &Value) -> bool {
        fin["status"] == json!("failed") && fin.get("turnStartedAt").is_none_or(Value::is_null)
    }

    fn name(&self) -> &'static str {
        "local-gateway"
    }
}
