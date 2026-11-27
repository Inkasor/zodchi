use super::{require_workflow, Entry, Launch};
use crate::Exit;
use serde_json::Value;
use zodchi_core::util::Result;
use zodchi_flow_incident_triage as workflow;

pub(super) const ENTRY: Entry = Entry::new(
    workflow::NAME,
    "1",
    start,
    workflow::resume,
);

pub fn start(args: &Value, launch: Option<Launch>) -> Result<Exit> {
    workflow::start(args, launch, require_workflow)
}
