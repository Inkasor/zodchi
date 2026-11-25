//! Static validation of the trusted version-1 adapter. This module does not run commands.
//! Pattern compilation, argument screening and execution must succeed separately before a
//! validated adapter can be used for collection.

use crate::input::Scrubber;
use regex::Regex;
use serde_json::json;
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use zodchi_core::process::{command_without_window, kill_tree};
use zodchi_core::util::iso;

// The watchdog is forked in pre_exec, after the operation's process group is
// established. Its pipe reaches EOF if the workflow dies, even during spawn.
// It also enforces the deadline independently of the workflow's wait loop.
#[cfg(unix)]
fn contain_unix(command: &mut std::process::Command, timeout: u64) -> std::io::Result<(std::os::unix::net::UnixStream, std::os::unix::net::UnixStream)> {
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    let (reader, writer) = UnixStream::pair()?;
    writer.set_nonblocking(true)?;
    let read_fd = reader.as_raw_fd();
    let write_fd = writer.as_raw_fd();
    command.process_group(0);
    unsafe {
        command.pre_exec(move || {
            libc::close(write_fd);
            let group = libc::getpgrp();
            let watchdog = libc::fork();
            if watchdog < 0 { return Err(std::io::Error::last_os_error()); }
            if watchdog == 0 {
                libc::signal(libc::SIGPIPE, libc::SIG_IGN);
                let mut start: libc::timespec = std::mem::zeroed();
                libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut start);
                // Do not retain stdout, stderr, journal locks, or other inherited handles.
                for fd in 0..libc::getdtablesize() {
                    if fd != read_fd { libc::close(fd); }
                }
                loop {
                    let mut now: libc::timespec = std::mem::zeroed();
                    libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now);
                    let elapsed_ms = (now.tv_sec - start.tv_sec) as i64 * 1000
                        + (now.tv_nsec - start.tv_nsec) as i64 / 1_000_000;
                    let remaining = (timeout as i64 * 1000 - elapsed_ms).clamp(0, i32::MAX as i64) as i32;
                    let mut pollfd = libc::pollfd { fd: read_fd, events: libc::POLLIN | libc::POLLHUP, revents: 0 };
                    let ready = libc::poll(&mut pollfd, 1, remaining);
                    if ready == 0 {
                        // Tell the collector why the group is being killed before
                        // killing it, so reaping cannot race the timeout report.
                        let marker = [1u8];
                        libc::write(read_fd, marker.as_ptr().cast(), 1);
                    }
                    if ready >= 0 { break; }
                    // An interrupted or failed poll is conservatively contained.
                    break;
                }
                libc::kill(-group, libc::SIGKILL);
                libc::_exit(0);
            }
            libc::close(read_fd);
            Ok(())
        });
    }
    // Keep both descriptors open through spawn; the writer then represents
    // the workflow's lifetime until collection finishes.
    Ok((reader, writer))
}

