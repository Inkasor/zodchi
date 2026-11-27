#[path = "../unity_check.rs"]
mod unity_check;

pub(super) use unity_check::{start_child, NAME};

use super::{require_workflow, Entry};

pub(super) const ENTRY: Entry = Entry::new(
    unity_check::NAME,
    "1",
    |args, launch| unity_check::start(args, launch, require_workflow),
    unity_check::resume,
);
