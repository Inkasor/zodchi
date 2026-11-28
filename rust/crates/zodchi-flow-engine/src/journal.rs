//! The journal of a run: `~/.zodchi/flows/<run-id>/` (or `$ZODCHI_HOME/flows/<run-id>/`), outside the repository
//! and every folder a model or a check is pointed at. `run.json` pins what the run is (workflow version, base,
//! inputs, the writer/reviewer pair, the policy); `events.jsonl` records, before each effect, its step, round,
//! attempt, input digest, intended effect and gateway key, and after it the validated result or the Git receipt.
//! One process at a time works on a run: `lock/` holds its pid and start.

use crate::{
    boundary::{Exit, WORKFLOW},
    budget::Budget,
};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use zodchi_core::config::Config;
use zodchi_core::process::{alive, process_start, reused_after_reboot};
use zodchi_core::util::{fail, iso, pretty, read_stored, sha256_hex, write_json_atomic, GatewayError, Result};

pub struct Journal {
    pub dir: PathBuf,
    events: Vec<Value>,
}

// A durable journal event that can be written while events.jsonl is held by the worker.
pub const SHUTDOWN_REQUEST: &str = "shutdown-request.json";
pub const PENDING_REMARKS: &str = "pending-remarks";

pub fn flows_dir(home: &Path) -> PathBuf {
    home.join("flows")
}

pub fn last_write(dir: &Path) -> Option<SystemTime> {
    ["events.jsonl", "run.json", "result.json"]
        .into_iter()
        .filter_map(|name| {
            let meta = fs::metadata(dir.join(name)).ok()?;
            meta.is_file().then(|| meta.modified().ok()).flatten()
        })
        .max()
}

pub(crate) const CANDIDATE_WORKSPACES: &str = "flow-candidates";

pub fn candidate_workspace(home: &Path, id: &str) -> PathBuf {
    home.join(CANDIDATE_WORKSPACES).join(id)
}

pub fn candidate_applied(events: &[Value]) -> Option<Value> {
    events
        .iter()
        .rev()
        .find(|event| event["kind"] == "application finished")
        .map(|event| event["result"].clone())
}

pub fn application_status(events: &[Value]) -> Option<Value> {
    candidate_applied(events).or_else(|| {
        events
            .iter()
            .any(|event| event["kind"] == "application intent")
            .then(|| json!({ "status": "pending_reconciliation" }))
    })
}

/// Administrative events leave the stopped step in place.
pub fn last_state_event(events: &[Value]) -> Option<&Value> {
    events.iter().rev().find(|event| {
        match event["kind"].as_str() {
            Some("owner clarification" | "cleanup" | "cancel requested" | "remarks attached") => false,
            Some("scope allowed") => event["awaitingReply"] != true,
            Some("finished") => event["verdict"] != "closed",
            _ => true,
        }
    })
}

pub fn scope_approvals(events: &[Value]) -> impl Iterator<Item = &Value> {
    events.iter().filter_map(|event| {
        if event["kind"] == "scope allowed" { Some(event) } else { event.get("scopeApproval") }
    })
}

/// Legacy waiting and approval events may predate the round field.
pub fn scope_round(event: &Value) -> u64 {
    let step = event["step"].as_str().unwrap_or("");
    event["round"].as_u64().or_else(|| {
        step.strip_prefix("apply ").unwrap_or(step).split_whitespace().nth(1)?
            .split('.').next()?.parse().ok()
    }).unwrap_or(1).max(1)
}

pub struct PendingRemark {
    pub id: String,
    pub text: String,
    pub after_step: Option<String>,
}

/// Completion requires both a finished event and a stored result with a closed claim.
pub fn finished_event<'a>(events: &'a [Value], result: Option<&Value>) -> Option<&'a Value> {
    let result = result.filter(|result| result.is_object() && result.get("claimLeftOpen").is_none())?;
    events.iter().rfind(|event| {
        event["kind"] == "finished" && (event["verdict"] == "closed") == (result["verdict"] == "closed")
    })
}

