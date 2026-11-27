#[path = "../acceptance/mod.rs"]
pub(super) mod acceptance;

use super::{require_workflow, Entry, Exit, Result, Start, Value};

pub(super) const fn entry(name: &'static str, start: Start) -> Entry {
    Entry {
        handoff_from_status: Some(acceptance::handoff),
        finished_approved: Some(|result| result["verdict"] == "pass"),
        ..Entry::new(name, "1", start, resume)
    }
}

fn resume(id: &str, _: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    acceptance::resume(id, rerun)
}

pub(super) const ENTRY: Entry = entry(acceptance::CANDIDATE, |args, launch| {
    acceptance::start(acceptance::CANDIDATE, args, launch, require_workflow)
});
