//! A model step records its exact request before submission, then reattaches to its recorded job by key.

use crate::{agent, boundary::{REVIEWER_GATEWAY_ROLE, WRITER_GATEWAY_ROLE}, budget::Budget, checks, executor::{self, Executor}, input_common, journal::Journal, models::Pick, verify::WriterSettings};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use zodchi_core::{appserver::{SAFETY_BLOCKED, SAFETY_MESSAGE}, config::Config, job::LIMIT_PROMPT, util::{sha256_hex, GatewayError, Result}};

pub fn pin_browser(variable: &str, path: &Path) -> std::result::Result<Value, String> {
    if !checks::valid_browser_variable(variable) || !path.is_absolute() {
        return Err("Invalid pinned browser variable or path".into());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("Cannot inspect the pinned browser executable: {e}. Restore the pinned file, then resume; if the writer cannot launch it, use the candidate acceptance runner."))?;
    if !metadata.file_type().is_file() { return Err("Browser executable must be a regular file".into()); }
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("Cannot resolve browser executable: {e}"))?;
    #[cfg(windows)]
    if !matches!(canonical.components().next(), Some(std::path::Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_))) {
        return Err("Browser executable must be on a local drive".into());
    }
    let bytes = std::fs::read(&canonical).map_err(|e| format!("Cannot read browser executable: {e}"))?;
    let configured = path.to_str().ok_or("Browser path must be Unicode")?;
    let resolved = canonical.to_str().ok_or("Browser path must be Unicode")?;
    Ok(json!({"variable": variable, "path": resolved, "configuredPath": configured, "sha256": sha256_hex(bytes)}))
}

fn shell_environment_set(config: &mut Map<String, Value>) -> Result<&mut Map<String, Value>> {
    const SET: &str = "shell_environment_policy.set";
    const LEAF: &str = "shell_environment_policy.set.";
    let invalid = || GatewayError("shell environment set is not an object".into());
    let leaves: Vec<_> = config.keys().filter(|key| key.starts_with(LEAF)).cloned().collect();
    let mut additions = Map::new();
    for key in leaves {
        additions.insert(key[LEAF.len()..].to_string(), config.remove(&key).unwrap());
    }
    let dotted = config.remove(SET);
    let set = if config.contains_key("shell_environment_policy") {
        config.get_mut("shell_environment_policy").and_then(Value::as_object_mut)
            .ok_or_else(|| GatewayError("shell environment policy is not an object".into()))?
            .entry("set").or_insert_with(|| json!({}))
    } else {
        config.entry(SET).or_insert_with(|| json!({}))
    };
    let set = set.as_object_mut().ok_or_else(invalid)?;
    if let Some(dotted) = dotted {
        set.extend(dotted.as_object().ok_or_else(invalid)?.clone());
    }
    set.extend(additions);
    Ok(set)
}

fn set_shell_variable(set: &mut Map<String, Value>, name: &str, value: Value) {
    if cfg!(windows) {
        set.retain(|existing, _| !existing.eq_ignore_ascii_case(name));
    }
    set.insert(name.into(), value);
}

fn add_writer_cache_root(config: &mut Map<String, Value>, cache: &Path) -> Result<()> {
    const ROOTS: &str = "sandbox_workspace_write.writable_roots";
    let invalid_roots = || GatewayError("writer sandbox writable roots must be an array".into());
    let dotted = match config.remove(ROOTS) {
        Some(Value::Array(roots)) => roots,
        None => Vec::new(),
        Some(_) => return Err(invalid_roots()),
    };
    let roots = if let Some(policy) = config.get_mut("sandbox_workspace_write") {
        let policy = policy.as_object_mut().ok_or_else(|| GatewayError("writer sandbox policy is not an object".into()))?;
        policy.entry("writable_roots").or_insert_with(|| json!([]))
    } else {
        config.entry(ROOTS).or_insert_with(|| json!([]))
    };
    let roots = roots.as_array_mut().ok_or_else(invalid_roots)?;
    let nested = std::mem::take(roots);
    for root in nested.into_iter().chain(dotted).chain([json!(cache)]) {
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    Ok(())
}

fn configure_writer_role(role: &mut Value, writer: Option<&WriterSettings>, browser: Option<&Value>) -> Result<()> {
    let Some(writer) = writer else { return Ok(()) };
    if writer.env.is_empty() && writer.cache.is_none() && browser.is_none() {
        return Ok(());
    }
    let config = role.as_object_mut().ok_or_else(|| GatewayError("writer role is not an object".into()))?
        .entry("config").or_insert_with(|| json!({}));
    let config = config.as_object_mut().ok_or_else(|| GatewayError("writer role config is not an object".into()))?;
    if !writer.env.is_empty() || browser.is_some() {
        let set = shell_environment_set(config)?;
        for (name, value) in &writer.env {
            set_shell_variable(set, name, json!(value));
        }
        if let Some(pin) = browser {
            let variable = pin["variable"].as_str().unwrap_or("");
            set_shell_variable(set, variable, pin["path"].clone());
        }
    }
    if let Some(cache) = &writer.cache {
        add_writer_cache_root(config, cache)?;
    }
    Ok(())
}

/// A step label as a part of a gateway key: "review 2" -> "review-2", "fix 1.1" -> "fix-1.1".
pub fn slug(step: &str) -> String {
    step.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '-' }).collect()
}

