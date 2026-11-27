//! Common runtime and on-disk contracts for Zodchi workflows.

#![allow(clippy::result_large_err)]

// Keep flow progress and local diagnostics out of the CLI's JSON stderr stream.
macro_rules! eprintln {
    ($($args:tt)*) => {
        if !zodchi_core::config::agent_requested() {
            ::std::eprintln!($($args)*);
        }
    };
}

pub mod accepted_media;
pub mod agent;
pub mod args;
pub mod boundary;
pub mod budget;
pub mod catalog;
pub mod checks;
pub mod claims;
pub mod cleanup;
pub mod executor;
pub mod gateway;
pub mod git;
pub mod input_common;
pub mod journal;
pub mod models;
pub mod package_source;
pub mod patch;
pub mod publish;
pub mod review_contract;
pub mod review_source;
pub mod verify;
pub mod video_media;

pub use boundary::{Exit, CUT_EXIT};
