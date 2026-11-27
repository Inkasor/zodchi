//! Voiceover workflow.

mod voiceover;

pub use voiceover::{preview, resume, start, voices, NAME};

#[doc(hidden)]
pub use voiceover::project_stop_status;
