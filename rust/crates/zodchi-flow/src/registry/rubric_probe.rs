use super::{require_workflow, Entry, Launch};
use crate::Exit;
use serde_json::Value;
use zodchi_core::util::Result;
use zodchi_flow_rubric_probe as workflow;

pub(crate) use workflow::start_child;
pub(super) use workflow::NAME;

pub(super) const ENTRY: Entry = Entry {
    allows_paid_worker: true,
    ..Entry::new(NAME, "1", start, workflow::resume)
};

pub fn start(args: &Value, launch: Option<Launch>) -> Result<Exit> {
    workflow::start(args, launch, require_workflow)
}
