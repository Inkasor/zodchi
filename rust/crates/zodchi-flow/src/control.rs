use crate::{
    acceptance,
    asset_round::{self, ChildWorkflow, Children},
    boundary, branch_review, budget, child_package, cleanup, code_package, design_brief,
    incident_triage, input, input_common::args_match,
    journal::{self, safety_block, Journal, StatusHooks},
    method_question, ops_script, research, rubric_probe, unity_check, video, voiceover,
    workspace_audit, youtube_publish, Exit,
};
use serde_json::{json, Value};
use std::path::Path;
use zodchi_core::config::Config;
use zodchi_core::util::{fail, GatewayError, Result};

pub(crate) const ASSET_CHILDREN: Children = Children {
    package: ChildWorkflow {
        name: boundary::WORKFLOW,
        start: child_package::start,
        resume: child_package::resume,
    },
    unity: ChildWorkflow {
        name: unity_check::NAME,
        start: |args, id| unity_check::start_child(args, id, crate::require_workflow),
        resume: |id, args| resume(unity_check::NAME, id, Some(args), None, false),
    },
    rubric: ChildWorkflow {
        name: rubric_probe::NAME,
        start: |args, id| rubric_probe::start_child(args, id, crate::require_workflow),
        resume: |id, args| resume(rubric_probe::NAME, id, Some(args), None, false),
    },
};

pub(crate) fn reply_policy(run: &Value) -> input::ReplyPolicy {
    let mut policy = input::ReplyPolicy::default();
    match run["workflow"].as_str() {
        Some(research::NAME) => policy.read_text = Some(research::reply_text),
        Some(design_brief::NAME) => policy.decision_flags = true,
        Some(video::NAME) => policy.media_decision = Some(video::record_reply),
        Some(youtube_publish::NAME) => {
            policy.media_decision = Some(youtube_publish::record_reply);
            policy.waiting_only_error = Some(youtube_publish::REPLY_WAITING_ONLY);
        }
        _ => {}
    }
    policy
}

pub fn status(id: &str) -> Result<Exit> {
    journal::status(
        id,
        StatusHooks {
            check_result: Some(ops_script::project_status_result),
            details: Some(|run, events, result| {
                video::project_status(run, events, result);
                youtube_publish::project_status(run, events, result);
            }),
            stop_details: Some(voiceover::project_stop_status),
        },
    )
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
    let result_path = Path::new(current["journal"].as_str().unwrap()).join(result_file);
    if run["workflow"] == youtube_publish::NAME {
        return Ok(Exit { code: 0, result: youtube_publish::handoff(id, &run, &current, result, &result_path) });
    }
    if [acceptance::RELEASE, acceptance::PLAYER, acceptance::CANDIDATE].iter().any(|name| current["workflow"] == *name) {
        return Ok(Exit { code: 0, result: acceptance::handoff(id, &run, &current, result, &result_path) });
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
        branch_review::project_handoff(&run, result, &mut handoff);
    }
    Ok(Exit { code: 0, result: handoff })
}

/// Starts a new run from its arguments: the gate, then the journal, the claim and the machine.
pub fn start_package(raw: &Value) -> Result<Exit> {
    code_package::start_run(raw, code_package::StartMode::Foreground, crate::require_workflow)
}

pub fn start_package_detached(raw: &Value) -> Result<Exit> {
    code_package::start_run(raw, code_package::StartMode::Detached(launch_start), crate::require_workflow)
}

pub(crate) fn dry_run_package(raw: &Value) -> Result<Exit> {
    crate::git::Git::with_preview(|| {
        code_package::start_run(raw, code_package::StartMode::DryRun, crate::require_workflow)
    })
}

pub(crate) fn launch_start(journal: &Journal, id: &str) -> Result<Exit> {
    launch(journal, id, None)
}

fn launch(journal: &Journal, id: &str, rerun: Option<&str>) -> Result<Exit> {
    boundary::launch(
        journal,
        id,
        rerun,
        |run| [rubric_probe::NAME, asset_round::NAME, voiceover::NAME]
            .iter()
            .any(|name| run["workflow"] == *name),
        status,
    )
}

pub fn extend_budget(id: &str, options: &[String]) -> Result<Exit> {
    if options.is_empty() || options.len() % 2 != 0 {
        return fail(crate::USAGE);
    }
    let mut calls = None;
    let mut minutes = None;
    for pair in options.chunks_exact(2) {
        let destination = match pair[0].as_str() {
            "--add-calls" => &mut calls,
            "--add-minutes" => &mut minutes,
            _ => return fail(crate::USAGE),
        };
        let amount = pair[1]
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| {
                GatewayError("Budget additions must be positive whole numbers.".into())
            })?;
        if destination.replace(amount).is_some() {
            return fail(crate::USAGE);
        }
    }
    budget::extend(id, calls, minutes, |run| run["workflow"] == boundary::WORKFLOW)
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

pub fn resume(workflow: &str, id: &str, given: Option<&Value>, rerun: Option<&str>, detach: bool) -> Result<Exit> {
    let (journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if run["workflow"] != workflow {
        return zodchi_core::util::fail(format!("Run {id} belongs to {}.", run["workflow"]));
    }
    if let Some(given) = given {
        if !args_match(&run["inputs"], given) {
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
    resume_workflow(workflow, id, given, rerun).map(cleanup::after_run)
}

pub fn worker(id: &str, rerun: Option<&str>) -> Result<Exit> {
    let (journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if let Some(exit) = refused_rerun(&journal, id, rerun)? {
        return Ok(exit);
    }
    let exit = match resume_workflow(run["workflow"].as_str().unwrap_or(""), id, None, rerun) {
        Ok(exit) => cleanup::after_run(exit),
        Err(error) => Exit { result: json!({ "runId": id, "status": "stopped", "stoppedAt": "worker", "infra": if run["workflow"] == ops_script::NAME { "ops-script worker failed; inspect the run locally".to_owned() } else { error.0 } }), code: 2 },
    };
    journal.write_value("worker-result.json", &exit.result)?;
    Ok(exit)
}

fn resume_workflow(workflow: &str, id: &str, given: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    match workflow {
        ops_script::NAME => ops_script::resume(id, given, rerun),
        code_package::WORKFLOW => code_package::resume(id, given, rerun),
        branch_review::NAME => branch_review::resume(id, given, rerun),
        design_brief::NAME => design_brief::resume(id, given, rerun),
        incident_triage::NAME => incident_triage::resume(id, given, rerun),
        method_question::NAME => method_question::resume(id, given, rerun),
        rubric_probe::NAME => rubric_probe::resume(id, given, rerun),
        unity_check::NAME => unity_check::resume(id, given, rerun),
        workspace_audit::NAME => workspace_audit::resume(id, given, rerun),
        asset_round::NAME => asset_round::resume(id, given, rerun, &ASSET_CHILDREN),
        research::NAME => research::resume(id, given, rerun),
        video::NAME => video::resume(id, given, rerun),
        voiceover::NAME => voiceover::resume(id, rerun),
        youtube_publish::NAME => youtube_publish::resume(id, given, rerun),
        acceptance::RELEASE | acceptance::PLAYER | acceptance::CANDIDATE => acceptance::resume(id, rerun),
        _ => zodchi_core::util::fail(format!("Workflow {workflow:?} is not available in this installation.")),
    }
}
