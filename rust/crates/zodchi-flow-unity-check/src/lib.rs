//! Unity check workflow.

mod unity_check;

pub use unity_check::{resume, start, NAME};

#[doc(hidden)]
pub use unity_check::start_child;
