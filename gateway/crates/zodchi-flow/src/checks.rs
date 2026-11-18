//! The checks of a round, run by the engine itself: each command with bash, in order and each to its end, in an
//! exported copy of the candidate tree (a temporary folder, never the checkout), with an environment cut down to
//! what programs need to start (no tokens, keys or credentials from the caller's environment). The real exit code
//! and the log of each command are recorded.
//!
//! Known limit of this version: nothing isolates the network or the file system; a command can still reach the
//! network and read what the user can read. Recorded in docs/flow.md.

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
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

/// What the journal is told about a check command: it started (its pid), or it ended (and, on Unix, what it left in
/// its process group was ended with it). The callback answers false when the journal could not record it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Started,
    Ended,
}

/// The gate every check command passes: bash waits for the engine's word on stdin and only then runs the command
/// (`$1`) in its own place (the same pid). The engine gives the word after the pid and start time are in the journal;
/// when the engine is gone first, stdin closes and the gate exits 125 without running anything.
const GATE: &str = "IFS= read -r go || exit 125; [ \"$go\" = go ] || exit 125; exec \"$BASH\" -c \"$1\" </dev/null";

/// Ends what a check command left in its process group (Unix: a check leads its own group). An error only when the
/// group could not be signalled at all; no group left is not one.
pub fn end_group(pid: u32) -> std::result::Result<(), String> {
    #[cfg(unix)]
    {
        // Exit 1 is "no such group" (or not ours): nothing of the check runs there.
        let status = Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).stderr(Stdio::null()).status();
        if let Err(e) = status {
            return Err(format!("kill could not start for the process group {pid}: {e}"));
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    Ok(())
}

/// Runs one command; returns its exit code (None: killed at the time limit or not started), how long it ran, a note,
/// and whether the journal recorded its start and its end. The command runs only after `on(Started, pid)` answered
/// true; when it answers false the command never runs, and when either answers false the caller stops.
fn run_one(bash: &Path, cmd: &str, cwd: &Path, log: &Path, log_dir: &Path, limit: Duration, on: &mut dyn FnMut(Phase, u32) -> bool) -> (Option<i32>, u128, String, bool) {
    let started = Instant::now();
    let Ok(file) = fs::File::create(log) else { return (None, 0, "the log could not be created".into(), true) };
    let Ok(err) = file.try_clone() else { return (None, 0, "the log could not be opened twice".into(), true) };
    let mut c = Command::new(bash);
    c.arg("-c").arg(GATE).arg("zodchi-check").arg(cmd).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::from(file)).stderr(Stdio::from(err));
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
        Err(e) => return (None, 0, format!("bash could not start ({}): {e}", bash.display()), true),
    };
    let pid = child.id();
    let stdin = child.stdin.take();
    let go = on(Phase::Started, pid) && stdin.is_some_and(|mut s| s.write_all(b"go\n").is_ok());
    if !go {
        // Not recorded, or the word did not reach it: the gate never runs the command.
        kill_tree(pid);
        let _ = child.wait();
        let _ = end_group(pid);
        return (None, started.elapsed().as_millis(), "not run: its start could not be recorded in the journal".into(), false);
    }
    let (code, note) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), String::new()),
            Ok(None) if started.elapsed() > limit => {
                kill_tree(pid);
                let _ = child.wait();
                break (None, format!("stopped at its time limit of {} s", limit.as_secs()));
            }
            Ok(None) => pause(100),
            Err(e) => {
                kill_tree(pid);
                let _ = child.wait();
                break (None, format!("waiting for it failed: {e}"));
            }
        }
    };
    let ms = started.elapsed().as_millis();
    if let Err(e) = end_group(pid) {
        return (code, ms, format!("{note} {e}").trim().to_string(), false);
    }
    (code, ms, note, on(Phase::Ended, pid))
}

/// Runs a list of commands in order, each to its end. Every entry of the evidence holds the command, its source,
/// its real exit code (null when it did not end by itself) and its log. `on` records the start and the end of each
/// command; the second value is false when it could not, and then no further command starts.
pub fn run_list(cmds: &[String], source: &str, cwd: &Path, logs: &Path, limit: Duration, on: &mut dyn FnMut(Phase, u32) -> bool) -> (Vec<Value>, bool) {
    let bash = find_bash();
    let _ = fs::create_dir_all(logs);
    let mut out = Vec::new();
    for (i, cmd) in cmds.iter().enumerate() {
        let name = format!("{}-{}.log", source.replace(['.', ' '], "-"), i + 1);
        let log = logs.join(&name);
        let (code, ms, note, recorded) = run_one(&bash, cmd, cwd, &log, logs, limit, on);
        out.push(json!({ "command": cmd, "source": source, "exitCode": code, "log": log.display().to_string(), "ms": ms as u64, "note": note }));
        if !recorded {
            return (out, false);
        }
    }
    (out, true)
}

/// How a model sees a command of the evidence: its source and number ("args.verify #1"), never the command line,
/// which may hold a private path or a credential.
pub fn name(evidence: &[Value], i: usize) -> String {
    let source = evidence[i]["source"].as_str().unwrap_or("?");
    let n = evidence[..=i].iter().filter(|e| e["source"].as_str() == Some(source)).count();
    format!("{source} #{n}")
}

/// Output of a check made fit for a model: the known private folders (`places`: a path and the word that stands for
/// it) replaced in any spelling of the path, and every line that may hold a credential (a password, token, key,
/// secret, cookie or a URL with a user) left out whole.
pub fn sanitize(text: &str, places: &[(String, &str)]) -> String {
    const MARKERS: [&str; 12] = ["password", "passwd", "secret", "token", "api_key", "apikey", "api-key", "authorization", "bearer", "private key", "credential", "cookie"];
    let mut spellings: Vec<(String, &str)> = Vec::new();
    for (path, word) in places {
        let fwd = path.replace('\\', "/").trim_end_matches('/').to_string();
        if fwd.len() < 2 {
            continue;
        }
        let mut forms = vec![fwd.clone(), fwd.replace('/', "\\")];
        // The MSYS spelling of a drive path: the drive letter as the first folder, lower case.
        let b = fwd.as_bytes();
        if b.len() > 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            forms.push(format!("/{}{}", (b[0] as char).to_ascii_lowercase(), &fwd[2..]));
        }
        for f in forms {
            spellings.push((f, word));
        }
    }
    // The longest first: a folder inside another is named by its own word.
    spellings.sort_by_key(|(f, _)| std::cmp::Reverse(f.len()));
    let mut lines = Vec::new();
    for line in text.lines() {
        let low = line.to_ascii_lowercase();
        let user_url = low.find("://").is_some_and(|i| low[i..].split_whitespace().next().is_some_and(|u| u.contains('@')));
        if user_url || MARKERS.iter().any(|m| low.contains(m)) {
            lines.push("[a line that may hold a credential is left out]".to_string());
            continue;
        }
        let mut out = line.to_string();
        for (form, word) in &spellings {
            out = replace_caseless(&out, form, word);
        }
        lines.push(out);
    }
    lines.join("\n")
}

/// Replaces every occurrence of `needle` in `text`, ignoring ASCII case (paths on Windows and macOS).
fn replace_caseless(text: &str, needle: &str, with: &str) -> String {
    let low = text.to_ascii_lowercase();
    let n = needle.to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(i) = low[at..].find(&n) {
        out.push_str(&text[at..at + i]);
        out.push_str(with);
        at += i + n.len();
    }
    out.push_str(&text[at..]);
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
