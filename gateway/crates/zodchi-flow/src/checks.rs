//! The checks of a round, run by the engine itself: each command with bash, in order and each to its end, in an
//! exported copy of the candidate tree (a temporary folder, never the checkout), with an environment cut down to
//! what programs need to start (no tokens, keys or credentials from the caller's environment). The real exit code
//! and the log of each command are recorded.
//!
//! Known limit of this version: nothing isolates the network or the file system; a command can still reach the
//! network and read what the user can read. Recorded in docs/flow.md.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use zodchi_core::process::kill_tree;
use zodchi_core::util::{pause, Result};

/// What a check command may see of the caller's environment: where programs and the user's tool chains are, the
/// temporary folder and the locale. Nothing else passes.
const KEEP: [&str; 30] = [
    "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "USER", "USERNAME", "LOGNAME", "CARGO_HOME", "RUSTUP_HOME",
];

/// bash: `ZODCHI_BASH`, else on Windows the bash of Git for Windows (never the WSL launcher in System32), else
/// `bash` on PATH.
pub fn find_bash() -> PathBuf {
    if let Some(b) = std::env::var_os("ZODCHI_BASH").filter(|v| !v.is_empty()) {
        return PathBuf::from(b);
    }
    if cfg!(windows) {
        if let Ok(out) = Command::new("git").arg("--exec-path").output() {
            // <git>/mingw64/libexec/git-core (or usr/libexec/git-core): bash is <git>/bin/bash.exe or <git>/usr/bin/bash.exe.
            let exec = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
            for up in exec.ancestors().skip(1).take(4) {
                for c in [up.join("bin").join("bash.exe"), up.join("usr").join("bin").join("bash.exe")] {
                    if c.is_file() {
                        return c;
                    }
                }
            }
        }
    }
    PathBuf::from("bash")
}

/// Runs one command; returns its exit code (None: killed at the time limit or not started) and how long it ran.
/// `started_cb` gets the pid of the command as soon as it runs, before the engine waits for it.
fn run_one(bash: &Path, cmd: &str, cwd: &Path, log: &Path, log_dir: &Path, limit: Duration, started_cb: &mut dyn FnMut(u32)) -> (Option<i32>, u128, String) {
    let started = Instant::now();
    let Ok(file) = fs::File::create(log) else { return (None, 0, "the log could not be created".into()) };
    let Ok(err) = file.try_clone() else { return (None, 0, "the log could not be opened twice".into()) };
    let mut c = Command::new(bash);
    c.arg("-c").arg(cmd).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::from(file)).stderr(Stdio::from(err));
    c.env_clear();
    for k in KEEP {
        if let Some(v) = std::env::var_os(k) {
            c.env(k, v);
        }
    }
    c.env("LOG_DIR", log_dir);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match c.spawn() {
        Ok(child) => child,
        Err(e) => return (None, 0, format!("bash could not start ({}): {e}", bash.display())),
    };
    started_cb(child.id());
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return (status.code(), started.elapsed().as_millis(), String::new()),
            Ok(None) if started.elapsed() > limit => {
                kill_tree(child.id());
                let _ = child.wait();
                return (None, started.elapsed().as_millis(), format!("stopped at its time limit of {} s", limit.as_secs()));
            }
            Ok(None) => pause(100),
            Err(e) => return (None, started.elapsed().as_millis(), format!("waiting for it failed: {e}")),
        }
    }
}

/// Runs a list of commands in order, each to its end. Every entry of the evidence holds the command, its source,
/// its real exit code (null when it did not end by itself) and its log. `started` gets the pid of each command.
pub fn run_list(cmds: &[String], source: &str, cwd: &Path, logs: &Path, limit: Duration, started: &mut dyn FnMut(u32)) -> Vec<Value> {
    let bash = find_bash();
    let _ = fs::create_dir_all(logs);
    let mut out = Vec::new();
    for (i, cmd) in cmds.iter().enumerate() {
        let name = format!("{}-{}.log", source.replace(['.', ' '], "-"), i + 1);
        let log = logs.join(&name);
        let (code, ms, note) = run_one(&bash, cmd, cwd, &log, logs, limit, started);
        out.push(json!({ "command": cmd, "source": source, "exitCode": code, "log": log.display().to_string(), "ms": ms as u64, "note": note }));
    }
    out
}

pub fn passed(evidence: &[Value]) -> bool {
    evidence.iter().all(|e| e["exitCode"] == json!(0))
}

/// The end of a log, for the writer that fixes a failure.
pub fn tail(log: &str, max: usize) -> String {
    let text = fs::read(log).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("... ({} bytes before)\n{}", start, &text[start..])
}

pub fn temp_dir(run: &str, tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("zodchi-flow-{run}-{}-{:08x}", tag.replace([' ', '.'], "-"), rand::random::<u32>()))
}

pub fn remove(dir: &Path) {
    for _ in 0..5 {
        if fs::remove_dir_all(dir).is_ok() || !dir.exists() {
            return;
        }
        pause(200);
    }
}

pub fn result(evidence: &[Value]) -> Result<Value> {
    Ok(json!({ "ok": passed(evidence), "evidence": evidence }))
}
