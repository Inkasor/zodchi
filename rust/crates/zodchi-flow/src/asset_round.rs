//! Advance one asset round using the ledger, scoped tools and the native child workflows.

use crate::{
    checks, code_package, control, git::Git, input, journal::Journal, patch, rubric_probe,
    unity_check, Exit,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};
use zodchi_core::{
    config::Config,
    util::{fail, is_key, iso, sha256_hex, write_json_atomic, GatewayError, Result},
};

pub const NAME: &str = "asset-round";
const VERSION: &str = "1";
const OWNER: &str = "owner verdict";

pub fn start(raw: &Value, detach: bool) -> Result<Exit> {
    match prepare(raw) {
        Ok((id, journal)) if detach => control::launch(&journal, &id, None),
        Ok((id, _)) => resume(&id, None, None),
        Err(error) => Ok(Exit {
            code: 2,
            result: json!({"workflow": NAME, "approved": false, "refused": error.0}),
        }),
    }
}

fn absolute(value: &Value, field: &str) -> Result<PathBuf> {
    value
        .as_str()
        .map(PathBuf::from)
        .filter(|path| {
            path.is_absolute() && path.components().all(|part| part != Component::ParentDir)
        })
        .ok_or_else(|| {
            GatewayError(format!(
                "{field} needs an absolute path without parent components."
            ))
        })
}

fn object_file(path: &Path) -> Result<(String, Value)> {
    let text = fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| GatewayError(format!("Invalid asset input JSON: {error}")))?;
    if !value.is_object() {
        return fail("The asset input must be a JSON object.");
    }
    Ok((text, value))
}

fn ledger_round(ledger: &Value, stage: u64, accepted: &str) -> Result<u64> {
    let method = &ledger[if stage == 2 { "lookMethod" } else { "method" }];
    if !method.as_str().is_some_and(|name| !name.trim().is_empty())
        && !method.as_object().is_some_and(|row| !row.is_empty())
    {
        return fail("The owner must choose a method for this stage first.");
    }
    let rounds = ledger["rounds"]
        .as_array()
        .ok_or_else(|| GatewayError("The asset ledger needs a rounds array.".into()))?;
    if rounds
        .iter()
        .enumerate()
        .any(|(i, row)| row["n"].as_u64() != Some(i as u64 + 1))
    {
        return fail("The ledger rounds must be consecutive.");
    }
    if rounds.last().is_some_and(|row| {
        row["owner"]
            .as_str()
            .is_none_or(|verdict| verdict.trim().is_empty())
    }) {
        return fail("The owner still needs to judge the previous asset round.");
    }
    let after = method["afterRound"].as_u64().unwrap_or(0);
    if after > rounds.len() as u64 {
        return fail("The method refers to an unavailable earlier round.");
    }
    let since = &rounds[after as usize..];
    if since.len() >= 3
        && !since.iter().any(|row| {
            row["owner"]
                .as_str()
                .is_some_and(|verdict| verdict.trim().starts_with(accepted))
        })
    {
        return fail("Three rounds since this method were tried without acceptance. Record a new method before continuing.");
    }
    Ok(rounds.len() as u64 + 1)
}

