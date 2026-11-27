use super::{
    candidate_acceptance_entry::{acceptance, entry},
    require_workflow, Entry,
};

pub(super) const ENTRY: Entry = entry(acceptance::PLAYER, |args, launch| {
    acceptance::start(acceptance::PLAYER, args, launch, require_workflow)
});
