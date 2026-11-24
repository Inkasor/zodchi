//! Inventory a workspace, pin the owner's decisions, and create verified archive copies.

use crate::{control, git::Git, input, journal::Journal, patch, Exit};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use zodchi_core::{
    config::Config,
    util::{fail, iso, sha256_hex, GatewayError, Result},
};

pub const NAME: &str = "workspace-audit";
const VERSION: &str = "1";
const OWNER_STEP: &str = "owner decisions";

pub fn start(raw: &Value, detach: bool) -> Result<Exit> {
    match prepare(raw) {
        Ok((id, journal)) if detach => control::launch(&journal, &id, None),
        Ok((id, _)) => resume(&id, None, None),
        Err(error) => Ok(Exit {
            code: 2,
            result: json!({ "workflow": NAME, "approved": false, "refused": error.0 }),
        }),
    }
}

fn absolute(value: &Value, field: &str) -> Result<PathBuf> {
    value
        .as_str()
        .map(PathBuf::from)
        .filter(|path| {
            path.is_absolute()
                && path
                    .components()
                    .all(|component| component != Component::ParentDir)
        })
        .ok_or_else(|| {
            GatewayError(format!(
                "{field} needs an absolute path without parent components."
            ))
        })
}

fn linked(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return meta.file_attributes() & 0x400 != 0; // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    false
}

fn repo_marker(folder: &Path) -> bool {
    fs::symlink_metadata(folder.join(".git")).is_ok()
}