/// The base key of a step's attempt: `flow-<run>-<step>`, with `-a<n>` from the second attempt on.
pub fn base_key(run: &str, step: &str, attempt: u32) -> String {
    let key = format!("flow-{run}-{}", slug(step));
    if attempt > 1 { format!("{key}-a{attempt}") } else { key }
}

pub fn summary(final_job: &Value) -> Value {
    json!({ "key": final_job["key"], "status": final_job["status"], "error": final_job["error"], "account": final_job["account"] })
}

fn credit_balances(final_job: &Value) -> Option<Value> {
    let credits = final_job["credits"].as_object()?;
    (credits.get("limitUsedUp").and_then(Value::as_bool) == Some(true)).then(|| {
        Value::Object(["balanceBefore", "balanceAfter"].into_iter()
            .filter_map(|key| credits.get(key).map(|value| (key.to_string(), value.clone())))
            .collect())
    })
}

pub fn credits_report(events: &[Value], round: Option<u64>) -> Option<Value> {
    let balance = |value: &Value| value.as_f64().or_else(|| value.as_str()?.trim().parse::<f64>().ok())
        .filter(|balance| balance.is_finite());
    let mut steps = Vec::new();
    let mut spent = Some(0.0);
    for event in events.iter().filter(|event| matches!(event["kind"].as_str(), Some("done" | "job credits"))) {
        let Some(balances) = event["credits"].as_object() else { continue };
        let recorded_round = event["round"].as_u64().unwrap_or(0);
        // Include the initial write (recorded as round zero) with the first review round.
        if round.is_some_and(|n| n != recorded_round.max(1)) {
            continue;
        }
        let delta = balances.get("balanceBefore").and_then(balance).zip(balances.get("balanceAfter").and_then(balance))
            .map(|(before, after)| before - after).filter(|delta| delta.is_finite() && *delta >= 0.0);
        // Keep the reported balances and leave the total unknown when a balance is absent or went up.
        spent = spent.zip(delta).map(|(total, delta)| total + delta).filter(|total| total.is_finite());
        let mut step = Map::new();
        for field in ["step", "round", "attempt"] {
            step.insert(field.into(), event[field].clone());
        }
        step.extend(balances.clone());
        steps.push(Value::Object(step));
    }
    (!steps.is_empty()).then(|| json!({ "spent": spent, "steps": steps }))
}

pub fn record_safety_block(journal: &mut Journal, step: &str, attempt: u32, key: &str, provider: &str) -> Result<()> {
    if journal.last("safety blocked", step, attempt).is_none() {
        journal.append(json!({
            "kind": "safety blocked", "step": step, "attempt": attempt, "key": key, "provider": provider
        }))?;
    }
    Ok(())
}

pub struct Call<'a> {
    pub id: &'a str,
    pub step: &'a str,
    pub round: u32,
    pub role: &'a str,
    pub pick: &'a Pick,
    pub schema: &'a Value,
    pub prompt: String,
    pub writer_workspace: Option<&'a Path>,
}

pub enum CallError {
    Stop { at: String, reason: String },
    Context { bytes: usize },
}

pub struct Decision<'a> {
    pub role: &'a Value,
    pub image: PathBuf,
    pub sha256: &'a str,
}

