//! Read-only discovery and waiting for Flow journals.

use crate::{
    acceptance,
    journal::{self, finished_event, last_state_event, status_outcome, Journal},
    ops_script, voiceover, workspace_audit, youtube_publish, Exit, USAGE,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zodchi_core::{
    config::user_home,
    util::{fail, GatewayError, Result},
};

const STALE_SECONDS: u64 = 3600;
const POLL_INTERVAL: Duration = Duration::from_secs(2);

fn journal_home() -> PathBuf {
    // Follow Config's home resolution without loading accounts or repository configuration.
    std::env::var_os("ZODCHI_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".zodchi"))
}

fn run_ids(flows: &Path) -> Result<Vec<String>> {
    let entries = match fs::read_dir(flows) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Ok(id) = entry.file_name().into_string() else {
            continue;
        };
        if journal::is_run_id(&id) && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            ids.push(id);
        }
    }
    ids.sort();
    Ok(ids)
}

// The result is optional and published by rename. A present, unreadable result is journal damage.
fn read_result(journal: &Journal) -> Result<Option<Value>> {
    let path = journal.file("result.json");
    match fs::metadata(&path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return fail(format!(
                "Cannot read the journal {}: {error}",
                path.display()
            ))
        }
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return fail(format!("The journal {} is not a file.", path.display())),
    }
    journal
        .read_value("result.json")
        .filter(Value::is_object)
        .map(Some)
        .ok_or_else(|| {
            GatewayError(format!(
                "The journal {} is not a readable JSON object.",
                path.display()
            ))
        })
}

fn finished_approved(workflow: &str, result: &Value) -> bool {
    // Several workflows record their successful outcome under a workflow-specific field.
    match workflow {
        acceptance::CANDIDATE | acceptance::PLAYER | acceptance::RELEASE => {
            result["verdict"] == "pass"
        }
        ops_script::NAME => result["ready"] == true,
        voiceover::NAME => result["status"] == "rendered",
        youtube_publish::NAME => result["verdict"] == "private_verified",
        _ => result["approved"]
            .as_bool()
            .unwrap_or(result["verdict"] == "approved"),
    }
}

fn read_state(home: &Path, id: &str, live: bool, details: bool, row: &mut Value) -> Result<bool> {
    let (journal, run) = Journal::open(home, id)?;
    let Some(workflow) = run["workflow"].as_str().filter(|name| !name.is_empty()) else {
        return fail(format!("The journal for {id} has no workflow in run.json."));
    };
    row["workflow"] = json!(workflow);
    // Code-package journals store the label inside the pinned arguments.
    let label = run["label"]
        .as_str()
        .or_else(|| run["inputs"]["args"]["label"].as_str());
    row["label"] = json!(label);

    // As in status, sample liveness before the worker receipt and events, and the final result after the events.
    let worker = journal.read_value("worker-result.json");
    let events = journal.snapshot()?;
    if events.iter().any(|event| !event["kind"].is_string()) {
        return fail(format!("The journal for {id} has an event without a kind."));
    }
    let last = last_state_event(&events).unwrap_or(&Value::Null);
    let stored = read_result(&journal)?;
    let result = stored
        .as_ref()
        .filter(|result| finished_event(&events, Some(result)).is_some());
    let status = status_outcome(last, result.is_some(), live, worker.is_some());
    row["status"] = json!(status);
    row["step"] = last["step"].clone();
    if status == "waiting" {
        let decision = ["decisions", "scope", "video", "planSha256", "frames"]
            .iter()
            .any(|field| !last[*field].is_null())
            || last["reason"] == "budget"
            || (workflow == workspace_audit::NAME && last["step"] == "owner decisions");
        row["waiting"] = json!(if decision { "decision" } else { "question" });
    }
    if details {
        let receipt = result.or(worker
            .as_ref()
            .filter(|_| !matches!(status, "running" | "ready")));
        for field in ["question", "next"] {
            let from_event = last.get(field).filter(|value| !value.is_null());
            let from_receipt = receipt
                .and_then(|value| value.get(field))
                .filter(|value| !value.is_null());
            if let Some(value) = from_event.or(from_receipt) {
                row[field] = value.clone();
            }
        }
    }
    Ok(result.is_some_and(|result| finished_approved(workflow, result)))
}

struct Observation {
    row: Value,
    approved: bool,
}

fn observe(home: &Path, id: &str, live: bool, details: bool) -> Observation {
    let mut row = json!({
        "runId": id, "workflow": null, "label": null, "status": null, "step": null, "waiting": null,
    });
    let approved = match read_state(home, id, live, details, &mut row) {
        Ok(approved) => approved,
        Err(error) => {
            row["error"] = json!(error.0);
            false
        }
    };
    Observation { row, approved }
}