fn inspect_path(path: &Path) -> Result<()> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(meta) if linked(&meta) => {
                return fail("An audit path crosses a link or reparse point.")
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn prepare(raw: &Value) -> Result<(String, Journal)> {
    if raw.as_object().is_none_or(|row| {
        row.keys()
            .any(|key| !["root", "archive"].contains(&key.as_str()))
    }) {
        return fail("workspace-audit accepts root and an optional archive directory.");
    }
    let root = absolute(&raw["root"], "args.root")?;
    inspect_path(&root)?;
    let root = fs::canonicalize(&root)?;
    if !root.is_dir() {
        return fail("args.root must name a directory.");
    }
    let archive = if let Some(value) = raw.get("archive") {
        let location = absolute(value, "args.archive")?;
        inspect_path(&location)?;
        // Require the archive's parent to exist so its identity is known before the owner sees the plan.
        let parent = location.parent().ok_or_else(|| {
            GatewayError("The archive needs an existing parent directory.".into())
        })?;
        let name = location
            .file_name()
            .ok_or_else(|| GatewayError("The archive needs a new directory name.".into()))?;
        let parent = fs::canonicalize(parent)?;
        let location = parent.join(name);
        if location.starts_with(&root)
            || parent.ancestors().any(repo_marker)
            || fs::symlink_metadata(&location).is_ok()
        {
            return fail("The archive must be a new directory outside the audited workspace and any Git repository.");
        }
        Some(location)
    } else {
        None
    };
    let cfg = Config::new(None)?;
    if fs::canonicalize(&cfg.home).is_ok_and(|home| home.starts_with(&root)) {
        return fail("The audit root contains the active Zodchi journal.");
    }
    let id = crate::journal::new_run_id();
    let run = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"),
        "createdAt": iso(), "repo": root, "archive": archive,
        "inputs": { "argsSha256": input::args_digest(raw) },
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    Ok((id, journal))
}

fn file_digest(file: &Path) -> Result<String> {
    let mut file = fs::File::open(file)?;
    let mut digest = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        digest.update(&buf[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn entries(folder: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = fs::read_dir(folder)?
        .map(|row| row.map(|entry| entry.path()))
        .collect::<io::Result<Vec<_>>>()?;
    paths.sort();
    Ok(paths)
}

fn snapshot(path: &Path) -> Result<(Value, bool)> {
    let meta = fs::symlink_metadata(path)?;
    let changed = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64);
    if linked(&meta) {
        return Ok((
            json!({"kind": "link", "verdict": "ASK", "changedAtMs": changed}),
            false,
        ));
    }
    if meta.is_file() {
        return Ok((
            json!({
                "kind": "file", "bytes": meta.len(), "changedAtMs": changed, "sha256": file_digest(path)?,
                "verdict": "ASK",
            }),
            true,
        ));
    }
    if !meta.is_dir() {
        return Ok((
            json!({"kind": "special", "verdict": "KEEP", "changedAtMs": changed}),
            false,
        ));
    }
    if repo_marker(path) {
        let git = Git::new(path);
        let state = git
            .run(&[
                "-c",
                "core.fsmonitor=false",
                "--no-optional-locks",
                "status",
                "--porcelain=v1",
                "--branch",
            ])
            .ok();
        let status = state
            .as_ref()
            .map(|text| text.lines().next().unwrap_or("").to_string());
        let dirty = state.as_ref().map(|text| text.lines().skip(1).count());
        return Ok((
            json!({
                "kind": "git", "verdict": "KEEP", "status": status, "dirtyPaths": dirty, "changedAtMs": changed,
            }),
            false,
        ));
    }
    let mut row = Vec::new();
    let mut bytes = 0u64;
    let mut complete = true;
    for child in entries(path)? {
        let name = child.file_name().and_then(|name| name.to_str());
        let Some(name) = name else {
            complete = false;
            continue;
        };
        let (seen, safe) = snapshot(&child)?;
        complete &= safe;
        bytes = bytes.saturating_add(seen["bytes"].as_u64().unwrap_or(0));
        row.push(json!({ "name": name, "state": seen }));
    }
    Ok((
        json!({
            "kind": "directory", "bytes": bytes, "changedAtMs": changed, "children": row.len(),
            "sha256": sha256_hex(Value::Array(row).to_string()), "verdict": "ASK",
        }),
        complete,
    ))
}

fn survey(root: &Path) -> Result<Value> {
    let mut inventory = Vec::new();
    let mut uninspected = 0;
    let outside_repo = !root.ancestors().any(repo_marker);
    for path in entries(root)? {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            uninspected += 1;
            continue;
        };
        let (state, open) = snapshot(&path)
            .unwrap_or_else(|_| (json!({"kind": "unreadable", "verdict": "ASK"}), false));
        let archivable = outside_repo
            && open
            && state["kind"] == "file"
            && patch::plain(name)
            && !name.contains('/')
            && !name.eq_ignore_ascii_case(".zodchi-audit.json");
        inventory.push(json!({"path": name, "state": state, "archivable": archivable}));
    }
    Ok(json!({"root": root, "items": inventory, "uninspected": uninspected}))
}

pub fn resume(id: &str, given: Option<&Value>, retry: Option<&str>) -> Result<Exit> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if run["workflow"] != NAME
        || run["version"] != VERSION
        || retry.is_some()
        || given.is_some_and(|value| !input::args_match(&run["inputs"], value))
    {
        return fail("Resume the workspace audit with its original run ID.");
    }
    let _lock = journal.lock()?;
    journal.load()?;
    if let Some(result) = journal.read_value("result.json") {
        finish_event(&mut journal)?;
        return Ok(Exit {
            code: if result["approved"] == true { 0 } else { 2 },
            result,
        });
    }
    let root = run["repo"]
        .as_str()
        .map(Path::new)
        .ok_or_else(|| GatewayError("The journal has no audit root.".into()))?;
    inspect_path(root)?;
    let inventory = if let Some(value) = journal.read_value("inventory.json") {
        value
    } else {
        let rows = survey(root)?;
        journal.write_value("inventory.json", &rows)?;
        rows
    };
    let inventory_digest = sha256_hex(inventory.to_string());
    let mut result = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "journal": journal.dir,
        "inventory": journal.file("inventory.json"), "inventorySha256": inventory_digest,
        "items": inventory["items"].as_array().map(Vec::len).unwrap_or(0),
    });
    let Some(archive) = run["archive"].as_str().map(Path::new) else {
        result["approved"] = json!(true);
        result["outcome"] = json!("inventoried");
        journal.write_value("result.json", &result)?;
        finish_event(&mut journal)?;
        return Ok(Exit { code: 0, result });
    };
    let answer = journal
        .events()
        .iter()
        .rev()
        .find(|event| event["step"] == OWNER_STEP && event["ownerAnswer"].is_string())
        .and_then(|event| event["ownerAnswer"].as_str())
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let list = answer.as_ref().and_then(|answer| {
        (answer["inventorySha256"] == inventory_digest
            && answer.as_object().is_some_and(|fields| fields.len() == 2))
        .then(|| answer["copy"].as_array())
        .flatten()
    });
    let rows = inventory["items"]
        .as_array()
        .ok_or_else(|| GatewayError("The inventory has no item list.".into()))?;
    let mut unique = HashSet::new();
    let selected = list.and_then(|list| {
        list.iter()
            .map(|value| {
                let name = value.as_str()?;
                if !unique.insert(name) {
                    return None;
                }
                rows.iter()
                    .find(|row| row["path"] == name && row["archivable"] == true)
            })
            .collect::<Option<Vec<&Value>>>()
    });
    let Some(selected) = selected else {
        let question = format!(
            "Approve copies by precise inventory item name. Reply with a JSON object containing inventorySha256 {:?} and copy, an array of names marked archivable. An empty array keeps everything.",
            inventory_digest
        );
        if journal
            .last_event()
            .is_none_or(|event| event["kind"] != "waiting")
        {
            journal
                .append(json!({ "kind": "waiting", "step": OWNER_STEP, "question": question }))?;
        }
        result["status"] = json!("waiting");
        result["question"] = json!(question);
        result["approved"] = json!(false);
        return Ok(Exit { code: 2, result });
    };
    if root.ancestors().any(repo_marker) {
        return fail(
            "The workspace is now inside a Git repository. The inventory is available for review.",
        );
    }
    let mut receipts = Vec::new();
    if !selected.is_empty() {
        inspect_path(archive)?;
        if archive.ancestors().skip(1).any(repo_marker) {
            return fail("The archive now crosses a Git checkout.");
        }
        if journal.last("intent", "archive", 1).is_none() {
            if fs::symlink_metadata(archive).is_ok() {
                return fail("The approved archive directory already exists.");
            }
            journal.append(json!({ "kind": "intent", "step": "archive", "attempt": 1, "inventorySha256": inventory_digest }))?;
        }
        let marker = archive.join(".zodchi-audit.json");
        let expected = json!({ "runId": id, "inventorySha256": inventory_digest }).to_string();
        match fs::create_dir(archive) {
            Ok(()) => {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&marker)?;
                file.write_all(expected.as_bytes())?;
                file.sync_all()?;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let meta = fs::symlink_metadata(archive)?;
                let owned = fs::symlink_metadata(&marker)
                    .is_ok_and(|meta| !linked(&meta) && meta.is_file())
                    && fs::read_to_string(&marker).is_ok_and(|value| value == expected);
                if linked(&meta) || !meta.is_dir() || !owned {
                    return fail(
                        "The archive directory lacks this run's verified ownership record.",
                    );
                }
            }
            Err(error) => return Err(error.into()),
        }
        for row in selected {
            let name = row["path"].as_str().expect("inventory name");
            let sha = row["state"]["sha256"]
                .as_str()
                .expect("inventory fingerprint");
            let source = root.join(name);
            let target = archive.join(name);
            let status = match copy_verified(&source, &target, sha) {
                Ok(()) => {
                    json!({"path": name, "copy": target, "sha256": sha, "status": "verified"})
                }
                Err(error) => json!({"path": name, "status": "skipped", "reason": error.0}),
            };
            receipts.push(status);
        }
    }
    let verified = receipts
        .iter()
        .filter(|row| row["status"] == "verified")
        .count();
    let all = verified == receipts.len();
    result["outcome"] = json!(if receipts.is_empty() {
        "kept"
    } else if all {
        "copied"
    } else {
        "partial"
    });
    result["approved"] = json!(all);
    result["copies"] = json!(receipts);
    journal.write_value("result.json", &result)?;
    finish_event(&mut journal)?;
    Ok(Exit {
        code: if all { 0 } else { 2 },
        result,
    })
}

