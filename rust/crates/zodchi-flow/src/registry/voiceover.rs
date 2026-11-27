use super::{Entry, SignIn, StatusHooks, NO_STATUS};
use std::path::Path;
use zodchi_core::util::Result;
use zodchi_flow_engine::{video_media, Exit};
use zodchi_flow_voiceover as workflow;

pub(super) const ENTRY: Entry = Entry {
    special: Some(special),
    status: StatusHooks {
        stop_details: Some(workflow::project_stop_status),
        ..NO_STATUS
    },
    finished_approved: Some(|result| result["status"] == "rendered"),
    allows_paid_worker: true,
    stop_sign_in: Some(|result| (result["errorKind"] == "auth_required").then_some(SignIn::ApiKey)),
    ..Entry::new(workflow::NAME, "1", workflow::start, |id, _, rerun| {
        workflow::resume(id, rerun)
    })
};

fn special(args: &[String]) -> Option<Result<Exit>> {
    match args {
        [command] if command == "voices" => Some(Ok(workflow::voices())),
        [command, flag, file] if command == "plan" && flag == "--args" => {
            Some(video_media::read_json(Path::new(file)).and_then(|args| workflow::preview(&args)))
        }
        _ => None,
    }
}
