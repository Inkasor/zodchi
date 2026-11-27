use super::{require_workflow, Entry, Launch};
use crate::Exit;
use serde_json::Value;
use zodchi_core::util::Result;
use zodchi_flow_branch_review as workflow;

pub(super) const ENTRY: Entry = Entry {
    project_handoff: Some(workflow::project_handoff),
    ..Entry::new(workflow::NAME, "2", start, workflow::resume)
};

pub fn start(args: &Value, launch: Option<Launch>) -> Result<Exit> {
    workflow::start(args, launch, require_workflow)
}
