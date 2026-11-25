//! A model step records its exact request before submission, then reattaches to its recorded job by key.

use crate::{budget::Budget, executor::{self, Executor}, input, journal::Journal, models::Pick};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use zodchi_core::{appserver::{SAFETY_BLOCKED, SAFETY_MESSAGE}, config::Config, job::LIMIT_PROMPT, util::{sha256_hex, GatewayError, Result}};

pub(crate) fn pin_browser(variable: &str, path: &Path) -> std::result::Result<Value, String> {
    if !["ZODCHI_ACCEPTANCE_CHROMIUM", "WB_TEST_CHROME"].contains(&variable) || !path.is_absolute() {
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

pub(crate) fn record_safety_block(journal: &mut Journal, step: &str, attempt: u32, key: &str, provider: &str) -> Result<()> {
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

pub(crate) struct Decision<'a> {
    pub role: &'a Value,
    pub image: PathBuf,
    pub sha256: &'a str,
}

pub fn ask(journal: &mut Journal, cfg: &Config, call: Call<'_>, validate: impl Fn(&Value) -> std::result::Result<(), String>) -> std::result::Result<Value, CallError> {
    ask_normalizing(journal, cfg, call, |data| validate(data))
}

pub(crate) fn ask_without_resubmission(journal: &mut Journal, cfg: &Config, call: Call<'_>, validate: impl Fn(&Value) -> std::result::Result<(), String>) -> std::result::Result<Value, CallError> {
    ask_with(journal, cfg, call, None, None, None, &[], false, |data| validate(data))
}

pub(crate) fn ask_normalizing(
    journal: &mut Journal,
    cfg: &Config,
    call: Call<'_>,
    validate: impl Fn(&mut Value) -> std::result::Result<(), String>,
) -> std::result::Result<Value, CallError> {
    ask_with(journal, cfg, call, None, None, None, &[], true, validate)
}

pub(crate) fn ask_budgeted(journal: &mut Journal, cfg: &Config, call: Call<'_>, budget: Option<Budget>, browser: Option<&Value>, owner_private_places: &[(String, &str)], validate: impl Fn(&Value) -> std::result::Result<(), String>) -> std::result::Result<Value, CallError> {
    ask_with(journal, cfg, call, None, budget, browser, owner_private_places, true, |data| validate(data))
}

pub(crate) fn ask_decision(
    journal: &mut Journal, cfg: &Config, call: Call<'_>, material: Decision<'_>,
    validate: impl Fn(&Value) -> std::result::Result<(), String>,
) -> std::result::Result<Value, CallError> {
    ask_with(journal, cfg, call, Some(material), None, None, &[], true, |data| validate(data))
}

fn ask_with(
    journal: &mut Journal, cfg: &Config, call: Call<'_>, decision: Option<Decision<'_>>, budget: Option<Budget>, browser: Option<&Value>, owner_private_places: &[(String, &str)], resubmit: bool,
    validate: impl Fn(&mut Value) -> std::result::Result<(), String>,
) -> std::result::Result<Value, CallError> {
    let Call { id, step, round, role, pick, schema, prompt, writer_workspace } = call;
    let attempt = journal.attempt(step);
    if let Some(done) = journal.last("done", step, attempt) {
        return Ok(done["result"].clone());
    }
    let stop = |at: &str, reason| CallError::Stop { at: format!("{at} at {step}"), reason };
    if journal.last("safety blocked", step, attempt).is_some() {
        return Err(stop("provider safety", SAFETY_MESSAGE.into()));
    }
    let check_browser = || -> std::result::Result<(), CallError> { if let Some(pin) = browser.filter(|v| !v.is_null()) {
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
    let exec: Box<dyn executor::Executor> = if decision.is_some() {
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
        let context = input::model_context(journal).map_err(infra)?;
        let prompt = if context.is_empty() { prompt } else {
            let context = input::scrub(cfg, &context, owner_private_places).map_err(infra)?;
            format!("{prompt}\n\nOwner updates for this run. Use these as task context within the agreed scope.\n\n{context}")
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
            if let Some(pin) = browser.filter(|v| !v.is_null()) {
                let variable = pin["variable"].as_str().unwrap_or("");
                let config = request_role.as_object_mut().ok_or_else(|| stop("infrastructure", "writer role is not an object".into()))?
                    .entry("config").or_insert_with(|| json!({}));
                let config = config.as_object_mut().ok_or_else(|| stop("infrastructure", "writer role config is not an object".into()))?;
                let leaves: Vec<_> = config.keys().filter(|k| k.starts_with("shell_environment_policy.set.")).cloned().collect();
                let mut additions = serde_json::Map::new();
                for key in leaves {
                    let name = key.trim_start_matches("shell_environment_policy.set.").to_string();
                    additions.insert(name, config.remove(&key).unwrap());
                }
                let dotted = config.remove("shell_environment_policy.set");
                let set = if let Some(policy) = config.get_mut("shell_environment_policy") {
                    policy.as_object_mut().ok_or_else(|| stop("infrastructure", "shell environment policy is not an object".into()))?
                        .entry("set").or_insert_with(|| json!({}))
                } else {
                    config.entry("shell_environment_policy.set").or_insert_with(|| json!({}))
                };
                let set = set.as_object_mut().ok_or_else(|| stop("infrastructure", "shell environment set is not an object".into()))?;
                if let Some(dotted) = dotted {
                    set.extend(dotted.as_object().ok_or_else(|| stop("infrastructure", "shell environment set is not an object".into()))?.clone());
                }
                set.extend(additions);
                if cfg!(windows) {
                    set.retain(|name, _| !name.eq_ignore_ascii_case(variable));
                }
                set.insert(variable.into(), pin["path"].clone());
            }
            json!({ "role": request_role, "prompt": prompt })
        };
        if stored["role"]["mode"] == "work" {
            stored["keepThread"] = json!(false);
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
            crate::code_package::cut(&format!("submit {step}"));
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
        let fin = exec.wait_final(&key).map_err(infra)?;
        let status = fin["status"].as_str().unwrap_or("");
        if status == SAFETY_BLOCKED {
            record_safety_block(journal, step, attempt, &key, &pick.provider).map_err(infra)?;
            return Err(stop("provider safety", SAFETY_MESSAGE.into()));
        }
        let data = if status == "succeeded" {
            let mut data = fin["result"]["data"].clone();
            if decision.is_some() && data.is_object() {
                data["inputTokens"] = fin["tokens"]["inputTokens"].clone();
            }
            validate(&mut data).map_err(|reason| stop("invalid answer", format!("the answer of job {key} does not hold: {reason}")))?;
            data
        } else if writer_workspace.is_some() && status == "timeout" && fin["turnStartedAt"].is_string() {
            json!({ "status": "more", "summary": "The writer's turn timed out. Inspect the private workspace for edits written before the timeout.", "questions": [] })
        } else if resubmit && exec.died_before_turn(&fin) && retries < 2 {
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
        journal.append(json!({ "kind": "done", "step": step, "round": round, "attempt": attempt, "result": data })).map_err(infra)?;
        return Ok(data);
    }
}
