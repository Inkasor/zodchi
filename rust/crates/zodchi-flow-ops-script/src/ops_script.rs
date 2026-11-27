//! Native ops-script: snapshot, check and hand a pinned command to the operator.
//!
//! A check template is argv, not shell. The string form is deliberately limited to
//! whitespace-separated, unquoted words; callers needing spaces use an array.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
#[cfg(not(windows))]
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
#[cfg(not(windows))]
use std::time::Instant;
use serde_json::{json, Value};
use zodchi_core::util::sha256_hex;
use zodchi_core::{config::Config, util::{fail, iso, GatewayError}};
use zodchi_flow_engine::{
    boundary::{self, Launch},
    checks, input_common,
    journal::{self, Journal},
    models, Exit,
};

pub const NAME: &str = "ops-script";
const VERSION: &str = "1";

pub struct RepairHooks {
    pub start: fn(&Value, &str) -> zodchi_core::util::Result<Exit>,
    pub resume: fn(&str, &Value) -> zodchi_core::util::Result<Exit>,
}

fn reject_privileged(privileged: bool) -> Result<(), String> {
    if privileged { Err("The dry run must not run as root or elevated".into()) } else { Ok(()) }
}

/// Do not start an operator script with an elevated token. The result is
/// conservative: an unavailable identity check is a refusal, not permission.
#[cfg(target_os = "linux")]
fn unprivileged() -> Result<(), String> {
    extern "C" { fn getuid() -> u32; fn geteuid() -> u32; }
    reject_privileged(unsafe { getuid() == 0 || geteuid() == 0 })
}

#[cfg(all(unix, not(target_os = "linux")))]
fn unprivileged() -> Result<(), String> {
    Err("This platform cannot enforce the local dry-run privilege boundary".into())
}

#[cfg(windows)]
fn unprivileged() -> Result<(), String> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" { fn GetCurrentProcess() -> *mut c_void; fn CloseHandle(handle: *mut c_void) -> i32; }
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(token: *mut c_void, class: u32, data: *mut c_void, len: u32, returned: *mut u32) -> i32;
    }
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) } == 0 {
        return Err("Cannot determine process elevation".into());
    }
    let mut elevated = 0u32;
    let mut returned = 0u32;
    let ok = unsafe { GetTokenInformation(token, 20, (&mut elevated as *mut u32).cast(), 4, &mut returned) };
    unsafe { CloseHandle(token); }
    if ok == 0 || returned != 4 { return Err("Cannot determine process elevation".into()); }
    reject_privileged(elevated != 0)
}

#[cfg(not(any(unix, windows)))]
fn unprivileged() -> Result<(), String> { Err("Cannot verify the current privilege on this platform".into()) }

#[derive(Debug)]
struct CommandResult {
    check: Option<String>,
    input_index: Option<usize>,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

// The job is included in STARTUPINFOEX so process creation and assignment are
// one operation, including when the worker itself is killed during creation.
#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use std::io::Read;
    use std::path::Path;
    use std::time::Duration;
    use super::CommandResult;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64, job_time: i64, flags: u32, min_working_set: usize,
        max_working_set: usize, active_process_limit: u32, affinity: usize,
        priority: u32, scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters { read_ops: u64, write_ops: u64, other_ops: u64, read_bytes: u64, write_bytes: u64, other_bytes: u64 }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits, io: IoCounters, process_memory: usize, job_memory: usize,
        peak_process_memory: usize, peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, size: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn CreatePipe(read: *mut *mut c_void, write: *mut *mut c_void, security: *mut Security, size: u32) -> i32;
        fn SetHandleInformation(handle: *mut c_void, mask: u32, flags: u32) -> i32;
        fn CreateFileW(name: *const u16, access: u32, share: u32, security: *mut Security, disposition: u32, flags: u32, template: *mut c_void) -> *mut c_void;
        fn InitializeProcThreadAttributeList(list: *mut c_void, count: u32, flags: u32, size: *mut usize) -> i32;
        fn UpdateProcThreadAttribute(list: *mut c_void, flags: u32, attribute: usize, value: *mut c_void, size: usize, previous: *mut c_void, returned: *mut usize) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(app: *const u16, command: *mut u16, process_security: *const c_void, thread_security: *const c_void, inherit: i32, flags: u32, env: *const c_void, cwd: *const u16, startup: *mut Startup, info: *mut ProcessInfo) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, millis: u32) -> u32;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
    }
    #[repr(C)]
    struct Security { size: u32, descriptor: *mut c_void, inherit: i32 }
    #[repr(C)]
    struct Startup { size: u32, reserved: *mut u16, desktop: *mut u16, title: *mut u16, geometry: [u32; 7], flags: u32, show: u16, reserved2_size: u16, reserved2: *mut u8, stdin: *mut c_void, stdout: *mut c_void, stderr: *mut c_void }
    #[repr(C)]
    struct StartupEx { startup: Startup, attributes: *mut c_void }
    #[repr(C)]
    struct ProcessInfo { process: *mut c_void, thread: *mut c_void, pid: u32, tid: u32 }
    struct Handle(*mut c_void);
    impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    struct Attributes(*mut c_void);
    impl Drop for Attributes { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.0); } } }
    fn wide(s: &std::ffi::OsStr) -> Vec<u16> { s.encode_wide().chain(std::iter::once(0)).collect() }
    fn error(context: &str) -> String { format!("{context}: {}", std::io::Error::last_os_error()) }
    fn pipe(security: &mut Security) -> Result<(Handle, Handle), String> {
        let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
        if unsafe { CreatePipe(&mut read, &mut write, security, 0) } == 0 { return Err(error("Cannot create output pipe")); }
        let (read, write) = (Handle(read), Handle(write));
        if unsafe { SetHandleInformation(read.0, 1, 0) } == 0 { return Err(error("Cannot protect output pipe")); }
        Ok((read, write))
    }
    // Microsoft CRT argument quoting; application name is supplied separately.
    fn quote_arg(arg: &std::ffi::OsStr, output: &mut Vec<u16>) {
        output.push(b'"' as u16);
        let mut slashes = 0;
        for c in arg.encode_wide() {
            if c == b'\\' as u16 { slashes += 1; continue; }
            let count = if c == b'"' as u16 { slashes * 2 + 1 } else { slashes };
            output.extend(std::iter::repeat(b'\\' as u16).take(count));
            output.push(c);
            slashes = 0;
        }
        output.extend(std::iter::repeat(b'\\' as u16).take(slashes * 2));
        output.push(b'"' as u16);
    }

    pub(super) fn failed_to_initialize(code: u32) -> bool {
        matches!(code, 0xc000007b | 0xc0000135 | 0xc0000138 | 0xc0000139 | 0xc0000142)
    }

    pub fn run(program: &Path, args: &[std::ffi::OsString], cwd: &Path, extra_env: &[(&str, &Path)], limit: Duration) -> Result<CommandResult, String> {
        let raw = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if raw.is_null() { return Err(format!("Cannot create process job: {}", std::io::Error::last_os_error())); }
        let job = Handle(raw);
        let mut limits = ExtendedLimits::default();
        limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if unsafe { SetInformationJobObject(job.0, 9, (&limits as *const ExtendedLimits).cast(), std::mem::size_of::<ExtendedLimits>() as u32) } == 0 {
            return Err(format!("Cannot configure process job: {}", std::io::Error::last_os_error()));
        }
        let mut security = Security { size: std::mem::size_of::<Security>() as u32, descriptor: std::ptr::null_mut(), inherit: 1 };
        let (out_read, out_write) = pipe(&mut security)?;
        let (err_read, err_write) = pipe(&mut security)?;
        let nul = wide(std::ffi::OsStr::new("NUL"));
        let input = unsafe { CreateFileW(nul.as_ptr(), 0x8000_0000, 3, &mut security, 3, 0, std::ptr::null_mut()) };
        if input as isize == -1 { return Err(error("Cannot open null input")); }
        let input = Handle(input);
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut size); }
        if size == 0 { return Err(error("Cannot size process attributes")); }
        let mut storage = vec![0usize; (size + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
        let list = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(list, 2, 0, &mut size) } == 0 { return Err(error("Cannot initialize process attributes")); }
        let _attributes = Attributes(list);
        let mut handles = [input.0, out_write.0, err_write.0];
        let mut jobs = [job.0];
        for (attribute, ptr, bytes) in [(0x0002_0002, handles.as_mut_ptr(), std::mem::size_of_val(&handles)), (0x0002_000d, jobs.as_mut_ptr(), std::mem::size_of_val(&jobs))] {
            if unsafe { UpdateProcThreadAttribute(list, 0, attribute, ptr.cast(), bytes, std::ptr::null_mut(), std::ptr::null_mut()) } == 0 { return Err(error("Cannot set process attributes")); }
        }
        let mut startup: StartupEx = unsafe { std::mem::zeroed() };
        startup.startup.size = std::mem::size_of::<StartupEx>() as u32;
        startup.startup.flags = 0x100;
        startup.startup.stdin = input.0; startup.startup.stdout = out_write.0; startup.startup.stderr = err_write.0;
        startup.attributes = list;
        let mut command = Vec::new();
        quote_arg(program.as_os_str(), &mut command);
        for arg in args { command.push(b' ' as u16); quote_arg(arg, &mut command); }
        command.push(0);
        let mut env = std::collections::BTreeMap::new();
        for name in ["PATH", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"] {
            if let Some(value) = std::env::var_os(name) { env.insert(name.to_owned(), value); }
        }
        env.insert("PYTHONDONTWRITEBYTECODE".into(), "1".into());
        for (name, value) in extra_env { env.insert(name.to_ascii_uppercase(), value.as_os_str().to_owned()); }
        let mut environment = Vec::new();
        for (name, value) in env { environment.extend(std::ffi::OsStr::new(&name).encode_wide()); environment.push(b'=' as u16); environment.extend(value.encode_wide()); environment.push(0); }
        environment.push(0);
        let mut info: ProcessInfo = unsafe { std::mem::zeroed() };
        if unsafe { CreateProcessW(wide(program.as_os_str()).as_ptr(), command.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1, 0x0808_0400, environment.as_ptr().cast(), wide(cwd.as_os_str()).as_ptr(), &mut startup.startup, &mut info) } == 0 { return Err(error("Cannot start contained process")); }
        let process = Handle(info.process);
        let _thread = Handle(info.thread);
        drop(out_write); drop(err_write); drop(input);
        let collect = |handle: Handle| {
            let file = unsafe { std::fs::File::from_raw_handle(handle.0) };
            std::mem::forget(handle);
            let (send, recv) = std::sync::mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let mut file = file; let mut output = Vec::new(); let mut buffer = [0u8; 4096];
                while let Ok(n) = file.read(&mut buffer) { if n == 0 { break; } let remaining = 16384usize.saturating_sub(output.len()); output.extend_from_slice(&buffer[..n.min(remaining)]); }
                let _ = send.send(String::from_utf8_lossy(&output).into_owned());
            });
            recv
        };
        let stdout = collect(out_read); let stderr = collect(err_read);
        let wait = unsafe { WaitForSingleObject(process.0, limit.as_millis().min(u32::MAX as u128 - 1) as u32) };
        if wait != 0 && wait != 258 { return Err(error("Cannot wait for process")); }
        let timed_out = wait == 258;
        if timed_out {
            if unsafe { TerminateJobObject(job.0, 1) } == 0 { return Err(error("Cannot terminate process job")); }
            if unsafe { WaitForSingleObject(process.0, 5000) } != 0 { return Err("Timed-out process did not terminate".into()); }
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 { return Err(error("Cannot read process exit code")); }
        drop(job);
        // The Windows loader can fail after CreateProcessW succeeds, before the tool runs.
        if !timed_out && failed_to_initialize(code) {
            return Err(format!("The check process failed to initialize (0x{code:08X})"));
        }
        Ok(CommandResult { check: None, input_index: None, code: Some(code as i32), timed_out,
            stdout: stdout.recv_timeout(Duration::from_secs(2)).map_err(|_| "The process output did not close")?,
            stderr: stderr.recv_timeout(Duration::from_secs(2)).map_err(|_| "The process error output did not close")? })
    }
}

/// Execute argv directly with null stdin, bounded in-memory excerpts, a
/// deadline and the same hidden-window helper as the shared flow engine.
/// The caller must durably journal the intended effect before calling this.
#[cfg(windows)]
fn run_command(program: &Path, args: &[std::ffi::OsString], cwd: &Path, extra_env: &[(&str, &Path)], limit: Duration) -> Result<CommandResult, String> {
    windows_job::run(program, args, cwd, extra_env, limit)
}

#[cfg(not(windows))]
fn run_command(program: &Path, args: &[std::ffi::OsString], cwd: &Path, extra_env: &[(&str, &Path)], limit: Duration) -> Result<CommandResult, String> {
    run_unix_command(program, program, args, cwd, extra_env, limit)
}

#[cfg(any(target_os = "linux", test))]
fn linux_loader_diagnostic<'a>(executable: &Path, stderr: &'a str) -> Option<&'a str> {
    let executable = executable.to_string_lossy();
    let glibc_prefix = format!("{executable}: error while loading shared libraries: ");
    stderr.lines().find(|line| {
        if line.starts_with(&glibc_prefix) { return true; }
        // musl names the object requesting the missing library. That object can
        // be a shared library rather than the executable.
        let Some((failure, requester)) = line.strip_prefix("Error loading shared library ")
            .and_then(|message| message.strip_suffix(')'))
            .and_then(|message| message.rsplit_once(" (needed by ")) else { return false; };
        !requester.is_empty() && failure.split_once(": ")
            .is_some_and(|(library, reason)| !library.is_empty() && !reason.is_empty())
    })
}

