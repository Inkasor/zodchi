//! Ops script workflow.

#![allow(clippy::result_large_err)]

// The facade runs the existing unit tests with the real code-package callbacks.
#[cfg(test)]
macro_rules! ops_script_tests {
    ($tests:item) => {};
}

#[cfg(test)]
pub(crate) use ops_script_tests;

mod ops_script;

pub use ops_script::{resume, start, NAME};

#[doc(hidden)]
pub use ops_script::{project_status_result, RepairHooks};
