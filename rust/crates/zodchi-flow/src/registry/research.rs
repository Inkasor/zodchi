use super::{require_workflow, Entry, Launch, ReplyPolicy};
use crate::Exit;
use serde_json::Value;
use zodchi_core::util::Result;
use zodchi_flow_research as workflow;

pub(super) const ENTRY: Entry = Entry {
    reply_policy: ReplyPolicy {
        read_text: Some(workflow::reply_text),
        ..ReplyPolicy::TEXT
    },
    ..Entry::new(workflow::NAME, "1", start, workflow::resume)
};

pub fn start(args: &Value, launch: Option<Launch>) -> Result<Exit> {
    workflow::start(args, launch, require_workflow)
}