#[cfg(windows)]
mod process_group {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    type Handle = *mut core::ffi::c_void;
    #[repr(C)]
    struct BasicLimits {
        process_user_time: i64,
        job_user_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut core::ffi::c_void, name: *const u16) -> Handle;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn SetInformationJobObject(
            job: Handle,
            class: u32,
            info: *const core::ffi::c_void,
            size: u32,
        ) -> i32;
        fn TerminateJobObject(job: Handle, code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtResumeProcess(process: Handle) -> i32;
    }
    pub struct Group(Handle);
    impl Group {
        pub fn new(child: &Child) -> std::io::Result<Self> {
            let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits: ExtendedLimits = unsafe { std::mem::zeroed() };
            limits.basic.flags = 0x0000_2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if unsafe {
                SetInformationJobObject(
                    job,
                    9,
                    (&limits as *const ExtendedLimits).cast(),
                    std::mem::size_of::<ExtendedLimits>() as u32,
                )
            } == 0
            {
                let error = std::io::Error::last_os_error();
                unsafe {
                    CloseHandle(job);
                }
                return Err(error);
            }
            if unsafe { AssignProcessToJobObject(job, child.as_raw_handle().cast()) } == 0 {
                let error = std::io::Error::last_os_error();
                unsafe {
                    CloseHandle(job);
                }
                return Err(error);
            }
            Ok(Self(job))
        }
        pub fn stop(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
        pub fn resume(&self, child: &Child) -> std::io::Result<()> {
            if unsafe { NtResumeProcess(child.as_raw_handle().cast()) } < 0 {
                return Err(std::io::Error::other("Could not resume contained read"));
            }
            Ok(())
        }
    }
    impl Drop for Group {
        fn drop(&mut self) {
            self.stop();
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
use zodchi_core::util::{fail, GatewayError, Result};

const PROVIDES: &[&str] = &[
    "job",
    "status",
    "error",
    "release",
    "changelog",
    "health",
    "logs",
    "config",
    "other",
];
// The adapter is trusted, but the matching input is taken from an incident report.
// Limit UTF-16 code units before the backtracking ECMAScript matcher sees it.
const MAX_ARGUMENT_UNITS: usize = 128;
const MAX_PATTERN_UNITS: usize = 1024;

fn argument_pattern(pattern: &str) -> Result<regress::Regex> {
    if pattern.encode_utf16().take(MAX_PATTERN_UNITS + 1).count() > MAX_PATTERN_UNITS {
        return fail("The adapter argument pattern exceeds its size limit.");
    }
    let anchored = format!("^(?:{pattern})$");
    regress::Regex::from_unicode(
        anchored.encode_utf16().map(u32::from),
        regress::Flags::default(),
    )
    .map_err(|_| {
        GatewayError(
            "The adapter argument pattern is not a valid ECMAScript regular expression.".into(),
        )
    })
}

fn argument_matches(pattern: &regress::Regex, raw: &str) -> bool {
    let units: Vec<u16> = raw.encode_utf16().take(MAX_ARGUMENT_UNITS + 1).collect();
    if units.len() > MAX_ARGUMENT_UNITS {
        return false;
    }
    pattern
        .find_from_ucs2(&units, 0)
        .next()
        .is_some_and(|matched| matched.range() == (0..units.len()))
}

pub(super) fn redact(text: &str, scrubber: &Scrubber) -> String {
    static PATTERNS: std::sync::OnceLock<Vec<Regex>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(?i)(?:basic|bearer|token)\s+[A-Za-z0-9._~+/=-]+",
            r#"(?i)(?:password|passwd|pwd|pass|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth|cookie|session[_-]?id|пароль|токен|ключ)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&"']+)"#,
            r"(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}",
            r"gh[pousr]_[A-Za-z0-9]{20,}",
            r"xox[abpr]-[A-Za-z0-9-]{10,}",
            r"AKIA[0-9A-Z]{16}",
            r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("constant redaction regex"))
        .collect()
    });
    let mut value = text.to_owned();
    for pattern in patterns {
        value = pattern.replace_all(&value, "[REDACTED]").into_owned();
    }
    scrubber.text(&value, &[])
}

pub(super) fn is_private(text: &str, scrubber: &Scrubber) -> bool {
    scrubber.private(text) || redact(text, scrubber) != text
}

fn known(value: &Value, allowed: &[&str], at: &str) -> Result<()> {
    let fields = value
        .as_object()
        .ok_or_else(|| GatewayError(format!("{at} must be an object.")))?;
    if let Some(name) = fields.keys().find(|name| !allowed.contains(&name.as_str())) {
        return fail(format!("{at}: unknown field {name:?}."));
    }
    Ok(())
}

fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.trim().is_empty())
}

fn name(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn arg_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(u8::is_ascii_alphanumeric)
}

fn whole_placeholder(item: &str) -> Option<&str> {
    item.strip_prefix('{')
        .and_then(|s| s.strip_suffix('}'))
        .filter(|s| arg_name(s))
}

