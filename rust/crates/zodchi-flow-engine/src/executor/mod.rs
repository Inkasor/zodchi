//! Where a model step runs. `code_package` asks an `Executor`; the executor owns the role of the request, the
//! submission under a key, the lookup of a job by key, the wait for its final state and the reading of a death
//! before the model turn. The local gateway (zodchi-core, on this machine) is the executor of today; the server and
//! Claude executors are separate files that later packages fill.

pub mod claude;
pub mod local;
pub mod server;

use serde_json::Value;
use std::path::PathBuf;
use zodchi_core::config::Config;
use zodchi_core::util::Result;

use crate::models::Pick;

pub trait Executor {
    /// The role as the request carries it: the installed role, the pinned model and effort, the schema of this version.
    fn role(&self, name: &str, pick: &Pick, schema: &Value) -> Result<Value>;
    /// Submits the stored request (`{ "role", "prompt" }`) under `key`; true when the job was created now.
    fn submit(&self, key: &str, stored: &Value) -> Result<bool>;
    /// Whether the executor holds a job of this key.
    fn exists(&self, key: &str) -> bool;
    /// Waits in the foreground until the job of `key` is final; returns the final job.
    fn wait_final(&self, key: &str) -> Result<Value>;
    /// A job that failed before its model turn started: nothing was asked, a new key may ask again.
    fn died_before_turn(&self, fin: &Value) -> bool;
    /// The name recorded in the intent.
    fn name(&self) -> &'static str;
}

/// The optional `server` field of `~/.zodchi/flow.json` (`$ZODCHI_HOME` respected); an absent or unreadable file, or
/// an empty field, is "not configured".
pub fn flow_server(cfg: &Config) -> Option<String> {
    let file: PathBuf = cfg.home.join("flow.json");
    let text = std::fs::read_to_string(file).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("server").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Whether local Codex steps may spend ChatGPT credits when the subscription limit is used up: `"credits": true`
/// in `~/.zodchi/flow.json`. Off unless set. A flow server decides this for itself.
pub fn flow_credits(cfg: &Config) -> bool {
    let Ok(text) = std::fs::read_to_string(cfg.home.join("flow.json")) else { return false };
    serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("credits").and_then(Value::as_bool)).unwrap_or(false)
}

/// The executor of a pick: codex without a server is the local gateway, codex with one is the server, claude is Claude.
pub fn for_pick(cfg: &Config, pick: &Pick) -> std::result::Result<Box<dyn Executor>, String> {
    match pick.provider.as_str() {
        "codex" => match flow_server(cfg) {
            None => Ok(Box::new(local::LocalGateway::new(cfg.clone()))),
            Some(server) => Ok(Box::new(server::Server::new(cfg.clone(), server))),
        },
        "claude" => Ok(Box::new(claude::Claude::new(cfg.clone()))),
        other => Err(format!("No executor for the provider {other:?}")),
    }
}
