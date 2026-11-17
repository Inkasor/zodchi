//! A worker survives the job object of the shell that submitted it (Windows). An agent's shell runs inside a job
//! object that ends its children when the shell ends; `spawn_detached` asks to break away from it.
//!
//! This test binary stands in for both sides: with ZODCHI_STAND_IN unset, `stand_in` does nothing; started by the test
//! with ZODCHI_STAND_IN=submitter it waits for the file `go`, spawns the worker through `spawn_detached` (the worker is
//! this binary again, with ZODCHI_STAND_IN=worker, which sleeps until the file `stop`), and writes the worker's pid.

use std::path::PathBuf;
use std::time::{Duration, Instant};

fn wait_for(what: &str, secs: u64, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The stand-in program (see the header). It does nothing in a normal test run.
#[test]
fn stand_in() {
    let role = std::env::var("ZODCHI_STAND_IN").unwrap_or_default();
    let dir = PathBuf::from(std::env::var("ZODCHI_STAND_IN_DIR").unwrap_or_default());
    match role.as_str() {
        "submitter" => {
            wait_for("go", 30, || dir.join("go").exists());
            std::env::set_var("ZODCHI_STAND_IN", "worker");
            let args: Vec<std::ffi::OsString> = vec!["--exact".into(), "stand_in".into(), "--nocapture".into()];
            let mut child = zodchi_core::job::spawn_detached(&args, false).unwrap();
            std::fs::write(dir.join("worker.pid"), child.id().to_string()).unwrap();
            // As the server does: the worker is waited on from a thread of its own.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            // Stay alive: the job object, not this program, is what ends it.
            std::thread::sleep(Duration::from_secs(120));
        }
        "worker" => wait_for("stop", 120, || dir.join("stop").exists()),
        _ => {}
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use zodchi_core::process::alive;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zodchi-core-breakaway-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    type Handle = *mut core::ffi::c_void;
    const JOB_OBJECT_LIMIT_BREAKAWAY_OK: u32 = 0x0000_0800;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut core::ffi::c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut core::ffi::c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// A job object that ends its processes when its last handle closes; `breakaway_ok` lets them break away.
    struct JobObject(Handle);
    impl JobObject {
        fn new(breakaway_ok: bool) -> Self {
            let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            assert!(!job.is_null(), "CreateJobObjectW: {}", std::io::Error::last_os_error());
            // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows; LimitFlags sits at offset 16.
            let mut info = [0u64; 18];
            let flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | if breakaway_ok { JOB_OBJECT_LIMIT_BREAKAWAY_OK } else { 0 };
            info[2] = flags as u64;
            let ok = unsafe { SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info.as_mut_ptr().cast(), 144) };
            assert!(ok != 0, "SetInformationJobObject: {}", std::io::Error::last_os_error());
            JobObject(job)
        }
        fn assign(&self, child: &Child) {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle().cast()) };
            assert!(ok != 0, "AssignProcessToJobObject: {}", std::io::Error::last_os_error());
        }
        fn close(self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Can this test process itself start a child that leaves its job object? Not when an outer job forbids it.
    fn can_break_away() -> bool {
        let comspec = std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into());
        let mut command = Command::new(comspec);
        command.args(["/c", "exit 0"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        command.creation_flags(zodchi_core::job::WORKER_BREAKAWAY);
        match command.spawn() {
            Ok(mut child) => {
                let _ = child.wait();
                true
            }
            Err(_) => false,
        }
    }

    /// Submitter inside a job object, worker through `spawn_detached`, the job object closed: returns the pids.
    fn run(breakaway_ok: bool, dir: &Path) -> (u32, u32, Child) {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "stand_in", "--nocapture"]).env("ZODCHI_STAND_IN", "submitter").env("ZODCHI_STAND_IN_DIR", dir);
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let submitter = command.spawn().unwrap();
        let job = JobObject::new(breakaway_ok);
        job.assign(&submitter);
        std::fs::write(dir.join("go"), "").unwrap();
        wait_for("the worker pid", 30, || dir.join("worker.pid").exists());
        let worker: u32 = std::fs::read_to_string(dir.join("worker.pid")).unwrap().trim().parse().unwrap();
        assert!(alive(worker), "the worker is not running before the job object closes");
        job.close();
        let submitter_pid = submitter.id();
        (submitter_pid, worker, submitter)
    }

    #[test]
    fn the_worker_outlives_the_job_object_of_its_submitter() {
        if !can_break_away() {
            eprintln!("skipped: a job object around this test process forbids breakaway, so no worker can leave one here");
            return;
        }
        let dir = scratch();
        let (submitter_pid, worker, mut submitter) = run(true, &dir);
        // The job object ended the submitter ...
        wait_for("the submitter to end", 20, || submitter.try_wait().unwrap().is_some());
        assert!(!alive(submitter_pid));
        // ... and the worker, which broke away, still runs.
        std::thread::sleep(Duration::from_secs(1));
        let survived = alive(worker);
        std::fs::write(dir.join("stop"), "").unwrap();
        assert!(survived, "the worker died with the job object of its submitter");
        wait_for("the worker to stop", 20, || !alive(worker));
    }

    /// A job object that forbids breakaway makes the first spawn fail with access denied; the worker is then started
    /// without the flag, inside the job object (as before this change): it runs, and it ends with the job object.
    #[test]
    fn a_job_object_without_breakaway_still_gets_a_worker() {
        let dir = scratch();
        let (_, worker, mut submitter) = run(false, &dir);
        wait_for("the submitter to end", 20, || submitter.try_wait().unwrap().is_some());
        wait_for("the worker to end with the job object", 20, || !alive(worker));
    }
}

#[test]
fn worker_flags_ask_for_breakaway_and_the_fallback_drops_only_that() {
    #[cfg(windows)]
    {
        use zodchi_core::job::{WORKER_BREAKAWAY, WORKER_FLAGS};
        // The flags are constants, so the compiler checks them.
        const {
            assert!(WORKER_BREAKAWAY == 0x0100_0000);
            assert!(WORKER_FLAGS & WORKER_BREAKAWAY != 0);
            assert!(WORKER_FLAGS & 0x0000_0008 != 0, "DETACHED_PROCESS");
            assert!(WORKER_FLAGS & 0x0000_0200 != 0, "CREATE_NEW_PROCESS_GROUP");
            assert!(WORKER_FLAGS & !WORKER_BREAKAWAY == 0x0000_0208);
        }
    }
}
