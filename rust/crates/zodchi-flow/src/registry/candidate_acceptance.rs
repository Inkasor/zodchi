use super::{require_workflow, Entry, Exit, Result, Start, Value};
use zodchi_flow_acceptance as workflow;

pub(super) const fn entry(name: &'static str, start: Start) -> Entry {
    Entry {
        handoff_from_status: Some(workflow::handoff),
        finished_approved: Some(|result| result["verdict"] == "pass"),
        ..Entry::new(name, "1", start, resume)
    }
}

fn resume(id: &str, _: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    workflow::resume(id, rerun)
}

pub(super) const ENTRY: Entry = entry(workflow::CANDIDATE, |args, launch| {
    workflow::start(workflow::CANDIDATE, args, launch, require_workflow)
});
