//! Research workflow.

#![allow(clippy::result_large_err)]

mod research;
mod research_lists;
mod research_material;

pub use research::{resume, start, NAME};

#[doc(hidden)]
pub use research::reply_text;

#[cfg(test)]
use zodchi_flow_engine::{input_common, journal};

#[cfg(test)]
fn require_workflow(
    git: &zodchi_flow_engine::git::Git,
    base: &str,
    name: &str,
) -> zodchi_core::util::Result<()> {
    use zodchi_flow_engine::catalog;

    let shipped = serde_json::from_str(catalog::SHIPPED).expect("workflow catalog");
    catalog::require(git, base, name, &shipped)
}
