#[path = "../code_package.rs"]
pub mod code_package;

use super::{Entry, Launch, ShutdownClaim, ShutdownHooks, StatusHooks, NO_STATUS};
use crate::{gateway, Exit};
use serde_json::Value;
use zodchi_core::util::Result;

pub(super) const ENTRY: Entry = Entry {
    dry_run: Some(code_package::dry_run),
    status: StatusHooks {
        details: Some(credits),
        ..NO_STATUS
    },
    handle_reply: Some(code_package::handle_reply),
    remark: Some(code_package::queue_remark),
    allows_budget_extension: true,
    shutdown: Some(ShutdownHooks {
        pin_claim: |run, id| ShutdownClaim::for_shutdown(run, id),
        findings: code_package::recorded_findings,
        unknown_files: code_package::unknown_shutdown_files,
        candidate: code_package::shutdown_candidate,
    }),
    ..Entry::new(
        code_package::WORKFLOW,
        code_package::VERSION,
        start,
        code_package::resume,
    )
};

fn start(args: &Value, launch: Option<Launch>) -> Result<Exit> {
    if launch.is_some() {
        code_package::start_detached(args)
    } else {
        code_package::start(args)
    }
}

fn credits(_: &Value, events: &[Value], result: &mut Value) {
    if let Some(credits) = gateway::credits_report(events, None) {
        result["credits"] = credits;
    }
}