pub fn ask(journal: &mut Journal, cfg: &Config, call: Call<'_>, validate: impl Fn(&Value) -> std::result::Result<(), String>) -> std::result::Result<Value, CallError> {
    ask_normalizing(journal, cfg, call, |data| validate(data))
}

pub fn ask_without_resubmission(journal: &mut Journal, cfg: &Config, call: Call<'_>, validate: impl Fn(&Value) -> std::result::Result<(), String>) -> std::result::Result<Value, CallError> {
    run_call(journal, cfg, call, None, None, None, &[], None, None, false, |data| validate(data))
        .map(Step::completed)
}

pub fn ask_normalizing(
    journal: &mut Journal,
    cfg: &Config,
    call: Call<'_>,
    validate: impl Fn(&mut Value) -> std::result::Result<(), String>,
) -> std::result::Result<Value, CallError> {
    ask_with(journal, cfg, call, None, None, None, &[], validate)
}

pub fn ask_budgeted(journal: &mut Journal, cfg: &Config, call: Call<'_>, budget: Option<Budget>, browser: Option<&Value>, owner_private_places: &[(String, &str)], validate: impl Fn(&Value) -> std::result::Result<(), String>) -> std::result::Result<Value, CallError> {
    ask_with(journal, cfg, call, None, budget, browser, owner_private_places, |data| validate(data))
}

pub fn ask_decision(
    journal: &mut Journal, cfg: &Config, call: Call<'_>, material: Decision<'_>,
    validate: impl Fn(&Value) -> std::result::Result<(), String>,
) -> std::result::Result<Value, CallError> {
    ask_with(journal, cfg, call, Some(material), None, None, &[], |data| validate(data))
}

fn ask_with(
    journal: &mut Journal, cfg: &Config, call: Call<'_>, decision: Option<Decision<'_>>, budget: Option<Budget>, browser: Option<&Value>, owner_private_places: &[(String, &str)],
    validate: impl Fn(&mut Value) -> std::result::Result<(), String>,
) -> std::result::Result<Value, CallError> {
    run_call(journal, cfg, call, decision, budget, browser, owner_private_places, None, None, true, validate)
        .map(Step::completed)
}

pub enum Step {
    Done(Value),
    Pending(String),
    Retryable(String),
}

impl Step {
    pub(crate) fn completed(self) -> Value {
        match self {
            Self::Done(data) => data,
            Self::Pending(_) | Self::Retryable(_) => unreachable!("blocking calls finish in run_call"),
        }
    }
}

