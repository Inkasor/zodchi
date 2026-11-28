use super::{candidate_acceptance_entry::entry, require_workflow, Entry};
use zodchi_flow_acceptance as workflow;

pub(super) const ENTRY: Entry = entry(workflow::PLAYER, |args, launch| {
    workflow::start(workflow::PLAYER, args, launch, require_workflow)
});
