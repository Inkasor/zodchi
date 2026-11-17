//! Lock files between processes: `server.lock` (one serving process per data folder) and `server.json.lock` (one
//! read-modify-write of the registry at a time). A lock file holds the pid and the start time of its owner and
//! appears whole or not at all; a lock whose owner is gone is taken over.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use zodchi_core::process::{alive, process_start};
use zodchi_core::util::{fail, pause, publish, Result};

pub struct PidLock {
    file: PathBuf,
    mine: String,
}

fn owner_line() -> String {
    let me = std::process::id();
    format!("{me} {}", process_start(me).unwrap_or_default())
}

/// The owner of a lock is gone when its pid is free, or when the pid now belongs to a process started at another
/// moment. A lock that cannot be read, or names no pid, is left alone unless it is older than a minute.
fn holder_gone(file: &Path) -> Option<String> {
    let text = fs::read_to_string(file).ok()?;
    let (pid, start) = text.split_once(' ').unwrap_or((text.as_str(), ""));
    let gone = match pid.trim().parse::<u32>() {
        Ok(pid) => {
            !alive(pid) || (!start.trim().is_empty() && process_start(pid).is_some_and(|now| now.trim() != start.trim()))
        }
        Err(_) => fs::metadata(file).and_then(|m| m.modified()).ok()
            .and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(60)),
    };
    gone.then_some(text)
}

impl PidLock {
    /// Takes the lock, or None while a live process holds it.
    pub fn try_acquire(file: &Path) -> Result<Option<PidLock>> {
        let mine = owner_line();
        for _ in 0..3 {
            if publish(file, &mine)? {
                return Ok(Some(PidLock { file: file.to_path_buf(), mine }));
            }
            match holder_gone(file) {
                // The stale lock is removed only if it is still the one judged stale.
                Some(stale) => {
                    if fs::read_to_string(file).ok().as_deref() == Some(stale.as_str()) {
                        let _ = fs::remove_file(file);
                    }
                }
                None => return Ok(None),
            }
        }
        Ok(None)
    }

    /// Takes the lock, waiting up to `wait` for a live holder to let it go.
    pub fn acquire(file: &Path, wait: Duration) -> Result<PidLock> {
        let deadline = Instant::now() + wait;
        loop {
            if let Some(lock) = Self::try_acquire(file)? {
                return Ok(lock);
            }
            if Instant::now() > deadline {
                return fail(format!("{} is held by another process.", file.display()));
            }
            pause(20 + rand::random::<u64>() % 40);
        }
    }
}

impl Drop for PidLock {
    fn drop(&mut self) {
        if fs::read_to_string(&self.file).ok().as_deref() == Some(self.mine.as_str()) {
            let _ = fs::remove_file(&self.file);
        }
    }
}
