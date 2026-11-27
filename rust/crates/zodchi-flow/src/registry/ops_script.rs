use super::{Entry, StatusHooks, NO_STATUS};
use crate::{boundary::Launch, child_package, code_package, Exit};
use serde_json::Value;
use zodchi_core::util::Result;
use zodchi_flow_ops_script as workflow;

const REPAIR: workflow::RepairHooks = workflow::RepairHooks {
    start: child_package::start,
    resume: |id, args| code_package::resume(id, Some(args), None),
};

pub(super) const ENTRY: Entry = Entry {
    status: StatusHooks {
        check_result: Some(workflow::project_status_result),
        ..NO_STATUS
    },
    finished_approved: Some(|result| result["ready"] == true),
    worker_error: Some("ops-script worker failed; inspect the run locally"),
    ..Entry::new(workflow::NAME, "1", start, resume)
};

fn start(args: &Value, launch: Option<Launch>) -> Result<Exit> {
    workflow::start(args, launch, &REPAIR)
}

fn resume(id: &str, given: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    workflow::resume(id, given, rerun, &REPAIR)
}
