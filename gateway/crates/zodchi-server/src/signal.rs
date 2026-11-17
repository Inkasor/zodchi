//! Ctrl+C and SIGTERM: the handler only raises a flag; the serving loop sees it, cancels the open sign-ins and
//! returns. Declared directly against the system, as the core does for processes, so nothing compiles C.

use std::sync::atomic::{AtomicBool, Ordering};

static STOP: AtomicBool = AtomicBool::new(false);
static DONE: AtomicBool = AtomicBool::new(false);

pub fn requested() -> bool {
    STOP.load(Ordering::SeqCst)
}

/// Called once the shutdown is complete: a console handler that waits for it may return.
pub fn finished() {
    DONE.store(true, Ordering::SeqCst);
}

#[cfg(windows)]
mod imp {
    use super::{DONE, STOP};
    use std::sync::atomic::Ordering;
    extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
    }

    /// Runs on a thread of its own. For a closing console the process ends when it returns, so it waits (a few
    /// seconds at most, what Windows allows) for the shutdown to finish.
    unsafe extern "system" fn on_ctrl(_event: u32) -> i32 {
        STOP.store(true, Ordering::SeqCst);
        for _ in 0..45 {
            if DONE.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        1
    }

    pub fn install() {
        unsafe {
            SetConsoleCtrlHandler(Some(on_ctrl), 1);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::STOP;
    use std::sync::atomic::Ordering;
    extern "C" {
        fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
    }
    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;

    extern "C" fn on_signal(_signum: i32) {
        STOP.store(true, Ordering::SeqCst);
    }

    pub fn install() {
        unsafe {
            signal(SIGINT, on_signal);
            signal(SIGTERM, on_signal);
        }
    }
}

pub use imp::install;
