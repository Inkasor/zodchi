use super::Entry;
use zodchi_flow_workspace_audit as workflow;

pub(super) const ENTRY: Entry = Entry {
    waiting_decision: Some(|last| last["step"] == "owner decisions"),
    ..Entry::new(workflow::NAME, "1", workflow::start, workflow::resume)
};