pub(crate) fn list(args: &[String]) -> Result<Exit> {
    let active_only = match args {
        [] => false,
        [flag] if flag == "--active" => true,
        _ => return fail(USAGE),
    };
    let home = journal_home();
    let flows = journal::flows_dir(&home);
    let now = SystemTime::now();
    let mut rows = Vec::new();
    for id in run_ids(&flows)? {
        let dir = flows.join(&id);
        let live = Journal::active_at(&dir);
        let Observation { mut row, .. } = observe(&home, &id, live, false);
        if active_only && !live && row["waiting"].is_null() {
            continue;
        }
        let modified = journal::last_write(&dir);
        let timestamp = modified.and_then(utc_timestamp);
        let age = modified.map(|time| now.duration_since(time).unwrap_or_default().as_secs());
        if row["error"].is_null() {
            row["error"] = if timestamp.is_some() {
                Value::Null
            } else {
                json!("No readable journal file modification time.")
            };
        }
        row["lastWriteAt"] = json!(timestamp);
        row["secondsSinceLastWrite"] = json!(age);
        row["live"] = json!(live);
        row["stale"] = json!(live && age.is_some_and(|seconds| seconds > STALE_SECONDS));
        rows.push((modified, id, row));
    }
    rows.sort_by(|(a_time, a_id, _), (b_time, b_id, _)| {
        b_time.cmp(a_time).then_with(|| a_id.cmp(b_id))
    });
    Ok(Exit {
        code: 0,
        result: Value::Array(rows.into_iter().map(|(_, _, row)| row).collect()),
    })
}

fn utc_timestamp(time: SystemTime) -> Option<String> {
    const NANOS_PER_SECOND: i128 = 1_000_000_000;
    const SECONDS_PER_DAY: i128 = 86_400;
    const DAYS_PER_CYCLE: i128 = 146_097;
    let nanos = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    };
    let seconds = nanos.div_euclid(NANOS_PER_SECOND);
    let days = seconds.div_euclid(SECONDS_PER_DAY);
    // Every 400 Gregorian years contain 97 leap days. Start at the cycle containing the file time.
    let mut year = 1970 + 400 * days.div_euclid(DAYS_PER_CYCLE);
    let mut day = days.rem_euclid(DAYS_PER_CYCLE);
    let leap = loop {
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let year_days = 365 + leap as i128;
        if day < year_days {
            break leap;
        }
        day -= year_days;
        year += 1;
    };
    if !(0..=9999).contains(&year) {
        return None;
    }
    let mut month = 1;
    for length in [
        31,
        28 + leap as i128,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ] {
        if day < length {
            break;
        }
        day -= length;
        month += 1;
    }
    let day = day + 1;
    let clock = seconds.rem_euclid(SECONDS_PER_DAY);
    let (hour, minute, second) = (clock / 3600, clock / 60 % 60, clock % 60);
    let fraction = nanos.rem_euclid(NANOS_PER_SECOND);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{fraction:09}Z"
    ))
}

struct WaitOptions<'a> {
    ids: Vec<&'a str>,
    all: bool,
    timeout: Option<Duration>,
}

impl<'a> WaitOptions<'a> {
    fn parse(args: &'a [String]) -> Result<Self> {
        let mut options = Self {
            ids: Vec::new(),
            all: false,
            timeout: None,
        };
        let mut args = args.iter().map(String::as_str);
        while let Some(arg) = args.next() {
            match arg {
                "--all" if !options.all => options.all = true,
                "--timeout-min" if options.timeout.is_none() => {
                    let Some(timeout) = args
                        .next()
                        .and_then(|value| value.parse::<f64>().ok())
                        .and_then(|minutes| Duration::try_from_secs_f64(minutes * 60.0).ok())
                    else {
                        return fail(format!(
                            "--timeout-min needs a finite, nonnegative duration in minutes.\n{USAGE}"
                        ));
                    };
                    options.timeout = Some(timeout);
                }
                id if journal::is_run_id(id) => options.ids.push(id),
                _ => return fail(USAGE),
            }
        }
        // --all takes no IDs. A named wait takes at least one ID.
        if options.all != options.ids.is_empty() {
            return fail(USAGE);
        }
        Ok(options)
    }
}

pub(crate) fn wait(args: &[String]) -> Result<Exit> {
    let options = WaitOptions::parse(args)?;
    let started = Instant::now();
    let home = journal_home();
    let flows = journal::flows_dir(&home);
    let ids = if options.all {
        let ids: Vec<_> = run_ids(&flows)?
            .into_iter()
            .filter(|id| Journal::active_at(&flows.join(id)))
            .collect();
        if ids.is_empty() {
            return fail("No live runs to wait for.");
        }
        ids
    } else {
        for id in &options.ids {
            if !flows.join(id).is_dir() {
                return fail(format!("No run {id} in {}.", flows.display()));
            }
        }
        options.ids.into_iter().map(str::to_owned).collect()
    };

    loop {
        let mut rows = Vec::with_capacity(ids.len());
        for id in &ids {
            let live = Journal::active_at(&flows.join(id));
            let Observation { row, approved } = observe(&home, id, live, true);
            if row["status"] != "running" {
                return Ok(Exit {
                    code: if approved { 0 } else { 2 },
                    result: row,
                });
            }
            rows.push(row);
        }
        let sleep = if let Some(timeout) = options.timeout {
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Ok(Exit {
                    code: 3,
                    result: json!({ "status": "timeout", "runs": rows }),
                });
            }
            remaining.min(POLL_INTERVAL)
        } else {
            POLL_INTERVAL
        };
        thread::sleep(sleep);
    }
}