#[cfg(not(windows))]
fn run_unix_command(program: &Path, startup_executable: &Path, args: &[std::ffi::OsString], cwd: &Path, extra_env: &[(&str, &Path)], limit: Duration) -> Result<CommandResult, String> {
    // On Linux a pipe binds the process group to the worker. A small Bash
    // watcher owns the read end; only the worker owns the write end. If the
    // worker dies, EOF makes the watcher kill the group, even if the check's
    // leader has already exited. No untrusted argument is interpolated.
    #[cfg(target_os = "linux")]
    let start_failure = format!("ops-watch startup failed {:016x}", rand::random::<u64>());
    #[cfg(target_os = "linux")]
    let bash = ["/bin/bash", "/usr/bin/bash"].into_iter().find(|path| Path::new(path).is_file())
        .ok_or("Linux process containment requires a system Bash")?;
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = zodchi_core::process::command_without_window(bash);
        command.arg("-c").arg(concat!(
            "set -e; start_failure=$1; shift; ",
            // Report failures during watcher setup.
            "trap 'printf \"\\n%s\\n\" \"$start_failure\" >&2' EXIT; ",
            "shopt -s execfail; exec 3<&0; exec </dev/null; ",
            "( IFS= read -r _ <&3 || kill -KILL -- \"-$$\" ) >/dev/null 2>&1 & ",
            "kill -0 \"$!\"; ",
            "exec 3<&-; trap - EXIT; ",
            // execfail makes a failed exec return; under errexit Bash still exits on a failed
            // exec even inside an || list, so errexit is turned off for the final exec only.
            "set +e; exec \"$@\" || { status=$?; printf '\\n%s\\n' \"$start_failure\" >&2; exit \"$status\"; }"
        )).arg("ops-watch").arg(&start_failure).arg(program).args(args);
        command
    };
    #[cfg(not(target_os = "linux"))]
    let mut command = zodchi_core::process::command_without_window(program);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = startup_executable;
        command.args(args);
    }
    command.current_dir(cwd).stdout(Stdio::piped()).stderr(Stdio::piped()).env_clear();
    #[cfg(target_os = "linux")]
    command.stdin(Stdio::piped());
    #[cfg(not(target_os = "linux"))]
    command.stdin(Stdio::null());
    for name in ["PATH", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    command.env("PYTHONDONTWRITEBYTECODE", "1");
    for (name, value) in extra_env { command.env(name, value); }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        #[cfg(target_os = "linux")]
        unsafe {
            command.pre_exec(|| {
                extern "C" { fn prctl(option: i32, ...) -> i32; }
                // Prevent a check from gaining privileges via setuid or file capabilities.
                if prctl(38, 1usize, 0usize, 0usize, 0usize) != 0 { return Err(std::io::Error::last_os_error()); }
                Ok(())
            });
        }
    }
    let mut child = command.spawn().map_err(|e| format!("Cannot start {}: {e}", program.display()))?;
    // Keep the write end alive until the process group has been stopped.
    #[cfg(target_os = "linux")]
    let _lifetime = child.stdin.take().ok_or("Missing containment pipe")?;
    let pid = child.id();
    let collect = |mut stream: Box<dyn Read + Send>| {
        let (send, recv) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut captured = Vec::new();
            let mut buffer = [0u8; 4096];
            while let Ok(n) = stream.read(&mut buffer) {
                if n == 0 { break; }
                let remaining = 16384usize.saturating_sub(captured.len());
                captured.extend_from_slice(&buffer[..n.min(remaining)]);
            }
            let _ = send.send(String::from_utf8_lossy(&captured).into_owned());
        });
        recv
    };
    let stdout = collect(Box::new(child.stdout.take().ok_or("Missing stdout pipe")?));
    let stderr = collect(Box::new(child.stderr.take().ok_or("Missing stderr pipe")?));
    let started = Instant::now();
    let wait = loop {
        match child.try_wait() {
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(25)),
            result => break result,
        }
    };
    let timed_out = matches!(wait, Ok(None));
    let status = match wait {
        Ok(Some(status)) => Ok(status),
        other => {
            zodchi_core::process::kill_tree(pid);
            let _ = child.kill();
            let reaped = child.wait();
            other.and(reaped)
        }
    };
    // On Unix, also stop children that survived a successfully exited leader.
    #[cfg(unix)]
    checks::end_group(pid)?;
    let status = status.map_err(|error| format!("Cannot wait for the check process: {error}"))?;
    let stdout = stdout.recv_timeout(Duration::from_secs(2)).map_err(|_| "The process output did not close")?;
    let stderr = stderr.recv_timeout(Duration::from_secs(2)).map_err(|_| "The process error output did not close")?;
    #[cfg(target_os = "linux")]
    if let Some(diagnostic) = stderr.strip_suffix(&format!("\n{start_failure}\n")) {
        return Err(format!("Cannot start the check process: {}", diagnostic.trim()));
    }
    // The dynamic loader can fail after exec replaces Bash, leaving no startup marker.
    // Exit 127 also belongs to checks, so require a shared-library loader diagnostic.
    #[cfg(target_os = "linux")]
    if !timed_out && status.code() == Some(127) && stdout.is_empty() {
        if let Some(diagnostic) = linux_loader_diagnostic(startup_executable, &stderr)
            .or_else(|| linux_loader_diagnostic(Path::new(bash), &stderr)) {
            return Err(format!("Cannot start the check process: {diagnostic}"));
        }
    }
    Ok(CommandResult {
        check: None,
        input_index: None,
        code: status.code(),
        stdout,
        stderr,
        timed_out,
    })
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn shell_path(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or("Path is not Unicode")?;
    #[cfg(windows)]
    {
        let text = text.strip_prefix(r"\\?\").unwrap_or(text).replace('\\', "/");
        let bytes = text.as_bytes();
        if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || bytes[2] != b'/' {
            return Err("The snapshot needs a local drive path for Git Bash".into());
        }
        Ok(format!("/{}/{}", (bytes[0] as char).to_ascii_lowercase(), &text[3..]))
    }
    #[cfg(not(windows))]
    { Ok(text.to_owned()) }
}

fn interpreter_path(path: &Path) -> Result<std::ffi::OsString, String> {
    #[cfg(windows)]
    {
        let text = path.to_str().ok_or("Path is not Unicode")?;
        let text = text.strip_prefix(r"\\?\").unwrap_or(text);
        if text.starts_with("UNC\\") { return Err("UNC snapshot paths are not supported".into()); }
        Ok(text.into())
    }
    #[cfg(not(windows))]
    { Ok(path.as_os_str().to_owned()) }
}

/// Human-only shell text: no privileged process is started by the workflow.
/// The expected digests are literal values from the receipt, not a mutable
/// manifest next to the script.
fn local_human_command(snapshot: &Snapshot, sudo: &[String], interpreter: Option<&Path>) -> Result<String, String> {
    verify_snapshot(snapshot)?;
    let dir = shell_path(&snapshot.dir)?;
    let script = shell_path(&snapshot.dir.join(&snapshot.files[0].name))?;
    let lines = snapshot.files.iter().map(|file| {
        if file.name.contains('\\') {
            format!("\\{}  {}", file.sha256, file.name.replace('\\', "\\\\"))
        } else {
            format!("{}  {}", file.sha256, file.name)
        }
    }).map(|line| quote(&line)).collect::<Vec<_>>().join(" ");
    let resolved = interpreter.map(shell_path).transpose()?;
    let command = sudo.iter().enumerate().map(|(i, word)| quote(if word == "{script}" { &script } else if i == 1 { resolved.as_deref().unwrap_or(word) } else { word }))
        .collect::<Vec<_>>().join(" ");
    let mut checks = Vec::new();
    for (index, file) in snapshot.files.iter().enumerate() {
        let name = quote(&format!("./{}", file.name));
        checks.push(format!("[ -f {name} ] && [ ! -L {name} ]"));
        for previous in &snapshot.files[..index] {
            checks.push(format!("[ ! {name} -ef {} ]", quote(&format!("./{}", previous.name))));
        }
    }
    Ok(format!("([ ! -L {dir} ] && cd -- {dir} && unset GLOBIGNORE && set +f && shopt -s dotglob nullglob && set -- * && [ \"$#\" -eq {count} ] && {checks} && printf '%s\\n' {lines} | sha256sum -c - && {command})",
        dir = quote(&dir), count = snapshot.files.len(), checks = checks.join(" && ")))
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let name_path = Path::new(name);
    if name_path.is_absolute() { return name_path.is_file().then(|| name_path.to_path_buf()); }
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        if dir.as_os_str().is_empty() { continue; }
        #[cfg(windows)]
        let candidates = [dir.join(format!("{name}.exe")), dir.join(name)];
        #[cfg(not(windows))]
        let candidates = [dir.join(name)];
        for candidate in candidates {
            if candidate.is_file() { return Some(if candidate.is_absolute() { candidate } else { std::env::current_dir().ok()?.join(candidate) }); }
        }
    }
    None
}

fn find_checksum_tool(bash: &Path) -> Option<PathBuf> {
    if let Some(tool) = find_tool("sha256sum") { return Some(tool); }
    #[cfg(windows)]
    {
        for ancestor in bash.ancestors().take(5) {
            for path in [ancestor.join("usr/bin/sha256sum.exe"), ancestor.join("bin/sha256sum.exe")] {
                if path.is_file() { return Some(path); }
            }
        }
    }
    let _ = bash;
    None
}

#[derive(Debug)]
struct Tools {
    bash: PathBuf,
    python: Option<PathBuf>,
    shellcheck: Option<PathBuf>,
}

fn working_python(program: &Path, cwd: &Path) -> bool {
    static PROBES: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<bool>>>>> =
        LazyLock::new(Mutex::default);
    // Serialize probes of the same interpreter and retry failures on the next use.
    let probe = PROBES.lock().unwrap().entry(program.to_owned()).or_default().clone();
    let mut verified = probe.lock().unwrap();
    if !*verified {
        // Use the same import isolation as the static check.
        let argv = ["-I".into(), "-B".into(), "-c".into(),
            "import py_compile, sys; print('Python', sys.version.split()[0])".into()];
        *verified = run_command(program, &argv, cwd, &[], Duration::from_secs(60))
            .is_ok_and(|result| !result.timed_out && result.code == Some(0)
                && result.stdout.lines().any(|line| line.starts_with("Python 3.")));
    }
    *verified
}

/// Resolve and try required tools before a snapshot or a remote side effect.
fn preflight_tools(args: &Args) -> Result<Tools, String> {
    validate_direct(&args.check, &args.inputs[0])?;
    let configured_bash = checks::find_bash();
    let bash = find_tool(configured_bash.to_str().ok_or("Bash path is not Unicode")?)
        .ok_or("Bash is required")?;
    let checksum = find_checksum_tool(&bash).ok_or("sha256sum is required for the operator command")?;
    let needs_python = args.inputs.iter().any(|path| script_kind(path).is_ok_and(|kind| kind == Some("python")))
        || args.check.first().is_some_and(|word| word == "python" || word == "python3");
    let python = if needs_python {
        let direct_python = if args.check.first().map(String::as_str) == Some("{copy}") && script_kind(&args.inputs[0])? == Some("python") {
            Some(direct_interpreter(&args.inputs[0])?)
        } else { None };
        let names: &[&str] = match args.check.first().map(String::as_str) {
            Some("python") => &["python"],
            Some("python3") => &["python3"],
            _ => &["python3", "python"],
        };
        let candidates: Vec<PathBuf> = if let Some(path) = direct_python { vec![path] } else { names.iter().filter_map(|name| find_tool(name)).collect() };
        Some(candidates.into_iter().find(|path| working_python(path, &args.tmp))
            .ok_or("A working Python 3 interpreter with isolated py_compile is required")?)
    } else { None };
    let shellcheck = find_tool("shellcheck");
    let programs = [(&bash, "GNU bash"), (&checksum, "sha256sum")].into_iter()
        .chain(shellcheck.iter().map(|path| (path, "ShellCheck")));
    for (program, expected) in programs {
        let result = run_command(program, &["--version".into()], &args.tmp, &[], Duration::from_secs(10))?;
        if result.timed_out || result.code != Some(0) || !format!("{}{}", result.stdout, result.stderr).contains(expected) {
            return Err(format!("Required tool failed its version check: {}", program.display()));
        }
    }
    Ok(Tools { bash, python, shellcheck })
}

/// Check the named script plus script companions; other companions remain
/// data. The caller records the effect and sanitizes excerpts before storing.
fn script_kind(path: &Path) -> Result<Option<&'static str>, String> {
    let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    let suffix = if extension.eq_ignore_ascii_case("py") { Some("python") }
        else if extension.eq_ignore_ascii_case("sh") || extension.eq_ignore_ascii_case("bash") { Some("shell") }
        else { None };
    let bytes = regular_bytes(path)?;
    let first = bytes.split(|b| *b == b'\n').next().unwrap_or_default();
    if first.starts_with(b"#!") {
        let shebang = String::from_utf8_lossy(first);
        let interpreter = shebang[2..].trim();
        let words: Vec<_> = interpreter.split_whitespace().collect();
        let kind = match words.as_slice() {
            ["/usr/bin/env" | "/bin/env", "python" | "python3"]
            | ["/usr/bin/python" | "/usr/bin/python3" | "/usr/local/bin/python" | "/usr/local/bin/python3"] => "python",
            ["/usr/bin/env" | "/bin/env", "bash" | "sh"]
            | ["/bin/bash" | "/usr/bin/bash" | "/bin/sh" | "/usr/bin/sh"] => "shell",
            [path] if Path::new(path).is_absolute() && matches!(Path::new(path).file_name().and_then(|n| n.to_str()), Some("python" | "python3")) => "python",
            _ => return Err("Unsupported script companion interpreter".into()),
        };
        if suffix.is_some_and(|expected| expected != kind) { return Err("Script suffix conflicts with its interpreter".into()); }
        return Ok(Some(kind));
    }
    Ok(suffix)
}

