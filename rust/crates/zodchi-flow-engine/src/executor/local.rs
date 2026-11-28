//! Model calls of a run through the local gateway (zodchi-core): a role, the pinned model and effort, the output
//! schema of this workflow version, and a key per step. The same key with the same stored request is always the same
//! job, so a resumed run polls the job it submitted and never submits it again.

use serde_json::{json, Value};
use std::{fs::File, io::Read, path::Path, time::Duration};
use zodchi_core::config::Config;
use zodchi_core::job::{self, is_terminal, Request};
use zodchi_core::role::{check_role, load_role, Overrides};
use zodchi_core::util::{fail, sha256_hex, GatewayError, Result};

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

pub fn pinned_image(file: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(file)?.take((job::LIMIT_IMAGE_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > job::LIMIT_IMAGE_BYTES
        || zodchi_core::appserver::image_type(&bytes).is_none()
    {
        return fail("A frame must be PNG, JPEG or WebP, up to 20 MB.");
    }
    Ok(bytes)
}

fn request(key: &str, stored: &Value) -> Result<Request> {
    let images = if let Some(image) = stored.get("decisionsImage") {
        let file = image["file"].as_str().map(Path::new)
            .ok_or_else(|| GatewayError("The Decisions request has no pinned frame.".into()))?;
        let bytes = pinned_image(file)?;
        if image["sha256"] != sha256_hex(&bytes) {
            return fail("The pinned Decisions frame has changed.");
        }
        vec![bytes]
    } else {
        Vec::new()
    };
    Ok(Request {
        key: key.to_string(),
        role: stored["role"].clone(),
        prompt: stored["prompt"].as_str().unwrap_or("").to_string(),
        paid: !images.is_empty(),
        images,
        credits: stored["credits"] == json!(true),
        resume: stored["resume"].as_str().map(String::from),
        keep_thread: stored["keepThread"].as_bool(),
        fingerprint: None,
    })
}

impl Executor for LocalGateway {
    /// The role as the job gets it: the installed role, with the pinned model and effort and the schema of this version.
    fn role(&self, name: &str, pick: &Pick, schema: &Value) -> Result<Value> {
        let mut role = load_role(&self.cfg, name, &Overrides { model: Some(pick.model.clone()), effort: Some(pick.effort.clone()), ..Default::default() })?;
        if name == crate::agent::ROLE {
            crate::agent::check_writer_role(&role)?;
        }
        if name == "research" && (role["mode"] != "work" || role["sandbox"] != "read-only" || role["mcpServers"] != json!([])) {
            return zodchi_core::util::fail("The Flow research role needs read-only access and an empty MCP server list.");
        }
        if name == "method-synthesis" && role["mode"] != "expert" {
            return zodchi_core::util::fail("The method-synthesis role must run as an expert.");
        }
        role["outputSchema"] = schema.clone();
        check_role(&role)
    }

    fn submit(&self, key: &str, stored: &Value) -> Result<bool> {
        let req = request(key, stored)?;
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
        fin["status"] == "failed" && fin["turnRequestedAt"].is_null() && fin["turnStartedAt"].is_null()
    }

    fn name(&self) -> &'static str {
        "local-gateway"
    }
}
