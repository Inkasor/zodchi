#[path = "../research.rs"]
mod research;

use super::{require_workflow, Entry, ReplyPolicy};

pub(super) const ENTRY: Entry = Entry {
    reply_policy: ReplyPolicy {
        read_text: Some(research::reply_text),
        ..ReplyPolicy::TEXT
    },
    ..Entry::new(
        research::NAME,
        "1",
        |args, launch| research::start(args, launch, require_workflow),
        research::resume,
    )
};