fn static_checks(snapshot: &Snapshot, tools: &Tools, cache: &Path, shellcheck_ran: &mut usize) -> Result<Vec<CommandResult>, String> {
    let mut results = Vec::new();
    for (index, file) in snapshot.files.iter().enumerate() {
        let path = snapshot.dir.join(&file.name);
        let kind = script_kind(&path)?;
        let python = kind == Some("python");
        let shell = kind == Some("shell") || index == 0 && !python;
        let mut commands: Vec<(&Path, Vec<std::ffi::OsString>, bool)> = Vec::new();
        if python {
            commands.push((tools.python.as_deref().ok_or("Python was not preflighted")?, vec!["-I".into(), "-X".into(), format!("pycache_prefix={}", cache.display()).into(), "-m".into(), "py_compile".into(), interpreter_path(&path)?], true));
        } else if shell {
            commands.push((&tools.bash, vec!["-n".into(), "--".into(), shell_path(&path)?.into()], false));
            if let Some(shellcheck) = &tools.shellcheck {
                commands.push((shellcheck, vec!["--severity=warning".into(), "--".into(), path.as_os_str().to_owned()], false));
            }
        }
        for (program, argv, needs_cache) in commands {
            verify_snapshot(snapshot)?;
            let env = if needs_cache { vec![("PYTHONPYCACHEPREFIX", cache)] } else { Vec::new() };
            let label = if tools.shellcheck.as_deref() == Some(program) { *shellcheck_ran += 1; "shellcheck" } else if needs_cache { "py_compile" } else { "bash -n" };
            let result = run_command(program, &argv, &snapshot.dir, &env, Duration::from_secs(30));
            verify_snapshot(snapshot)?;
            let mut result = result?;
            result.check = Some(format!("{}: {}", file.name, label));
            result.input_index = Some(index);
            let failed = result.timed_out || result.code != Some(0);
            results.push(result);
            if failed { return Ok(results); }
        }
    }
    Ok(results)
}

#[cfg(not(windows))]
fn direct_interpreter(script: &Path) -> Result<PathBuf, String> {
    let bytes = regular_bytes(script)?;
    let line = bytes.split(|b| *b == b'\n').next().unwrap_or_default();
    if !line.starts_with(b"#!") || line.contains(&b'\r') || line.contains(&0) || line.len() >= 255 { return Err("Direct checks require a supported LF shebang".into()); }
    let raw = std::str::from_utf8(&line[2..]).map_err(|_| "Invalid direct shebang")?;
    let name = raw.trim_matches(|c| c == ' ' || c == '\t');
    let python = Path::new(name).is_absolute() && matches!(Path::new(name).file_name().and_then(|n| n.to_str()), Some("python" | "python3"));
    if name.contains([' ', '\t']) || !(python || matches!(name, "/bin/bash" | "/usr/bin/bash" | "/bin/sh" | "/usr/bin/sh")) {
        return Err("Unsupported direct shebang interpreter".into());
    }
    use std::os::unix::fs::PermissionsExt;
    let executable = Path::new(name);
    if !fs::metadata(executable).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) {
        return Err(format!("Direct shebang executable is unavailable: {name}"));
    }
    Ok(executable.to_path_buf())
}

#[cfg(windows)]
fn direct_interpreter(_script: &Path) -> Result<PathBuf, String> { Err("Direct checks are unavailable on Windows; declare an interpreter".into()) }

fn validate_direct(check: &[String], script: &Path) -> Result<(), String> {
    if check.first().map(String::as_str) != Some("{copy}") { return Ok(()); }
    #[cfg(windows)]
    { let _ = script; return Err("Direct checks are unavailable on Windows; declare an interpreter".into()); }
    #[cfg(not(windows))]
    {
        direct_interpreter(script)?;
        Ok(())
    }
}

/// Run a validated check template without a shell wrapper. The workflow must
/// journal an intent before this call; interruption is an unresolved effect.
fn local_dry_run(snapshot: &Snapshot, args: &Args, tools: &Tools) -> Result<CommandResult, String> {
    unprivileged()?;
    validate_check_argv(&args.check)?;
    verify_snapshot(snapshot)?;
    let copy = snapshot.dir.join(&snapshot.files[0].name);
    let direct = args.check[0] == "{copy}";
    let python = if direct {
        script_kind(&copy)? == Some("python")
    } else {
        args.check[0] == "python" || args.check[0] == "python3"
    };
    #[cfg(unix)]
    if direct {
        let interpreter = direct_interpreter(&copy)?;
        let command_args: Vec<std::ffi::OsString> = args.check[1..].iter().map(std::ffi::OsString::from).collect();
        let result = run_unix_command(&copy, &interpreter, &command_args, &snapshot.dir, &[], Duration::from_secs(60));
        verify_snapshot(snapshot)?;
        return result;
    }
    #[cfg(windows)]
    if direct { return Err("Direct checks are unavailable on Windows; declare an interpreter".into()); }
    let program = if python { tools.python.as_deref().ok_or("Python was not preflighted")? } else { &tools.bash };
    let script: std::ffi::OsString = if python { interpreter_path(&copy)? } else { shell_path(&copy)?.into() };
    let mut command_args = vec![script];
    let start = if direct { 1 } else { 2 };
    command_args.extend(args.check[start..].iter().map(std::ffi::OsString::from));
    let result = run_command(program, &command_args, &snapshot.dir, &[], Duration::from_secs(60));
    verify_snapshot(snapshot)?;
    result
}

#[derive(Debug, PartialEq)]
enum EffectState {
    Pending,
    Unresolved,
    Complete(Value),
}

/// Read a single journaled effect. An intent without a result is never replayed
/// automatically: the process may have reached a host or executed a script.
fn effect_state(events: &[Value], step: &str) -> Result<EffectState, String> {
    let mut state = EffectState::Pending;
    for event in events.iter().filter(|event| event["step"] == step) {
        match event["kind"].as_str() {
            Some("ops-start") if state == EffectState::Pending => state = EffectState::Unresolved,
            Some("ops-done") if state == EffectState::Unresolved && event.get("result").is_some() => {
                state = EffectState::Complete(event["result"].clone());
            }
            Some("ops-start" | "ops-done") => return Err(format!("Invalid journal history for {step}")),
            _ => (),
        }
    }
    Ok(state)
}

fn outcome(result: Value) -> Exit {
    Exit { code: if result["ready"] == true { 0 } else { 2 }, result }
}

pub fn project_status_result(run: &Value, result: Value) -> Value {
    if run["workflow"] == NAME {
        checked_result(run, result)
    } else {
        result
    }
}

fn checked_result(run: &Value, mut result: Value) -> Value {
    if result["ready"] != true { return result; }
    let verified = Args::parse_mode(&run["inputs"]["args"], false)
        .and_then(|args| Snapshot::restore(&result["snapshot"], &args.tmp, &args.inputs).map(|_| ()));
    if let Err(error) = verified {
        result["ready"] = json!(false);
        result["status"] = json!("changed");
        result["refused"] = json!(error);
        if let Some(fields) = result.as_object_mut() { fields.remove("forHuman"); }
    }
    result
}

pub fn start(raw: &Value, launch: Option<Launch>, repair: &RepairHooks) -> zodchi_core::util::Result<Exit> {
    let prepared = (|| -> Result<(Args, Tools), String> {
        let args = Args::parse(raw)?;
        if args.remote.is_some() {
            return Err("Remote mode is not available in this build; no remote action was started".into());
        }
        unprivileged()?;
        let tools = preflight_tools(&args)?;
        Ok((args, tools))
    })();
    let (args, _) = match prepared {
        Ok(value) => value,
        Err(reason) => return Ok(outcome(json!({ "workflow": NAME, "ready": false, "refused": reason }))),
    };
    let cfg = Config::new(None)?;
    let id = journal::new_run_id();
    let run = json!({ "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"),
        "createdAt": iso(), "repo": args.repo, "inputs": { "args": raw } });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    if let Some(launch) = launch { launch(&journal, &id) } else { resume(&id, None, None, repair) }
}

/// Journal the intention before the effect. A recorded start without a result
/// is unresolved on resume; it is never sent again automatically.
fn effect<F>(journal: &mut Journal, step: &str, run: F) -> zodchi_core::util::Result<Option<Value>>
where F: FnOnce() -> Value {
    match effect_state(journal.events(), step).map_err(GatewayError)? {
        EffectState::Complete(value) => Ok(Some(value)),
        EffectState::Unresolved => Ok(None),
        EffectState::Pending => {
            journal.append(json!({ "kind": "ops-start", "step": step }))?;
            boundary::cut(&format!("ops-start {step}"));
            let value = run();
            boundary::cut(&format!("ops-effect {step}"));
            journal.append(json!({ "kind": "ops-done", "step": step, "result": value }))?;
            boundary::cut(&format!("ops-done {step}"));
            Ok(Some(value))
        }
    }
}

fn unresolved(id: &str, step: &str) -> Exit {
    outcome(json!({ "workflow": NAME, "runId": id, "ready": false, "status": "unresolved", "step": step,
        "next": "Inspect the prior effect and start a new run after resolving it; it was not repeated." }))
}

fn finish(journal: &mut Journal, result: Value) -> zodchi_core::util::Result<Exit> {
    journal.write_value("result.json", &result)?;
    journal.append(json!({ "kind": "finished", "step": "result" }))?;
    Ok(outcome(result))
}

fn repair_scope(args: &Args) -> Option<(PathBuf, Vec<String>)> {
    let repo = fs::canonicalize(args.repo.as_ref()?).ok()?;
    if !repo.is_dir() { return None; }
    let cfg = Config::new(None).ok()?;
    let scrubber = input_common::Scrubber::new(&cfg).ok()?;
    let mut files = Vec::new();
    for (index, source) in args.inputs.iter().enumerate() {
        // Companions remain local unless explicitly selected by the caller.
        if index != 0 {
            if !args.repair_files.contains(source) { continue; }
            if let Some(ext) = source.extension() {
                let ext = ext.to_str()?;
                if !["py", "sh", "bash"].iter().any(|kind| ext.eq_ignore_ascii_case(kind)) { return None; }
            }
            if script_kind(source).ok()?.is_none() { return None; }
        }
        let path = fs::canonicalize(source).ok()?;
        let relative = path.strip_prefix(&repo).ok()?;
        if relative.as_os_str().is_empty() || fs::OpenOptions::new().write(true).open(&path).is_err() { return None; }
        let text = String::from_utf8(regular_bytes(&path).ok()?).ok()?;
        if text.lines().any(|line| scrubber.private(line) || checks::credential_line(line)
            || (line.to_ascii_uppercase().contains("-----BEGIN ") && line.to_ascii_uppercase().contains("PRIVATE KEY-----"))) {
            return None;
        }
        let relative = relative.to_str()?;
        #[cfg(windows)]
        let relative = relative.replace('\\', "/");
        #[cfg(not(windows))]
        let relative = {
            // The code-package path parser treats backslashes as separators.
            if relative.contains('\\') { return None; }
            relative.to_owned()
        };
        // The child parser deduplicates relative paths case-insensitively on
        // every platform. Refuse a scope it would silently shrink.
        if files.iter().any(|file: &String| file.to_lowercase() == relative.to_lowercase()) { return None; }
        files.push(relative);
    }
    // The package claim normalizer expects a drive path, not Windows'
    // verbatim prefix; keeping it would create a separate claim namespace.
    #[cfg(windows)]
    let repo = {
        use std::path::{Component, Prefix};
        let text = repo.to_str()?.strip_prefix(r"\\?\")?;
        let path = PathBuf::from(text);
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))) { return None; }
        path
    };
    Some((repo, files))
}

// Older receipts have only a label. Match the entire known label, since a
// basename can itself contain the delimiter or another input's basename.
fn failed_unselected_static(step: &str, detail: &Value, args: &Args) -> bool {
    if !step.starts_with("static ") { return false; }
    detail["checks"].as_array().is_some_and(|checks| checks.iter().any(|check| {
        if check["timedOut"] != true && check["code"] == 0 { return false; }
        let index = if let Some(value) = check.get("inputIndex") {
            value.as_u64().and_then(|n| usize::try_from(n).ok())
        } else {
            check["check"].as_str().and_then(|label| args.inputs.iter().position(|path| {
                path.file_name().and_then(|name| name.to_str()).is_some_and(|name|
                    ["py_compile", "bash -n", "shellcheck"].iter().any(|kind| label == format!("{name}: {kind}")))
            }))
        };
        index.and_then(|i| args.inputs.get(i).map(|path| (i, path)))
            .is_some_and(|(i, path)| i != 0 && !args.repair_files.contains(path))
    }))
}

fn nonzero_check_exit(code: &Value) -> bool {
    let Some(code) = code.as_i64().and_then(|code| i32::try_from(code).ok()) else { return false; };
    // Older Windows receipts stored loader failures as signed exit codes.
    #[cfg(windows)]
    if windows_job::failed_to_initialize(code as u32) { return false; }
    code != 0
}