/// A model request can reach its executor before the `submitted` record is durable.
pub fn unknown_model_step(events: &[Value]) -> Option<&str> {
    let mut settled = HashSet::new();
    for event in events.iter().rev() {
        let (Some(step), Some(attempt)) = (event["step"].as_str(), event["attempt"].as_u64()) else {
            continue;
        };
        let call = (step, attempt);
        let resolved = matches!(event["kind"].as_str(), Some("done" | "safety blocked")) || known_model_stop(event);
        let model_intent = event["kind"] == "intent"
            && (event["model"].is_string()
                || matches!(event["effect"].as_str(), Some("gateway job" | "acceptor" | "expert job")));
        if resolved {
            settled.insert(call);
        } else if (event["kind"] == "submitted" || model_intent) && !settled.contains(&call) {
            return Some(step);
        }
    }
    None
}

fn known_model_stop(event: &Value) -> bool {
    event["kind"] == "stop" && event["stoppedAt"].as_str().is_some_and(|at| {
        (at.starts_with("gateway ") && !at.starts_with("gateway unknown")) || at.starts_with("invalid answer at ")
    })
}

pub fn safety_block(events: &[Value]) -> Option<Value> {
    events.iter().rev().find(|event| event["kind"] == "safety blocked").map(|event| {
        json!({ "step": event["step"], "jobKey": event["key"], "provider": event["provider"] })
    })
}

/// Optional workflow projections applied at the same points as the common status fields.
#[derive(Default)]
pub struct StatusHooks {
    pub check_result: Option<fn(&Value, Value) -> Value>,
    pub details: Option<fn(&Value, &[Value], &mut Value)>,
    pub stop_details: Option<fn(&Value, &Value, &mut Value)>,
}

pub fn status(id: &str, hooks: StatusHooks) -> Result<Exit> {
    let (journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    // The finished event precedes the completion receipt. Sample worker state first
    // so that a completion receipt cannot be paired with a pre-finish snapshot.
    let active = journal.active();
    let receipt = journal.read_value("worker-result.json");
    let events = journal.snapshot()?;
    let final_result = journal.read_value("result.json").filter(|result| finished_event(&events, Some(result)).is_some()).map(|mut result| {
        if let Some(applied) = application_status(&events) {
            result["application"] = applied;
        }
        if let Some(check_result) = hooks.check_result {
            result = check_result(&run, result);
        }
        result
    });
    let last = last_state_event(&events).unwrap_or(&Value::Null);
    let outcome = status_outcome(last, final_result.is_some(), active, receipt.is_some());
    let mut result = json!({
        "runId": id, "workflow": run["workflow"], "version": run["version"], "release": run["release"], "repo": run["repo"],
        "status": outcome, "step": last["step"], "event": last["kind"], "models": run["pair"],
        "journal": journal.dir.display().to_string(),
    });
    if let Some(commit) = run.get("buildCommit") {
        result["buildCommit"] = commit.clone();
    }
    if let Some(details) = hooks.details {
        details(&run, &events, &mut result);
    }
    if let Some(block) = safety_block(&events) {
        result["safetyBlock"] = block;
    }
    if run["workflow"] == WORKFLOW {
        let pending = journal.pending_remarks(&events)?;
        if !pending.is_empty() {
            result["pendingRemarks"] = json!(pending.into_iter().map(|remark| json!({
                "remarkId": remark.id, "text": remark.text, "afterStep": remark.after_step,
            })).collect::<Vec<_>>());
        }
    }
    if outcome == "waiting" {
        result["question"] = last["question"].clone();
        if let Some(reason) = last.get("reason") { result["reason"] = reason.clone(); }
        if last["scope"].is_array() {
            result["outsideClaim"] = last["scope"].clone();
        }
        if last["decisions"].is_array() {
            result["ownerDecisions"] = last["decisions"].clone();
            result["draft"] = last["draft"].clone();
        }
    }
    if let Ok(budget) = Budget::parse(&run["inputs"]["args"]["budget"]) {
        result["budget"] = budget.report(&events);
    }
    if let Some(key) = last["key"].as_str() {
        result["jobKey"] = json!(key);
    }
    if last["kind"] == "stop" && !active {
        result["stoppedAt"] = last["stoppedAt"].clone();
        result["infra"] = last["what"].clone();
        if let Some(stop_details) = hooks.stop_details {
            stop_details(&run, last, &mut result);
        }
    }
    if let Some(final_result) = final_result {
        result["result"] = final_result;
    } else if !active && outcome != "ready" {
        if let Some(receipt) = receipt {
            result["lastResult"] = receipt;
        }
    }
    Ok(Exit { result, code: 0 })
}

pub fn status_outcome(
    last: &Value,
    finished: bool,
    active: bool,
    has_receipt: bool,
) -> &'static str {
    if finished && last["kind"] == "closed" {
        "closed"
    } else if finished {
        "finished"
    } else if active {
        "running"
    } else if last["kind"] == "waiting" {
        "waiting"
    } else if last["kind"] == "youtube processing" {
        "processing"
    } else if last["kind"] == "scope allowed"
        || last["kind"] == "budget extended"
        || (last["kind"] == "rerun" && last.get("ownerAnswer").is_some())
    {
        "ready"
    } else if has_receipt || last["kind"] == "stop" {
        "stopped"
    } else {
        "interrupted"
    }
}

