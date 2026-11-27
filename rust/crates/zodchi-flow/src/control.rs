use crate::{
    acceptance,
    asset_round::{self, ChildWorkflow, Children},
    boundary, branch_review, budget, checks, child_package, cleanup, code_package, design_brief,
    gateway, incident_triage, input, input_common::args_match,
    journal::{self, safety_block, Journal, StatusHooks, SHUTDOWN_REQUEST},
    method_question, ops_script, research, rubric_probe, unity_check, video, voiceover,
    workspace_audit, youtube_publish, Exit,
};
use serde_json::{json, Value};
use std::{
    path::Path,
    thread,
    time::{Duration, Instant},
};
use zodchi_core::{
    config::Config,
    process::stop_process,
    util::{fail, iso, GatewayError, Result},
};

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
                if run["workflow"] == boundary::WORKFLOW {
                    if let Some(credits) = gateway::credits_report(events, None) {
                        result["credits"] = credits;
                    }
                }
            }),
            stop_details: Some(voiceover::project_stop_status),
        },
    )
}

#[derive(Clone, Copy)]
pub enum SignIn {
    Codex,
    Claude,
    Server,
    ApiKey,
    YouTube,
}

pub(crate) const NO_CONSENT_TERMINAL: &str = "YouTube consent requires a controlling terminal.";

impl SignIn {
    pub fn for_job(job: &Value) -> Option<Self> {
        if job["status"] != "auth_required" || job["kind"] == "decisions" {
            return None;
        }
        if job["provider"] == "claude" {
            return job["error"].as_str().filter(|why| claude_signed_out(why)).map(|_| Self::Claude);
        }
        // LOGIN_HINT is the unsigned-account outcome. Provider auth errors come after account selection.
        // A missing account for a resumed thread has the legacy status but neither of these signals.
        (job["error"] == zodchi_core::job::LOGIN_HINT || job["account"].is_string()).then_some(Self::Codex)
    }

    /// Recognize the legacy diagnostic when a workflow reports a gate failure as text.
    pub fn for_gate(why: &str) -> Option<Self> {
        if why == NO_CONSENT_TERMINAL {
            return Some(Self::YouTube);
        }
        if why == zodchi_core::job::LOGIN_HINT {
            return Some(Self::Codex);
        }
        if why.starts_with("auth_required: your ChatGPT subscription on the flow server ") {
            return Some(Self::Server);
        }
        if why.starts_with("No writer/reviewer pair of distinct models: ")
            || why.starts_with("No available candidate for ")
        {
            if why.contains(": Codex is not signed in (zodchi account)") {
                return Some(Self::Codex);
            }
            if why.split(": Claude preflight: ").skip(1).any(claude_signed_out) {
                return Some(Self::Claude);
            }
        }
        None
    }
}

fn stop_sign_in(result: &Value) -> Option<SignIn> {
    if result["status"] == "closed" || result["verdict"] == "closed" {
        return None;
    }
    if result["workflow"] == voiceover::NAME && result["errorKind"] == "auth_required" {
        return Some(SignIn::ApiKey);
    }
    let stopped = result["stoppedAt"].as_str().unwrap_or_default();
    let why = result["infra"].as_str().or_else(|| result["reason"].as_str()).unwrap_or_default();
    if stopped == "worker" {
        return SignIn::for_gate(why);
    }
    let job_error = why.strip_prefix("job ")
        .or_else(|| why.split_once(". job ").map(|(_, job)| job))
        .and_then(|job| job.split_once(": ").map(|(_, error)| error));
    // The gateway has already recorded the provider's auth status in these stop reasons.
    if stopped.starts_with("gateway auth_required at ")
        || why.starts_with("gateway auth_required at ")
    {
        let error = job_error.unwrap_or(why);
        return Some(if let Some(provider) = SignIn::for_gate(error) {
            provider
        } else if error.starts_with("OPENAI_API_KEY ") || error.starts_with("The Realtime API refused ") {
            SignIn::ApiKey
        } else {
            SignIn::Codex
        });
    }
    ((stopped.starts_with("gateway refused at ") || why.starts_with("gateway refused at "))
        && job_error.is_some_and(claude_signed_out))
        .then_some(SignIn::Claude)
}