fn copy_verified(source: &Path, target: &Path, expect: &str) -> Result<()> {
    let meta = fs::symlink_metadata(source)
        .map_err(|_| GatewayError("The source is unavailable.".into()))?;
    if linked(&meta) || !meta.is_file() || file_digest(source)? != expect {
        return fail("The source changed since inventory.");
    }
    if let Ok(meta) = fs::symlink_metadata(target) {
        return if !linked(&meta) && meta.is_file() && file_digest(target)? == expect {
            Ok(())
        } else {
            fail("The archive item already exists and its contents differ.")
        };
    }
    let temp = target
        .parent()
        .expect("archive parent")
        .join(format!(".copy-{:016x}.tmp", rand::random::<u64>()));
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let copy_path = &temp;
    let checked = (move || -> Result<()> {
        let mut input = fs::File::open(source)?;
        io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        drop(output);
        if file_digest(copy_path)? != expect || file_digest(source)? != expect {
            return fail("The source changed while it was being copied.");
        }
        fs::hard_link(copy_path, target)?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    checked
}

fn finish_event(journal: &mut Journal) -> Result<()> {
    if !journal
        .events()
        .iter()
        .any(|event| event["kind"] == "finished")
    {
        journal.append(json!({ "kind": "finished", "step": "result" }))?;
    }
    Ok(())
}
