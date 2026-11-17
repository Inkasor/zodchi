//! Locks between processes: `server.lock` (one serving process per data folder) and `server.json.lock` (one
//! read-modify-write of the registry at a time). The lock is the operating system's exclusive lock on the open file
//! (`flock` / `LockFileEx`), held for as long as the owner lives. A crashed owner's lock is released by the system
//! with its process, so there is no stale lock to take over and no window in which two contenders both win. The
//! file itself stays on disk; its text (pid and start of the owner) is only for a human looking at it.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};
use zodchi_core::process::process_start;
use zodchi_core::util::{fail, pause, Result};

pub struct PidLock {
    /// Held open: closing it (on drop, or when the process ends) releases the lock.
    _file: File,
}

fn owner_line() -> String {
    let me = std::process::id();
    format!("{me} {}", process_start(me).unwrap_or_default())
}

impl PidLock {
    /// Takes the lock, or None while another owner (a process, or another handle in this one) holds it.
    pub fn try_acquire(file: &Path) -> Result<Option<PidLock>> {
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut handle = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(file)?;
        match handle.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Error(e)) => return fail(format!("{} cannot be locked: {e}", file.display())),
        }
        // Informational only; the lock does not depend on it.
        let _ = handle.set_len(0).and_then(|_| handle.write_all(owner_line().as_bytes())).and_then(|_| handle.flush());
        Ok(Some(PidLock { _file: handle }))
    }

    /// Takes the lock, waiting up to `wait` for its holder to let it go.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};

    /// A lock file left behind by a crashed owner (a dead pid in it) is taken by exactly one of many contenders at
    /// once, and by nobody else while that one holds it.
    #[test]
    fn simultaneous_contenders_on_a_stale_lock_file() {
        let dir = std::env::temp_dir().join(format!("zodchi-lock-test-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("server.lock");
        fs::write(&file, "999999999 gone").unwrap();
        for _round in 0..20 {
            let contenders = 8;
            let barrier = Arc::new(Barrier::new(contenders));
            let held = Arc::new(Mutex::new(Vec::new()));
            let threads: Vec<_> = (0..contenders).map(|_| {
                let (barrier, held, file) = (Arc::clone(&barrier), Arc::clone(&held), file.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    if let Some(lock) = PidLock::try_acquire(&file).unwrap() {
                        held.lock().unwrap().push(lock);
                    }
                })
            }).collect();
            for t in threads {
                t.join().unwrap();
            }
            let winners = held.lock().unwrap().len();
            assert_eq!(winners, 1, "exactly one contender holds the lock");
            assert!(PidLock::try_acquire(&file).unwrap().is_none(), "nobody else while it is held");
            held.lock().unwrap().clear();
            assert!(PidLock::try_acquire(&file).unwrap().is_some(), "free again once its owner lets go");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
