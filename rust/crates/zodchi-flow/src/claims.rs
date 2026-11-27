//! Package claims, shared with the JavaScript workflows: one JSON file per package in
//! `~/.zodchi/packages/<repository>/<label>.json` with `label`, `status` ("open", "done", "stopped", "closed"), `files` (paths
//! relative to the repository, lower case) and `base`. Every change of the folder happens under the lock folder
//! `.lock` (mkdir is atomic); a lock older than ten minutes is stale.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use zodchi_core::config::user_home;
use zodchi_core::util::{fail, iso, pause, read_stored, write_json_atomic, Result};

/// A path the way the workflows write it: forward slashes, no dot segments. Windows paths (a drive letter) compare
/// without case, as Windows does.
pub fn norm(path: &str) -> Result<String> {
    let s = path.replace('\\', "/");
    let lead = if s.len() >= 3 && s.as_bytes()[1] == b':' && s.as_bytes()[2] == b'/' && s.as_bytes()[0].is_ascii_alphabetic() {
        s[..3].to_string()
    } else if s.starts_with('/') {
        "/".to_string()
    } else {
        String::new()
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in s[lead.len()..].split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return fail(format!("path {path} leaves the file system root"));
                }
            }
            _ => parts.push(seg),
        }
    }
    Ok(lead + &parts.join("/"))
}

pub fn caseless(repo_norm: &str) -> bool {
    let b = repo_norm.as_bytes();
    b.len() >= 3 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

pub fn fold(repo_norm: &str, text: &str) -> String {
    if caseless(repo_norm) { text.to_lowercase() } else { text.to_string() }
}

/// The claims folder of a repository: its path with every character outside [A-Za-z0-9] replaced by "-".
pub fn claims_dir(repo_norm: &str) -> PathBuf {
    let name: String = fold(repo_norm, repo_norm).chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    user_home().join(".zodchi").join("packages").join(name)
}

fn with_lock<T>(dir: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
    fs::create_dir_all(dir)?;
    let lock = dir.join(".lock");
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match fs::create_dir(&lock) {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&lock).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a > Duration::from_secs(600));
                if stale {
                    let _ = fs::remove_dir(&lock);
                    continue;
                }
                if Instant::now() > deadline {
                    return fail(format!("The claims lock {} stayed busy for two minutes.", lock.display()));
                }
                pause(250);
            }
            Err(e) => return Err(e.into()),
        }
    }
    let result = f();
    let _ = fs::remove_dir(&lock);
    result
}

fn others(dir: &Path, label: &str) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    let mut out = Vec::new();
    for e in entries.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        if let Some(v) = read_stored(&p) {
            if v["status"] == json!("open") && v["label"] != json!(label) {
                out.push(v);
            }
        }
    }
    out
}

fn conflicts(dir: &Path, label: &str, keys: &[String]) -> Vec<String> {
    let mut found = Vec::new();
    for claim in others(dir, label) {
        let theirs: Vec<String> = claim["files"].as_array().cloned().unwrap_or_default().iter().filter_map(|f| f.as_str().map(String::from)).collect();
        for k in keys {
            if theirs.contains(k) {
                let label = claim["label"].as_str().unwrap_or("?");
                let run = claim["run"].as_str().map(|id| format!(" (run {id})")).unwrap_or_default();
                found.push(format!("{label}{run}: {k}"));
            }
        }
    }
    found.sort();
    found
}

pub fn file(dir: &Path, label: &str) -> PathBuf {
    dir.join(format!("{label}.json"))
}

enum Opening {
    Existing,
    Available,
    Conflicts(Vec<String>),
}

fn opening(dir: &Path, label: &str, run: &str, keys: &[String]) -> Opening {
    if let Some(existing) = read_stored(&file(dir, label)).filter(|claim| claim["status"] == "open") {
        if existing["run"] == run {
            return Opening::Existing;
        }
        let run = existing["run"].as_str().map(|id| format!(" (run {id})")).unwrap_or_default();
        return Opening::Conflicts(vec![format!("{label}{run}: an open package of this label (close it, or pick another label)")]);
    }
    let found = conflicts(dir, label, keys);
    if found.is_empty() { Opening::Available } else { Opening::Conflicts(found) }
}

/// The same conflict probe as open, without creating the claims directory or taking its lock.
pub(crate) fn preview_conflicts(dir: &Path, label: &str, run: &str, keys: &[String]) -> Vec<String> {
    match opening(dir, label, run, keys) {
        Opening::Conflicts(found) => found,
        Opening::Existing | Opening::Available => vec![],
    }
}

/// Opens the claim of a run. Returns the conflicts; none means the claim is written. A claim of this label that is
/// open for another run is a conflict too; one already open for this run is kept as it is.
pub fn open(dir: &Path, label: &str, run: &str, keys: &[String], brief: &str, base: &str) -> Result<Vec<String>> {
    with_lock(dir, || {
        match opening(dir, label, run, keys) {
            Opening::Existing => return Ok(vec![]),
            Opening::Conflicts(found) => return Ok(found),
            Opening::Available => {}
        }
        write_json_atomic(&file(dir, label), &json!({ "label": label, "status": "open", "files": keys, "brief": brief, "base": base, "run": run, "openedAt": iso() }))?;
        Ok(vec![])
    })
}

/// Adds files to the open claim of this run, or returns the conflicts and adds nothing.
pub fn extend(dir: &Path, label: &str, run: &str, keys: &[String]) -> Result<Vec<String>> {
    with_lock(dir, || {
        let own = file(dir, label);
        let Some(mut claim) = read_stored(&own) else { return fail(format!("The claim {} is gone.", own.display())) };
        if claim["status"] != json!("open") || claim["run"] != json!(run) {
            return fail(format!("The claim {} is no longer the open claim of this run.", own.display()));
        }
        let found = conflicts(dir, label, keys);
        if !found.is_empty() {
            return Ok(found);
        }
        let mut files: Vec<Value> = claim["files"].as_array().cloned().unwrap_or_default();
        for k in keys {
            if !files.contains(&json!(k)) {
                files.push(json!(k));
            }
        }
        claim["files"] = Value::Array(files);
        write_json_atomic(&own, &claim)?;
        Ok(vec![])
    })
}

/// The claim is still the open claim of this run and lists every key.
pub fn holds(dir: &Path, label: &str, run: &str, keys: &[String]) -> bool {
    let Some(claim) = read_stored(&file(dir, label)) else { return false };
    let files = claim["files"].as_array().cloned().unwrap_or_default();
    claim["status"] == json!("open") && claim["run"] == json!(run) && keys.iter().all(|k| files.contains(&json!(k)))
}

/// Closes the claim of this run with a status; a claim that is gone or belongs to another run is left alone.
pub fn close(dir: &Path, label: &str, run: &str, status: &str) -> Result<bool> {
    with_lock(dir, || {
        let own = file(dir, label);
        let bytes = match std::fs::read(&own) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(e) => return fail(format!("cannot read claim {}: {e}", own.display())),
        };
        let mut claim: Value = match serde_json::from_slice(&bytes) {
            Ok(claim) => claim,
            Err(e) => return fail(format!("cannot parse claim {}: {e}", own.display())),
        };
        if claim["run"] != json!(run) {
            return Ok(false);
        }
        if claim["status"] == "open" || (status == "closed" && claim["status"] != "closed") {
            claim["status"] = json!(status);
            claim["closedAt"] = json!(iso());
            write_json_atomic(&own, &claim)?;
        }
        Ok(true)
    })
}
