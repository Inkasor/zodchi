use super::{Entry, ReplyPolicy, StatusHooks, NO_STATUS};
use crate::{control::NO_CONSENT_TERMINAL, controlling_terminal, video_media, Exit};
use std::path::Path;
use zodchi_core::util::Result;
use zodchi_flow_youtube_publish as workflow;

pub(super) const ENTRY: Entry = Entry {
    special: Some(special),
    requests_consent: Some(requests_consent),
    status: StatusHooks {
        details: Some(workflow::project_status),
        ..NO_STATUS
    },
    handoff_from_run: Some(workflow::handoff),
    finished_approved: Some(|result| result["verdict"] == "private_verified"),
    reply_policy: ReplyPolicy {
        media_decision: Some(workflow::record_reply),
        waiting_only_error: Some(workflow::REPLY_WAITING_ONLY),
        ..ReplyPolicy::TEXT
    },
    ..Entry::new(
        workflow::NAME,
        "1",
        |args, _| workflow::start(args),
        workflow::resume,
    )
};

fn requests_consent(args: &[String]) -> bool {
    matches!(args, [command, flag, _] if command == "connect" && flag == "--args")
}

fn special(args: &[String]) -> Option<Result<Exit>> {
    match args {
        [_, _, file] if requests_consent(args) => Some(
            video_media::read_json(Path::new(file)).and_then(|args| {
                workflow::connect(&args, controlling_terminal, NO_CONSENT_TERMINAL)
            }),
        ),
        [command, flag, profile] if command == "whoami" && flag == "--profile" => {
            Some(workflow::whoami(profile))
        }
        _ => None,
    }
}