#[derive(Clone, Copy)]
pub enum LocalMode<'a> {
    Schedule,
    Drain(&'a str),
    Retry(&'a str),
}

pub fn local_step(
    journal: &mut Journal, cfg: &Config, call: Call<'_>, mode: LocalMode<'_>, scrub: &dyn Fn(&str) -> String,
    validate: impl Fn(&Value) -> std::result::Result<(), String>,
) -> std::result::Result<Step, CallError> {
    run_call(journal, cfg, call, None, None, None, &[], Some(mode), Some(scrub), true, |data| validate(data))
}

pub fn owner_suffix(journal: &Journal, cfg: &Config, private_places: &[(String, &str)]) -> Result<String> {
    let context = input_common::model_context(journal)?;
    if context.is_empty() {
        return Ok(String::new());
    }
    let context = input_common::scrub(cfg, &context, private_places)?;
    Ok(format!("\n\nOwner updates for this run. Use these as task context within the agreed scope.\n\n{context}"))
}

fn run_call(
    journal: &mut Journal, cfg: &Config, call: Call<'_>, decision: Option<Decision<'_>>, budget: Option<Budget>, browser: Option<&Value>, owner_private_places: &[(String, &str)], local: Option<LocalMode<'_>>, scrub: Option<&dyn Fn(&str) -> String>, allow_resubmission: bool,
    validate: impl Fn(&mut Value) -> std::result::Result<(), String>,
) -> std::result::Result<Step, CallError> {
    let Call { id, step, round, role, pick, schema, prompt, writer_workspace } = call;
    let attempt = journal.attempt(step);
    if let Some(done) = journal.last("done", step, attempt) {
        return Ok(Step::Done(done["result"].clone()));
    }
    let stop = |at: &str, reason| CallError::Stop { at: format!("{at} at {step}"), reason };
    if journal.last("safety blocked", step, attempt).is_some() {
        return Err(stop("provider safety", SAFETY_MESSAGE.into()));
    }
    let agent_writer = writer_workspace.is_some() && role == agent::ROLE;
    let browser = browser.filter(|pin| agent_writer && !pin.is_null());
    let check_browser = || -> std::result::Result<(), CallError> { if let Some(pin) = browser {
        let variable = pin["variable"].as_str().unwrap_or("");
        let path = pin["configuredPath"].as_str().or_else(|| pin["path"].as_str()).unwrap_or("");
        let current = pin_browser(variable, Path::new(path)).map_err(|e| stop("browser prerequisite", e))?;
        if current["path"] != pin["path"] || current["sha256"] != pin["sha256"] { return Err(stop("browser prerequisite", "The pinned browser executable changed; restore it before resuming.".into())); }
    } Ok(()) };
    let infra = |error: GatewayError| stop("infrastructure", error.0);
    let reserve = |journal: &Journal| {
        if budget.is_some_and(|budget| budget.exhausted(journal)) {
            return Err(stop("budget", "The package budget for new model calls is exhausted.".into()));
        }
        Ok(())
    };
    let exec: Box<dyn executor::Executor> = if decision.is_some() || local.is_some() {
        Box::new(executor::local::LocalGateway::new(cfg.clone()))
    } else if let Some(root) = writer_workspace {
        let mut cfg = cfg.clone();
        cfg.root = Some(root.to_path_buf());
        cfg.jobs_dir = Some(root.join(".agent-tmp/gateway"));
        Box::new(executor::local::LocalGateway::new(cfg))
    } else {
        executor::for_pick(cfg, pick).map_err(|reason| stop("infrastructure", reason))?
    };
    let base = base_key(id, step, attempt);
    let intents = journal.all("intent", step, attempt);
    if let Some(LocalMode::Drain(expected) | LocalMode::Retry(expected)) = local {
        if intents.last().and_then(|row| row["key"].as_str()) != Some(expected) {
            return Err(stop("unknown outcome", format!("the active intent does not match job {expected}")));
        }
    }
    let mut retries = intents.len().saturating_sub(1) as u32;
    let file = format!("requests/{}.json", slug(&base));
    let (mut key, stored, mut fresh) = if let Some(last) = intents.last() {
        let key = last["key"].as_str().unwrap_or("");
        let name = last["request"].as_str().unwrap_or("");
        let stored = journal.read_value(name).filter(|request| last["digest"] == sha256_hex(request.to_string()));
        let Some(stored) = stored else {
            return Err(stop("unknown outcome", format!("the stored request {name} of key {key} is missing or does not match its intent")));
        };
        if last["executor"] != exec.name() {
            return Err(stop("infrastructure", format!("job {key} uses {}; restore that executor to inspect its outcome", last["executor"])));
        }
        (key.to_string(), stored, false)
    } else {
        reserve(journal)?;
        check_browser()?;
        let writer = agent_writer.then(|| {
            let run = journal.read_value("run.json").ok_or_else(|| GatewayError("The run pin is missing.".into()))?;
            let variable = browser.and_then(|pin| pin["variable"].as_str());
            WriterSettings::from_pin(&run["verificationPlan"], variable)
        }).transpose().map_err(infra)?;
        let suffix = owner_suffix(journal, cfg, owner_private_places).map_err(infra)?;
        let mut prompt = prompt;
        if let Some(writer) = writer.as_ref().filter(|writer| !writer.env.is_empty()) {
            let scrubber = input_common::Scrubber::new(cfg).map_err(infra)?;
            agent::describe_writer_environment(&mut prompt, writer, &scrubber, owner_private_places);
        }
        prompt.push_str(&suffix);
        let prompt = match scrub {
            Some(scrub) => scrub(&prompt),
            None => prompt,
        };
        if prompt.len() > LIMIT_PROMPT {
            return Err(CallError::Context { bytes: prompt.len() });
        }
        let mut stored = if let Some(material) = &decision {
            json!({ "role": material.role, "prompt": prompt, "decisionsImage": { "file": material.image, "sha256": material.sha256 } })
        } else {
            // The writable export is the execution root. Local role overrides belong to the project.
            let mut request_role = if writer_workspace.is_some() {
                executor::local::LocalGateway::new(cfg.clone()).role(role, pick, schema)
            } else {
                exec.role(role, pick, schema)
            }.map_err(infra)?;
            configure_writer_role(&mut request_role, writer.as_ref(), browser).map_err(infra)?;
            if let Some(writer) = &writer {
                agent::create_writer_cache(writer).map_err(infra)?;
            }
            json!({ "role": request_role, "prompt": prompt })
        };
        if stored["role"]["mode"] == "work" {
            stored["keepThread"] = json!(false);
        }
        if exec.name() == "local-gateway" && executor::flow_credits(cfg) {
            stored["credits"] = json!(true);
        }
        journal.write_value(&file, &stored).map_err(infra)?;
        journal.append(json!({
            "kind": "intent", "step": step, "round": round, "attempt": attempt, "effect": "gateway job",
            "digest": sha256_hex(stored.to_string()), "key": base, "request": file,
            "role": role, "model": pick.model, "effort": pick.effort, "executor": exec.name(),
        })).map_err(infra)?;
        (base.clone(), stored, true)
    };
    loop {
        if fresh {
            eprintln!("{id}: {step} · {}/{} {} · {key}", pick.provider, pick.model, pick.effort);
            let created = exec.submit(&key, &stored).map_err(infra)?;
            crate::boundary::cut(&format!("submit {step}"));
            journal.append(json!({ "kind": "submitted", "step": step, "attempt": attempt, "key": key, "created": created })).map_err(infra)?;
        } else if !exec.exists(&key) {
            let submitted = journal.events().iter().any(|e| e["kind"] == "submitted" && e["key"] == key);
            let reason = if submitted {
                format!("the job {key} was submitted and its folder is gone")
            } else {
                format!("the job {key} has an intent but neither a submitted record nor a job folder")
            };
            return Err(stop("unknown outcome", reason));
        }
        if matches!(local, Some(LocalMode::Schedule)) || (fresh && matches!(local, Some(LocalMode::Retry(_)))) {
            return Ok(Step::Pending(key));
        }
        let fin = exec.wait_final(&key).map_err(infra)?;
        let status = fin["status"].as_str().unwrap_or("");
        let timed_out_writer = writer_workspace.is_some() && status == "timeout" && fin["turnStartedAt"].is_string();
        let credits = if exec.name() == "local-gateway" && pick.provider == "codex"
            && matches!(role, agent::ROLE | WRITER_GATEWAY_ROLE | REVIEWER_GATEWAY_ROLE)
        {
            credit_balances(&fin)
        } else {
            None
        };
        let record_credits_without_result = |journal: &mut Journal| -> Result<()> {
            if let Some(credits) = &credits {
                if !journal.events().iter().any(|event| event["kind"] == "job credits" && event["key"] == key) {
                    journal.append(json!({ "kind": "job credits", "step": step, "round": round, "attempt": attempt, "key": key, "credits": credits }))?;
                }
            }
            Ok(())
        };
        if status != "succeeded" && !timed_out_writer {
            record_credits_without_result(journal).map_err(infra)?;
        }
        if status == SAFETY_BLOCKED {
            record_safety_block(journal, step, attempt, &key, &pick.provider).map_err(infra)?;
            return Err(stop("provider safety", SAFETY_MESSAGE.into()));
        }
        let data = if status == "succeeded" {
            let mut data = fin["result"]["data"].clone();
            if decision.is_some() && data.is_object() {
                data["inputTokens"] = fin["tokens"]["inputTokens"].clone();
            }
            if let Err(reason) = validate(&mut data) {
                record_credits_without_result(journal).map_err(infra)?;
                return Err(stop("invalid answer", format!("the answer of job {key} does not hold: {reason}")));
            }
            data
        } else if timed_out_writer {
            json!({ "status": "more", "summary": "The writer's turn timed out. Inspect the private workspace for edits written before the timeout.", "questions": [] })
        } else if allow_resubmission && exec.died_before_turn(&fin) && retries < 2 {
            if matches!(local, Some(LocalMode::Drain(_))) {
                return Ok(Step::Retryable(key));
            }
            if let Some(scrub) = scrub {
                let prompt = stored["prompt"].as_str()
                    .ok_or_else(|| stop("privacy", "The saved request has no prompt to check before retry.".into()))?;
                if scrub(prompt) != prompt.lines().collect::<Vec<_>>().join("\n") {
                    return Err(stop("privacy", "The saved request is covered by a newer privacy rule. Start a fresh round for a new request.".into()));
                }
            }
            reserve(journal)?;
            check_browser()?;
            retries += 1;
            key = format!("{base}-r{}", retries + 1);
            journal.append(json!({
                "kind": "intent", "step": step, "round": round, "attempt": attempt, "effect": "gateway job",
                "digest": sha256_hex(stored.to_string()), "key": key, "request": file,
                "role": role, "model": pick.model, "effort": pick.effort,
                "after": summary(&fin), "executor": exec.name(),
            })).map_err(infra)?;
            fresh = true;
            continue;
        } else {
            let kind = if status == "unknown" { "unknown outcome".to_string() } else { format!("gateway {status}") };
            return Err(stop(&kind, format!("job {key}: {}", fin["error"].as_str().unwrap_or(status))));
        };
        let mut done = json!({ "kind": "done", "step": step, "round": round, "attempt": attempt, "result": data });
        if let Some(credits) = credits {
            done["credits"] = credits;
        }
        journal.append(done).map_err(infra)?;
        return Ok(Step::Done(data));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_config_merges_the_environment_and_appends_only_the_writer_cache() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR"));
        let cache = home.join("flow-cache/repo/writer");
        let existing = home.join("existing");
        let mut role = json!({ "mode": "work", "config": {
            "model_context_window": 272000,
            "shell_environment_policy.set": { "EXISTING": "kept", "CARGO_BUILD_JOBS": "2" },
            "shell_environment_policy.set.OTHER": "also kept",
            "sandbox_workspace_write.writable_roots": [existing],
        }});
        let settings = WriterSettings {
            env: [("CARGO_BUILD_JOBS".into(), "4".into()), ("APP_TEST_CHROME".into(), "other".into())].into(),
            cache: Some(cache.clone()),
        };
        let pin = json!({ "variable": "APP_TEST_CHROME", "path": "pinned-browser" });

        for _ in 0..2 {
            configure_writer_role(&mut role, Some(&settings), Some(&pin)).unwrap();
        }
        assert_eq!(role["config"]["shell_environment_policy.set"], json!({
            "EXISTING": "kept", "CARGO_BUILD_JOBS": "4", "OTHER": "also kept", "APP_TEST_CHROME": "pinned-browser",
        }));
        assert_eq!(role["config"]["sandbox_workspace_write.writable_roots"], json!([existing, cache]));
        assert_eq!(role["config"]["model_context_window"], 272000);
    }

    #[test]
    fn writer_cache_root_preserves_a_nested_sandbox_policy() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR"));
        let existing = home.join("existing");
        let cache = home.join("flow-cache/repo/writer");
        let mut role = json!({ "config": { "sandbox_workspace_write": {
            "writable_roots": [existing], "network_access": false,
        }}});
        let settings = WriterSettings { env: [("CARGO_BUILD_JOBS".into(), "4".into())].into(), cache: None };
        configure_writer_role(&mut role, Some(&settings), None).unwrap();
        assert_eq!(role["config"]["sandbox_workspace_write"]["writable_roots"], json!([existing]));

        let settings = WriterSettings { cache: Some(cache.clone()), ..settings };
        configure_writer_role(&mut role, Some(&settings), None).unwrap();
        assert_eq!(role["config"]["sandbox_workspace_write"], json!({
            "writable_roots": [existing, cache], "network_access": false,
        }));
        assert!(role["config"].get("sandbox_workspace_write.writable_roots").is_none());
    }

    #[test]
    fn writer_cache_root_merges_nested_and_dotted_roots() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR"));
        let nested = home.join("nested");
        let dotted = home.join("dotted");
        let cache = home.join("flow-cache/repo/writer");
        let mut role = json!({ "config": {
            "sandbox_workspace_write": {
                "writable_roots": [nested], "network_access": false,
            },
            "sandbox_workspace_write.writable_roots": [dotted, nested],
        }});
        let settings = WriterSettings { cache: Some(cache.clone()), ..WriterSettings::default() };

        for _ in 0..2 {
            configure_writer_role(&mut role, Some(&settings), None).unwrap();
        }
        assert_eq!(role["config"], json!({ "sandbox_workspace_write": {
            "writable_roots": [nested, dotted, cache], "network_access": false,
        }}));
    }
}
