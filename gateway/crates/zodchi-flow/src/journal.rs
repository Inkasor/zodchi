//! The journal of a run: `~/.zodchi/flows/<run-id>/` (or `$ZODCHI_HOME/flows/<run-id>/`), outside the repository
//! and every folder a model or a check is pointed at. `run.json` pins what the run is (workflow version, base,
//! inputs, the writer/reviewer pair, the policy); `events.jsonl` records, before each effect, its step, round,
//! attempt, input digest, intended effect and gateway key, and after it the validated result or the Git receipt.
//! One process at a time works on a run: `lock/` holds its pid and start.

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use zodchi_core::process::{alive, process_start};
use zodchi_core::util::{fail, iso, pretty, read_stored, write_json_atomic, GatewayError, Result};

pub struct Journal {
    pub dir: PathBuf,
    events: Vec<Value>,
}

pub fn flows_dir(home: &Path) -> PathBuf {
    home.join("flows")
}

pub fn is_run_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 64 && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && text.as_bytes()[0].is_ascii_alphanumeric()
}

impl Journal {
    /// A new run folder; refuses one that exists.
    pub fn create(home: &Path, id: &str, run: &Value) -> Result<Journal> {
        let dir = flows_dir(home).join(id);
        fs::create_dir_all(flows_dir(home))?;
        fs::create_dir(&dir).map_err(|e| GatewayError(format!("Cannot make the journal {}: {e}", dir.display())))?;
        write_json_atomic(&dir.join("run.json"), run)?;
        fs::write(dir.join("events.jsonl"), "")?;
        Ok(Journal { dir, events: vec![] })
    }

    pub fn open(home: &Path, id: &str) -> Result<(Journal, Value)> {
        if !is_run_id(id) {
            return fail(format!("Not a run id: {id}"));
        }
        let dir = flows_dir(home).join(id);
        let Some(run) = read_stored(&dir.join("run.json")) else {
            return fail(format!("No run {id} in {}.", flows_dir(home).display()));
        };
        let text = fs::read_to_string(dir.join("events.jsonl")).unwrap_or_default();
        let mut events = Vec::new();
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            match serde_json::from_str::<Value>(line) {
                Ok(v) => events.push(v),
                // A line cut in the middle of its write is the last one; anything after it would be a broken journal.
                Err(_) => break,
            }
        }
        Ok((Journal { dir, events }, run))
    }

    /// Takes the lock of the run: one process at a time. A lock whose process is gone (or is another program now)
    /// is stale and taken over.
    pub fn lock(&self) -> Result<RunLock> {
        let dir = self.dir.join("lock");
        for _ in 0..2 {
            match fs::create_dir(&dir) {
                Ok(()) => {
                    let me = std::process::id();
                    write_json_atomic(&dir.join("owner.json"), &json!({ "pid": me, "start": process_start(me), "at": iso() }))?;
                    return Ok(RunLock { dir });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let owner = read_stored(&dir.join("owner.json")).unwrap_or(Value::Null);
                    let pid = owner.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
                    let start = owner.get("start").and_then(Value::as_str).map(String::from);
                    if pid > 0 && pid != std::process::id() && alive(pid) && (start.is_none() || process_start(pid) == start) {
                        return fail(format!("Another process (pid {pid}) works on this run; one at a time."));
                    }
                    if pid == 0 && owner.is_null() {
                        // A lock folder without its owner file may be one being made right now.
                        let age = fs::metadata(&dir).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
                        if age.is_none_or(|a| a.as_secs() < 60) {
                            return fail("Another process is taking the lock of this run; one at a time.");
                        }
                    }
                    let _ = fs::remove_dir_all(&dir);
                }
                Err(e) => return Err(e.into()),
            }
        }
        fail("The lock of this run could not be taken.")
    }

    pub fn events(&self) -> &[Value] {
        &self.events
    }

    /// Appends one event and makes it durable before the effect it announces.
    pub fn append(&mut self, mut event: Value) -> Result<()> {
        event["seq"] = json!(self.events.len() + 1);
        event["at"] = json!(iso());
        let mut file = fs::OpenOptions::new().append(true).open(self.dir.join("events.jsonl"))?;
        file.write_all(format!("{}\n", serde_json::to_string(&event).unwrap_or_default()).as_bytes())?;
        file.sync_all()?;
        self.events.push(event);
        Ok(())
    }

    /// The last event of a kind for a step and attempt.
    pub fn last(&self, kind: &str, step: &str, attempt: u32) -> Option<&Value> {
        self.events.iter().rev().find(|e| e["kind"] == json!(kind) && e["step"] == json!(step) && e["attempt"] == json!(attempt))
    }

    pub fn all(&self, kind: &str, step: &str, attempt: u32) -> Vec<&Value> {
        self.events.iter().filter(|e| e["kind"] == json!(kind) && e["step"] == json!(step) && e["attempt"] == json!(attempt)).collect()
    }

    /// The attempt a step is on: 1, plus one for each recorded rerun of it.
    pub fn attempt(&self, step: &str) -> u32 {
        1 + self.events.iter().filter(|e| e["kind"] == json!("rerun") && e["step"] == json!(step)).count() as u32
    }

    pub fn last_event(&self) -> Option<&Value> {
        self.events.last()
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn write_text(&self, name: &str, text: &str) -> Result<PathBuf> {
        let file = self.dir.join(name);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&file, text)?;
        Ok(file)
    }

    pub fn write_value(&self, name: &str, value: &Value) -> Result<PathBuf> {
        self.write_text(name, &(pretty(value) + "\n"))
    }

    pub fn read_value(&self, name: &str) -> Option<Value> {
        read_stored(&self.dir.join(name))
    }
}

/// The lock of a run, released when the process is done with it.
pub struct RunLock {
    dir: PathBuf,
}

impl Drop for RunLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
