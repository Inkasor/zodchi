//! Workflow result and process contracts shared by the engine and facade.

use crate::journal::Journal;
use serde_json::{json, Value};
use std::ffi::OsString;
use zodchi_core::{job::spawn_flow_worker, process::process_start, util::Result};

pub const WORKFLOW: &str = "code-package";
pub const WRITER_GATEWAY_ROLE: &str = "flow-patch";
pub const REVIEWER_GATEWAY_ROLE: &str = "code-review";

/// The process exit code of a cut made on purpose (`ZODCHI_FLOW_CUT`), as a crash would leave the run.
pub const CUT_EXIT: i32 = 75;

pub struct Exit {
    pub result: Value,
    pub code: u8,
}

/// A cut on purpose, for recovery tests: `ZODCHI_FLOW_CUT=<point>` exits without running destructors.
pub(crate) fn cut(point: &str) {
    if std::env::var("ZODCHI_FLOW_CUT").ok().as_deref() == Some(point) {
        eprintln!("zodchi flow: cut after {point} (ZODCHI_FLOW_CUT)");
        std::process::exit(CUT_EXIT);
    }
}

pub(crate) type Launch = fn(&Journal, &str) -> Result<Exit>;

pub(crate) fn launch(
    journal: &Journal,
    id: &str,
    rerun: Option<&str>,
    allows_paid: impl FnOnce(&Value) -> bool,
    active_status: impl FnOnce(&str) -> Result<Exit>,
) -> Result<Exit> {
    if journal.active() {
        return active_status(id);
    }
    let mut args: Vec<OsString> = ["flow", "_worker", id].into_iter().map(OsString::from).collect();
    if let Some(step) = rerun {
        args.push(step.into());
    }
    let keep_api_key = journal.read_value("run.json").is_some_and(|run|
        allows_paid(&run) && run["policy"]["paid"] == true);
    match spawn_flow_worker(&args, keep_api_key) {
        Ok(child) => {
            let pid = child.id();
            let mut receipt = json!({ "runId": id, "status": "submitted", "pid": pid });
            if let Err(error) = journal.write_value("worker.json", &json!({
                "pid": pid, "start": process_start(pid),
                "executable": std::env::current_exe().ok().map(|path| path.display().to_string()),
            })) {
                receipt["note"] = json!(format!("Worker started; its process receipt could not be stored: {}", error.0));
            }
            Ok(Exit { result: receipt, code: 0 })
        }
        Err(error) => {
            let result = json!({
                "runId": id, "status": "stopped", "stoppedAt": "start worker", "infra": error.0,
                "next": "Resume this run to start its worker."
            });
            journal.write_value("worker-result.json", &result)?;
            Ok(Exit { result, code: 2 })
        }
    }
}
