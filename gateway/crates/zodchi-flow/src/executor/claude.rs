//! A stub: Claude as an executor of a model step. A later package fills it.

use serde_json::Value;
use zodchi_core::config::Config;
use zodchi_core::util::{fail, Result};

use super::Executor;
use crate::models::Pick;

const NOT_HERE: &str = "the claude executor is not in this version";

pub struct Claude {
    #[allow(dead_code)]
    cfg: Config,
}

impl Claude {
    pub fn new(cfg: Config) -> Claude {
        Claude { cfg }
    }
}

impl Executor for Claude {
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
        "claude"
    }
}
