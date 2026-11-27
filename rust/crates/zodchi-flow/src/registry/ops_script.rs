#[cfg(not(test))]
#[path = "../ops_script.rs"]
mod ops_script;

#[cfg(test)]
use crate::ops_script;

use super::{Entry, StatusHooks, NO_STATUS};

pub(super) const ENTRY: Entry = Entry {
    status: StatusHooks {
        check_result: Some(ops_script::project_status_result),
        ..NO_STATUS
    },
    finished_approved: Some(|result| result["ready"] == true),
    worker_error: Some("ops-script worker failed; inspect the run locally"),
    ..Entry::new(ops_script::NAME, "1", ops_script::start, ops_script::resume)
};
