#[path = "../rubric_probe.rs"]
mod rubric_probe;

pub(super) use rubric_probe::{start_child, NAME};

use super::{require_workflow, Entry};

pub(super) const ENTRY: Entry = Entry {
    allows_paid_worker: true,
    ..Entry::new(
        rubric_probe::NAME,
        "1",
        |args, launch| rubric_probe::start(args, launch, require_workflow),
        rubric_probe::resume,
    )
};
