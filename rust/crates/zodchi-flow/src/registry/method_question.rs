#[path = "../method_question.rs"]
mod method_question;

use super::{require_workflow, Entry};

pub(super) const ENTRY: Entry = Entry::new(
    method_question::NAME,
    "1",
    |args, launch| method_question::start(args, launch, require_workflow),
    method_question::resume,
);
