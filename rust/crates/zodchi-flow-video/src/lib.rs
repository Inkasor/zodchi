//! Video workflow.

#![allow(clippy::result_large_err)]

// Keep flow progress and local diagnostics out of the CLI's JSON stderr stream.
macro_rules! eprintln {
    ($($args:tt)*) => {
        if !zodchi_core::config::agent_requested() {
            ::std::eprintln!($($args)*);
        }
    };
}

mod video;
mod video_manifest;
mod video_metrics;
mod video_research;

pub use video::{resume, start, NAME, VERSION};

#[doc(hidden)]
pub use video::{project_status, record_publication, record_reply, record_stats};
#[doc(hidden)]
pub use video_research::capture;
