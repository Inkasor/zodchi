#[path = "../video.rs"]
mod video;

use super::{Entry, ReplyPolicy, StatusHooks, NO_STATUS};
use crate::{accepted_media, video_media, video_research, Exit};
use std::path::Path;
use zodchi_core::util::Result;

pub(super) const ENTRY: Entry = Entry {
    special: Some(special),
    status: StatusHooks {
        details: Some(video::project_status),
        ..NO_STATUS
    },
    reply_policy: ReplyPolicy {
        media_decision: Some(video::record_reply),
        ..ReplyPolicy::TEXT
    },
    ..Entry::new(
        video::NAME,
        accepted_media::VERSION,
        video::start,
        video::resume,
    )
};

fn special(args: &[String]) -> Option<Result<Exit>> {
    match args {
        [command, flag, file] if command == "research" && flag == "--args" => Some(
            video_media::read_json(Path::new(file)).and_then(|args| video_research::capture(&args)),
        ),
        [command, id, flag, file]
            if ["publish", "stats"].contains(&command.as_str()) && flag == "--file" =>
        {
            Some(video_media::read_json(Path::new(file)).and_then(|payload| {
                if command == "publish" {
                    video::record_publication(id, &payload)
                } else {
                    video::record_stats(id, &payload)
                }
            }))
        }
        _ => None,
    }
}
