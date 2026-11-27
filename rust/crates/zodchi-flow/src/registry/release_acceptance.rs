use super::{
    candidate_acceptance_entry::{acceptance, entry},
    require_workflow, Entry,
};

pub(super) const ENTRY: Entry = entry(acceptance::RELEASE, |args, launch| {
    acceptance::start(acceptance::RELEASE, args, launch, require_workflow)
});