// Use the recorded command results so a resume makes the same repair decision.
fn repairable_failure(step: &str, detail: &Value) -> bool {
    if detail.get("error").is_some() { return false; }
    if step.starts_with("static ") {
        return detail["checks"].as_array().is_some_and(|checks| checks.iter().any(|check| {
            // A command killed by a signal records a null exit code on Unix.
            check["timedOut"] == false
                && check.get("code").is_some_and(|code| code.is_null() || nonzero_check_exit(code))
        }));
    }
    step.starts_with("dry ") && (detail["timedOut"] == true || nonzero_check_exit(&detail["code"]))
}

fn failed(
    journal: &mut Journal,
    id: &str,
    args: &Args,
    attempt: u64,
    step: &str,
    detail: Value,
    repair: &RepairHooks,
) -> zodchi_core::util::Result<Exit> {
    let prior = journal.events().iter().find(|event| event["kind"] == "ops-repair" && event["attempt"] == attempt).cloned();
    if attempt >= args.fixes || (prior.is_none() && !repairable_failure(step, &detail)) {
        return finish(journal, json!({ "workflow": NAME, "runId": id, "ready": false, "status": "failed", "step": step, "detail": detail }));
    }
    let scope = if prior.is_none() && !failed_unselected_static(step, &detail, args) { repair_scope(args) } else { None };
    if prior.is_some() || scope.is_some() {
        let first = prior.is_none();
        let event = if let Some(event) = prior { event } else {
            let (repo, files) = scope.ok_or_else(|| GatewayError("Repair scope is unavailable".into()))?;
            let child = journal::new_run_id();
            let cfg = Config::new(None)?;
            let scrubber = input_common::Scrubber::new(&cfg)?;
            let mut places: Vec<(String, &str)> = args.inputs.iter().map(|path| (path.display().to_string(), "[input]")).collect();
            places.push((args.tmp.display().to_string(), "[tmp]"));
            places.push((repo.display().to_string(), "[repo]"));
            places.push((cfg.home.display().to_string(), "[home]"));
            if let Some(paths) = std::env::var_os("PATH") {
                places.extend(std::env::split_paths(&paths).filter(|path| path.is_absolute()).map(|path| (path.display().to_string(), "[tool-dir]")));
            }
            if let Some(path) = std::env::var_os("ZODCHI_BASH") { places.push((PathBuf::from(path).display().to_string(), "[tool]")); }
            for key in ["bash", "python", "interpreter"] {
                if let Some(path) = detail[key].as_str() { places.push((path.to_owned(), "[tool]")); }
            }
            let mut model_detail = detail.clone();
            scrubber.value(&mut model_detail, &places);
            if files.len() < args.inputs.len() {
                // A check can echo arbitrary companion data without any secret
                // marker. Keep its free-form output in the local receipt only.
                fn omit_output(value: &mut Value) {
                    match value {
                        Value::Object(fields) => {
                            // Static check labels include snapshot basenames, which
                            // can identify a companion excluded from the claim.
                            for key in ["stdout", "stderr", "error", "check"] { fields.remove(key); }
                            for child in fields.values_mut() { omit_output(child); }
                        }
                        Value::Array(items) => items.iter_mut().for_each(omit_output),
                        _ => (),
                    }
                }
                omit_output(&mut model_detail);
            }
            let brief = format!("Repair the operator script or its named companions only. A {} failed: {}\nDo not execute privileged commands or expand the file claim. The repaired snapshot will be checked separately.\n", step, model_detail);
            // A cut after writing the brief but before recording the child
            // leaves an orphan, so each prospective child gets a fresh path.
            let brief_path = journal.write_text(&format!("repair-{attempt}-{child}.md"), &brief)?;
            let mut models = args.models.clone();
            if let Some(writer) = &args.writer {
                models.insert("expertWriter".into(), json!({ "candidates": [{ "provider": "claude", "model": writer }] }));
            }
            let raw = json!({ "label": format!("ops-{id}-{attempt}"), "brief": brief_path, "repo": repo,
                "files": files, "rounds": 1, "fixes": 0, "models": models });
            let event = json!({ "kind": "ops-repair", "attempt": attempt, "child": child, "args": raw });
            journal.append(event.clone())?;
            boundary::cut(&format!("ops-repair {attempt}"));
            event
        };
        let child = event["child"].as_str().ok_or_else(|| GatewayError("Missing repair child id".into()))?;
        let cfg = Config::new(None)?;
        let child_dir = journal::flows_dir(&cfg.home).join(child);
        let result = if first {
            (repair.start)(&event["args"], child)
        } else if child_dir.join("initialized").is_file() {
            // Preserve the initialized repair's direct lock acquisition and result handling.
            (repair.resume)(child, &event["args"])
        } else {
            // A cut in the code-package gate may have interrupted a model
            // preflight before the child journal existed; never repeat it.
            return Ok(unresolved(id, &format!("repair {attempt} ({child})")));
        };
        match result {
            Ok(exit) if exit.result["approved"] == true => {
                journal.append(json!({ "kind": "ops-fix-done", "attempt": attempt, "child": child }))?;
                return Ok(outcome(json!({ "workflow": NAME, "runId": id, "status": "retry" })));
            }
            Ok(exit) if (!child_dir.exists() && exit.result.get("refused").is_some()) ||
                Journal::open(&cfg.home, child).ok().and_then(|(j, _)| j.snapshot().ok())
                    .is_some_and(|events| events.iter().any(|e| e["kind"] == "finished")) => {
                let reason = ["reason", "question", "infra", "refused", "next", "stoppedAt", "verdict"].iter()
                    .filter_map(|key| exit.result.get(*key)).find(|value| !value.is_null() && value.as_str() != Some(""))
                    .cloned().unwrap_or_else(|| json!("Repair completed without approval"));
                let question = "The repair was not approved. Fix only the named original script or companions, then reply to this run.";
                journal.append(json!({ "kind": "waiting", "step": step, "question": question, "detail": detail, "attempt": attempt, "child": child, "reason": reason }))?;
                return Ok(outcome(json!({ "workflow": NAME, "runId": id, "ready": false, "status": "waiting", "step": step, "question": question, "detail": detail, "childRunId": child, "reason": reason, "files": args.inputs })));
            },
            _ => return Ok(outcome(json!({ "workflow": NAME, "runId": id, "ready": false, "status": "waiting-repair",
                "childRunId": child, "next": "Resolve or resume the existing code-package run, then resume this run." }))),
        }
    }
    let question = "Fix only the named original script or companions, then reply to this run. A fresh snapshot will be checked.";
    journal.append(json!({ "kind": "waiting", "step": step, "question": question, "detail": detail, "attempt": attempt }))?;
    Ok(outcome(json!({ "workflow": NAME, "runId": id, "ready": false, "status": "waiting", "step": step,
        "question": question, "detail": detail, "files": args.inputs })))
}

pub fn resume(
    id: &str,
    given: Option<&Value>,
    retry: Option<&str>,
    repair: &RepairHooks,
) -> zodchi_core::util::Result<Exit> {
    loop {
        let exit = resume_once(id, given, retry, repair)?;
        if exit.result["status"] != "retry" { return Ok(exit); }
    }
}

fn resume_once(
    id: &str,
    given: Option<&Value>,
    retry: Option<&str>,
    repair: &RepairHooks,
) -> zodchi_core::util::Result<Exit> {
    let cfg = Config::new(None)?;
    resume_guarded_with_repair(id, given, retry, &cfg, unprivileged, repair)
}

fn resume_guarded_with_repair(
    id: &str,
    given: Option<&Value>,
    retry: Option<&str>,
    cfg: &Config,
    guard: impl FnOnce() -> Result<(), String>,
    repair: &RepairHooks,
) -> zodchi_core::util::Result<Exit> {
    let (mut journal, run) = Journal::open(&cfg.home, id)?;
    if run["workflow"] != NAME || run["version"] != VERSION || given.is_some_and(|value| value != &run["inputs"]["args"]) {
        return fail("The run does not match this ops-script command.");
    }
    if retry.is_some() { return fail("ops-script does not replay effects with --rerun."); }
    let _lock = journal.lock()?;
    journal.load()?;
    if let Some(result) = journal.read_value("result.json") {
        let result = checked_result(&run, result);
        if !journal.events().iter().any(|event| event["kind"] == "finished") {
            journal.append(json!({ "kind": "finished", "step": "result" }))?;
        }
        return Ok(outcome(result));
    }
    if journal.last_event().is_some_and(|event| event["kind"] == "waiting") {
        let waiting = journal.last_event().unwrap();
        return Ok(outcome(json!({ "workflow": NAME, "runId": id, "ready": false, "status": "waiting", "question": waiting["question"], "childRunId": waiting["child"], "reason": waiting["reason"] })));
    }
    guard().map_err(GatewayError)?;
    let attempt = journal.events().iter().filter(|event| event["kind"] == "waiting" || event["kind"] == "ops-fix-done").count() as u64;
    let mut recorded_failure = None;
    for step in [format!("snapshot {attempt}"), format!("static {attempt}"), format!("dry {attempt}")] {
        match effect_state(journal.events(), &step).map_err(GatewayError)? {
            EffectState::Unresolved => return Ok(unresolved(id, &step)),
            EffectState::Complete(detail) if detail["ok"] != true => { recorded_failure = Some((step, detail)); break; },
            _ => (),
        }
    }
    if let Some((ref step, ref detail)) = recorded_failure {
        if journal.events().iter().any(|event| event["kind"] == "ops-repair" && event["attempt"] == attempt) {
            let args = Args::parse_mode(&run["inputs"]["args"], false).map_err(GatewayError)?;
            return failed(&mut journal, id, &args, attempt, step, detail.clone(), repair);
        }
    }
    let mut args = match Args::parse_mode(&run["inputs"]["args"], false) {
        Ok(args) => args,
        Err(error) => {
            if let Some((step, detail)) = recorded_failure {
                return finish(&mut journal, json!({ "workflow": NAME, "runId": id, "ready": false,
                    "status": "failed", "step": step, "detail": detail, "next": format!("Restore the input paths before a new run: {error}") }));
            }
            return Err(GatewayError(error));
        }
    };
    if args.remote.is_some() { return fail("Remote mode is not available in this build."); }
    // A recorded failure or interrupted effect must survive even if that effect
    // damaged the snapshot. Never restore or run a new check before this audit.
    if let Some((step, detail)) = recorded_failure { return failed(&mut journal, id, &args, attempt, &step, detail, repair); }
    let scrubber = input_common::Scrubber::new(cfg)?;
    let mut places: Vec<(String, &str)> = args.inputs.iter().map(|path| (path.display().to_string(), "[input]")).collect();
    places.push((args.tmp.display().to_string(), "[tmp]"));
    if let Some(repo) = &args.repo { places.push((repo.display().to_string(), "[repo]")); }
    let clean = |text: &str| scrubber.text(text, &places);

    let step = format!("snapshot {attempt}");
    let Some(made) = effect(&mut journal, &step, || match Args::parse(&run["inputs"]["args"]).and_then(|_| capture_snapshot(&args.tmp, &args.inputs)).and_then(|snap| snap.receipt()) {
        Ok(receipt) => json!({ "ok": true, "snapshot": receipt }),
        Err(error) => json!({ "ok": false, "error": clean(&error) }),
    })? else { return Ok(unresolved(id, &step)); };
    if made["ok"] != true { return failed(&mut journal, id, &args, attempt, &step, made, repair); }
    let restored = Snapshot::restore(&made["snapshot"], &args.tmp, &args.inputs).and_then(|snapshot| {
        if run["inputs"]["args"].get("check").is_none() {
            let interpreter = if script_kind(&snapshot.dir.join(&snapshot.files[0].name))? == Some("python") { "python3" } else { "bash" };
            args.check = vec![interpreter.into(), "{copy}".into(), "--check".into()];
        }
        validate_interpreter_parity(&args.check, &args.sudo)?;
        Ok(snapshot)
    });
    let snapshot = match restored {
        Ok(snapshot) => snapshot,
        Err(error) => return failed(&mut journal, id, &args, attempt, &step, json!({ "ok": false, "error": clean(&error) }), repair),
    };
    let mut snapshot_args = args.clone();
    snapshot_args.inputs = snapshot.files.iter().map(|file| snapshot.dir.join(&file.name)).collect();
    let step = format!("static {attempt}");
    let cache = journal.file(&format!("pycache-{attempt}"));
    let Some(checked) = effect(&mut journal, &step, || match preflight_tools(&snapshot_args).and_then(|tools| {
        let applicable = snapshot_args.inputs.iter().enumerate().filter(|(i, p)| script_kind(p).is_ok_and(|k| k == Some("shell") || *i == 0 && k != Some("python"))).count();
        let mut ran = 0;
        static_checks(&snapshot, &tools, &cache, &mut ran).map(|results| (results, tools, applicable, ran))
    }) {
        Ok((results, tools, applicable, ran)) => json!({ "ok": results.iter().all(|r| !r.timed_out && r.code == Some(0)),
            "bash": tools.bash, "python": tools.python,
            "checks": results.iter().map(|r| json!({ "check": r.check, "inputIndex": r.input_index, "code": r.code, "timedOut": r.timed_out,
                "stdout": clean(&r.stdout), "stderr": clean(&r.stderr) })).collect::<Vec<_>>(),
            "shellcheck": if applicable == 0 { "not applicable" } else if tools.shellcheck.is_none() { "not installed" } else if ran == applicable { "checked" } else { "not reached" } }),
        Err(error) => json!({ "ok": false, "error": clean(&error) }),
    })? else { return Ok(unresolved(id, &step)); };
    if checked["ok"] != true { return failed(&mut journal, id, &args, attempt, &step, checked, repair); }
    let step = format!("dry {attempt}");
    let Some(dry) = effect(&mut journal, &step, || match (|| -> Result<_, String> {
        validate_direct(&args.check, &snapshot_args.inputs[0])?;
        let bash = checked["bash"].as_str().ok_or("Static receipt lacks the resolved Bash executable")?;
        let tools = Tools { bash: PathBuf::from(bash), python: checked["python"].as_str().map(PathBuf::from), shellcheck: None };
        let interpreter = match args.check[0].as_str() {
            "{copy}" => None,
            "bash" => Some(tools.bash.clone()),
            _ => Some(tools.python.clone().ok_or("Static receipt lacks the resolved Python executable")?),
        };
        local_dry_run(&snapshot, &args, &tools).map(|r| (r, interpreter))
    })() {
        Ok((r, interpreter)) => json!({ "ok": !r.timed_out && r.code == Some(0), "code": r.code, "timedOut": r.timed_out,
            "stdout": clean(&r.stdout), "stderr": clean(&r.stderr), "interpreter": interpreter }),
        Err(error) => json!({ "ok": false, "error": clean(&error) }),
    })? else { return Ok(unresolved(id, &step)); };
    if dry["ok"] != true { return failed(&mut journal, id, &args, attempt, &step, dry, repair); }
    let interpreter = dry["interpreter"].as_str().map(Path::new);
    if args.check[0] != "{copy}" && interpreter.is_none() { return Err(GatewayError("Dry-run receipt lacks the resolved interpreter".into())); }
    let command = local_human_command(&snapshot, &args.sudo, interpreter).map_err(GatewayError)?;
    finish(&mut journal, json!({ "workflow": NAME, "version": VERSION, "runId": id, "ready": true,
        "snapshot": made["snapshot"], "static": checked, "dry": dry, "nopass": args.nopass, "forHuman": command }))
}

