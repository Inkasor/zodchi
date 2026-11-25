use crate::{acceptance, asset_round, branch_review, code_package, design_brief, input, journal::{last_state_event, Journal}, method_question, rubric_probe, unity_check, video, voiceover, workspace_audit, youtube_publish, Exit};
use serde_json::{json, Value};
use std::ffi::OsString;
use zodchi_core::config::Config;
use zodchi_core::job::spawn_flow_worker;
use zodchi_core::process::process_start;
use zodchi_core::util::Result;

fn safety_block(events: &[Value]) -> Option<Value> {
    events.iter().rev().find(|event| event["kind"] == "safety blocked").map(|event| {
        json!({ "step": event["step"], "jobKey": event["key"], "provider": event["provider"] })
    })
}

pub fn status(id: &str) -> Result<Exit> {
    let (journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    let events = journal.snapshot()?;
    let finished = events.iter().any(|event| event["kind"] == "finished");
    let final_result = journal.read_value("result.json").filter(|result| finished && result.get("claimLeftOpen").is_none()).map(|mut result| {
        if let Some(applied) = crate::candidate::application_status(&events) {
            result["application"] = applied;
        }
        result
    });
    let active = journal.active();
    let receipt = journal.read_value("worker-result.json");
    let last = last_state_event(&events).unwrap_or(&Value::Null);
    let outcome = if final_result.is_some() {
        "finished"
    } else if active {
        "running"
    } else if last["kind"] == "waiting" {
        "waiting"
    } else if last["kind"] == "youtube processing" {
        "processing"
    } else if last["kind"] == "scope allowed" || last["kind"] == "budget extended" || (last["kind"] == "rerun" && last.get("ownerAnswer").is_some()) {
        "ready"
    } else if receipt.is_some() || last["kind"] == "stop" {
        "stopped"
    } else {
        "interrupted"
    };
    let mut result = json!({
        "runId": id, "workflow": run["workflow"], "version": run["version"], "release": run["release"], "repo": run["repo"],
        "status": outcome, "step": last["step"], "event": last["kind"], "models": run["pair"],
        "journal": journal.dir.display().to_string(),
    });
    if let Some(commit) = run.get("buildCommit") {
        result["buildCommit"] = commit.clone();
    }
    if run["workflow"] == video::NAME {
        result["video"] = video::status_detail(&run, &events);
    }
    if run["workflow"] == youtube_publish::NAME {
        result["youtube"] = youtube_publish::status_detail(&run, &events);
    }
    if let Some(block) = safety_block(&events) {
        result["safetyBlock"] = block;
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
    if let Ok(budget) = crate::budget::Budget::parse(&run["inputs"]["args"]["budget"]) {
        result["budget"] = budget.report(&events);
    }
    if let Some(key) = last["key"].as_str() {
        result["jobKey"] = json!(key);
    }
    if last["kind"] == "stop" && !active {
        result["stoppedAt"] = last["stoppedAt"].clone();
        result["infra"] = last["what"].clone();
        if run["workflow"] == voiceover::NAME {
            result["errorKind"] = last["errorKind"].clone();
            result["mayHaveBeenCharged"] = last["mayHaveBeenCharged"].clone();
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

/// The state a new executor needs to continue safely, without model responses, commands or log contents.
pub fn handoff(id: &str) -> Result<Exit> {
    let (_, run) = Journal::open(&Config::new(None)?.home, id)?;
    let current = status(id)?.result;
    let result = current.get("result").or_else(|| current.get("lastResult")).unwrap_or(&Value::Null);
    let review = result["rounds"].as_array().and_then(|rounds| {
        rounds.iter().rev().find_map(|round| round["review"]["verdict"].as_str())
    });
    let full = &result["fullVerification"];
    let evidence: Vec<_> = full["evidence"].as_array().into_iter().flatten()
        .map(|entry| json!({ "source": entry["source"], "exitCode": entry["exitCode"], "log": entry["log"] }))
        .collect();
    let result_file = if current.get("result").is_some() { "result.json" } else { "worker-result.json" };
    let result_path = std::path::Path::new(current["journal"].as_str().unwrap()).join(result_file);
    if run["workflow"] == youtube_publish::NAME {
        return Ok(Exit { code: 0, result: json!({ "runId": id, "workflow": run["workflow"], "version": run["version"],
            "status": current["status"], "step": current["step"], "journal": current["journal"],
            "question": current["question"], "reason": result.get("reason").unwrap_or(&current["infra"]),
            "youtube": current["youtube"], "resultFile": (!result.is_null()).then_some(result_path),
            "verdict": result["verdict"], "observed": result["observed"] }) });
    }
    if [acceptance::RELEASE, acceptance::PLAYER, acceptance::CANDIDATE].iter().any(|name| current["workflow"] == *name) {
        let scenarios: Vec<_> = result["scenarios"].as_array().into_iter().flatten().map(|s| json!({ "id": s["id"], "status": s["status"] })).collect();
        return Ok(Exit { code: 0, result: json!({ "runId": id, "workflow": current["workflow"], "version": current["version"],
            "repo": current["repo"], "head": run["head"], "status": current["status"], "step": current["step"],
            "journal": current["journal"], "resultFile": (!result.is_null()).then_some(result_path),
            "verdict": result["verdict"], "reason": result["reason"], "models": current["models"],
            "scenarios": scenarios, "safetyBlock": current["safetyBlock"] }) });
    }
    let mut handoff = json!({
        "runId": id, "workflow": current["workflow"], "version": current["version"], "repo": current["repo"],
        "status": current["status"], "step": current["step"], "journal": current["journal"],
        "resultFile": (!result.is_null()).then_some(result_path), "base": run["base"],
        "targetBranch": result.get("targetBranch").unwrap_or(&run["branch"]),
        "candidate": { "commit": result["candidate"]["commit"], "tree": result["candidate"]["tree"], "ref": result["candidate"]["ref"] },
        "verdict": result["verdict"], "stoppedAt": result.get("stoppedAt").unwrap_or(&current["stoppedAt"]),
        "review": { "verdict": review, "openFindings": result["openFindings"].as_array().map(Vec::len) },
        "fullVerification": { "status": full["status"], "tree": full["tree"], "evidence": evidence },
        "application": { "status": result["application"]["status"] },
        "safetyBlock": current["safetyBlock"],
    });
    if run["workflow"] == branch_review::NAME {
        handoff["head"] = run["head"].clone();
        handoff["screening"] = run["screening"].clone();
        for key in ["previousReview", "reviewRound", "reviewLimit", "verificationReceipt"] {
            if let Some(value) = run.get(key).filter(|value| !value.is_null()) {
                handoff[key] = value.clone();
            }
        }
        handoff["review"] = json!({ "verdict": result["review"]["verdict"],
            "openFindings": result["blocking"].as_array().map(Vec::len) });
    }
    Ok(Exit { code: 0, result: handoff })
}

fn refused_rerun(journal: &Journal, id: &str, rerun: Option<&str>) -> Result<Option<Exit>> {
    if rerun.is_none() || safety_block(&journal.snapshot()?).is_none() {
        return Ok(None);
    }
    let mut exit = handoff(id)?;
    exit.code = 2;
    exit.result["reason"] = json!("The provider blocked this frozen request for safety. Its recorded receipts are available for inspection.");
    Ok(Some(exit))
}

pub fn launch(journal: &Journal, id: &str, rerun: Option<&str>) -> Result<Exit> {
    if journal.active() {
        return status(id);
    }
    let mut args: Vec<OsString> = ["flow", "_worker", id].into_iter().map(OsString::from).collect();
    if let Some(step) = rerun {
        args.push(step.into());
    }
    let keep_api_key = journal.read_value("run.json").is_some_and(|run|
        (run["workflow"] == rubric_probe::NAME || run["workflow"] == asset_round::NAME
            || run["workflow"] == voiceover::NAME)
            && run["policy"]["paid"] == true);
    match spawn_flow_worker(&args, keep_api_key) {
        Ok(child) => {
            let pid = child.id();
            let mut receipt = json!({ "runId": id, "status": "submitted", "pid": pid });
            if let Err(error) = journal.write_value("worker.json", &json!({ "pid": pid, "start": process_start(pid) })) {
                receipt["note"] = json!(format!("Worker started; its process receipt could not be stored: {}", error.0));
            }
            Ok(Exit { result: receipt, code: 0 })
        }
        Err(error) => {
            let result = json!({
                "runId": id, "status": "stopped", "stoppedAt": "start worker", "infra": error.0,
                "next": "Resume this run to start its worker."
            });
            journal.write_value("worker-result.json", &result)?;
            Ok(Exit { result, code: 2 })
        }
    }
}

pub fn resume(workflow: &str, id: &str, given: Option<&Value>, rerun: Option<&str>, detach: bool) -> Result<Exit> {
    let (journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if run["workflow"] != workflow {
        return zodchi_core::util::fail(format!("Run {id} belongs to {}.", run["workflow"]));
    }
    if let Some(given) = given {
        if !input::args_match(&run["inputs"], given) {
            return zodchi_core::util::fail(format!("The args differ from those run {id} started with."));
        }
    }
    if let Some(exit) = refused_rerun(&journal, id, rerun)? {
        return Ok(exit);
    }
    if journal.active() && rerun.is_none() {
        return status(id);
    }
    if detach && !journal.file("result.json").is_file() && !journal.active() {
        return launch(&journal, id, rerun);
    }
    resume_workflow(workflow, id, given, rerun)
}

pub fn worker(id: &str, rerun: Option<&str>) -> Result<Exit> {
    let (journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if let Some(exit) = refused_rerun(&journal, id, rerun)? {
        return Ok(exit);
    }
    let exit = match resume_workflow(run["workflow"].as_str().unwrap_or(""), id, None, rerun) {
        Ok(exit) => exit,
        Err(error) => Exit { result: json!({ "runId": id, "status": "stopped", "stoppedAt": "worker", "infra": error.0 }), code: 2 },
    };
    journal.write_value("worker-result.json", &exit.result)?;
    Ok(exit)
}

fn resume_workflow(workflow: &str, id: &str, given: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    match workflow {
        code_package::WORKFLOW => code_package::resume(id, given, rerun),
        branch_review::NAME => branch_review::resume(id, given, rerun),
        design_brief::NAME => design_brief::resume(id, given, rerun),
        method_question::NAME => method_question::resume(id, given, rerun),
        rubric_probe::NAME => rubric_probe::resume(id, given, rerun),
        unity_check::NAME => unity_check::resume(id, given, rerun),
        workspace_audit::NAME => workspace_audit::resume(id, given, rerun),
        asset_round::NAME => asset_round::resume(id, given, rerun),
        video::NAME => video::resume(id, given, rerun),
        voiceover::NAME => voiceover::resume(id, rerun),
        youtube_publish::NAME => youtube_publish::resume(id, given, rerun),
        acceptance::RELEASE | acceptance::PLAYER | acceptance::CANDIDATE => acceptance::resume(id, rerun),
        _ => zodchi_core::util::fail(format!("Workflow {workflow:?} is not available in this installation.")),
    }
}
