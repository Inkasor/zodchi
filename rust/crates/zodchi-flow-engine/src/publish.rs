//! Publication of workflow artifacts.

use std::fs;
use std::io::Write;
use std::path::Path;
use zodchi_core::util::{GatewayError, Result};

pub fn publish(path: &Path, text: &str, replace: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| GatewayError("The brief has no parent directory.".into()))?;
    fs::create_dir_all(parent)?;
    let staged = parent.join(format!(".zodchi-brief-{:016x}.tmp", rand::random::<u64>()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&staged)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    if replace {
        fs::rename(&staged, path)?;
    } else {
        let written = fs::hard_link(&staged, path);
        let _ = fs::remove_file(&staged);
        written?;
    }
    Ok(())
}
