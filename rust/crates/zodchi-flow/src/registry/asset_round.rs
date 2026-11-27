use super::{require_workflow, rubric_probe_entry, unity_check_entry, Entry, Launch};
use crate::{boundary, child_package, control, Exit};
use serde_json::Value;
use zodchi_core::util::Result;
use zodchi_flow_asset_round as workflow;

use workflow::{ChildWorkflow, Children};

const CHILDREN: Children = Children {
    package: ChildWorkflow {
        name: boundary::WORKFLOW,
        start: child_package::start,
        resume: child_package::resume,
    },
    unity: ChildWorkflow {
        name: unity_check_entry::NAME,
        start: |args, id| unity_check_entry::start_child(args, id, require_workflow),
        resume: |id, args| control::resume(unity_check_entry::NAME, id, Some(args), None, false),
    },
    rubric: ChildWorkflow {
        name: rubric_probe_entry::NAME,
        start: |args, id| rubric_probe_entry::start_child(args, id, require_workflow),
        resume: |id, args| control::resume(rubric_probe_entry::NAME, id, Some(args), None, false),
    },
};

pub(super) const ENTRY: Entry = Entry {
    allows_paid_worker: true,
    ..Entry::new(workflow::NAME, "1", start, resume)
};

pub fn start(args: &Value, launch: Option<Launch>) -> Result<Exit> {
    workflow::start(args, launch, require_workflow, &CHILDREN)
}

pub fn resume(id: &str, given: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    workflow::resume(id, given, rerun, &CHILDREN)
}
