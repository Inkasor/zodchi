//! Rubric probe workflow.

mod rubric_probe;

pub use rubric_probe::{resume, start, NAME};

#[doc(hidden)]
pub use rubric_probe::start_child;
