use super::{Entry, StatusHooks, NO_STATUS};
use crate::{boundary::Launch, child_package, code_package, Exit};
#[cfg(test)]
use crate::ops_script as workflow;
use serde_json::Value;
use zodchi_core::util::Result;
#[cfg(not(test))]
use zodchi_flow_ops_script as workflow;

pub(crate) const REPAIR: workflow::RepairHooks = workflow::RepairHooks {
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

pub fn start(args: &Value, launch: Option<Launch>) -> Result<Exit> {
    workflow::start(args, launch, &REPAIR)
}

pub fn resume(id: &str, given: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    workflow::resume(id, given, rerun, &REPAIR)
}

#[cfg(test)]
macro_rules! ops_script_tests {
    ($tests:item) => {
        fn resume_guarded(
            id: &str,
            given: Option<&serde_json::Value>,
            retry: Option<&str>,
            cfg: &zodchi_core::config::Config,
            guard: impl FnOnce() -> std::result::Result<(), String>,
        ) -> zodchi_core::util::Result<$crate::Exit> {
            resume_guarded_with_repair(
                id,
                given,
                retry,
                cfg,
                guard,
                &$crate::registry::ops_script_entry::REPAIR,
            )
        }

        $tests
    };
}

#[cfg(test)]
pub(crate) use ops_script_tests;
