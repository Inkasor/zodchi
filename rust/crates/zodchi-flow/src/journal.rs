//! The journal of a run: `~/.zodchi/flows/<run-id>/` (or `$ZODCHI_HOME/flows/<run-id>/`), outside the repository
//! and every folder a model or a check is pointed at. `run.json` pins what the run is (workflow version, base,
//! inputs, the writer/reviewer pair, the policy); `events.jsonl` records, before each effect, its step, round,
//! attempt, input digest, intended effect and gateway key, and after it the validated result or the Git receipt.
//! One process at a time works on a run: `lock/` holds its pid and start.

use serde_json::{json, Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use zodchi_core::process::{alive, process_start};
use zodchi_core::util::{fail, iso, pretty, read_stored, sha256_hex, write_json_atomic, GatewayError, Result};

pub struct Journal {
    pub dir: PathBuf,
    events: Vec<Value>,
}

pub fn flows_dir(home: &Path) -> PathBuf {
    home.join("flows")
}

/// A clarification adds input while leaving the stopped step in place.
pub(crate) fn last_state_event(events: &[Value]) -> Option<&Value> {
    events.iter().rev().find(|event| {
        !matches!(event["kind"].as_str(), Some("owner clarification" | "cleanup"))
    })
}

/// Completion requires both a finished event and a stored result with a closed claim.
pub(crate) fn finished_event<'a>(events: &'a [Value], result: Option<&Value>) -> Option<&'a Value> {
    result.filter(|result| result.is_object() && result.get("claimLeftOpen").is_none())?;
    events.iter().rfind(|event| event["kind"] == "finished")
}

/// An inaccessible process still owns its receipt unless its PID was demonstrably reused.
pub(crate) fn live_pid(owner: &Value) -> Option<u32> {
    let pid = owner_pid(owner)?;
    if !alive(pid) {
        return None;
    }
    if owner["start"].as_str().is_some_and(|expected| process_start(pid).is_some_and(|actual| expected != actual)) {
        return None;
    }
    Some(pid)
}

/// A recorded pid outside the range a process can have is no owner. On Unix `kill(pid, 0)` cannot test a pid above
/// `i32::MAX` and reports it as unknown, which `live_pid` would otherwise keep as a live, unreadable owner.
pub(crate) fn owner_pid(owner: &Value) -> Option<u32> {
    u32::try_from(owner["pid"].as_u64()?).ok().filter(|&pid| pid != 0 && pid <= i32::MAX as u32)
}

pub(crate) fn source_ids(run: &Value) -> impl Iterator<Item = &str> {
    [&run["sourceRun"], &run["inputs"]["args"]["sourceRun"]]
        .into_iter()
        .filter_map(Value::as_str)
        .filter(|id| is_run_id(id))
}

pub fn is_run_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 64 && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && text.as_bytes()[0].is_ascii_alphanumeric()
}

pub fn new_run_id() -> String {
    let digits: String = iso().chars().filter(char::is_ascii_digit).collect();
    let suffix = rand::random::<u32>() & 0xff_ffff;
    format!("{}-{}-{suffix:06x}", &digits[..8], &digits[8..14])
}

impl Journal {
    /// A new run folder; refuses one that exists.
    pub fn create(home: &Path, id: &str, run: &Value) -> Result<Journal> {
        let dir = flows_dir(home).join(id);
        fs::create_dir_all(flows_dir(home))?;
        // Register source dependencies under the same lock the collector uses to retire a source.
        let _sources = if source_ids(run).next().is_some() {
            let lock = crate::cleanup::lock_sources(home, true)?;
            for source in source_ids(run) {
                Self::open(home, source)?;
            }
            Some(lock)
        } else {
            None
        };
        fs::create_dir(&dir).map_err(|e| GatewayError(format!("Cannot make the journal {}: {e}", dir.display())))?;
        fs::File::create(dir.join("events.jsonl"))?.sync_all()?;
        let pinned = zodchi_core::config::dev_build_commit(home).map(|commit| {
            let mut run = run.clone();
            run["buildCommit"] = json!(commit);
            run
        });
        write_json_atomic(&dir.join("run.json"), pinned.as_ref().unwrap_or(run))?;
        if run["workflow"] == crate::code_package::WORKFLOW {
            crate::cleanup::note_package_home(home, id);
        }
        Ok(Journal { dir, events: vec![] })
    }

    /// Opens the run folder; its events are read by `load`, under the lock.
    pub fn open(home: &Path, id: &str) -> Result<(Journal, Value)> {
        if !is_run_id(id) {
            return fail(format!("Not a run id: {id}"));
        }
        let dir = flows_dir(home).join(id);
        let Some(run) = read_stored(&dir.join("run.json")) else {
            return fail(format!("No run {id} in {}.", flows_dir(home).display()));
        };
        Ok((Journal { dir, events: vec![] }, run))
    }

