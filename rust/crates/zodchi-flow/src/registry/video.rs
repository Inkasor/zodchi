use super::{Entry, ReplyPolicy, StatusHooks, NO_STATUS};
use crate::{video_media, Exit};
use std::path::Path;
use zodchi_core::util::Result;
use zodchi_flow_video as workflow;

pub(super) const ENTRY: Entry = Entry {
    special: Some(special),
    status: StatusHooks {
        details: Some(workflow::project_status),
        ..NO_STATUS
    },
    reply_policy: ReplyPolicy {
        media_decision: Some(workflow::record_reply),
        ..ReplyPolicy::TEXT
    },
    ..Entry::new(
        workflow::NAME,
        workflow::VERSION,
        workflow::start,
        workflow::resume,
    )
};

fn special(args: &[String]) -> Option<Result<Exit>> {
    match args {
        [command, flag, file] if command == "research" && flag == "--args" => Some(
            video_media::read_json(Path::new(file)).and_then(|args| workflow::capture(&args)),
        ),
        [command, id, flag, file]
            if ["publish", "stats"].contains(&command.as_str()) && flag == "--file" =>
        {
            Some(video_media::read_json(Path::new(file)).and_then(|payload| {
                if command == "publish" {
                    workflow::record_publication(id, &payload)
                } else {
                    workflow::record_stats(id, &payload)
                }
            }))
        }
        _ => None,
    }
}
