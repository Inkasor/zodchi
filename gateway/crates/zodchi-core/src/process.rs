//! Processes by pid and start time. A pid alone names no process: the system gives it to another program once its
//! owner is gone. A process is known by its pid together with the moment the system started it, kept as text to be
//! compared with itself and nothing else. Whenever the system does not clearly say "no such process", the answer is
//! "unknown", and nothing is decided on it.

/// What the system says about a pid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    Alive,
    Absent,
    Unknown,
}

#[cfg(windows)]
#[allow(non_snake_case, clippy::upper_case_acronyms)]
mod imp {
    use super::Probe;
    // The few kernel32 functions this needs, declared directly: the GNU toolchain links kernel32 as it is.
    type HANDLE = *mut core::ffi::c_void;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FILETIME {
        dwLowDateTime: u32,
        dwHighDateTime: u32,
    }
    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;
    const WAIT_OBJECT_0: u32 = 0;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_INVALID_PARAMETER: i32 = 87;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> HANDLE;
        fn CloseHandle(handle: HANDLE) -> i32;
        fn GetExitCodeProcess(handle: HANDLE, code: *mut u32) -> i32;
        fn GetProcessTimes(handle: HANDLE, created: *mut FILETIME, exited: *mut FILETIME, kernel: *mut FILETIME, user: *mut FILETIME) -> i32;
        fn WaitForSingleObject(handle: HANDLE, ms: u32) -> u32;
    }

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// The handle, or what the failure to open one says about the pid.
    fn open(pid: u32, rights: u32) -> Result<Handle, Probe> {
        let h = unsafe { OpenProcess(rights, 0, pid) };
        if !h.is_null() {
            return Ok(Handle(h));
        }
        Err(match std::io::Error::last_os_error().raw_os_error() {
            // No process has this pid.
            Some(ERROR_INVALID_PARAMETER) => Probe::Absent,
            // A process has it and we may not touch it.
            Some(ERROR_ACCESS_DENIED) => Probe::Alive,
            _ => Probe::Unknown,
        })
    }

    fn running(h: &Handle) -> Probe {
        let mut code = 0u32;
        if unsafe { GetExitCodeProcess(h.0, &mut code) } == 0 {
            return Probe::Unknown;
        }
        if code == STILL_ACTIVE { Probe::Alive } else { Probe::Absent }
    }

    /// Creation time in 100 ns ticks since 1601, as decimal text.
    fn start_of(h: &Handle) -> Option<String> {
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        if unsafe { GetProcessTimes(h.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
            return None;
        }
        Some((((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string())
    }

    pub fn probe(pid: u32) -> Probe {
        match open(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
            Ok(h) => running(&h),
            Err(p) => p,
        }
    }

    pub fn process_start(pid: u32) -> Option<String> {
        start_of(&open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok()?)
    }

    /// One handle is held from the check to the kill: while it is open the system gives the pid to nobody else, so
    /// what is killed is what was checked.
    pub fn stop_process(pid: u32, start: &str) -> &'static str {
        let h = match open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE) {
            Ok(h) => h,
            Err(Probe::Absent) => return "absent",
            Err(_) => return "unknown",
        };
        match running(&h) {
            Probe::Absent => return "absent",
            Probe::Unknown => return "unknown",
            Probe::Alive => {}
        }
        match start_of(&h) {
            Some(now) if now == start => {}
            Some(_) => return "other",
            None => return "unknown",
        }
        super::kill_tree(pid);
        if unsafe { WaitForSingleObject(h.0, 10_000) } == WAIT_OBJECT_0 { "stopped" } else { "alive" }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Probe;
    use std::process::Command;

    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const ESRCH: i32 = 3;
    const EPERM: i32 = 1;

    pub fn probe(pid: u32) -> Probe {
        if pid > i32::MAX as u32 {
            return Probe::Unknown;
        }
        if unsafe { kill(pid as i32, 0) } == 0 {
            return Probe::Alive;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(ESRCH) => Probe::Absent,
            Some(EPERM) => Probe::Alive,
            _ => Probe::Unknown,
        }
    }

    pub fn process_start(pid: u32) -> Option<String> {
        let out = Command::new("ps").args(["-o", "lstart=", "-p", &pid.to_string()]).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || c == ':' || c == ' ') { Some(text) } else { None }
    }

    /// Elsewhere the check and the kill are two steps.
    pub fn stop_process(pid: u32, start: &str) -> &'static str {
        match probe(pid) {
            Probe::Absent => return "absent",
            Probe::Unknown => return "unknown",
            Probe::Alive => {}
        }
        match process_start(pid) {
            None => return if probe(pid) == Probe::Absent { "absent" } else { "unknown" },
            Some(now) if now != start => return "other",
            _ => {}
        }
        super::kill_tree(pid);
        for _ in 0..100 {
            match probe(pid) {
                Probe::Absent => return "stopped",
                Probe::Unknown => return "unknown",
                Probe::Alive => crate::util::pause(100),
            }
        }
        "alive"
    }
}

pub use imp::{probe, process_start};

/// True unless the system clearly says there is no such process: an unknown answer counts as alive, so that nothing
/// is decided about a process that may still run.
pub fn alive(pid: u32) -> bool {
    probe(pid) != Probe::Absent
}

/// Kills a process with everything it started.
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let taskkill = match std::env::var_os("SystemRoot") {
            Some(root) => std::path::Path::new(&root).join("System32").join("taskkill.exe"),
            None => std::path::PathBuf::from("taskkill.exe"),
        };
        let mut command = std::process::Command::new(taskkill);
        command.args(["/pid", &pid.to_string(), "/t", "/f"]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        // Codex and the worker start their own process group, so the group goes with them.
        let _ = std::process::Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).stderr(std::process::Stdio::null()).status();
        let _ = std::process::Command::new("kill").args(["-KILL", &pid.to_string()]).stderr(std::process::Stdio::null()).status();
    }
}

/// Stops the process `pid` that was started at `start`, with everything it started. "absent": there is no such
/// process. "other": the pid belongs to another program now, which is left alone. "stopped": it was that process and
/// it has exited. "alive": it was told to go and has not gone. "unknown": the system could not tell, nothing touched.
pub fn stop_process(pid: i64, start: Option<&str>) -> &'static str {
    if pid <= 0 || pid > u32::MAX as i64 || pid as u32 == std::process::id() {
        return "unknown";
    }
    let pid = pid as u32;
    match probe(pid) {
        Probe::Absent => return "absent",
        Probe::Unknown => return "unknown",
        Probe::Alive => {}
    }
    match start {
        Some(s) if !s.trim().is_empty() => imp::stop_process(pid, s.trim()),
        _ => "unknown",
    }
}

pub fn gone(answer: &str) -> bool {
    matches!(answer, "absent" | "other" | "stopped")
}