/// An inaccessible process still owns its receipt unless its PID was demonstrably reused.
pub fn live_pid(owner: &Value) -> Option<u32> {
    let pid = owner_pid(owner)?;
    if !alive(pid) {
        return None;
    }
    // A reboot can give the pid to a protected system process (csrss), whose start this user cannot read.
    if owner["start"].as_str().is_some_and(|start| reused_after_reboot(pid, start)) {
        return None;
    }
    // A detached process may have exited without being reaped yet. It can no longer hold the lock.
    #[cfg(target_os = "linux")]
    if fs::read_to_string(format!("/proc/{pid}/stat")).ok()
        .and_then(|stat| stat.rsplit_once(") ")?.1.as_bytes().first().copied()) == Some(b'Z')
    {
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
        if run["workflow"] == WORKFLOW {
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
        self.load_for_shutdown()?;
        // Closure may have started since the caller checked the run, before it took the lock.
        if self.file(SHUTDOWN_REQUEST).try_exists()?
            && finished_event(&self.events, self.read_value("result.json").as_ref()).is_none()
        {
            return fail("This run is being closed. Finish closing it before working on it.");
        }
        Ok(())
    }

    #[doc(hidden)]
    pub fn load_for_shutdown(&mut self) -> Result<()> {
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

    #[doc(hidden)]
    pub fn finished(&self, events: &[Value]) -> bool {
        finished_event(events, self.read_value("result.json").as_ref()).is_some()
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
        Self::active_at(&self.dir)
    }

    #[doc(hidden)]
    pub fn active_at(dir: &Path) -> bool {
        Self::live_owner_at(dir, None).is_some()
    }

    #[doc(hidden)]
    pub fn live_owner(&self, ignore_pid: Option<u32>) -> Option<(u32, Value)> {
        Self::live_owner_at(&self.dir, ignore_pid)
    }

    fn live_owner_at(dir: &Path, ignore_pid: Option<u32>) -> Option<(u32, Value)> {
        ["lock/owner.json", "worker.json"].iter()
            .filter_map(|name| read_stored(&dir.join(name)))
            .find_map(|owner| {
                let pid = live_pid(&owner).filter(|&pid| Some(pid) != ignore_pid)?;
                Some((pid, owner))
            })
    }

    /// Takes the lock of the run: one process at a time. A lock whose process is gone (or is another program now)
    /// is stale and taken over.
    pub fn lock(&self) -> Result<RunLock> {
        Self::lock_directory(self.dir.join("lock"))
    }

    #[doc(hidden)]
    pub fn lock_directory(dir: PathBuf) -> Result<RunLock> {
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

    /// A pinned request is replayed verbatim on resume. Only a `done` or `safety blocked`
    /// event marks the remarks attached to that attempt as delivered.
    #[doc(hidden)]
    pub fn pending_remarks(&self, events: &[Value]) -> Result<Vec<PendingRemark>> {
        let files = match fs::read_dir(self.file(PENDING_REMARKS)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(error) => return Err(error.into()),
        };
        let mut attached = HashMap::new();
        let mut delivered = HashSet::new();
        for event in events {
            let (Some(step), Some(attempt)) = (event["step"].as_str(), event["attempt"].as_u64()) else {
                continue;
            };
            let call = (step, attempt);
            if event["kind"] == "remarks attached" {
                attached.insert(call, &event["remarkIds"]);
            } else if matches!(event["kind"].as_str(), Some("done" | "safety blocked")) {
                if let Some(ids) = attached.remove(&call).and_then(Value::as_array) {
                    delivered.extend(ids.iter().filter_map(Value::as_str));
                }
            }
        }
        let mut pending = Vec::new();
        for entry in files {
            let name = entry?.file_name();
            let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else { continue };
            if delivered.contains(id) {
                continue;
            }
            let Some(value) = self.read_value(&format!("{PENDING_REMARKS}/{id}.json")) else { continue };
            let Some(text) = value["text"].as_str() else { continue };
            pending.push(PendingRemark {
                id: id.to_string(), text: text.to_string(), after_step: value["afterStep"].as_str().map(String::from),
            });
        }
        pending.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(pending)
    }

    #[doc(hidden)]
    pub fn unknown_file_step(&self) -> Option<(&str, Value)> {
        let mut settled = HashSet::new();
        for event in self.events.iter().rev() {
            let (Some(step), Some(attempt)) = (event["step"].as_str(), event["attempt"].as_u64()) else {
                continue;
            };
            let call = (step, attempt);
            if matches!(event["kind"].as_str(), Some("done" | "index restored")) {
                settled.insert(call);
            } else if !settled.contains(&call) {
                let apply = event["kind"] == "intent" && event["effect"] == "apply patch";
                if apply || event["kind"] == "index planned" {
                    let paths = event.get("paths").cloned().or_else(|| {
                        let plan = self.read_value(event["plan"].as_str()?)?;
                        let plan = crate::patch::Plan::from_json(&plan)?;
                        (event["digest"] == sha256_hex(plan.to_json().to_string()))
                            .then(|| json!(plan.after.keys().collect::<Vec<_>>()))
                    });
                    return Some((step, paths.unwrap_or_else(|| json!([]))));
                }
            }
        }
        None
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

    #[doc(hidden)]
    pub fn write_bytes(&self, name: &str, bytes: &[u8]) -> Result<PathBuf> {
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
    #[doc(hidden)]
    pub fn verify_legacy_workflow(&self, run: &Value, expected_digest: &str) -> Result<()> {
        let digest = &run["inputs"]["definitionSha256"];
        if digest != expected_digest {
            return fail("The journal identifies an unrecognized version-one workflow.");
        }
        self.read_verified("workflow.js", digest)?;
        Ok(())
    }

    #[doc(hidden)]
    pub fn completed_steps(&self) -> Map<String, Value> {
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
#[cfg(all(test, windows))]
mod owner_tests {
    use super::*;

    /// The System process: this user is denied even a limited query unless the test runs elevated.
    const SYSTEM: u32 = 4;

    #[test]
    fn a_system_pid_with_a_start_before_boot_is_no_worker() {
        let own = std::process::id();
        let start = process_start(own).unwrap();
        assert_eq!(live_pid(&json!({"pid": own, "start": start})), Some(own));
        if process_start(SYSTEM).is_some() {
            eprintln!("skipping: the System process is readable (elevated test run)");
            return;
        }
        assert!(alive(SYSTEM));
        // 2020-01-01 as FILETIME: before any boot of a machine running these tests.
        let before_boot = 132_223_104_000_000_000u64.to_string();
        let legacy = (before_boot.parse::<u64>().unwrap() + 504_911_232_000_000_000).to_string();
        assert_eq!(live_pid(&json!({"pid": SYSTEM, "start": before_boot})), None);
        assert_eq!(live_pid(&json!({"pid": SYSTEM, "start": legacy})), None);
        // A start in this boot, or none, keeps the conservative answer for an unreadable process.
        assert_eq!(live_pid(&json!({"pid": SYSTEM, "start": start})), Some(SYSTEM));
        assert_eq!(live_pid(&json!({"pid": SYSTEM})), Some(SYSTEM));
    }
}