fn claude_signed_out(why: &str) -> bool {
    why.starts_with("Claude Code is not signed in with a Claude subscription (claude auth status:")
}

/// Classify the existing result without changing the stdout or journal schema.
pub fn sign_in_required(args: &[String], exit: &Exit) -> Option<SignIn> {
    if exit.code != 2 || matches!(args.first().map(String::as_str), Some("close" | "cancel")) {
        return None;
    }
    let result = &exit.result;
    let sign_in = result["refused"].as_str().and_then(SignIn::for_gate).or_else(|| stop_sign_in(result));
    if sign_in.is_some() {
        return sign_in;
    }
    // Detached wait keeps its terse observation on stdout; its journal has the actual stop cause.
    if args.first().is_some_and(|command| command == "wait")
        && matches!(result["status"].as_str(), Some("stopped" | "finished"))
    {
        let observed = status(result["runId"].as_str()?).ok()?.result;
        return [&observed, &observed["result"], &observed["lastResult"]].into_iter().find_map(stop_sign_in);
    }
    None
}

pub(crate) fn stop_run(id: &str, reason: &str, cancel: bool) -> Result<Exit> {
    if reason.trim().is_empty() || reason.chars().count() > 500 {
        return fail("--reason must contain between 1 and 500 characters of text.");
    }
    let cfg = Config::new(None)?;
    let (mut journal, run) = Journal::open(&cfg.home, id)?;
    if journal.finished(&journal.snapshot()?) {
        return fail(format!("run {id} has finished"));
    }
    let live_error = |pid| {
        format!("Run {id} is live (pid {pid}). Use zodchi flow cancel {id} --reason <text>.")
    };
    if !cancel {
        if let Some((pid, _)) = journal.live_owner(None) {
            return fail(live_error(pid));
        }
    }
    let claim = code_package::PinnedClaim::for_shutdown(&run, id)?;
    let places = [
        (cfg.home.to_string_lossy().into_owned(), "<zodchi-home>"),
        (run["repo"].as_str().unwrap_or("").to_owned(), "<repo>"),
    ];
    let reason = input::scrub(&cfg, reason.trim(), &places)?;
    let Some(_shutdown) = cleanup::lock_shutdown(&journal)? else {
        return fail(format!("Another command is closing run {id}."));
    };

    let deadline = Instant::now() + Duration::from_secs(60);
    let lock = loop {
        if let Some((pid, owner)) = journal.live_owner(None) {
            if !cancel {
                return fail(live_error(pid));
            }
            if Instant::now() >= deadline {
                return fail(format!("Run {id} is still live (pid {pid}) after waiting 60 seconds."));
            }
            cancel_worker(&journal, claim.as_ref(), id, (pid, &owner), &reason, deadline)?;
        }
        match journal.lock() {
            Ok(lock) if journal.live_owner(Some(std::process::id())).is_none() => break lock,
            Ok(_) => {} // A detached worker appeared before we took the lock.
            Err(error) => match journal.live_owner(None) {
                Some((pid, _)) if !cancel => return fail(live_error(pid)),
                Some(_) if Instant::now() < deadline => {}
                _ => return Err(error),
            },
        }
    };
    journal.load_for_shutdown()?;
    let stored = journal.read_value("result.json");
    if journal::finished_event(journal.events(), stored.as_ref()).is_some() {
        return fail(format!("run {id} has finished"));
    }
    let request = match shutdown_request(&journal)? {
        Some(request) => request,
        None => {
            let request = json!({ "kind": "close requested", "at": iso(), "reason": reason });
            journal.write_value(SHUTDOWN_REQUEST, &request)?;
            request
        }
    };
    let result = finish_shutdown(&mut journal, &run, id, claim.as_ref(), &request, stored.as_ref())?;
    drop(lock);
    Ok(cleanup::after_run(Exit { code: 0, result }))
}

