//! The checks of a round, run by the engine itself: each command with bash, in order and each to its end, in an
//! exported copy of the candidate tree (a temporary folder, never the checkout), with an environment cut down to
//! what programs need to start (no tokens, keys or credentials from the caller's environment). The real exit code
//! and the log of each command are recorded.
//!
//! Known limit of this version: nothing isolates the network or the file system; a command can still reach the
//! network and read what the user can read. Recorded in docs/flow.md.

use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use zodchi_core::process::{command_without_window, kill_tree, stop_process};
use zodchi_core::util::{fail, pause, Result};

/// What a check command may see of the caller's environment: where programs and the user's tool chains are, the
/// temporary folder and the locale. Nothing else passes.
pub(crate) const KEEP: [&str; 30] = [
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
        if let Ok(out) = command_without_window("git").arg("--exec-path").output() {
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

pub fn preflight() -> Result<()> {
    let program = find_bash();
    if cfg!(windows) && !program.is_file() {
        return zodchi_core::util::fail("Git Bash is required to run the configured checks. Install Git for Windows or set ZODCHI_BASH to the Bash executable.");
    }
    let mut command = command_without_window(&program);
    command.args(["-c", "exit 0"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if !command.status().is_ok_and(|status| status.success()) {
        return zodchi_core::util::fail(format!("The configured checks require Bash, but {} could not run.", program.display()));
    }
    Ok(())
}

pub fn preflight_tools(tools: &[String]) -> Result<()> {
    if tools.is_empty() { return Ok(()); }
    let out = command_without_window(find_bash())
        .args(["-c", "for tool; do command -v \"$tool\" >/dev/null || printf '%s\\n' \"$tool\"; done", "zodchi-tool-check"])
        .args(tools).stdin(Stdio::null()).output()?;
    let missing = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() { return zodchi_core::util::fail("Could not inspect the verification tools on PATH."); }
    if !missing.trim().is_empty() {
        return zodchi_core::util::fail(format!("Verification environment is missing required tools: {}.", missing.lines().collect::<Vec<_>>().join(", ")));
    }
    Ok(())
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
        let status = command_without_window("kill").args(["-KILL", "--", &format!("-{pid}")]).stderr(Stdio::null()).status();
        if let Err(e) = status {
            return Err(format!("kill could not start for the process group {pid}: {e}"));
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    Ok(())
}

/// Settle commands from earlier attempts before executing checks again.
pub(crate) fn reap_unended(journal: &mut crate::journal::Journal) -> Result<()> {
    let events = journal.events();
    let open: Vec<_> = events.iter().filter(|start| start["kind"] == "check started")
        .filter(|start| !events.iter().any(|end| {
            end["kind"] == "check ended" && end["step"] == start["step"]
                && end["attempt"] == start["attempt"] && end["pid"] == start["pid"]
                && end["seq"].as_u64().unwrap_or(0) > start["seq"].as_u64().unwrap_or(0)
        })).cloned().collect();
    for event in open {
        let pid = event["pid"].as_i64().unwrap_or(0);
        let state = stop_process(pid, event["start"].as_str());
        // On Unix a check owns its process group, which can outlive the group leader.
        let group = match state {
            "absent" | "stopped" => end_group(pid as u32),
            "other" => Ok(()),
            _ => Err(format!("it is still running and could not be stopped ({state})")),
        };
        if let Err(why) = group {
            let step = event["step"].as_str().unwrap_or("?");
            return fail(format!("a check command (pid {pid}) of {step} left by an earlier run: {why}. Stop it, then resume"));
        }
        journal.append(json!({ "kind": "check ended", "step": event["step"], "attempt": event["attempt"], "pid": pid, "reaped": state }))?;
    }
    Ok(())
}

/// Runs one command; returns its exit code (None: killed at the time limit or not started), how long it ran, a note,
/// and whether the journal recorded its start and its end. The command runs only after `on(Started, pid)` answered
/// true; when it answers false the command never runs, and when either answers false the caller stops.
fn run_one(bash: &Path, cmd: &str, cwd: &Path, log: &Path, limit: Duration, repo: Option<&Path>, on: &mut dyn FnMut(Phase, u32) -> bool) -> (Option<i32>, u128, String, bool) {
    let started = Instant::now();
    let Ok(file) = fs::File::create(log) else { return (None, 0, "the log could not be created".into(), true) };
    let Ok(err) = file.try_clone() else { return (None, 0, "the log could not be opened twice".into(), true) };
    let mut c = command_without_window(bash);
    c.arg("-c").arg(GATE).arg("zodchi-check").arg(cmd).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::from(file)).stderr(Stdio::from(err));
    c.env_clear();
    for k in KEEP {
        if let Some(v) = std::env::var_os(k) {
            c.env(k, v);
        }
    }
    if let Some(log_dir) = log.parent() { c.env("LOG_DIR", log_dir); }
    if let Some(repo) = repo {
        c.env("ZODCHI_VERIFY_REPOSITORY", repo);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
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
    run_project_list(cmds, source, cwd, logs, limit, None, on)
}

pub(crate) fn run_project_list(cmds: &[String], source: &str, cwd: &Path, logs: &Path, limit: Duration, repo: Option<&Path>, on: &mut dyn FnMut(Phase, u32) -> bool) -> (Vec<Value>, bool) {
    let bash = find_bash();
    let _ = fs::create_dir_all(logs);
    let mut out = Vec::new();
    for (i, cmd) in cmds.iter().enumerate() {
        let name = format!("{}-{}.log", source.replace(['.', ' '], "-"), i + 1);
        let log = logs.join(&name);
        let (code, ms, note, recorded) = run_one(&bash, cmd, cwd, &log, limit, repo, on);
        out.push(json!({ "command": cmd, "source": source, "exitCode": code, "log": log.display().to_string(), "ms": ms as u64, "note": note }));
        if !recorded {
            return (out, false);
        }
    }
    (out, true)
}

/// A stable label for a command in the evidence, such as "args.verify #1".
pub fn name(evidence: &[Value], i: usize) -> String {
    let source = evidence[i]["source"].as_str().unwrap_or("?");
    let n = evidence[..=i].iter().filter(|e| e["source"].as_str() == Some(source)).count();
    format!("{source} #{n}")
}

pub(crate) const WITHHELD_LINE: &str = "[source line withheld]";
pub(crate) const LEGACY_WITHHELD_LINE: &str = "[a line that may hold a credential is left out]";

/// Output of a check made fit for a model: the known private folders (`places`: a path and the word that stands for
/// it) replaced in any spelling of the path, and every line that may hold a credential (a password, token, key,
/// secret, cookie or a URL with a user) left out whole.
pub fn sanitize(text: &str, places: &[(String, &str)]) -> String {
    let lines = text.lines().map(|line| if credential_line(line) { WITHHELD_LINE } else { line });
    screen_paths(lines, places)
}

pub(crate) fn credential_url(line: &str) -> bool {
    line.match_indices("://").any(|(i, _)| line[i..].split_whitespace().next().is_some_and(|u| u.contains('@')))
}

pub(crate) fn credential_line(line: &str) -> bool {
    const MARKERS: [&str; 12] = ["password", "passwd", "secret", "token", "api_key", "apikey", "api-key", "authorization", "bearer", "private key", "credential", "cookie"];
    let low = line.to_ascii_lowercase().replace(LEGACY_WITHHELD_LINE, WITHHELD_LINE);
    credential_url(&low) || MARKERS.iter().any(|m| low.contains(m))
}

pub(crate) fn screen_paths<'a>(text: impl Iterator<Item = &'a str>, places: &[(String, &str)]) -> String {
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
    for line in text {
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
    tail_text(&text, max)
}

fn tail_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("... ({} bytes before)\n{}", start, &text[start..])
}

/// Read from the beginning so the scrubber sees multiline credentials before anything is clipped for review.
pub fn review_output(log: &Path, budget: usize, clean: impl FnOnce(&str) -> String) -> String {
    const READ_LIMIT: u64 = 128 * 1024;
    let mut bytes = Vec::new();
    if fs::File::open(log).and_then(|file| file.take(READ_LIMIT + 1).read_to_end(&mut bytes)).is_err() {
        return "[log unavailable]".into();
    }
    let clipped = bytes.len() as u64 > READ_LIMIT;
    if clipped {
        // Keep complete lines from the bounded read. Do not expose an incomplete value at its boundary.
        bytes.truncate(bytes.iter().rposition(|byte| *byte == b'\n').unwrap_or(0));
    }
    let text = clean(&String::from_utf8_lossy(&bytes));
    let excerpt = tail_text(&text, budget);
    if clipped { format!("{excerpt}\n[remaining log omitted]") } else { excerpt }
}

pub fn temp_dir(run: &str, tag: &str) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("zodchi-flow-{run}-{}-{:08x}", tag.replace([' ', '.'], "-"), rand::random::<u32>()));
    fs::create_dir(&dir)?;
    Ok(dir)
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
