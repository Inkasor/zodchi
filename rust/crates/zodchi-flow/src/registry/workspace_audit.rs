#[path = "../workspace_audit.rs"]
mod workspace_audit;

use super::Entry;

pub(super) const ENTRY: Entry = Entry {
    waiting_decision: Some(|last| last["step"] == "owner decisions"),
    ..Entry::new(
        workspace_audit::NAME,
        "1",
        workspace_audit::start,
        workspace_audit::resume,
    )
};