fn has_placeholder(item: &str) -> bool {
    item.match_indices('{').any(|(start, _)| {
        item[start + 1..].find('}').is_some_and(|end| {
            let inner = &item[start + 1..start + 1 + end];
            !inner.is_empty()
                && inner.as_bytes()[0].is_ascii_alphabetic()
                && inner
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
    })
}

fn base(program: &str) -> String {
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_string()
}

fn remote(name: &str) -> bool {
    [
        "ssh", "scp", "rsh", "docker", "podman", "kubectl", "nsenter", "chroot", "sudo", "su",
        "env", "xargs", "nice", "timeout", "stdbuf", "watch",
    ]
    .contains(&name)
}

fn launcher(name: &str) -> bool {
    [
        "env", "sudo", "doas", "su", "runuser", "nice", "ionice", "nohup", "timeout", "stdbuf",
        "time", "command", "exec", "xargs", "ssh", "wsl", "start", "npx", "pnpx", "uvx", "watch",
        "script", "setsid", "chroot", "flock", "taskset", "strace",
    ]
    .contains(&name)
}

fn interpreter(name: &str) -> bool {
    [
        "sh",
        "bash",
        "zsh",
        "dash",
        "ksh",
        "mksh",
        "ash",
        "csh",
        "tcsh",
        "fish",
        "busybox",
        "cmd",
        "powershell",
        "pwsh",
        "node",
        "nodejs",
        "deno",
        "bun",
        "py",
        "perl",
        "ruby",
        "php",
        "lua",
        "tclsh",
        "osascript",
        "cscript",
        "wscript",
        "awk",
        "gawk",
        "mawk",
        "nawk",
        "sed",
        "gsed",
    ]
    .contains(&name)
        || name
            .strip_prefix("python")
            .is_some_and(|suffix| suffix.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
        || name
            .strip_prefix("pypy")
            .is_some_and(|suffix| suffix.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
}

fn no_script_exception(name: &str) -> bool {
    [
        "sed",
        "gsed",
        "awk",
        "gawk",
        "mawk",
        "nawk",
        "busybox",
        "cmd",
        "powershell",
        "cscript",
        "wscript",
    ]
    .contains(&name)
}

fn script_file(text: &str) -> bool {
    let scheme = text.split_once(':').is_some_and(|(prefix, _)| {
        let bytes = prefix.as_bytes();
        bytes.len() >= 2
            && bytes[0].is_ascii_alphabetic()
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'.' | b'-'))
    });
    !text.starts_with(['-', '+'])
        && !scheme
        && !has_placeholder(text)
        && (text.contains(['/', '\\'])
            || text.rsplit_once('.').is_some_and(|(_, ext)| {
                !ext.is_empty() && ext.bytes().all(|c| c.is_ascii_alphanumeric())
            }))
        && !(text.starts_with('/')
            && text.len() <= 3
            && text[1..]
                .bytes()
                .all(|b| b.is_ascii_alphabetic() || b == b'?'))
}

fn bounded(value: &Value, key: &str, low: u64, high: u64, at: &str) -> Result<()> {
    if let Some(field) = value.get(key) {
        if !field
            .as_f64()
            .is_some_and(|n| n.fract() == 0.0 && n >= low as f64 && n <= high as f64)
        {
            return fail(format!("{at}: {key} must be a whole number {low}..{high}."));
        }
    }
    Ok(())
}

fn file_ref(value: &Value, at: &str, needs_name: bool) -> Result<()> {
    known(value, &["name", "path", "maxBytes"], at)?;
    if !value["path"].as_str().is_some_and(|path| !path.is_empty()) {
        return fail(format!("{at}: path is required."));
    }
    if needs_name && !value["name"].as_str().is_some_and(name) {
        return fail(format!("{at}: invalid name."));
    }
    bounded(value, "maxBytes", 256, 65536, at)
}

/// Validate the non-pattern part of an adapter. This is not authorization to execute it.
pub(super) fn validate_shape(adapter: &Value) -> Result<()> {
    known(
        adapter,
        &[
            "$comment",
            "adapterVersion",
            "product",
            "owner",
            "operator",
            "operations",
            "agentSkill",
            "allowLists",
            "retry",
            "releaseCommand",
            "incidentLog",
        ],
        "adapter",
    )?;
    if adapter["adapterVersion"] != 1
        || !nonempty(&adapter["product"])
        || !nonempty(&adapter["owner"])
    {
        return fail("Adapter version 1, product and owner are required.");
    }
    for key in ["operator", "releaseCommand", "incidentLog"] {
        if adapter.get(key).is_some_and(|value| !value.is_string()) {
            return fail(format!("adapter.{key} must be a string."));
        }
    }
    let operations = adapter["operations"]
        .as_object()
        .filter(|ops| !ops.is_empty())
        .ok_or_else(|| GatewayError("Adapter operations must be a non-empty object.".into()))?;
    let mut previous: Vec<&str> = Vec::new();
    for (op_name, op) in operations {
        let at = format!("operation {op_name}");
        if !name(op_name) {
            return fail(format!("{at}: invalid name."));
        }
        known(
            op,
            &[
                "description",
                "provides",
                "argv",
                "args",
                "timeoutSec",
                "maxBytes",
                "after",
            ],
            &at,
        )?;
        if !nonempty(&op["description"]) {
            return fail(format!("{at}: description is required."));
        }
        let argv: Vec<&str> = op["argv"]
            .as_array()
            .and_then(|args| args.iter().map(Value::as_str).collect())
            .filter(|args: &Vec<&str>| !args.is_empty() && args.iter().all(|arg| !arg.is_empty()))
            .ok_or_else(|| {
                GatewayError(format!("{at}: argv must be a non-empty list of strings."))
            })?;
        let program = argv[0].to_ascii_lowercase();
        if program.ends_with(".cmd") || program.ends_with(".bat") {
            return fail(format!("{at}: batch programs are not allowed."));
        }
        let declared = match op.get("args") {
            Some(v) => Some(
                v.as_object()
                    .ok_or_else(|| GatewayError(format!("{at}: args must be an object.")))?,
            ),
            None => None,
        };
        if let Some(args) = declared {
            for (key, pattern) in args {
                if !arg_name(key) || !pattern.is_string() {
                    return fail(format!("{at}: invalid argument pattern."));
                }
                argument_pattern(pattern.as_str().unwrap_or("")).map_err(|_| {
                    GatewayError(format!(
                        "{at}: invalid or unsupported argument pattern for {key}."
                    ))
                })?;
            }
        }
        if argv.iter().any(|item| remote(&base(item))) {
            return fail(format!(
                "{at}: remote or container launcher is not allowed."
            ));
        }
        for (i, item) in argv.iter().enumerate() {
            let executable = base(item);
            if interpreter(&executable)
                && argv.get(i + 1).is_some_and(|arg| {
                    let flag = arg.to_ascii_lowercase();
                    flag == "eval"
                        || flag.starts_with("--eval")
                        || flag.starts_with("-com")
                        || flag.starts_with("-enc")
                        || flag == "/c"
                        || (flag.starts_with('-')
                            && !flag.starts_with("--")
                            && flag[1..].chars().any(|c| c == 'c' || c == 'e'))
                })
            {
                return fail(format!("{at}: executable code flags are not allowed."));
            }
            if let Some(arg) = whole_placeholder(item) {
                if i == 0 || !declared.is_some_and(|args| args.contains_key(arg)) {
                    return fail(format!(
                        "{at}: undeclared placeholder or placeholder as program."
                    ));
                }
                let before = &argv[..i];
                if before.iter().any(|arg| launcher(&base(arg))) {
                    return fail(format!("{at}: placeholder reaches a launcher."));
                }
                if let Some((index, program)) = before
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, arg)| interpreter(&base(arg)))
                {
                    if no_script_exception(&base(program))
                        || !argv
                            .get(index + 1)
                            .is_some_and(|next| index + 1 < i && script_file(next))
                    {
                        return fail(format!(
                            "{at}: placeholder reaches an interpreter without a safe script file."
                        ));
                    }
                }
            } else if has_placeholder(item) {
                return fail(format!(
                    "{at}: placeholders must occupy an entire argument."
                ));
            }
        }
        if let Some(provides) = op.get("provides") {
            if !provides.as_array().is_some_and(|list| {
                list.iter()
                    .all(|v| v.as_str().is_some_and(|p| PROVIDES.contains(&p)))
            }) {
                return fail(format!("{at}: invalid provides."));
            }
        }
        bounded(op, "timeoutSec", 1, 300, &at)?;
        bounded(op, "maxBytes", 256, 65536, &at)?;
        if let Some(after) = op.get("after") {
            if !after.as_array().is_some_and(|list| {
                list.iter()
                    .all(|v| v.as_str().is_some_and(|dep| previous.contains(&dep)))
            }) {
                return fail(format!("{at}: after must name earlier operations."));
            }
        }
        previous.push(op_name);
    }
    let skill = adapter.get("agentSkill");
    if let Some(skill) = skill {
        file_ref(skill, "agentSkill", false)?;
    }
    let allow_lists = match adapter.get("allowLists") {
        Some(list) => Some(
            list.as_array()
                .ok_or_else(|| GatewayError("allowLists must be a list.".into()))?,
        ),
        None => None,
    };
    if let Some(lists) = allow_lists {
        for (i, list) in lists.iter().enumerate() {
            file_ref(list, &format!("allowLists[{i}]"), true)?;
        }
    }
    if skill.is_some() != allow_lists.is_some_and(|lists| !lists.is_empty()) {
        return fail("agentSkill and allowLists must occur together.");
    }
    if let Some(retry) = adapter.get("retry") {
        known(retry, &["how", "conditions"], "retry")?;
        if !nonempty(&retry["how"]) || !nonempty(&retry["conditions"]) {
            return fail("retry requires how and conditions.");
        }
    }
    Ok(())
}

