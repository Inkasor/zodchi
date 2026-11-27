//! Design brief workflow.

#![allow(clippy::result_large_err)]

mod design_brief;
mod design_material;

pub use design_brief::{resume, start, NAME};

#[doc(hidden)]
pub use design_brief::publish;
#[doc(hidden)]
pub use design_material::places;