fn prepare(raw: &Value) -> Result<(String, Journal)> {
    if raw.as_object().is_none_or(|args| {
        args.keys().any(|key| {
            ![
                "repo", "ledger", "tmp", "label", "stage", "summary", "accepted", "package",
                "check", "export", "unity", "rubric",
            ]
            .contains(&key.as_str())
        })
    }) {
        return fail("An unsupported asset-round argument was supplied.");
    }
    let stage = raw["stage"]
        .as_u64()
        .filter(|stage| [1, 2].contains(stage))
        .ok_or_else(|| GatewayError("args.stage is 1 (blockout) or 2 (look).".into()))?;
    let label = raw["label"]
        .as_str()
        .filter(|text| is_key(text) && text.len() <= 40)
        .ok_or_else(|| GatewayError("args.label must be a short gateway key.".into()))?;
    let accepted = raw["accepted"].as_str().unwrap_or("accepted");
    if accepted.trim().is_empty() {
        return fail("args.accepted must name the accepted verdict.");
    }
    let repo = fs::canonicalize(absolute(&raw["repo"], "args.repo")?)?;
    let git = Git::new(&repo);
    if fs::canonicalize(git.run(&["rev-parse", "--show-toplevel"])?.trim())? != repo {
        return fail("args.repo must be the top of its Git checkout.");
    }
    crate::catalog::require(&git, &git.rev("HEAD^{commit}")?, NAME)?;
    let cfg = Config::new(Some(&repo))?;
    let ledger = absolute(&raw["ledger"], "args.ledger")?;
    if ledger
        .ancestors()
        .any(|path| fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()))
    {
        return fail("args.ledger crosses a link.");
    }
    let ledger = fs::canonicalize(ledger)?;
    if !ledger.starts_with(&repo) || !ledger.is_file() {
        return fail("The ledger must be a regular file within args.repo.");
    }
    let (text, data) = object_file(&ledger)?;
    let round = ledger_round(&data, stage, accepted)?;
    let scrubber = input::Scrubber::new(&cfg)?;
    let summary = raw["summary"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(|text| scrubber.text(text, &[]))
        .ok_or_else(|| GatewayError("args.summary must describe the round.".into()))?;
    let tmp = absolute(&raw["tmp"], "args.tmp")?;
    let mut plan = serde_json::Map::new();
    for name in ["package", "unity"] {
        if let Some(file) = raw.get(name) {
            let (_, mut args) = object_file(&absolute(file, &format!("args.{name}"))?)?;
            if fs::canonicalize(absolute(&args["repo"], "child repo")?)? != repo {
                return fail(format!("args.{name} must target the same Git checkout."));
            }
            if name == "package" {
                let package = crate::args::parse(&args).map_err(GatewayError)?;
                let rel = ledger
                    .strip_prefix(&repo)
                    .expect("validated")
                    .to_string_lossy()
                    .replace('\\', "/");
                if patch::claimed_as(&package.files, &rel).is_some() {
                    return fail("The code package cannot change the active asset ledger.");
                }
            }
            // Make the child repository independent of the caller's current directory.
            args["repo"] = json!(repo);
            plan.insert(name.into(), args);
        }
    }
    for name in ["check", "export"] {
        if let Some(command) = raw.get(name) {
            let at = format!("args.{name}");
            let text = command["command"]
                .as_str()
                .filter(|text| !text.trim().is_empty() && scrubber.text(text, &[]) == *text)
                .ok_or_else(|| {
                    GatewayError(format!("{at}.command needs bounded public command text."))
                })?;
            let cwd = fs::canonicalize(absolute(&command["cwd"], &format!("{at}.cwd"))?)?;
            if !cwd.is_dir() || !cwd.starts_with(&repo) {
                return fail(format!("{at}.cwd must be a directory in args.repo."));
            }
            let mut entry = json!({"command": text, "cwd": cwd});
            if name == "export" {
                let files = command["files"]
                    .as_array()
                    .filter(|files| !files.is_empty())
                    .ok_or_else(|| {
                        GatewayError("args.export.files must identify expected FBX files.".into())
                    })?;
                for value in files {
                    let path = absolute(value, "expected export file")?;
                    if !path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("fbx"))
                        || !path.starts_with(&tmp)
                    {
                        return fail("Expected export files must be FBX outputs under args.tmp.");
                    }
                }
                entry["files"] = json!(files);
            }
            plan.insert(name.into(), entry);
        }
    }
    if let Some(rubric) = raw.get("rubric") {
        if !plan.contains_key("unity")
            || rubric["paid"] != true
            || rubric["role"]
                .as_str()
                .is_none_or(|role| role.trim().is_empty())
        {
            return fail("The asset rubric needs Unity captures, a named role and explicit paid authorization.");
        }
        plan.insert("rubric".into(), rubric.clone());
    }
    if plan.is_empty() {
        return fail("Supply a stage such as a code package, check or Unity plan.");
    }
    if plan.contains_key("check") || plan.contains_key("export") {
        checks::preflight()?;
    }
    fs::create_dir_all(&tmp)?;
    let id = crate::journal::new_run_id();
    let path = fs::canonicalize(tmp)?.join(format!("asset-{id}"));
    fs::create_dir(&path)?;
    let plan = Value::Object(plan);
    let run = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"),
        "createdAt": iso(), "repo": repo, "ledger": ledger, "label": label, "round": round, "stage": stage,
        "summary": summary, "tmp": path, "ledgerSha256": sha256_hex(&text), "accepted": accepted,
        "policy": { "paid": plan.get("rubric").is_some() },
        "inputs": { "argsSha256": input::args_digest(raw), "plan": plan, "planSha256": sha256_hex(plan.to_string()) }
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    Ok((id, journal))
}