fn cancel_worker(
    journal: &Journal,
    claim: Option<&code_package::PinnedClaim<'_>>,
    id: &str,
    (pid, owner): (u32, &Value),
    reason: &str,
    deadline: Instant,
) -> Result<()> {
    let start = owner["start"]
        .as_str()
        .filter(|start| !start.trim().is_empty())
        .ok_or_else(|| {
            GatewayError(format!("Cannot verify the start time of run {id}'s worker (pid {pid})."))
        })?;
    let events = journal.snapshot()?;
    if journal.finished(&events) {
        return fail(format!("run {id} has finished"));
    }
    // A live worker owns events.jsonl. Record the event separately before signalling
    // and merge it into the event stream once the run lock has been recovered.
    if shutdown_request(journal)?.is_none() {
        journal.write_value(SHUTDOWN_REQUEST, &json!({
            "kind": "cancel requested", "at": iso(), "pid": pid, "reason": reason,
            "step": journal::last_state_event(&events).and_then(|event| event["step"].as_str()),
        }))?;
        boundary::cut("flow cancel request");
    }

    let _claim_lock = if let Some(claim) = claim {
        std::fs::create_dir_all(&claim.dir)?;
        // A killed worker cannot release the legacy repository-wide claim lock. Wait
        // for claim writes to finish and hold the lock while signalling the worker.
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .saturating_sub(Duration::from_secs(10));
        Some(cleanup::ClaimLock::wait(&claim.dir, wait)?)
    } else {
        None
    };
    if journal.finished(&journal.snapshot()?) {
        return fail(format!("run {id} has finished"));
    }
    if journal::live_pid(owner).is_none() {
        return Ok(());
    }
    let signal = stop_process(i64::from(pid), Some(start));
    while journal::live_pid(owner).is_some() {
        if signal == "unknown" {
            return fail(format!("Could not signal run {id}'s worker (pid {pid})."));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return fail(format!("Run {id} is still live (pid {pid}) after waiting 60 seconds."));
        }
        thread::sleep(remaining.min(Duration::from_millis(100)));
    }
    Ok(())
}

fn shutdown_request(journal: &Journal) -> Result<Option<Value>> {
    if !journal.file(SHUTDOWN_REQUEST).try_exists()? {
        return Ok(None);
    }
    let request = journal
        .read_value(SHUTDOWN_REQUEST)
        .filter(|request| {
            matches!(request["kind"].as_str(), Some("cancel requested" | "close requested"))
                && request["reason"].is_string()
                && request["at"].is_string()
        })
        .ok_or_else(|| GatewayError("The run's shutdown request is unreadable.".into()))?;
    Ok(Some(request))
}

