//! Acceptance workflows.

#![allow(clippy::result_large_err)]

// Keep flow progress and local diagnostics out of the CLI's JSON stderr stream.
macro_rules! eprintln {
    ($($args:tt)*) => {
        if !zodchi_core::config::agent_requested() {
            ::std::eprintln!($($args)*);
        }
    };
}

mod acceptance;

pub use acceptance::{resume, start, CANDIDATE, PLAYER, RELEASE};

#[doc(hidden)]
pub use acceptance::handoff;