fn run_child(
    journal: &mut Journal,
    cfg: &Config,
    step: &str,
    name: &str,
    args: &Value,
    start: impl FnOnce(&Value, &str) -> Result<Exit>,
) -> Result<Option<Value>> {
    if let Some(done) = journal.last("done", step, 1) {
        return Ok(Some(done["result"].clone()));
    }
    let id = if let Some(intent) = journal.last("child intent", step, 1) {
        if intent["argsSha256"] != input::args_digest(args) {
            return fail("The saved child workflow arguments have changed.");
        }
        intent["runId"].as_str().unwrap_or("").to_string()
    } else {
        let id = crate::journal::new_run_id();
        journal.append(json!({ "kind": "child intent", "step": step, "attempt": 1, "runId": id, "workflow": name, "argsSha256": input::args_digest(args) }))?;
        id
    };
    let run_folder = cfg.home.join("flows").join(&id);
    let exit = if run_folder.exists() {
        control::resume(name, &id, Some(args), None, false)?
    } else {
        start(args, &id)?
    };
    if exit.code == 0 || !run_folder.is_dir() || run_folder.join("result.json").is_file() {
        let record = json!({"ok": exit.code == 0, "runId": id, "output": exit.result});
        journal.append(json!({"kind": "done", "step": step, "attempt": 1, "result": record}))?;
        return Ok(Some(record));
    }
    journal.append(json!({ "kind": "stop", "step": step, "stoppedAt": step, "what": format!("Continue {name} run {id} before resuming this asset round."), "childRunId": id }))?;
    Ok(None)
}