fn finish_shutdown(
    journal: &mut Journal,
    run: &Value,
    id: &str,
    claim: Option<&code_package::PinnedClaim<'_>>,
    request: &Value,
    stored: Option<&Value>,
) -> Result<Value> {
    if request["kind"] == "cancel requested"
        && !journal.events().iter().any(|event| event["kind"] == "cancel requested")
    {
        let mut event = request.clone();
        event["requestedAt"] = request["at"].clone();
        journal.append(event)?;
    }
    let result = if let Some(closed) = journal.events().iter().rfind(|event| event["kind"] == "closed") {
        closed["result"].clone()
    } else {
        let worker = journal.read_value("worker-result.json");
        let prior = stored.or(worker.as_ref()).unwrap_or(&Value::Null);
        let step = journal
            .last_event()
            .and_then(|event| event["step"].as_str())
            .or_else(|| prior["stoppedAt"].as_str())
            .or_else(|| journal.events().iter().rev().find_map(|event| event["step"].as_str()))
            .unwrap_or("start");
        let findings = stored
            .and_then(|result| result.get("openFindings").cloned())
            .or_else(|| {
                if run["workflow"] == code_package::WORKFLOW {
                    code_package::recorded_findings(journal.events()).map(|findings| json!(findings))
                } else {
                    None
                }
            })
            .or_else(|| prior.get("openFindings").cloned())
            .unwrap_or_else(|| json!([]));
        let mut result = json!({
            "runId": id, "workflow": run["workflow"], "version": run["version"],
            "status": "closed", "verdict": "closed", "approved": false,
            "stoppedAt": step, "reason": request["reason"],
            "openFindings": findings,
        });
        if let Some(step) = journal::unknown_model_step(journal.events()) {
            result["unknownOutcome"] = json!(step);
        }
        for key in ["candidate", "claimAdded"] {
            if let Some(value) = prior.get(key) {
                result[key] = value.clone();
            }
        }
        // A cut worker can leave independently contained checks. Settle the recorded
        // processes before cleanup can remove their checkouts.
        checks::reap_unended(journal)?;
        let event = json!({ "kind": "closed", "step": result["stoppedAt"], "reason": request["reason"], "result": result });
        journal.append(event)?;
        result
    };
    if let Some(claim) = claim {
        claim.close(id)?;
    }
    boundary::cut("flow close claim");
    journal.write_value("result.json", &result)?;
    journal.append(json!({ "kind": "finished", "step": result["stoppedAt"], "verdict": "closed" }))?;
    Ok(result)
}

fn saved_shutdown(id: &str, result: Option<Value>, rerun: Option<&str>) -> Result<Option<Exit>> {
    let Some(result) = result.filter(|result| result["verdict"] == "closed") else { return Ok(None) };
    if rerun.is_some() {
        return fail(format!("run {id} has finished"));
    }
    Ok(Some(Exit { code: 2, result }))
}

fn resume_shutdown(journal: &mut Journal, run: &Value, id: &str, rerun: Option<&str>) -> Result<Option<Exit>> {
    let Some(request) = shutdown_request(journal)? else { return Ok(None) };
    let events = journal.snapshot()?;
    let stored = journal.read_value("result.json");
    if journal::finished_event(&events, stored.as_ref()).is_some() {
        return saved_shutdown(id, stored, rerun);
    }
    if journal.live_owner(Some(std::process::id())).is_some() {
        return status(id).map(Some);
    }
    let Some(_shutdown) = cleanup::lock_shutdown(journal)? else {
        return status(id).map(Some);
    };
    let lock = journal.lock()?;
    if journal.live_owner(Some(std::process::id())).is_some() {
        drop(lock);
        return status(id).map(Some);
    }
    journal.load_for_shutdown()?;
    let stored = journal.read_value("result.json");
    if journal::finished_event(journal.events(), stored.as_ref()).is_some() {
        return saved_shutdown(id, stored, rerun);
    }
    let claim = code_package::PinnedClaim::for_shutdown(run, id)?;
    let result = finish_shutdown(journal, run, id, claim.as_ref(), &request, stored.as_ref())?;
    drop(lock);
    Ok(Some(cleanup::after_run(Exit { code: 2, result })))
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
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if run["workflow"] != workflow {
        return zodchi_core::util::fail(format!("Run {id} belongs to {}.", run["workflow"]));
    }
    if let Some(given) = given {
        if !args_match(&run["inputs"], given) {
            return zodchi_core::util::fail(format!("The args differ from those run {id} started with."));
        }
    }
    if let Some(exit) = resume_shutdown(&mut journal, &run, id, rerun)? {
        return Ok(exit);
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
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if let Some(exit) = resume_shutdown(&mut journal, &run, id, rerun)? {
        return Ok(exit);
    }
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
