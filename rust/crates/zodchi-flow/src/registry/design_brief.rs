#[path = "../design_brief.rs"]
pub(crate) mod design_brief;

use super::{require_workflow, Entry, ReplyPolicy};

pub(super) const ENTRY: Entry = Entry {
    reply_policy: ReplyPolicy {
        decision_flags: true,
        ..ReplyPolicy::TEXT
    },
    ..Entry::new(
        design_brief::NAME,
        "2",
        |args, launch| design_brief::start(args, launch, require_workflow),
        design_brief::resume,
    )
};
