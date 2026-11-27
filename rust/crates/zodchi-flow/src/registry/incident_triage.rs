#[path = "../incident_triage.rs"]
mod incident_triage;

use super::{require_workflow, Entry};

pub(super) const ENTRY: Entry = Entry::new(
    incident_triage::NAME,
    "1",
    |args, launch| incident_triage::start(args, launch, require_workflow),
    incident_triage::resume,
);
