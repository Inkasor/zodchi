#[path = "../asset_round.rs"]
mod asset_round;

use self::asset_round::{ChildWorkflow, Children};
use super::{require_workflow, rubric_probe_entry, unity_check_entry, Entry};
use crate::{boundary, child_package, control};

const CHILDREN: Children = Children {
    package: ChildWorkflow {
        name: boundary::WORKFLOW,
        start: child_package::start,
        resume: child_package::resume,
    },
    unity: ChildWorkflow {
        name: unity_check_entry::NAME,
        start: |args, id| unity_check_entry::start_child(args, id, require_workflow),
        resume: |id, args| control::resume(unity_check_entry::NAME, id, Some(args), None, false),
    },
    rubric: ChildWorkflow {
        name: rubric_probe_entry::NAME,
        start: |args, id| rubric_probe_entry::start_child(args, id, require_workflow),
        resume: |id, args| control::resume(rubric_probe_entry::NAME, id, Some(args), None, false),
    },
};

pub(super) const ENTRY: Entry = Entry {
    allows_paid_worker: true,
    ..Entry::new(
        asset_round::NAME,
        "1",
        |args, launch| asset_round::start(args, launch, require_workflow, &CHILDREN),
        |id, given, rerun| asset_round::resume(id, given, rerun, &CHILDREN),
    )
};