/// A snapshot receipt contains paths and digests, never a hash list supplied by
/// the script. It must be persisted in the journal before any check starts.
#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    pub(crate) dir: PathBuf,
    pub(crate) files: Vec<SnapshotFile>,
}

#[derive(Debug, Clone)]
pub(crate) struct SnapshotFile {
    pub(crate) source: PathBuf,
    pub(crate) name: String,
    pub(crate) sha256: String,
    identity: (u64, u64),
    modified_ns: String,
}

#[derive(Debug, Clone)]
pub(crate) struct Args {
    pub(crate) inputs: Vec<PathBuf>,
    repair_files: Vec<PathBuf>,
    pub(crate) tmp: PathBuf,
    pub(crate) check: Vec<String>,
    pub(crate) sudo: Vec<String>,
    pub(crate) remote: Option<String>,
    pub(crate) nopass: bool,
    pub(crate) fixes: u64,
    pub(crate) repo: Option<PathBuf>,
    writer: Option<String>,
    models: serde_json::Map<String, Value>,
}

fn argv(value: &Value, field: &str) -> Result<Vec<String>, String> {
    match value {
        Value::String(text) => simple_argv(text),
        Value::Array(items) => items.iter().map(|item| {
            item.as_str().map(str::to_owned).ok_or_else(|| format!("args.{field} must contain only strings"))
        }).collect(),
        _ => Err(format!("args.{field} must be a simple string or an argv array")),
    }
}

#[cfg(windows)]
fn local_drive_type(kind: u32) -> bool { matches!(kind, 2 | 3) }

fn absolute(value: &Value, field: &str, live: bool) -> Result<PathBuf, String> {
    let path = value.as_str().filter(|s| !s.chars().any(char::is_control)).map(PathBuf::from)
        .filter(|path| path.is_absolute()).ok_or_else(|| format!("args.{field} must be an absolute path"))?;
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))) {
            return Err(format!("args.{field} must be a local drive path"));
        }
        if live {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" { fn GetDriveTypeW(root: *const u16) -> u32; }
        let drive = match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() { Prefix::Disk(d) | Prefix::VerbatimDisk(d) => d, _ => unreachable!() },
            _ => unreachable!(),
        };
        let root = std::ffi::OsString::from(format!("{}:\\", drive as char));
        let wide: Vec<u16> = root.encode_wide().chain(std::iter::once(0)).collect();
        // DRIVE_FIXED and DRIVE_REMOVABLE only; unknown and remote are refused.
        if !local_drive_type(unsafe { GetDriveTypeW(wide.as_ptr()) }) {
            return Err(format!("args.{field} must be on a local drive"));
        }
        }
    }
    let _ = live;
    Ok(path)
}

impl Args {
    pub(crate) fn parse(raw: &Value) -> Result<Self, String> { Self::parse_mode(raw, true) }

    fn parse_mode(raw: &Value, live: bool) -> Result<Self, String> {
        let object = raw.as_object().ok_or("ops-script requires a JSON object")?;
        if object.contains_key("remote") {
            return Err("Remote mode is not available in this build; no remote action was started".into());
        }
        if let Some(key) = object.keys().find(|key| ![
            "script", "tmp", "check", "remote", "files", "repairFiles", "sudo", "nopass", "fixes", "writer", "repo", "models",
        ].contains(&key.as_str())) {
            return Err(format!("Unknown ops-script argument: {key}"));
        }
        let script = absolute(&raw["script"], "script", live)?;
        let mut inputs = vec![script.clone()];
        match raw.get("files") {
            None => (),
            Some(Value::Array(paths)) => for path in paths { inputs.push(absolute(path, "files", live)?); },
            Some(value @ Value::String(_)) => inputs.push(absolute(value, "files", live)?),
            _ => return Err("args.files must be a path or array of paths".into()),
        }
        let repair_files = match raw.get("repairFiles") {
            None => Vec::new(),
            Some(Value::Array(paths)) => paths.iter().map(|path| absolute(path, "repairFiles", live)).collect::<Result<Vec<_>, _>>()?,
            _ => return Err("args.repairFiles must be an array of companion paths".into()),
        };
        let mut selected = HashSet::new();
        for path in &repair_files {
            if !inputs[1..].contains(path) || !selected.insert(path) {
                return Err("args.repairFiles must contain distinct paths from args.files".into());
            }
        }
        let tmp = absolute(&raw["tmp"], "tmp", live)?;
        let repo = raw.get("repo").map(|value| absolute(value, "repo", live)).transpose()?;
        if live && !tmp.is_dir() { return Err("args.tmp must be an existing directory".into()); }
        let is_python = if live { script_kind(&script)? == Some("python") } else { false };
        let default_check = if is_python {
            vec!["python3".into(), "{copy}".into(), "--check".into()]
        } else {
            vec!["bash".into(), "{copy}".into(), "--check".into()]
        };
        let check = match raw.get("check") { Some(value) => argv(value, "check")?, None => default_check };
        validate_check_argv(&check)?;
        if live { validate_direct(&check, &script)?; }
        if live && ((check[0] == "bash" && is_python) || ((check[0] == "python" || check[0] == "python3") && !is_python)) {
            return Err("The check interpreter does not match the script type".into());
        }
        let sudo = argv(&raw["sudo"], "sudo")?;
        if sudo.is_empty() || sudo.iter().any(|word| word.is_empty() || word.chars().any(char::is_control))
            || sudo.iter().filter(|word| word.as_str() == "{script}").count() != 1
            || sudo.iter().any(|word| word != "{script}" && (word.contains('{') || word.contains('}')))
            || sudo[0] == "{script}"
        {
            return Err("args.sudo needs one standalone {script} after the command".into());
        }
        // The default interpreter depends on the script contents, unavailable
        // during receipt-only recovery; check it after restoring the snapshot.
        if live || raw.get("check").is_some() {
            validate_interpreter_parity(&check, &sudo)?;
        }
        let remote = match raw.get("remote") {
            None => None,
            Some(Value::String(text)) if valid_remote(text) => Some(text.clone()),
            _ => return Err("args.remote must be an explicit unprivileged user@host".into()),
        };
        let nopass = match raw.get("nopass") {
            None => false,
            Some(Value::Bool(value)) => *value,
            _ => return Err("args.nopass must be boolean".into()),
        };
        let fixes = match raw.get("fixes") {
            None => 2,
            Some(value) => value.as_u64().ok_or("args.fixes must be a nonnegative integer")?,
        };
        if live && repo.as_ref().is_some_and(|path| !path.is_dir()) { return Err("args.repo must be an existing directory".into()); }
        if raw.get("writer").is_some_and(|v| v.as_str().is_none_or(str::is_empty)) {
            return Err("args.writer must be a nonempty model name".into());
        }
        if raw.get("models").is_some_and(|v| !v.is_object()) {
            return Err("args.models must be an object".into());
        }
        let writer = raw.get("writer").and_then(Value::as_str).map(str::to_owned);
        let models = raw.get("models").and_then(Value::as_object).cloned().unwrap_or_default();
        for role in models.keys() {
            if role != "expertWriter" && role != "reviewer" {
                return Err(format!("Unsupported ops-script repair role: {role}"));
            }
            if models::candidates(&models, role)?.is_empty() {
                return Err(format!("args.models.{role} needs at least one candidate"));
            }
        }
        if writer.is_some() && models.contains_key("expertWriter") {
            return Err("args.writer and args.models.expertWriter cannot both be set".into());
        }
        // Validate existence, names and distinct identities before creating any
        // journal or snapshot. Capture repeats these checks before copying.
        let mut identities = HashSet::new();
        let mut names = HashSet::new();
        for path in &inputs {
            let name = path.file_name().and_then(|n| n.to_str()).filter(|n| valid_name(n)).ok_or("Invalid input name")?;
            let key = if cfg!(windows) { name.to_lowercase() } else { name.to_owned() };
            if !names.insert(key) { return Err("Input names must be distinct".into()); }
            if !live { continue; }
            let metadata = fs::symlink_metadata(path).map_err(|e| format!("Cannot inspect input: {e}"))?;
            if !metadata.file_type().is_file() || !distinct_identity(&mut identities, file_identity(path)?) {
                return Err("Inputs must be distinct regular files".into());
            }
            script_kind(path)?;
        }
        Ok(Self { inputs, repair_files, tmp, check, sudo, remote, nopass, fixes, repo, writer, models })
    }
}

fn distinct_identity(seen: &mut HashSet<(u64, u64)>, identity: (u64, u64)) -> bool {
    seen.insert(identity)
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && name != "-" && name != ".ops-sha256"
        && !name.chars().any(char::is_control)
        && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name)
        && (!cfg!(windows) || !name.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*']))
}

impl Snapshot {
    /// Produce journal data without silently losing non-Unicode paths.
    pub(crate) fn receipt(&self) -> Result<Value, String> {
        let dir = self.dir.to_str().ok_or("Snapshot path is not Unicode")?;
        let files = self.files.iter().map(|file| {
            Ok(json!({
                "source": file.source.to_str().ok_or("Input path is not Unicode")?,
                "name": file.name,
                "sha256": file.sha256,
                "identity": [file.identity.0, file.identity.1],
                "modifiedNs": file.modified_ns,
            }))
        }).collect::<Result<Vec<Value>, &str>>()?;
        Ok(json!({ "dir": dir, "files": files }))
    }

    /// Only a receipt for the original inputs and a direct child of the
    /// configured tmp directory can be restored. The receipt never grants an
    /// arbitrary filesystem path authority to the resumed workflow.
    pub(crate) fn restore(value: &Value, tmp: &Path, inputs: &[PathBuf]) -> Result<Self, String> {
        let dir = value.get("dir").and_then(Value::as_str).map(PathBuf::from).ok_or("Missing snapshot directory")?;
        let parent = fs::canonicalize(tmp).map_err(|e| format!("Cannot resolve tmp: {e}"))?;
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let valid_name = name.strip_prefix("snap.").is_some_and(|suffix| {
            suffix.len() == 8 && suffix.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
        if dir.parent() != Some(parent.as_path()) || !valid_name {
            return Err("Snapshot directory does not match the original tmp".into());
        }
        let entries = value.get("files").and_then(Value::as_array).ok_or("Missing snapshot files")?;
        if entries.len() != inputs.len() || entries.is_empty() {
            return Err("Snapshot inputs differ from the original arguments".into());
        }
        let mut files = Vec::new();
        for (entry, source) in entries.iter().zip(inputs) {
            let stored_source = entry.get("source").and_then(Value::as_str).ok_or("Missing source")?;
            let name = entry.get("name").and_then(Value::as_str).ok_or("Missing name")?;
            let hash = entry.get("sha256").and_then(Value::as_str).ok_or("Missing digest")?;
            let identity = entry.get("identity").and_then(Value::as_array).filter(|v| v.len() == 2)
                .ok_or("Missing file identity")?;
            let identity = (identity[0].as_u64().ok_or("Invalid file identity")?, identity[1].as_u64().ok_or("Invalid file identity")?);
            let modified_ns = entry.get("modifiedNs").and_then(Value::as_str).ok_or("Missing file timestamp")?.to_owned();
            if Path::new(stored_source) != source || source.file_name().and_then(|n| n.to_str()) != Some(name) {
                return Err("Snapshot inputs differ from the original arguments".into());
            }
            files.push(SnapshotFile { source: source.clone(), name: name.into(), sha256: hash.into(), identity, modified_ns });
        }
        let snapshot = Self { dir, files };
        verify_snapshot(&snapshot)?;
        Ok(snapshot)
    }
}

fn regular_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("Cannot inspect {}: {e}", path.display()))?;
    if !metadata.file_type().is_file() {
        return Err(format!("Not a regular file: {}", path.display()));
    }
    fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))
}

