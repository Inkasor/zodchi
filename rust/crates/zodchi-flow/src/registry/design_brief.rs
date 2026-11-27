use super::{require_workflow, Entry, ReplyPolicy};
use zodchi_flow_design_brief as workflow;

pub(super) const ENTRY: Entry = Entry {
    reply_policy: ReplyPolicy {
        decision_flags: true,
        ..ReplyPolicy::TEXT
    },
    ..Entry::new(
        workflow::NAME,
        "2",
        |args, launch| workflow::start(args, launch, require_workflow),
        workflow::resume,
    )
};