/// Build only screened inputs; values that fail any argument check are never returned.
/// The report is already scrubbed before it joins this persisted plan.
pub(super) fn plan(
    adapter: &Value,
    params: &Value,
    report: &str,
    scrubber: &Scrubber,
) -> Result<Value> {
    validate_shape(adapter)?;
    let params = params
        .as_object()
        .ok_or_else(|| GatewayError("params must be an object.".into()))?;
    let mut items = vec![
        json!({"id":"E1", "kind":"report", "source":"report", "provides":[], "text":redact(report, scrubber), "maxBytes":8000}),
    ];
    let mut count = 1;
    for (name, op) in adapter["operations"]
        .as_object()
        .expect("validated operations")
    {
        if is_private(name, scrubber) {
            return fail("An operation name contains private material.");
        }
        if op["args"]
            .as_object()
            .is_some_and(|args| args.keys().any(|name| is_private(name, scrubber)))
        {
            return fail("An argument name contains private material.");
        }
        count += 1;
        let mut argv = Vec::new();
        let mut reason = String::new();
        for item in op["argv"].as_array().expect("validated argv") {
            let text = item.as_str().expect("validated argv item");
            if let Some(arg) = whole_placeholder(text) {
                let value = params.get(arg);
                let raw = match value {
                    Some(Value::String(v)) => v.clone(),
                    Some(Value::Number(v)) => v.to_string(),
                    Some(Value::Bool(v)) => v.to_string(),
                    _ => String::new(),
                };
                let regex = argument_pattern(op["args"][arg].as_str().unwrap_or(""))?;
                let problem = if raw.is_empty() {
                    Some("argument was not given")
                } else if raw.encode_utf16().take(MAX_ARGUMENT_UNITS + 1).count()
                    > MAX_ARGUMENT_UNITS
                {
                    Some("argument exceeds the size limit")
                } else if !argument_matches(&regex, &raw) {
                    Some("argument does not match its pattern")
                } else if raw.chars().any(|c| "\0\r\n;&|$`<>(){}\\\"'*?!".contains(c)) {
                    Some("argument holds a prohibited character")
                } else if is_private(&raw, scrubber) {
                    Some("argument looks private or secret")
                } else {
                    None
                };
                if let Some(problem) = problem {
                    if reason.is_empty() {
                        reason = format!("argument {arg}: {problem}; nothing was run with it");
                    }
                    argv.push(text.to_string());
                } else {
                    argv.push(raw);
                }
            } else {
                // Trusted configuration is still screened before it becomes a stored command.
                if is_private(text, scrubber) {
                    return fail(format!(
                        "operation {name}: a fixed argument contains private material."
                    ));
                }
                argv.push(text.to_owned());
            }
        }
        items.push(json!({"id":format!("E{count}"),"kind":"op","name":name,"source":format!("op:{name}"),
            "provides":op.get("provides").cloned().unwrap_or(json!(["other"])),"argv":argv,
            "after":op.get("after").cloned().unwrap_or(json!([])),"timeoutSec":op.get("timeoutSec").and_then(Value::as_f64).map(|n| n as u64).unwrap_or(30),
            "maxBytes":op.get("maxBytes").and_then(Value::as_f64).map(|n| n as u64).unwrap_or(8000),"skip":reason}));
    }
    let mut add_file = |source: String, value: &Value, default: u64| -> Result<()> {
        count += 1;
        let path = value["path"].as_str().unwrap_or("");
        if is_private(path, scrubber) {
            return fail("An adapter file path contains private material.");
        }
        items.push(json!({"id":format!("E{count}"),"kind":"file","source":source,"provides":[],"path":path,"maxBytes":value.get("maxBytes").and_then(Value::as_f64).map(|n| n as u64).unwrap_or(default)}));
        Ok(())
    };
    if let Some(skill) = adapter.get("agentSkill") {
        add_file("agentSkill".into(), skill, 16000)?;
    }
    if let Some(lists) = adapter["allowLists"].as_array() {
        for list in lists {
            if is_private(list["name"].as_str().unwrap_or(""), scrubber) {
                return fail("An allow-list name contains private material.");
            }
            add_file(
                format!("allowList:{}", list["name"].as_str().unwrap_or("")),
                list,
                8000,
            )?;
        }
    }
    Ok(json!({"items":items}))
}

