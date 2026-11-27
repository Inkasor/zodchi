#[path = "../voiceover.rs"]
mod voiceover;

use super::{Entry, SignIn, StatusHooks, NO_STATUS};
use crate::{video_media, Exit};
use std::path::Path;
use zodchi_core::util::Result;

pub(super) const ENTRY: Entry = Entry {
    special: Some(special),
    status: StatusHooks {
        stop_details: Some(voiceover::project_stop_status),
        ..NO_STATUS
    },
    finished_approved: Some(|result| result["status"] == "rendered"),
    allows_paid_worker: true,
    stop_sign_in: Some(|result| (result["errorKind"] == "auth_required").then_some(SignIn::ApiKey)),
    ..Entry::new(voiceover::NAME, "1", voiceover::start, |id, _, rerun| {
        voiceover::resume(id, rerun)
    })
};

fn special(args: &[String]) -> Option<Result<Exit>> {
    match args {
        [command] if command == "voices" => Some(Ok(voiceover::voices())),
        [command, flag, file] if command == "plan" && flag == "--args" => {
            Some(video_media::read_json(Path::new(file)).and_then(|args| voiceover::preview(&args)))
        }
        _ => None,
    }
}