fn modified_ns(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("Cannot inspect snapshot timestamp: {e}"))?;
    let modified = metadata.modified()
        .map_err(|e| format!("Cannot inspect snapshot timestamp: {e}"))?;
    let modified = modified.duration_since(std::time::UNIX_EPOCH).map_err(|e| format!("Invalid snapshot timestamp: {e}"))?.as_nanos();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{modified}:{}:{}", metadata.ctime(), metadata.ctime_nsec()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct BasicInfo { created: i64, accessed: i64, modified: i64, changed: i64, attributes: u32 }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandleEx(handle: *mut std::ffi::c_void, class: i32, info: *mut std::ffi::c_void, size: u32) -> i32;
        }
        let file = fs::File::open(path).map_err(|e| format!("Cannot inspect snapshot: {e}"))?;
        let mut info = std::mem::MaybeUninit::<BasicInfo>::uninit();
        let ok = unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), 0, info.as_mut_ptr().cast(), std::mem::size_of::<BasicInfo>() as u32) };
        if ok == 0 { return Err(format!("Cannot inspect snapshot change time: {}", std::io::Error::last_os_error())); }
        let info = unsafe { info.assume_init() };
        Ok(format!("{modified}:{}", info.changed))
    }
    #[cfg(not(any(unix, windows)))]
    { Err("Cannot inspect snapshot change time on this platform".into()) }
}

/// Compare filesystem identities, not just canonical paths: two different
/// absolute names may be hard links to the same inode/file ID.
#[cfg(unix)]
fn file_identity(path: &Path) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(path).map_err(|e| format!("Cannot identify input: {e}"))?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn file_identity(path: &Path) -> Result<(u64, u64), String> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct FileInfo {
        attributes: u32,
        created: [u32; 2],
        accessed: [u32; 2],
        written: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut FileInfo) -> i32;
    }
    let file = fs::File::open(path).map_err(|e| format!("Cannot identify input: {e}"))?;
    let mut info = std::mem::MaybeUninit::<FileInfo>::uninit();
    // The handle remains open until the call returns. The API initializes the
    // whole output structure only on success.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(format!("Cannot identify input: {}", std::io::Error::last_os_error()));
    }
    let info = unsafe { info.assume_init() };
    Ok((u64::from(info.volume), (u64::from(info.index_high) << 32) | u64::from(info.index_low)))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_path: &Path) -> Result<(u64, u64), String> {
    Err("Cannot verify input identities on this platform".into())
}

/// Make a unique directory atomically, then copy the named regular files into
/// it. A failed or interrupted attempt is never adopted as a valid receipt.
pub(crate) fn capture_snapshot(tmp: &Path, inputs: &[PathBuf]) -> Result<Snapshot, String> {
    if !tmp.is_absolute() || !tmp.is_dir() || inputs.is_empty() {
        return Err("snapshot needs an existing absolute tmp directory and at least one input".into());
    }
    let mut names = HashSet::new();
    let mut sources = HashSet::new();
    let mut prepared = Vec::new();
    for path in inputs {
        if !path.is_absolute() {
            return Err(format!("Input path must be absolute: {}", path.display()));
        }
        let name = path.file_name().and_then(|n| n.to_str()).filter(|n| valid_name(n))
            .ok_or_else(|| format!("Invalid input name: {}", path.display()))?.to_owned();
        let name_key = if cfg!(windows) { name.to_lowercase() } else { name.clone() };
        if !names.insert(name_key) {
            return Err(format!("Input names must be distinct: {name}"));
        }
        let data = regular_bytes(path)?;
        if !distinct_identity(&mut sources, file_identity(path)?) {
            return Err("Input paths must name distinct files".into());
        }
        prepared.push((path.clone(), name, data));
    }
    let tmp = fs::canonicalize(tmp).map_err(|e| format!("Cannot resolve tmp: {e}"))?;
    let mut created = None;
    for _ in 0..32 {
        let dir = tmp.join(format!("snap.{:08x}", rand::random::<u32>()));
        #[allow(unused_mut)]
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&dir) {
            Ok(()) => { created = Some(dir); break; }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Cannot create snapshot: {e}")),
        }
    }
    let dir = created.ok_or_else(|| "Cannot allocate a unique snapshot".to_owned())?;
    let mut files = Vec::new();
    for (index, (source, name, bytes)) in prepared.into_iter().enumerate() {
        let target = dir.join(&name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&target)
            .map_err(|e| format!("Cannot create snapshot file: {e}"))?;
        output.write_all(&bytes).and_then(|_| output.sync_all()).map_err(|e| format!("Cannot write snapshot file: {e}"))?;
        let permissions = fs::metadata(&source).map_err(|e| format!("Cannot inspect source: {e}"))?.permissions();
        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = permissions;
            permissions.set_mode((permissions.mode() & 0o700) | if index == 0 { 0o100 } else { 0 });
            permissions
        };
        #[cfg(not(unix))]
        let _ = index;
        fs::set_permissions(&target, permissions).map_err(|e| format!("Cannot set snapshot permissions: {e}"))?;
        files.push(SnapshotFile { source, name, sha256: sha256_hex(&bytes), identity: file_identity(&target)?, modified_ns: modified_ns(&target)? });
    }
    let snapshot = Snapshot { dir, files };
    verify_snapshot(&snapshot)?;
    Ok(snapshot)
}

/// Recheck the snapshot identities, contents and every
/// copied byte. Call both before and after each check, and before issuing a
/// human command. New files are refused as they can affect script execution.
pub(crate) fn verify_snapshot(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.files.is_empty() || !snapshot.dir.is_absolute() {
        return Err("Invalid snapshot receipt".into());
    }
    let metadata = fs::symlink_metadata(&snapshot.dir).map_err(|e| format!("Cannot inspect snapshot: {e}"))?;
    if !metadata.file_type().is_dir() {
        return Err("Snapshot is not a directory".into());
    }
    let mut expected = HashSet::new();
    for file in &snapshot.files {
        if !file.source.is_absolute() || !valid_name(&file.name) || !expected.insert(file.name.clone())
            || file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Invalid snapshot receipt".into());
        }
        // A removed original does not invalidate a completed snapshot. If it
        // still exists, retain the existing check for changed input bytes.
        if file.source.exists() && sha256_hex(regular_bytes(&file.source)?) != file.sha256 {
            return Err(format!("Input changed: {}", file.name));
        }
        if sha256_hex(regular_bytes(&snapshot.dir.join(&file.name))?) != file.sha256 {
            return Err(format!("Snapshot changed: {}", file.name));
        }
        let copy = snapshot.dir.join(&file.name);
        if file_identity(&copy)? != file.identity || modified_ns(&copy)? != file.modified_ns {
            return Err(format!("Snapshot was modified or replaced: {}", file.name));
        }
        #[cfg(unix)]
        if file.name == snapshot.files[0].name {
            use std::os::unix::fs::PermissionsExt;
            if fs::metadata(&copy).map_err(|e| format!("Cannot inspect script mode: {e}"))?.permissions().mode() & 0o100 == 0 {
                return Err("The snapshot script is not executable".into());
            }
        }
    }
    let actual = fs::read_dir(&snapshot.dir).map_err(|e| format!("Cannot list snapshot: {e}"))?
        .map(|entry| entry.map_err(|e| e.to_string()).and_then(|e| e.file_name().into_string().map_err(|_| "Non-text snapshot name".to_owned())))
        .collect::<Result<HashSet<_>, _>>()?;
    if actual != expected {
        return Err("Snapshot contents changed".into());
    }
    Ok(())
}

/// Parse a legacy simple template without interpreting shell syntax.
pub(crate) fn simple_argv(template: &str) -> Result<Vec<String>, String> {
    if template.chars().any(|c| {
        c.is_control() || matches!(c, '\'' | '"' | '\\' | '$' | '`' | ';' | '&' | '|' | '<' | '>' | '(' | ')' | '*' | '?' | '[' | ']' | '~' | '#')
    }) {
        return Err("check string must contain simple words only; use an argv array for literal arguments".into());
    }
    let words: Vec<String> = template.split_whitespace().map(str::to_owned).collect();
    if words.is_empty() {
        return Err("check must not be empty".into());
    }
    Ok(words)
}

/// Accept only direct execution or a known interpreter with the copy as its first
/// argument. In particular, interpreter options such as `-c` cannot replace the
/// checked script. Substitution happens after this validation, as one argv item.
pub(crate) fn validate_check_argv(words: &[String]) -> Result<(), String> {
    if words.iter().any(|word| word.chars().any(char::is_control)) {
        return Err("check arguments must not contain control characters".into());
    }
    let copy_index = match words.first().map(String::as_str) {
        Some("{copy}") => 0,
        Some("bash" | "python" | "python3") => 1,
        _ => return Err("check must execute {copy} directly or through bash, python or python3".into()),
    };
    if words.get(copy_index).map(String::as_str) != Some("{copy}")
        || words.iter().enumerate().any(|(i, word)| i != copy_index && (word.contains('{') || word.contains('}')))
    {
        return Err("check needs exactly one standalone {copy} in the script position".into());
    }
    if words.get(copy_index + 1).map(String::as_str) != Some("--check")
        || words.iter().skip(copy_index + 2).any(|word| word == "--check" || word == "--apply" || word.starts_with("--apply=")) {
        return Err("check needs --check immediately after {copy} and cannot include apply mode".into());
    }
    Ok(())
}

fn validate_interpreter_parity(check: &[String], sudo: &[String]) -> Result<(), String> {
    let matches = if check.first().map(String::as_str) == Some("{copy}") {
        sudo.get(0).map(String::as_str) == Some("sudo") && sudo.get(1).map(String::as_str) == Some("{script}")
    } else {
        sudo.get(0).map(String::as_str) == Some("sudo")
            && sudo.get(1) == check.first()
            && sudo.get(2).map(String::as_str) == Some("{script}")
    };
    if !matches { return Err("args.sudo must use sudo and the same interpreter as args.check immediately before {script}".into()); }
    Ok(())
}