fn checked_command(
    journal: &mut Journal,
    stage: &str,
    args: &Value,
    timeout: Duration,
) -> Result<Value> {
    if let Some(done) = journal.last("done", stage, 1) {
        return Ok(done["result"].clone());
    }
    if journal.last("intent", stage, 1).is_some() {
        return fail(format!("The earlier {stage} command may already have run. Reconcile the recorded effect before starting another round."));
    }
    let cwd = Path::new(args["cwd"].as_str().unwrap_or(""));
    let command = args["command"].as_str().unwrap_or("").to_string();
    let logs = journal.file("logs");
    let captures = args["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let before: Vec<_> = captures
        .clone()
        .map(|path| fs::read(path).ok().map(sha256_hex))
        .collect();
    journal.append(json!({"kind": "intent", "step": stage, "attempt": 1, "cwd": cwd}))?;
    let (evidence, durable) =
        checks::run_list(&[command], stage, cwd, &logs, timeout, &mut |phase, pid| {
            journal.append(json!({
            "kind": if phase == checks::Phase::Started { "tool started" } else { "tool ended" },
            "step": stage, "attempt": 1, "pid": pid,
        })).is_ok()
        });
    if !durable {
        return fail(format!("The {stage} receipt could not be recorded."));
    }
    let files: Vec<_> = captures
        .zip(before)
        .filter_map(|(path, prior)| {
            let bytes = fs::read(path).ok()?;
            let digest = sha256_hex(&bytes);
            (prior.as_deref() != Some(&digest) && !bytes.is_empty())
                .then(|| json!({"file": path, "sha256": digest}))
        })
        .collect();
    let count = args["files"].as_array().map(Vec::len).unwrap_or(0);
    let record = json!({"ok": checks::passed(&evidence) && files.len() == count, "evidence": evidence, "files": files});
    journal.append(json!({"kind": "done", "step": stage, "attempt": 1, "result": record}))?;
    Ok(record)
}

fn lock_path(home: &Path, ledger: &Path) -> PathBuf {
    let identity = ledger.to_string_lossy();
    let identity = if cfg!(windows) {
        identity.to_lowercase()
    } else {
        identity.into_owned()
    };
    home.join("asset-ledgers")
        .join(format!("{}.lock", sha256_hex(identity)))
}

fn take_lock(file: &Path, id: &str) -> Result<()> {
    fs::create_dir_all(file.parent().expect("lock directory"))?;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
    {
        Ok(mut owner) => {
            owner.write_all(id.as_bytes())?;
            owner.sync_all()?;
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if fs::read_to_string(&file).is_ok_and(|owner| owner != id)
                || fs::read_to_string(&file).is_err()
            {
                return fail("Another run owns the asset ledger. Resume that run before starting a new round.");
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn release_lock(path: &Path, id: &str) -> Result<()> {
    match fs::read_to_string(path) {
        Ok(owner) if owner == id => fs::remove_file(path)?,
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

pub fn resume(id: &str, given: Option<&Value>, retry: Option<&str>) -> Result<Exit> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if run["workflow"] != NAME
        || run["version"] != VERSION
        || retry.is_some()
        || given.is_some_and(|given| !input::args_match(&run["inputs"], given))
    {
        return fail("Resume asset-round using its original run ID and reconcile its child workflow separately if needed.");
    }
    let _lock = journal.lock()?;
    journal.load()?;
    let plan = &run["inputs"]["plan"];
    if run["inputs"]["planSha256"] != sha256_hex(plan.to_string()) {
        return fail("The saved asset plan does not match its digest.");
    }
    let ledger = run["ledger"]
        .as_str()
        .map(Path::new)
        .ok_or_else(|| GatewayError("The ledger path is missing.".into()))?;
    let cfg = Config::new(run["repo"].as_str().map(Path::new))?;
    let lock = lock_path(&cfg.home, ledger);
    if let Some(result) = journal.read_value("result.json") {
        release_lock(&lock, id)?;
        complete_event(&mut journal)?;
        return Ok(exit(result));
    }
    let current_matches = |raw: &str, data: &Value| {
        run["ledgerSha256"] == sha256_hex(raw)
            || data["rounds"]
                .as_array()
                .and_then(|rows| rows.last())
                .is_some_and(|row| row["runId"] == id)
    };
    let (before, data) = object_file(ledger)?;
    if !current_matches(&before, &data) {
        return fail("The ledger changed before this round could start. Keep this run's receipts and inspect the ledger.");
    }
    take_lock(&lock, id)?;
    let (before, mut current) = object_file(ledger)?;
    if !current_matches(&before, &current) {
        release_lock(&lock, id)?;
        return fail("The ledger changed while the round acquired its lock.");
    }
    let rows = current["rounds"]
        .as_array_mut()
        .ok_or_else(|| GatewayError("The ledger needs a rounds array.".into()))?;
    let mut result = json!({"runId": id, "workflow": NAME, "version": VERSION, "round": run["round"], "ledger": ledger, "journal": journal.dir, "acceptedPrefix": run["accepted"], "approved": false});
    if let Some(row) = rows.last() {
        if row["runId"] == id {
            let row = row.clone();
            return record_owner(&mut journal, ledger, &lock, current, &row, result);
        }
    }
    let mut stopped = None;
    let mut frames = Vec::new();
    for step in ["package", "check", "export", "unity", "rubric"] {
        let Some(args) = plan.get(step) else { continue };
        if step == "rubric" && frames.is_empty() {
            stopped = Some("rubric");
            break;
        }
        let record = match step {
            "package" => run_child(
                &mut journal,
                &cfg,
                step,
                code_package::WORKFLOW,
                args,
                code_package::start_child,
            )?,
            "unity" => run_child(
                &mut journal,
                &cfg,
                step,
                unity_check::NAME,
                args,
                unity_check::start_child,
            )?,
            "rubric" => {
                let args = json!({
                    "repo": run["repo"], "tmp": run["tmp"], "label": run["label"], "role": args["role"], "paid": true,
                    "frames": frames.iter().map(|file| json!({"file": file, "note": run["summary"], "sound": true, "defects": []})).collect::<Vec<_>>(),
                });
                run_child(
                    &mut journal,
                    &cfg,
                    step,
                    rubric_probe::NAME,
                    &args,
                    rubric_probe::start_child,
                )?
            }
            "check" => Some(checked_command(
                &mut journal,
                step,
                args,
                Duration::from_secs(120),
            )?),
            "export" => Some(checked_command(
                &mut journal,
                step,
                args,
                Duration::from_secs(40 * 60),
            )?),
            _ => unreachable!(),
        };
        let Some(record) = record else {
            result["stoppedAt"] = json!(step);
            result["childRunId"] = journal
                .last_event()
                .map(|event| event["childRunId"].clone())
                .unwrap_or(Value::Null);
            return Ok(exit(result));
        };
        let ok = record["ok"] == true;
        if step == "unity" && ok {
            frames = record["output"]["steps"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|row| row["capture"].as_str().map(String::from))
                .collect();
        }
        if step == "rubric" && ok {
            let frame_verdicts = record["output"]["verdicts"]
                .as_array()
                .into_iter()
                .flatten();
            if frame_verdicts
                .flat_map(|question| question["answers"].as_array().into_iter().flatten())
                .any(|answer| answer["outcome"] != "pass")
            {
                stopped = Some("rubric");
            }
        }
        result[step] = record;
        if !ok || stopped.is_some() {
            stopped = Some(step);
            break;
        }
    }
    let current_text = fs::read_to_string(ledger)?;
    if run["ledgerSha256"] != sha256_hex(current_text) {
        return fail("The ledger changed while the asset steps ran.");
    }
    let row = json!({
        "n": run["round"], "runId": id, "label": run["label"], "stage": run["stage"], "change": run["summary"],
        "startedAt": run["createdAt"], "finishedAt": iso(), "stoppedAt": stopped, "frames": frames, "owner": null,
        "rubric": result["rubric"].get("ok").map(|ok| json!({"ok": ok == true && stopped != Some("rubric")})),
    });
    rows.push(row.clone());
    journal.write_value("round.json", &result)?;
    write_json_atomic(ledger, &current)?;
    crate::code_package::cut("asset ledger");
    record_owner(&mut journal, ledger, &lock, current, &row, result)
}

fn record_owner(
    journal: &mut Journal,
    ledger: &Path,
    lock: &Path,
    mut current: Value,
    row: &Value,
    fallback: Value,
) -> Result<Exit> {
    let mut result = journal.read_value("round.json").unwrap_or(fallback);
    let verdict = journal
        .events()
        .iter()
        .rev()
        .find(|event| event["step"] == OWNER && event["ownerAnswer"].is_string())
        .and_then(|event| event["ownerAnswer"].as_str())
        .map(str::trim);
    let Some(verdict) = verdict.filter(|text| !text.is_empty() && !text.contains('\n')) else {
        let question = "Record the owner's one-line verdict for this exact round.";
        if journal
            .last_event()
            .is_none_or(|event| event["kind"] != "waiting")
        {
            journal.append(json!({"kind": "waiting", "step": OWNER, "question": question, "frames": row["frames"]}))?;
        }
        result["status"] = json!("waiting");
        result["question"] = json!(question);
        result["frames"] = row["frames"].clone();
        result["stoppedAt"] = row["stoppedAt"].clone();
        return Ok(exit(result));
    };
    if row["owner"].is_null() {
        current["rounds"]
            .as_array_mut()
            .and_then(|rows| rows.last_mut())
            .expect("matching row")["owner"] = json!(verdict);
        write_json_atomic(ledger, &current)?;
    } else if row["owner"] != verdict {
        return fail("The recorded owner verdict differs from this reply.");
    }
    result["owner"] = json!(verdict);
    result["frames"] = row["frames"].clone();
    result["stoppedAt"] = row["stoppedAt"].clone();
    let accepted = result["acceptedPrefix"]
        .as_str()
        .is_some_and(|prefix| verdict.starts_with(prefix));
    result["approved"] = json!(accepted && row["stoppedAt"].is_null());
    if fs::read_to_string(lock)? != result["runId"].as_str().unwrap_or("") {
        return fail("The asset lock is owned by another run.");
    }
    journal.write_value("result.json", &result)?;
    release_lock(lock, result["runId"].as_str().unwrap_or(""))?;
    complete_event(journal)?;
    Ok(exit(result))
}

fn complete_event(journal: &mut Journal) -> Result<()> {
    if !journal
        .events()
        .iter()
        .any(|event| event["kind"] == "finished")
    {
        journal.append(json!({"kind": "finished", "step": "result"}))?;
    }
    Ok(())
}

fn exit(result: Value) -> Exit {
    Exit {
        code: if result["approved"] == true { 0 } else { 2 },
        result,
    }
}
