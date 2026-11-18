//! A stub: model steps through a flow server. A later package fills it.

use serde_json::Value;
use zodchi_core::config::Config;
use zodchi_core::util::{fail, Result};

use super::Executor;
use crate::models::Pick;

const NOT_HERE: &str = "the server executor is not in this version";

pub struct Server {
    #[allow(dead_code)]
    cfg: Config,
    #[allow(dead_code)]
    server: String,
}

impl Server {
    pub fn new(cfg: Config, server: String) -> Server {
        Server { cfg, server }
    }
}

impl Executor for Server {
    fn role(&self, _name: &str, _pick: &Pick, _schema: &Value) -> Result<Value> {
        fail(NOT_HERE)
    }
    fn submit(&self, _key: &str, _stored: &Value) -> Result<bool> {
        fail(NOT_HERE)
    }
    fn exists(&self, _key: &str) -> bool {
        false
    }
    fn wait_final(&self, _key: &str) -> Result<Value> {
        fail(NOT_HERE)
    }
    fn died_before_turn(&self, _fin: &Value) -> bool {
        false
    }
    fn name(&self) -> &'static str {
        "server"
    }
}
