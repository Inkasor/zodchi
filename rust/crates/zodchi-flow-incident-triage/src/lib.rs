//! Incident triage workflow.

#![allow(clippy::result_large_err)]

mod incident_adapter;
mod incident_draft;
mod incident_triage;

pub use incident_triage::{resume, start, NAME};