    /// Reads the events; call it holding the lock. Only a record without its line end, the last one, can be cut in
    /// the middle of its write: it is dropped from the file, so the next record starts on a line of its own. Any
    /// other record that does not read is a broken journal, and nothing goes on from it.
    pub fn load(&mut self) -> Result<()> {
        let file = self.dir.join("events.jsonl");
        let bytes = fs::read(&file).map_err(|e| GatewayError(format!("Cannot read the journal {}: {e}", file.display())))?;
        let (events, end) = Self::decode_events(&file, &bytes)?;
        if end < bytes.len() {
            let f = fs::OpenOptions::new().write(true).open(&file)?;
            f.set_len(end as u64)?;
            f.sync_all()?;
        }
        self.events = events;
        Ok(())
    }

    /// A status reader sees only complete records, including while a worker is appending.
    pub fn snapshot(&self) -> Result<Vec<Value>> {
        let file = self.dir.join("events.jsonl");
        let bytes = fs::read(&file)?;
        Self::decode_events(&file, &bytes).map(|(events, _)| events)
    }

    fn decode_events(file: &Path, bytes: &[u8]) -> Result<(Vec<Value>, usize)> {
        let end = bytes.iter().rposition(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0);
        let mut events = Vec::new();
        for (n, line) in bytes[..end].split(|b| *b == b'\n').enumerate() {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            match serde_json::from_slice::<Value>(line) {
                Ok(v) => events.push(v),
                Err(e) => return fail(format!("The journal {} is broken at line {}: {e}. Nothing was run; look at it before resuming.", file.display(), n + 1)),
            }
        }
        Ok((events, end))
    }

    pub fn active(&self) -> bool {
        ["lock/owner.json", "worker.json"].iter()
            .filter_map(|name| self.read_value(name))
            .any(|owner| live_pid(&owner).is_some())
    }

    /// Takes the lock of the run: one process at a time. A lock whose process is gone (or is another program now)
    /// is stale and taken over.
    pub fn lock(&self) -> Result<RunLock> {
        Self::lock_directory(self.dir.join("lock"))
    }

    pub(crate) fn lock_directory(dir: PathBuf) -> Result<RunLock> {
        for _ in 0..2 {
            match fs::create_dir(&dir) {
                Ok(()) => {
                    let me = std::process::id();
                    write_json_atomic(&dir.join("owner.json"), &json!({
                        "pid": me, "start": process_start(me), "at": iso(),
                        "executable": std::env::current_exe().ok().map(|path| path.display().to_string()),
                    }))?;
                    return Ok(RunLock { dir });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let owner = read_stored(&dir.join("owner.json")).unwrap_or(Value::Null);
                    if let Some(pid) = live_pid(&owner).filter(|&pid| pid != std::process::id()) {
                        return fail(format!("Another process (pid {pid}) works on this run; one at a time."));
                    }
                    if owner.is_null() {
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
        last_state_event(&self.events)
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Writes a file of the journal whole and durably (a temporary file, synced, then renamed), before any event that
    /// names it is recorded.
    pub fn write_text(&self, name: &str, text: &str) -> Result<PathBuf> {
        self.write_bytes(name, text.as_bytes())
    }

    pub(crate) fn write_bytes(&self, name: &str, bytes: &[u8]) -> Result<PathBuf> {
        let file = self.dir.join(name);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp = file.with_file_name(format!(".{}.{}.tmp", file.file_name().and_then(|n| n.to_str()).unwrap_or("file"), std::process::id()));
        {
            let mut f = fs::File::create(&temp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        if let Err(e) = fs::rename(&temp, &file) {
            let _ = fs::remove_file(&temp);
            return Err(e.into());
        }
        Ok(file)
    }

    pub fn write_value(&self, name: &str, value: &Value) -> Result<PathBuf> {
        self.write_text(name, &(pretty(value) + "\n"))
    }

    pub fn read_value(&self, name: &str) -> Option<Value> {
        read_stored(&self.dir.join(name))
    }

    pub fn read_verified(&self, name: &str, digest: &Value) -> Result<String> {
        let text = fs::read_to_string(self.file(name))?;
        if digest != &sha256_hex(&text) {
            return fail(format!("{name} does not match its recorded digest."));
        }
        Ok(text)
    }

    /// The Rust port can replay the known version-one definition using the same steps and receipts.
    pub(crate) fn verify_legacy_workflow(&self, run: &Value, expected_digest: &str) -> Result<()> {
        let digest = &run["inputs"]["definitionSha256"];
        if digest != expected_digest {
            return fail("The journal identifies an unrecognized version-one workflow.");
        }
        self.read_verified("workflow.js", digest)?;
        Ok(())
    }

    pub(crate) fn completed_steps(&self) -> Map<String, Value> {
        self.events.iter().filter_map(|event| {
            let step = event["step"].as_str()?;
            if event["kind"] != "done" || event["attempt"].as_u64()? != u64::from(self.attempt(step)) {
                return None;
            }
            Some((step.to_string(), event["result"].clone()))
        }).collect()
    }
}

/// The lock of a run, released when the process is done with it.
pub struct RunLock {
    dir: PathBuf,
}

impl RunLock {
    /// Move a locked journal out of the live namespace before deleting any of its files.
    pub(crate) fn move_journal(&mut self, destination: &Path) -> Result<()> {
        let journal = self.dir.parent().expect("run lock inside a journal");
        fs::rename(journal, destination)?;
        self.dir = destination.join("lock");
        Ok(())
    }
}

impl Drop for RunLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