/// Only an explicit, non-root account and a DNS name or IPv4 literal are
/// supported. This excludes SSH options, URI syntax, ports and shell syntax.
pub(crate) fn valid_remote(remote: &str) -> bool {
    let Some((user, host)) = remote.split_once('@') else { return false };
    !user.is_empty()
        && user.len() <= 64
        && user != "root"
        && user.as_bytes()[0].is_ascii_alphabetic()
        && user.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        && !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

#[cfg(test)]
crate::ops_script_tests! {
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_child_requires_parent_privilege_guard() {
        let base = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-guard-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&base).unwrap();
        let mut cfg = Config::new(None).unwrap();
        cfg.home = base.clone();
        let run = json!({ "workflow": NAME, "version": VERSION, "inputs": { "args": {} } });
        let mut journal = Journal::create(&cfg.home, "guard-test", &run).unwrap();
        journal.append(json!({ "kind": "ops-start", "step": "dry 0" })).unwrap();
        journal.append(json!({ "kind": "ops-done", "step": "dry 0", "result": { "ok": false } })).unwrap();
        journal.append(json!({ "kind": "ops-repair", "attempt": 0, "child": "child", "args": {} })).unwrap();
        let before = journal.snapshot().unwrap();
        let error = match resume_guarded("guard-test", None, None, &cfg, || Err("guard denied".into())) {
            Err(error) => error,
            Ok(_) => panic!("repair continued despite a denied guard"),
        };
        assert!(error.to_string().contains("guard denied"));
        assert_eq!(journal.snapshot().unwrap(), before);
        assert!(!journal::flows_dir(&cfg.home).join("child").exists());
        journal.write_value("result.json", &json!({ "workflow": NAME, "ready": false, "status": "failed" })).unwrap();
        let result = resume_guarded("guard-test", None, None, &cfg, || Err("guard denied".into())).unwrap();
        assert_eq!(result.result["status"], "failed");
        fs::remove_dir_all(base).unwrap();
    }

    // Windows may expose a non-working Microsoft Store alias as python3.exe.
    // Test fixtures require a real interpreter, independent of its command name.
    #[cfg(windows)]
    fn fixture_python(cwd: &Path) -> PathBuf {
        ["python", "python3"].into_iter().filter_map(find_tool)
            .find(|path| working_python(path, cwd))
            .expect("a working Python 3 is required for the fixture")
    }

    #[test]
    fn operator_interpreter_matches_the_check() {
        let words = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        let check = words(&["python", "{copy}", "--check"]);
        assert!(validate_interpreter_parity(&check, &words(&["sudo", "python", "{script}", "--apply"])).is_ok());
        assert!(validate_interpreter_parity(&check, &words(&["sudo", "python3", "{script}"])).is_err());
        assert!(validate_interpreter_parity(&check, &words(&["sudo", "{script}"])).is_err());
        let direct = words(&["{copy}", "--check"]);
        assert!(validate_interpreter_parity(&direct, &words(&["sudo", "{script}"])).is_ok());
        assert!(validate_interpreter_parity(&direct, &words(&["sudo", "bash", "{script}"])).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn mapped_and_unknown_drives_are_not_local() {
        assert!(local_drive_type(2)); // removable
        assert!(local_drive_type(3)); // fixed
        assert!(!local_drive_type(4)); // remote
        assert!(!local_drive_type(0)); // unknown
        assert!(!local_drive_type(1)); // no root
    }

    #[cfg(windows)]
    #[test]
    fn receipt_paths_are_lexical_without_drive_probes() {
        let raw = json!({ "script": concat!("Z:", r"\missing.py"), "files": [concat!("Z:", r"\data.txt")],
            "tmp": concat!("C:", r"\snapshots"), "repo": concat!("Z:", r"\repo"), "check": ["python3", "{copy}", "--check"],
            "sudo": ["sudo", "python3", "{script}"] });
        assert!(Args::parse_mode(&raw, false).is_ok());
    }

    #[test]
    fn malformed_effect_history_is_refused() {
        let step = "dry 0";
        let started = json!({"kind": "ops-start", "step": step});
        let done = json!({"kind": "ops-done", "step": step, "result": {"ok": true, "code": 0}});
        assert!(effect_state(&[done], step).is_err());
        assert!(effect_state(&[started.clone(), started], step).is_err());
    }

    fn failure_cases() -> Vec<(&'static str, &'static str, Value, bool)> {
        let static_failure = |code: Option<i32>, timed_out| json!({ "ok": false, "checks": [
            { "check": "script.py: py_compile", "inputIndex": 0, "code": code, "timedOut": timed_out }
        ] });
        vec![
            ("snapshot-error", "snapshot 0", json!({ "ok": false, "error": "Cannot copy [input]" }), false),
            ("missing-python", "static 0", json!({ "ok": false, "error": "A working Python interpreter is required" }), false),
            ("static-timeout", "static 0", static_failure(Some(1), true), false),
            ("dry-error", "dry 0", json!({ "ok": false, "error": "The process output did not close" }), false),
            ("dry-signal", "dry 0", json!({ "ok": false, "code": null, "timedOut": false }), false),
            #[cfg(windows)]
            ("static-loader-error", "static 0", static_failure(Some(0xc0000142_u32 as i32), false), false),
            #[cfg(windows)]
            ("dry-loader-error", "dry 0", json!({ "ok": false, "code": 0xc0000135_u32 as i32, "timedOut": false }), false),
            ("static-exit", "static 0", static_failure(Some(1), false), true),
            #[cfg(unix)]
            ("static-signal", "static 0", static_failure(None, false), true),
            ("dry-exit", "dry 0", json!({ "ok": false, "code": 127, "timedOut": false }), true),
            ("dry-timeout", "dry 0", json!({ "ok": false, "code": null, "timedOut": true }), true),
        ]
    }

    #[test]
    fn recorded_failures_repair_only_script_defects() {
        let base = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-failure-{:016x}", rand::random::<u64>()));
        // The child gate refuses a folder that is not a Git work tree root.
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let script = repo.join("script.py");
        fs::write(&script, b"print('checked')\n").unwrap();
        let run = json!({ "workflow": NAME, "version": VERSION, "inputs": { "args": {
            "script": script, "tmp": base, "repo": repo, "fixes": 1,
            "check": ["python3", "{copy}", "--check"], "sudo": ["sudo", "python3", "{script}"]
        } } });
        let record = |journal: &mut Journal, step: &str, result: Value| {
            journal.append(json!({ "kind": "ops-start", "step": step })).unwrap();
            journal.append(json!({ "kind": "ops-done", "step": step, "result": result })).unwrap();
        };
        let mut cfg = Config::new(None).unwrap();
        for (id, step, detail, expect_repair) in failure_cases() {
            cfg.home = base.join(id);
            let mut journal = Journal::create(&cfg.home, id, &run).unwrap();
            record(&mut journal, step, detail.clone());
            let exit = resume_guarded(id, None, None, &cfg, || Ok(())).unwrap();
            let events = journal.snapshot().unwrap();
            let repairs: Vec<_> = events.iter().filter(|event| event["kind"] == "ops-repair").collect();
            assert_eq!(exit.code, 2, "{id}");
            assert_eq!(exit.result["ready"], false, "{id}");
            assert_eq!(exit.result["step"], step, "{id}");
            assert_eq!(exit.result["detail"], detail, "{id}");
            assert_eq!(repairs.len(), usize::from(expect_repair), "{id}");
            if expect_repair {
                assert_eq!(exit.result["status"], "waiting", "{id}");
                assert_eq!(exit.result["childRunId"], repairs[0]["child"], "{id}");
            } else {
                assert_eq!(exit.result["status"], "failed", "{id}");
                assert_eq!(journal.read_value("result.json"), Some(exit.result), "{id}");
                assert_eq!(fs::read_dir(journal::flows_dir(&cfg.home)).unwrap().count(), 1, "{id}");
            }
            assert_eq!(events.iter().filter(|event| event["kind"] == "ops-start").count(), 1, "{id}");
        }

        let id = "interrupted-snapshot";
        cfg.home = base.join(id);
        let mut journal = Journal::create(&cfg.home, id, &run).unwrap();
        journal.append(json!({ "kind": "ops-start", "step": "snapshot 0" })).unwrap();
        let before = journal.snapshot().unwrap();
        let exit = resume_guarded(id, None, None, &cfg, || Ok(())).unwrap();
        assert_eq!(exit.result["status"], "unresolved");
        assert_eq!(exit.result["step"], "snapshot 0");
        assert_eq!(journal.snapshot().unwrap(), before);

        let id = "recorded-repair";
        cfg.home = base.join(id);
        let mut journal = Journal::create(&cfg.home, id, &run).unwrap();
        record(&mut journal, "snapshot 0", json!({ "ok": false, "error": "Cannot copy [input]" }));
        let child = journal::new_run_id();
        journal.append(json!({ "kind": "ops-repair", "attempt": 0, "child": child, "args": {} })).unwrap();
        let before = journal.snapshot().unwrap();
        let exit = resume_guarded(id, None, None, &cfg, || Ok(())).unwrap();
        assert_eq!(exit.result["status"], "unresolved");
        assert_eq!(exit.result["step"], format!("repair 0 ({child})"));
        assert_eq!(journal.snapshot().unwrap(), before);

        let id = "missing-receipt-interpreter";
        cfg.home = base.join(id);
        let mut journal = Journal::create(&cfg.home, id, &run).unwrap();
        let snapshot = capture_snapshot(&base, &[script]).unwrap().receipt().unwrap();
        record(&mut journal, "snapshot 0", json!({ "ok": true, "snapshot": snapshot }));
        record(&mut journal, "static 0", json!({ "ok": true, "bash": base.join("bash"), "python": null }));
        let exit = resume_guarded(id, None, None, &cfg, || Ok(())).unwrap();
        assert_eq!(exit.result["status"], "failed");
        assert_eq!(exit.result["step"], "dry 0");
        assert_eq!(exit.result["detail"]["error"], "Static receipt lacks the resolved Python executable");
        assert!(!journal.snapshot().unwrap().iter().any(|event| event["kind"] == "ops-repair"));
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn launcher_failure_is_distinct_from_a_check_exit() {
        let cwd = std::env::current_dir().unwrap();
        let absent = cwd.join(".agent-tmp").join(format!("missing-tool-{:016x}", rand::random::<u64>()));
        let error = run_command(&absent, &[], &cwd, &[], Duration::from_secs(5)).unwrap_err();
        assert!(error.starts_with("Cannot start the check process:"), "{error}");
        let result = run_command(Path::new("/bin/sh"), &["-c".into(), "exit 127".into()], &cwd, &[], Duration::from_secs(5)).unwrap();
        assert!(!result.timed_out);
        assert_eq!(result.code, Some(127));
    }

    #[test]
    fn musl_loader_diagnostic_names_the_requesting_object() {
        let interpreter = Path::new("/opt/tools/python3");
        let direct = "Error loading shared library liba.so: No such file or directory (needed by /opt/tools/python3)";
        let transitive = "Error loading shared library libb.so: No such file or directory (needed by /opt/tools/lib a.so.1)";
        for diagnostic in [direct, transitive] {
            assert_eq!(linux_loader_diagnostic(interpreter, diagnostic), Some(diagnostic));
        }
        for stderr in [
            "Error loading shared library libb.so: retry requested",
            "Error loading shared library libb.so: No such file or directory (needed by )",
            "check.sh: line 1: command not found",
        ] {
            assert_eq!(linux_loader_diagnostic(interpreter, stderr), None);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn missing_shared_library_is_a_tool_error() {
        let dir = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-loader-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        let library = "libops_check_dependency.so";
        let transitive = "libops_check_transitive.so";
        fs::write(dir.join("transitive.c"), b"int check_transitive(void) { return 1; }\n").unwrap();
        fs::write(dir.join("dependency.c"), b"int check_transitive(void);\n\
            int check_dependency(void) { return check_transitive(); }\n").unwrap();
        fs::write(dir.join("interpreter.c"), b"#include <unistd.h>\nint check_dependency(void);\n\
            int main(int argc, char **argv) { if (check_dependency()) execv(\"/bin/sh\", argv); return 1; }\n").unwrap();
        let compile = |args: &[&str]| {
            let result = std::process::Command::new("cc").args(args).current_dir(&dir).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        };
        compile(&["-shared", "-fPIC", "-o", transitive, "transitive.c"]);
        compile(&["-shared", "-fPIC", "-o", library, "dependency.c", "-L.", "-lops_check_transitive", "-Wl,-rpath,$ORIGIN"]);
        compile(&["-o", "interpreter", "interpreter.c", "-L.", "-lops_check_dependency", "-Wl,-rpath,$ORIGIN", "-Wl,-rpath-link,."]);
        fs::write(dir.join("check.sh"), b"echo 'check ran' >&2\nexit 127\n").unwrap();
        let run = || run_command(&dir.join("interpreter"), &["check.sh".into(), "--check".into()], &dir, &[], Duration::from_secs(5));

        let result = run().unwrap();
        assert_eq!(result.code, Some(127));
        assert_eq!(result.stderr.trim(), "check ran");
        assert!(repairable_failure("dry 0", &json!({ "code": result.code, "timedOut": result.timed_out })));

        for (missing, requester) in [(transitive, library), (library, "interpreter")] {
            fs::remove_file(dir.join(missing)).unwrap();
            let error = run().unwrap_err();
            assert!(error.starts_with("Cannot start the check process:") && error.contains(missing), "{error}");
            if error.contains(" (needed by ") {
                assert!(error.ends_with(&format!("/{requester})")), "{error}");
            }
            assert!(!repairable_failure("dry 0", &json!({ "error": error })));
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn input_aliases_are_rejected_by_file_identity() {
        let base = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-link-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&base).unwrap();
        let first = base.join("first.py");
        let second = base.join("second.py");
        fs::write(&first, b"print('ok')\n").unwrap();
        fs::write(&second, b"print('ok')\n").unwrap();
        let first_identity = file_identity(&first).unwrap();
        let mut seen = HashSet::new();
        assert!(distinct_identity(&mut seen, first_identity));
        assert!(distinct_identity(&mut seen, file_identity(&second).unwrap()));
        assert!(!distinct_identity(&mut seen, first_identity), "two names resolving to one file must be rejected");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn shell_syntax_checks_the_snapshot_with_spaces() {
        let base = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-static-test-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&base).unwrap();
        let source = base.join("script with spaces.sh");
        fs::write(&source, b"#!/bin/bash\nprintf '%s\\n' ok\n").unwrap();
        let configured_bash = crate::checks::find_bash();
        let bash = find_tool(configured_bash.to_str().unwrap()).expect("the flow engine requires bash");
        let tools = Tools { bash, python: None, shellcheck: None };
        let snapshot = capture_snapshot(&base, &[source.clone()]).unwrap();
        let results = static_checks(&snapshot, &tools, &base.join("cache"), &mut 0).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].code, Some(0));
        fs::write(&source, b"if then\n").unwrap();
        let bad = capture_snapshot(&base, &[source]).unwrap();
        let results = static_checks(&bad, &tools, &base.join("cache"), &mut 0).unwrap();
        assert_ne!(results[0].code, Some(0));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn snapshot_detects_changed_files_and_unexpected_contents() {
        let base = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-snapshot-test-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&base).unwrap();
        let script = base.join("script with spaces.py");
        let payload = base.join("payload.txt");
        fs::write(&script, b"print('check')\n").unwrap();
        fs::write(&payload, b"payload\n").unwrap();
        let args = json!({ "script": script, "tmp": base, "files": [payload], "sudo": ["sudo", "python3", "{script}", "--apply"] });
        let parsed = Args::parse(&args).unwrap();
        assert_eq!(parsed.check, ["python3", "{copy}", "--check"]);
        assert_eq!(parsed.fixes, 2);
        let mut invalid = args.clone();
        invalid["check"] = json!(["bash", "{copy}", "--check"]);
        assert!(Args::parse(&invalid).is_err());
        invalid = args.clone();
        invalid["sudo"] = json!("sudo {script}; id");
        assert!(Args::parse(&invalid).is_err());
        invalid = args.clone();
        invalid["surprise"] = json!(true);
        assert!(Args::parse(&invalid).is_err());
        let snapshot = capture_snapshot(&base, &[script.clone(), payload.clone()]).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(fs::metadata(snapshot.dir.join("script with spaces.py")).unwrap().permissions().mode() & 0o100, 0);
        }
        let other = capture_snapshot(&base, &[script.clone(), payload.clone()]).unwrap();
        assert_ne!(snapshot.dir, other.dir);
        assert!(verify_snapshot(&snapshot).is_ok());
        let command = local_human_command(&snapshot, &["sudo".into(), "{script}".into(), "a'b".into()], None).unwrap();
        assert!(command.contains(&snapshot.files[0].sha256));
        assert!(command.contains(&snapshot.files[1].sha256));
        assert!(command.contains("sha256sum -c - && 'sudo'"));
        assert!(command.contains("'a'\\''b'"));
        let receipt = snapshot.receipt().unwrap();
        assert!(Snapshot::restore(&receipt, &base, &[script.clone(), payload.clone()]).is_ok());
        assert!(Snapshot::restore(&receipt, &base, &[payload.clone(), script.clone()]).is_err());
        let mut bad_receipt = receipt.clone();
        bad_receipt["dir"] = json!(base.join("other").display().to_string());
        assert!(Snapshot::restore(&bad_receipt, &base, &[script.clone(), payload.clone()]).is_err());
        fs::write(snapshot.dir.join("payload.txt"), b"changed").unwrap();
        assert!(verify_snapshot(&snapshot).is_err());
        assert!(local_human_command(&snapshot, &["sudo".into(), "{script}".into()], None).is_err());
        fs::write(snapshot.dir.join("payload.txt"), b"payload\n").unwrap();
        fs::write(snapshot.dir.join("extra"), b"extra").unwrap();
        assert!(verify_snapshot(&snapshot).is_err());
        fs::remove_file(snapshot.dir.join("extra")).unwrap();
        fs::write(&script, b"changed").unwrap();
        assert!(verify_snapshot(&snapshot).is_err());
        assert!(capture_snapshot(&base, &[payload.clone(), payload]).is_err());
        let script_identity = file_identity(&script).unwrap();
        assert_eq!(script_identity, file_identity(&script).unwrap());
        assert_ne!(script_identity, file_identity(&base.join("payload.txt")).unwrap());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn simple_templates_and_literal_argv() {
        let words = simple_argv("python3 {copy} --check").unwrap();
        assert!(validate_check_argv(&words).is_ok());
        let words = vec!["{copy}".into(), "--check".into(), "path with spaces; literal".into()];
        assert!(validate_check_argv(&words).is_ok());
        for text in ["bash -c {copy}", "sudo {copy} --check", "{copy} {copy}", "{copy}"] {
            assert!(validate_check_argv(&simple_argv(text).unwrap()).is_err(), "{text}");
        }
        for text in ["{copy} --check; id", "{copy} $(id)", "{copy} 'a b'", "{copy}\n--check"] {
            assert!(simple_argv(text).is_err(), "{text}");
        }
    }

    #[test]
    fn rejects_non_check_modes() {
        for text in ["{copy} --apply", "{copy} --verbose", "{copy} -- --check", "{copy} --check --apply"] {
            assert!(validate_check_argv(&simple_argv(text).unwrap()).is_err(), "{text}");
        }
    }

    #[test]
    fn shebang_companions_are_classified() {
        let base = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-shebang-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("helper");
        fs::write(&path, b"#!/usr/bin/env python3\ninvalid python\n").unwrap();
        assert_eq!(script_kind(&path).unwrap(), Some("python"));
        fs::write(&path, b"#!/bin/bash\nif then\n").unwrap();
        assert_eq!(script_kind(&path).unwrap(), Some("shell"));
        fs::write(&path, b"#!/bin/perl\n").unwrap();
        assert!(script_kind(&path).is_err());
        let suffixed = base.join("helper.sh");
        fs::write(&suffixed, b"#!/bin/perl\n").unwrap();
        assert!(script_kind(&suffixed).is_err());
        fs::write(&suffixed, b"#!/usr/bin/env python3\n").unwrap();
        assert!(script_kind(&suffixed).is_err());
        fs::write(&suffixed, b"#!/usr/bin/env bash -c\n").unwrap();
        assert!(script_kind(&suffixed).is_err());
        fs::write(&suffixed, b"#!/tmp/bash\n").unwrap();
        assert!(script_kind(&suffixed).is_err());
        fs::write(&suffixed, b"#!/bin/bash\n").unwrap();
        assert_eq!(script_kind(&suffixed).unwrap(), Some("shell"));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn repair_scope_stays_inside_the_repository() {
        let base = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-scope-{:016x}", rand::random::<u64>()));
        let repo = base.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let script = repo.join("script.py");
        let other = base.join("outside.py");
        fs::write(&script, b"print('ok')\n").unwrap();
        fs::write(&other, b"outside").unwrap();
        let raw = json!({ "script": script, "tmp": base, "repo": repo, "sudo": ["sudo", "python3", "{script}"] });
        let mut args = Args::parse(&raw).unwrap();
        let (resolved_repo, files) = repair_scope(&args).unwrap();
        assert_eq!(files, vec!["script.py"]);
        let data = base.join("payload.json");
        fs::write(&data, b"#!/bin/bash\nsynthetic data").unwrap();
        args.inputs.push(data.clone());
        assert_eq!(repair_scope(&args).unwrap().1, vec!["script.py"]);
        args.repair_files.push(data);
        assert!(repair_scope(&args).is_none());
        args.repair_files.clear();
        args.inputs.pop();
        let helper = repo.join("helper.sh");
        fs::write(&helper, b"#!/bin/bash\necho ok\n").unwrap();
        args.inputs.push(helper.clone());
        assert_eq!(repair_scope(&args).unwrap().1, vec!["script.py"]);
        args.repair_files.push(helper.clone());
        assert_eq!(repair_scope(&args).unwrap().1, vec!["script.py", "helper.sh"]);
        fs::write(&helper, b"# password=synthetic\n").unwrap();
        assert!(repair_scope(&args).is_none());
        fs::write(&helper, concat!("# -----BEGIN ", "PRIVATE KEY-----\n")).unwrap();
        assert!(repair_scope(&args).is_none());
        args.inputs.pop();
        args.repair_files.clear();
        fs::write(&script, b"# ghp_synthetic\n").unwrap();
        assert!(repair_scope(&args).is_none());
        fs::write(&script, b"print('ok')\n").unwrap();
        #[cfg(windows)]
        assert!(matches!(resolved_repo.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_))));
        #[cfg(not(windows))]
        let _ = resolved_repo;
        #[cfg(unix)]
        {
            let upper = repo.join("Config.py");
            let lower = repo.join("config.py");
            fs::write(&upper, b"print('ok')\n").unwrap();
            // Case-insensitive filesystems already resolve the lowercase path to the first file.
            if !lower.exists() {
                fs::write(&lower, b"invalid syntax!\n").unwrap();
                let collision = json!({ "script": upper, "files": [lower], "repairFiles": [lower],
                    "tmp": base, "repo": repo, "sudo": ["sudo", "python3", "{script}"] });
                let collision_args = Args::parse(&collision).unwrap();
                assert!(repair_scope(&collision_args).is_none());
            }

            let literal = repo.join("literal\\name.sh");
            fs::write(&literal, b"#!/bin/bash\n").unwrap();
            args.inputs.push(literal.clone());
            args.repair_files.push(literal);
            assert!(repair_scope(&args).is_none());
            args.inputs.pop();
            args.repair_files.clear();
        }
        args.inputs.push(other.clone());
        args.repair_files.push(other);
        assert!(repair_scope(&args).is_none());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn repair_files_must_be_distinct_named_companions() {
        let base = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-selection-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&base).unwrap();
        let script = base.join("script.py");
        let settings = base.join("settings.py");
        let helper = base.join("helper.sh");
        fs::write(&script, "print('ok')\n").unwrap();
        fs::write(&settings, "REGION = 'synthetic-region'\n").unwrap();
        fs::write(&helper, "echo ok\n").unwrap();
        let mut raw = json!({ "script": script, "tmp": base, "repo": base, "files": [settings, helper], "sudo": ["sudo", "python3", "{script}"] });
        assert_eq!(repair_scope(&Args::parse(&raw).unwrap()).unwrap().1, vec!["script.py"]);
        let args = Args::parse(&raw).unwrap();
        let receipt = |check: Value| json!({ "checks": [check] });
        assert!(failed_unselected_static("static 0", &receipt(json!({"inputIndex": 1, "code": 1})), &args));
        assert!(!failed_unselected_static("static 0", &receipt(json!({"inputIndex": 0, "code": 1})), &args));
        assert!(failed_unselected_static("static 0", &receipt(json!({"check": "settings.py: py_compile", "code": 1})), &args));
        for label in ["settings.py.extra: py_compile", "settings.py: py_compile extra", "settings.py: unknown"] {
            assert!(!failed_unselected_static("static 0", &receipt(json!({"check": label, "code": 1})), &args));
        }
        assert!(!failed_unselected_static("dry 0", &receipt(json!({"inputIndex": 1, "code": 1})), &args));
        raw["repairFiles"] = json!([helper]);
        assert_eq!(repair_scope(&Args::parse(&raw).unwrap()).unwrap().1, vec!["script.py", "helper.sh"]);
        let selected = Args::parse(&raw).unwrap();
        assert!(!failed_unselected_static("static 0", &receipt(json!({"inputIndex": 2, "code": 1})), &selected));
        raw["repairFiles"] = json!([helper, helper]);
        assert!(Args::parse(&raw).is_err());
        raw["repairFiles"] = json!([script]);
        assert!(Args::parse(&raw).is_err());
        raw["repairFiles"] = json!([base.join("other.sh")]);
        assert!(Args::parse(&raw).is_err());
        fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_worker_death_stops_check_descendants() {
        if let Some(dir) = std::env::var_os("OPS_CONTAINMENT_TEST_DIR") {
            let dir = PathBuf::from(dir);
            let argv = vec!["-c".into(), "( sleep 3; printf survived > \"$2\" ) & printf ready > \"$1\"; wait".into(),
                "fixture".into(), dir.join("ready").into_os_string(), dir.join("survived").into_os_string()];
            let _ = run_command(Path::new("/bin/bash"), &argv, &dir, &[], Duration::from_secs(20));
            return;
        }
        let dir = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-watch-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        let mut worker = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "ops_script::tests::linux_worker_death_stops_check_descendants", "--nocapture"])
            .env("OPS_CONTAINMENT_TEST_DIR", &dir).spawn().unwrap();
        let start = Instant::now();
        while !dir.join("ready").exists() && start.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(dir.join("ready").exists(), "contained check did not start");
        worker.kill().unwrap();
        worker.wait().unwrap();
        std::thread::sleep(Duration::from_secs(4));
        assert!(!dir.join("survived").exists(), "a descendant survived the worker");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_contained_process_preserves_argv_and_timeout() {
        let cwd = std::env::current_dir().unwrap();
        let python = fixture_python(&cwd);
        let values = ["space value", "quote\"and\\slashes\\", "", "unicode-Р“В©"];
        let mut argv: Vec<std::ffi::OsString> = vec!["-c".into(), "import json,sys; print(json.dumps(sys.argv[1:]))".into()];
        argv.extend(values.iter().map(std::ffi::OsString::from));
        let result = run_command(&python, &argv, &cwd, &[], Duration::from_secs(10)).unwrap();
        assert_eq!(result.code, Some(0));
        assert_eq!(serde_json::from_str::<Vec<String>>(&result.stdout).unwrap(), values);
        let result = run_command(&python, &["-c".into(), "import time; time.sleep(10)".into()], &cwd, &[], Duration::from_millis(200)).unwrap();
        assert!(result.timed_out);
    }

    #[cfg(windows)]
    #[test]
    fn windows_worker_death_stops_contained_check() {
        if let Some(dir) = std::env::var_os("OPS_WINDOWS_TEST_DIR") {
            let dir = PathBuf::from(dir);
            let python = fixture_python(&dir);
            let argv = vec!["-c".into(), "import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text('ready'); time.sleep(3); pathlib.Path(sys.argv[2]).write_text('survived')".into(),
                dir.join("ready").into_os_string(), dir.join("survived").into_os_string()];
            let _ = run_command(&python, &argv, &dir, &[], Duration::from_secs(20));
            return;
        }
        let dir = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops windows watch {:016x}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        let mut worker = zodchi_core::process::command_without_window(std::env::current_exe().unwrap());
        let mut worker = worker.args(["--exact", "ops_script::tests::windows_worker_death_stops_contained_check", "--nocapture"])
            .env("OPS_WINDOWS_TEST_DIR", &dir).spawn().unwrap();
        let start = std::time::Instant::now();
        while !dir.join("ready").exists() && start.elapsed() < Duration::from_secs(10) { std::thread::sleep(Duration::from_millis(20)); }
        assert!(dir.join("ready").exists(), "contained check did not start");
        worker.kill().unwrap(); worker.wait().unwrap();
        std::thread::sleep(Duration::from_secs(4));
        assert!(!dir.join("survived").exists(), "check survived the worker");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn human_gate_rejects_extra_entries_and_links() {
        let base = std::env::current_dir().unwrap().join(".agent-tmp").join(format!("ops-gate-{:016x}", rand::random::<u64>()));
        fs::create_dir_all(&base).unwrap();
        let script = base.join("script.sh");
        let data = base.join("data");
        fs::write(&script, b"#!/bin/bash\nexit 0\n").unwrap();
        fs::write(&data, b"#!/bin/bash\nexit 0\n").unwrap();
        let snapshot = capture_snapshot(&base, &[script, data]).unwrap();
        let gate = local_human_command(&snapshot, &["true".into(), "{script}".into()], None).unwrap();
        let bash = find_tool(crate::checks::find_bash().to_str().unwrap()).unwrap();
        let run = || run_command(&bash, &["-c".into(), gate.clone().into()], &base, &[], Duration::from_secs(10)).unwrap().code;
        assert_eq!(run(), Some(0));
        fs::write(snapshot.dir.join("extra"), b"extra").unwrap();
        assert_ne!(run(), Some(0));
        let ignored = format!("GLOBIGNORE=extra; set -f; {gate}");
        let result = run_command(&bash, &["-c".into(), ignored.into()], &base, &[], Duration::from_secs(10)).unwrap();
        assert_ne!(result.code, Some(0), "caller glob settings must not hide an extra file");
        fs::remove_file(snapshot.dir.join("extra")).unwrap();
        #[cfg(unix)]
        {
            fs::remove_file(snapshot.dir.join("data")).unwrap();
            fs::hard_link(snapshot.dir.join("script.sh"), snapshot.dir.join("data")).unwrap();
            assert_ne!(run(), Some(0));
        }
        fs::remove_dir_all(&base).unwrap();
    }
}
}
