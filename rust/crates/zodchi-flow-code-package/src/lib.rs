//! Code package workflow.

#![allow(clippy::result_large_err)]

// Keep flow progress and local diagnostics out of the CLI's JSON stderr stream.
macro_rules! eprintln {
    ($($args:tt)*) => {
        if !zodchi_core::config::agent_requested() {
            ::std::eprintln!($($args)*);
        }
    };
}

mod candidate;
mod code_package;

pub use code_package::{
    resume, start, start_detached, Exit, CUT_EXIT, REVIEWER_GATEWAY_ROLE, VERSION, WORKFLOW,
    WRITER_GATEWAY_ROLE,
};

#[doc(hidden)]
pub use candidate::apply;
#[doc(hidden)]
pub use code_package::{
    credits, dry_run, handle_reply, queue_remark, recorded_findings, shutdown_candidate,
    start_child, unknown_shutdown_files, PinnedClaim, ReplyHooks, ReplyInput,
};
