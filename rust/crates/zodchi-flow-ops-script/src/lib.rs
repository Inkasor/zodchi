//! Ops script workflow.

#![allow(clippy::result_large_err)]

mod ops_script;

pub use ops_script::{resume, start, NAME};

#[doc(hidden)]
pub use ops_script::{project_status_result, RepairHooks};
