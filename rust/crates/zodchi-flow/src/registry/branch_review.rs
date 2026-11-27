#[path = "../branch_review.rs"]
mod branch_review;

use super::{require_workflow, Entry};

pub(super) const ENTRY: Entry = Entry {
    project_handoff: Some(branch_review::project_handoff),
    ..Entry::new(
        branch_review::NAME,
        "2",
        |args, launch| branch_review::start(args, launch, require_workflow),
        branch_review::resume,
    )
};
