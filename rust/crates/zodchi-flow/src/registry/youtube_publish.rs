#[path = "../youtube_publish/mod.rs"]
mod youtube_publish;

use super::{Entry, ReplyPolicy, StatusHooks, NO_STATUS};
use crate::{video_media, Exit};
use std::path::Path;
use zodchi_core::util::Result;

pub(super) const ENTRY: Entry = Entry {
    special: Some(special),
    requests_consent: Some(requests_consent),
    status: StatusHooks {
        details: Some(youtube_publish::project_status),
        ..NO_STATUS
    },
    handoff_from_run: Some(youtube_publish::handoff),
    finished_approved: Some(|result| result["verdict"] == "private_verified"),
    reply_policy: ReplyPolicy {
        media_decision: Some(youtube_publish::record_reply),
        waiting_only_error: Some(youtube_publish::REPLY_WAITING_ONLY),
        ..ReplyPolicy::TEXT
    },
    ..Entry::new(
        youtube_publish::NAME,
        "1",
        |args, _| youtube_publish::start(args),
        youtube_publish::resume,
    )
};

fn requests_consent(args: &[String]) -> bool {
    matches!(args, [command, flag, _] if command == "connect" && flag == "--args")
}

fn special(args: &[String]) -> Option<Result<Exit>> {
    match args {
        [_, _, file] if requests_consent(args) => Some(
            video_media::read_json(Path::new(file))
                .and_then(|args| youtube_publish::connect(&args)),
        ),
        [command, flag, profile] if command == "whoami" && flag == "--profile" => {
            Some(youtube_publish::whoami(profile))
        }
        _ => None,
    }
}