fn clip(raw: &[u8], limit: usize, cut: bool, scrubber: &Scrubber) -> (String, bool) {
    let text = redact(&String::from_utf8_lossy(raw), scrubber);
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), cut || text.len() > limit)
}

fn read_bounded<R: Read + Send + 'static>(
    mut reader: R,
    cap: usize,
    exceeded: Arc<AtomicBool>,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut data = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let remaining = cap.saturating_sub(data.len());
                    data.extend_from_slice(&buf[..n.min(remaining)]);
                    if n > remaining {
                        exceeded.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        }
        data
    })
}

/// Perform one planned read; the caller must durably journal intent before this call.
/// Only scrubbed, bounded excerpts are returned to the caller.
pub(super) fn collect(item: &Value, cwd: &Path, outcomes: &Value, scrubber: &Scrubber) -> Value {
    let kind = item["kind"].as_str().unwrap_or("");
    let limit = item["maxBytes"].as_u64().unwrap_or(8000) as usize;
    let mut result = json!({"id":item["id"],"source":item["source"],"provides":item["provides"],"untrusted":true,"observedAt":iso()});
    if kind == "report" {
        let text = item["text"].as_str().unwrap_or("");
        let (excerpt, truncated) = clip(text.as_bytes(), limit, false, scrubber);
        result["outcome"] = json!(if excerpt.trim().is_empty() {
            "empty"
        } else {
            "ok"
        });
        result["excerpt"] = json!(excerpt);
        result["truncated"] = json!(truncated);
        result["bytes"] = json!(text.len());
    } else if kind == "file" {
        let path = cwd.join(item["path"].as_str().unwrap_or(""));
        match std::fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                match file.take((limit * 4 + 1) as u64).read_to_end(&mut bytes) {
                    Ok(_) => {
                        let cut = bytes.len() > limit * 4;
                        bytes.truncate(limit * 4);
                        let (excerpt, truncated) = clip(&bytes, limit, cut, scrubber);
                        result["outcome"] = json!(if excerpt.trim().is_empty() {
                            "empty"
                        } else {
                            "ok"
                        });
                        result["excerpt"] = json!(excerpt);
                        result["truncated"] = json!(truncated);
                        result["bytes"] = json!(bytes.len());
                    }
                    Err(_) => {
                        result["outcome"] = json!("failed");
                        result["error"] = json!("Could not read the file.");
                    }
                }
            }
            Err(error) => {
                result["outcome"] =
                    json!(if error.kind() == std::io::ErrorKind::PermissionDenied {
                        "refused"
                    } else {
                        "failed"
                    });
                result["error"] = json!("Could not open the file.");
            }
        }
        result["path"] = item["path"].clone();
    } else if kind == "op" {
        let dependency = item["after"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find(|name| outcomes[*name] != "ok");
        let skipped = item["skip"].as_str().unwrap_or("");
        if !skipped.is_empty() || dependency.is_some() {
            result["outcome"] = json!("skipped");
            result["reason"] = json!(if !skipped.is_empty() {
                skipped.to_owned()
            } else {
                format!(
                    "depends on operation {}, which did not end ok",
                    dependency.unwrap()
                )
            });
        } else {
            let argv = item["argv"].as_array().expect("planned argv");
            let mut command = command_without_window(argv[0].as_str().expect("program"));
            command
                .args(argv.iter().skip(1).filter_map(Value::as_str))
                .current_dir(cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // No adapter code may execute until the kill-on-close job owns it.
                command.creation_flags(0x0800_0000 | 0x0000_0004); // NO_WINDOW | SUSPENDED
            }
            #[cfg(unix)]
            let _watchdog = match contain_unix(&mut command, item["timeoutSec"].as_u64().unwrap_or(30)) {
                Ok(guard) => guard,
                Err(_) => {
                    result["outcome"] = json!("failed");
                    result["error"] = json!("The read process could not be contained.");
                    result["excerpt"] = json!("");
                    result["truncated"] = json!(false);
                    result["missing"] = json!(true);
                    return result;
                }
            };
            match command.spawn() {
                Err(_) => {
                    result["outcome"] = json!("failed");
                    result["error"] = json!("The read command could not start.");
                }
                Ok(mut child) => {
                    #[cfg(windows)]
                    let group = match process_group::Group::new(&child) {
                        Ok(group) => group,
                        Err(_) => {
                            kill_tree(child.id());
                            let _ = child.kill();
                            let _ = child.wait();
                            result["outcome"] = json!("failed");
                            result["error"] = json!("The read process could not be contained.");
                            result["excerpt"] = json!("");
                            result["truncated"] = json!(false);
                            result["missing"] = json!(true);
                            return result;
                        }
                    };
                    #[cfg(windows)]
                    {
                        crate::code_package::cut("incident read contained");
                        if group.resume(&child).is_err() {
                            group.stop();
                            let _ = child.wait();
                            result["outcome"] = json!("failed");
                            result["error"] = json!("The contained read process could not start.");
                            return result;
                        }
                    }
                    let exceeded = Arc::new(AtomicBool::new(false));
                    let out = read_bounded(
                        child.stdout.take().expect("stdout"),
                        limit * 4,
                        exceeded.clone(),
                    );
                    let err = read_bounded(
                        child.stderr.take().expect("stderr"),
                        limit * 4,
                        exceeded.clone(),
                    );
                    let deadline = Instant::now()
                        + Duration::from_secs(item["timeoutSec"].as_u64().unwrap_or(30));
                    let mut timed_out = false;
                    let status = loop {
                        match child.try_wait() {
                            Ok(Some(status)) => break Some(status),
                            Ok(None)
                                if Instant::now() < deadline
                                    && !exceeded.load(Ordering::SeqCst) =>
                            {
                                std::thread::sleep(Duration::from_millis(25))
                            }
                            _ => {
                                timed_out = Instant::now() >= deadline;
                                kill_tree(child.id());
                                let _ = child.kill();
                                break child.wait().ok();
                            }
                        }
                    };
                    #[cfg(unix)]
                    {
                        let mut marker = [0u8; 1];
                        if (&_watchdog.1).read(&mut marker).ok() == Some(1) {
                            timed_out = true;
                        }
                    }
                    #[cfg(windows)]
                    group.stop();
                    #[cfg(unix)]
                    {
                        let _ = crate::checks::end_group(child.id());
                    }
                    let stdout = out.join().unwrap_or_default();
                    let stderr = err.join().unwrap_or_default();
                    let over = exceeded.load(Ordering::SeqCst);
                    let (excerpt, out_cut) = clip(&stdout, limit, over, scrubber);
                    let (err_excerpt, err_cut) = clip(&stderr, 2000, over, scrubber);
                    let combined = format!(
                        "{}\n{}",
                        String::from_utf8_lossy(&stdout),
                        String::from_utf8_lossy(&stderr)
                    )
                    .to_lowercase()
                    .replace("connection refused", "");
                    let policy = [
                        "permission denied",
                        "access denied",
                        "access is denied",
                        "not allowed",
                        "forbidden",
                        "unauthorized",
                        "unauthorised",
                        "not authorized",
                        "not authorised",
                        "insufficient privilege",
                        "operation not permitted",
                        "eacces",
                        "eperm",
                        "refused by policy",
                        "rejected by policy",
                        "refused by the classifier",
                        "refused by the allow-list",
                        "is not in the allow-list",
                        "нет доступа",
                        "доступ запрещ",
                        "запрещено",
                    ]
                    .iter()
                    .any(|p| combined.contains(p));
                    let ok = status.as_ref().is_some_and(|s| s.success());
                    let outcome = if timed_out {
                        "timeout"
                    } else if policy && !ok {
                        "refused"
                    } else if over {
                        "failed"
                    } else if ok {
                        if excerpt.trim().is_empty() {
                            "empty"
                        } else {
                            "ok"
                        }
                    } else {
                        "failed"
                    };
                    result["outcome"] = json!(outcome);
                    result["exitCode"] = json!(status.and_then(|s| s.code()));
                    result["excerpt"] = json!(excerpt);
                    result["stderrExcerpt"] = json!(err_excerpt);
                    result["truncated"] = json!(out_cut || err_cut);
                    result["bytes"] = json!(stdout.len());
                }
            }
        }
    } else {
        result["outcome"] = json!("failed");
        result["error"] = json!("Unknown planned read.");
    }
    if result["excerpt"].is_null() {
        result["excerpt"] = json!("");
    }
    if result["truncated"].is_null() {
        result["truncated"] = json!(false);
    }
    result["missing"] = json!(result["outcome"] != "ok");
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(windows)]
    #[test]
    fn suspended_read_is_contained_when_workflow_dies_at_launch() {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
            fn WaitForSingleObject(handle: *mut core::ffi::c_void, timeout: u32) -> u32;
            fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
        }
        let marker = "ZODCHI_INCIDENT_WINDOWS_CONTAINMENT_TEST";
        if let Some(path) = std::env::var_os(marker) {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .creation_flags(0x0800_0000 | 0x0000_0004)
                .spawn().unwrap();
            let _group = process_group::Group::new(&child).unwrap();
            std::fs::write(path, child.id().to_string()).unwrap();
            let _ = child.wait();
            return;
        }
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.agent-tmp");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("windows-containment-{}", std::process::id()));
        let mut workflow = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "incident_adapter::tests::suspended_read_is_contained_when_workflow_dies_at_launch", "--nocapture"])
            .env(marker, &path).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let pid = loop {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(pid) = text.parse::<u32>() { break pid; }
            }
            assert!(Instant::now() < deadline, "collector did not reach containment");
            std::thread::sleep(Duration::from_millis(20));
        };
        let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) }; // SYNCHRONIZE
        assert!(!handle.is_null());
        workflow.kill().unwrap();
        workflow.wait().unwrap();
        let result = unsafe { WaitForSingleObject(handle, 5000) };
        unsafe { CloseHandle(handle); }
        std::fs::remove_file(path).unwrap();
        assert_eq!(result, 0, "suspended read survived workflow termination");
    }
    #[cfg(unix)]
    #[test]
    fn watchdog_deadline_is_reported_even_if_it_reaps_first() {
        let mut command = std::process::Command::new("/bin/sleep");
        command.arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let guard = contain_unix(&mut command, 1).unwrap();
        let mut child = command.spawn().unwrap();
        std::thread::sleep(Duration::from_secs(2));
        assert!(!child.wait().unwrap().success());
        let mut marker = [0u8; 1];
        assert_eq!((&guard.1).read(&mut marker).unwrap(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn watchdog_stops_read_after_workflow_is_killed() {
        use std::process::Command;
        let marker = "ZODCHI_INCIDENT_WATCHDOG_TEST";
        if let Some(path) = std::env::var_os(marker) {
            let mut command = Command::new("/bin/sleep");
            command.arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            let _guard = contain_unix(&mut command, 10).unwrap();
            let mut child = command.spawn().unwrap();
            std::fs::write(path, child.id().to_string()).unwrap();
            let _ = child.wait();
            return;
        }
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.agent-tmp");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("watchdog-test-{}", std::process::id()));
        let mut workflow = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "incident_adapter::tests::watchdog_stops_read_after_workflow_is_killed", "--nocapture"])
            .env(marker, &path).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !path.exists() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
        assert!(path.exists(), "collector did not start");
        let pid: u32 = std::fs::read_to_string(&path).unwrap().parse().unwrap();
        workflow.kill().unwrap();
        workflow.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let state = Command::new("/bin/ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
            let state = String::from_utf8_lossy(&state.stdout);
            if state.trim().is_empty() || state.trim().starts_with('Z') { break; }
            assert!(Instant::now() < deadline, "operation survived workflow termination");
            std::thread::sleep(Duration::from_millis(50));
        }
        std::fs::remove_file(path).unwrap();
    }
    fn valid() -> Value {
        json!({"adapterVersion":1,"product":"Catalog","owner":"owner","operations":{"job":{"description":"read job","argv":["node","product.mjs","{id}"],"args":{"id":"[0-9]{1,9}"},"provides":["job"]}}})
    }
    #[test]
    fn rejects_shell_flags_and_launchers_even_before_placeholder() {
        let mut a = valid();
        assert!(validate_shape(&a).is_ok());
        for argv in [
            json!(["node", "-e", "{id}"]),
            json!(["node", "--eval", "secret"]),
            json!(["ssh", "host", "node", "product.mjs", "{id}"]),
            json!(["sed", "input.txt", "{id}"]),
            json!(["node", "product.mjs", "job-{id}"]),
            json!(["tools/read.CMD", "{id}"]),
            json!(["read.bat", "{id}"]),
        ] {
            a["operations"]["job"]["argv"] = argv;
            assert!(
                validate_shape(&a).is_err(),
                "accepted {}",
                a["operations"]["job"]["argv"]
            );
        }
    }
    #[test]
    fn checks_fields_limits_order_and_both_capability_sources() {
        let mut a = valid();
        a["operations"]["job"]["maxBytes"] = json!(255);
        assert!(validate_shape(&a).is_err());
        let mut a = valid();
        a["operations"]["job"]["after"] = json!(["later"]);
        assert!(validate_shape(&a).is_err());
        let mut a = valid();
        a["agentSkill"] = json!({"path":"skill.md"});
        assert!(validate_shape(&a).is_err());
        a["allowLists"] = json!([{"name":"tools","path":"allowed.txt"}]);
        assert!(validate_shape(&a).is_ok());
        a["extra"] = json!(true);
        assert!(validate_shape(&a).is_err());
    }

    #[test]
    fn private_or_unsafe_arguments_and_report_are_not_saved_in_the_plan() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.agent-tmp");
        let cfg = zodchi_core::config::Config {
            root: None,
            jobs_dir: None,
            home: root.clone(),
            roles_dir: root.clone(),
            codex_bin: root,
            accounts: vec![],
            max_parallel_jobs: 1,
            standalone: false,
        };
        let scrubber = Scrubber::new(&cfg).unwrap();
        let mut a = valid();
        a["operations"]["job"]["args"]["id"] = json!(".+");
        for value in [
            "4711;remove",
            "pk-abcdefghijklmnop123456",
            "яgho_01234567890123456789",
            "password=hunter2-secret",
        ] {
            let result = plan(
                &a,
                &json!({"id":value}),
                "password=hunter2-secret",
                &scrubber,
            )
            .unwrap();
            let serialized = result.to_string();
            assert!(!serialized.contains(value));
            assert!(!serialized.contains("hunter2-secret"));
            assert_eq!(result["items"][1]["argv"][2], "{id}");
            assert!(!result["items"][1]["skip"].as_str().unwrap().is_empty());
        }
        let result = plan(&a, &json!({"id":"4711"}), "job failed", &scrubber).unwrap();
        assert_eq!(result["items"][1]["argv"][2], "4711");
        assert_eq!(result["items"][1]["skip"], "");
        let secret = "opaqueSyntheticCredential123";
        let result = plan(&a, &json!({"id":"4711"}), &format!("Authorization: Bearer {secret}"), &scrubber).unwrap();
        assert!(!result.to_string().contains(secret));
        let collected = collect(&result["items"][0], &cfg.home, &json!({}), &scrubber);
        assert!(!collected.to_string().contains(secret));
        a["operations"]["job"]["timeoutSec"] = json!(1.0);
        a["operations"]["job"]["maxBytes"] = json!(256.0);
        assert!(validate_shape(&a).is_ok());
        let result = plan(&a, &json!({"id":"4711"}), "test", &scrubber).unwrap();
        assert_eq!(result["items"][1]["timeoutSec"].as_u64(), Some(1));
        assert_eq!(result["items"][1]["maxBytes"].as_u64(), Some(256));
        for report in ["пароль=очень-секретный", "pwd=confidential-value", "access_key=sample-sensitive-value", "session_id=another-sensitive-value"] {
            let result = plan(&a, &json!({"id":"4711"}), report, &scrubber).unwrap().to_string();
            assert!(!result.contains(report.split_once('=').unwrap().1));
        }
    }

    #[test]
    fn javascript_lookaround_backreference_and_utf16_are_whole_matches() {
        let regex = argument_pattern(r"(?=ab)(a.)\1").unwrap();
        assert!(argument_matches(&regex, "abab"));
        assert!(!argument_matches(&regex, "abac"));
        assert!(!argument_matches(&regex, "zabab"));
        assert!(!argument_matches(&regex, "ababz"));
        let one = argument_pattern(r".{1}").unwrap();
        let two = argument_pattern(r".{2}").unwrap();
        assert!(!argument_matches(&one, "😀"));
        assert!(argument_matches(&two, "😀"));
        assert!(!argument_matches(
            &argument_pattern(r".*").unwrap(),
            &"a".repeat(MAX_ARGUMENT_UNITS + 1)
        ));
        assert!(argument_pattern("(").is_err());
    }
}
