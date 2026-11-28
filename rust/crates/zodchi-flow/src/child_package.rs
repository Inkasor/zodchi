//! Facade entry points for a parent's code-package child.

use crate::{boundary::{Exit, WORKFLOW}, code_package, control};
use serde_json::Value;
use zodchi_core::util::Result;

pub(crate) fn start(args: &Value, id: &str) -> Result<Exit> {
    code_package::start_child(args, id, crate::require_workflow)
}

pub(crate) fn resume(id: &str, args: &Value) -> Result<Exit> {
    control::resume(WORKFLOW, id, Some(args), None, false)
}
