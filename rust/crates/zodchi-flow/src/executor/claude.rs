//! Claude as an executor of a model step: `claude -p` of the Claude Code CLI on this machine, signed in with the
//! person's own Claude subscription. It runs only when the person enabled it (`"claude": true` in
//! `~/.zodchi/flow.json`, read by the pair resolver) and never through a server or with an API key.
//!
//! The call: the step's prompt on stdin with the role's frame and the step's JSON Schema, `--model` and `--effort`
//! of the pinned pick, no tools (`--tools ""`), no MCP servers (`--strict-mcp-config` with none given), no hooks,
//! skills, plugins or CLAUDE.md (`--safe-mode`, `disableAllHooks`), no session kept, `--output-format json`, a
//! wall-clock limit (the role's `timeoutMin`), and an environment without `ANTHROPIC_*` variables, so the call can
//! only use the subscription Claude Code is signed in with. The engine reads the final message itself and checks it
//! against the schema.
//!
//! The run is bound at the gate to the account Claude Code is signed in with (a digest, `Pick::account`); right
//! before each call the opt-in and that account are checked again, and a call that does not match is refused with
//! nothing sent. A call counts only with a valid answer and a clean exit of the program.
//!
//! A job of a key is a folder in the run's journal (`flows/<run>/claude/<key>/`): `job.json` before anything starts,
//! with `turnStartedAt` written and synced before the program is started, the raw output (`raw.json`) and
//! `final.json` after; the folder entries are synced with the files. The folder is created exclusively, so a key is
//! called at most once; a folder without `job.json` was reserved and never started; a folder with `turnStartedAt`
//! and no `final.json` is a call that may have run, an unknown outcome, never called again by itself.

use serde_json::{json, Value};
use std::{fs, io::{self, Write}, path::{Path, PathBuf}, time::Duration};
use zodchi_core::config::Config;
use zodchi_core::job::LIMIT_PROMPT;
use zodchi_core::role::{check_role, load_role, Overrides};
use zodchi_core::util::{fail, is_key, iso, read_stored, sha256_hex, write_json_atomic, GatewayError, Result};

use super::Executor;
use crate::{gateway::{self, CallError}, journal::Journal};
use crate::models::{claude_enabled, Pick};
pub use zodchi_core::claude::{call, find_program, message, signed_in, version, Program, Sent};

const RUN_ID_LEN: usize = 22; // "20261118-120000-abcdef"
/// The field of a stored Claude role that carries the account the run was bound to at the gate.
const ROLE_ACCOUNT: &str = "claudeAccount";

/// Research screens the complete prompt, including owner updates, against both the current and
/// pinned privacy rules. Its local scheduler submits to Codex only. Prepare the screened Claude
/// request here, then let the common gateway code consume the intent, receipt and validated answer.
pub(crate) fn ask_screened(
    journal: &mut Journal,
    cfg: &Config,
    call: gateway::Call<'_>,
    scrub: &dyn Fn(&str) -> String,
    allow_retry: bool,
    validate: impl Fn(&Value) -> std::result::Result<(), String>,
) -> std::result::Result<Value, CallError> {
    let step = call.step;
    let attempt = journal.attempt(step);
    let stop = |at, reason| CallError::Stop { at: format!("{at} at {step}"), reason };
    let infra = |error: GatewayError| stop("infrastructure", error.0);
    let exec = Claude::new(cfg.clone());
    let intents = journal.all("intent", step, attempt);
    if journal.last("done", step, attempt).is_none() && journal.last("safety blocked", step, attempt).is_none() {
        if let Some(intent) = intents.last() {
            // A receipt for a started turn can always be read. Only unsent requests that
            // the gateway is eligible to retry need to pass the privacy rules again.
            let key = intent["key"].as_str().unwrap_or("");
            if allow_retry && intents.len() < 3 && intent["executor"] == exec.name()
                && exec.exists(key) && exec.wait_final(key).is_ok_and(|fin| exec.died_before_turn(&fin))
            {
                if let Some(stored) = intent["request"].as_str().and_then(|file| journal.read_value(file))
                    .filter(|stored| intent["digest"] == sha256_hex(stored.to_string()))
                {
                    let prompt = stored["prompt"].as_str()
                        .ok_or_else(|| stop("privacy", "The saved request has no prompt to check before retry.".into()))?;
                    if scrub(prompt) != prompt.lines().collect::<Vec<_>>().join("\n") {
                        return Err(stop("privacy", "The saved request is covered by a newer privacy rule. Start a fresh round for a new request.".into()));
                    }
                }
            }
        } else {
            let suffix = gateway::owner_suffix(journal, cfg, &[]).map_err(infra)?;
            let prompt = scrub(&format!("{}{suffix}", call.prompt));
            // Flow's journaled text requests share this byte limit with the Codex gateway.
            if prompt.len() > LIMIT_PROMPT {
                return Err(CallError::Context { bytes: prompt.len() });
            }
            let request_role = exec.role(call.role, call.pick, call.schema).map_err(infra)?;
            let stored = json!({ "role": request_role, "prompt": prompt });
            let key = gateway::base_key(call.id, step, attempt);
            let file = format!("requests/{}.json", gateway::slug(&key));
            journal.write_value(&file, &stored).map_err(infra)?;
            journal.append(json!({
                "kind": "intent", "step": step, "round": call.round, "attempt": attempt, "effect": "gateway job",
                "digest": sha256_hex(stored.to_string()), "key": key, "request": file,
                "role": call.role, "model": call.pick.model, "effort": call.pick.effort, "executor": exec.name(),
            })).map_err(infra)?;
            eprintln!("{}: {step} · {}/{} {} · {key}", call.id, call.pick.provider, call.pick.model, call.pick.effort);
            let created = exec.submit(&key, &stored).map_err(infra)?;
            cut(&format!("submit {step}"));
            journal.append(json!({ "kind": "submitted", "step": step, "attempt": attempt, "key": key, "created": created })).map_err(infra)?;
        }
    }
    if allow_retry {
        gateway::ask(journal, cfg, call, validate)
    } else {
        gateway::ask_without_resubmission(journal, cfg, call, validate)
    }
}

/// Makes the entries of a folder durable: a folder made in it, a file renamed into it. A file system that cannot
/// sync a folder (an error of that kind) is taken as it is. On Windows a folder is opened for writing to be flushed;
/// NTFS journals its entries, so a folder that refuses this is taken as it is too.
fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(windows)]
    let opened = {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new().write(true).custom_flags(0x0200_0000).open(dir) // FILE_FLAG_BACKUP_SEMANTICS
    };
    #[cfg(not(windows))]
    let opened = fs::File::open(dir);
    let synced = opened.and_then(|f| f.sync_all());
    match synced {
        Err(e) if cfg!(windows) || matches!(e.kind(), io::ErrorKind::InvalidInput | io::ErrorKind::Unsupported) => Ok(()),
        other => other,
    }
}

/// Writes a JSON file whole and makes it and its folder entry durable before the next step.
fn write_synced(file: &Path, value: &Value) -> Result<()> {
    write_json_atomic(file, value)?;
    fs::OpenOptions::new().write(true).open(file)?.sync_all()?;
    if let Some(dir) = file.parent() {
        sync_dir(dir)?;
    }
    Ok(())
}

/// Writes a file and syncs its content; its folder entry is synced with the next `write_synced` in that folder.
fn write_bytes_synced(file: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut f = fs::File::create(file)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// A test cut of the engine (`ZODCHI_FLOW_CUT`, as in `code_package`): the process ends right here.
fn cut(point: &str) {
    if std::env::var("ZODCHI_FLOW_CUT").ok().as_deref() == Some(point) {
        eprintln!("zodchi flow: cut after {point} (ZODCHI_FLOW_CUT)");
        std::process::exit(crate::CUT_EXIT);
    }
}

pub struct Claude {
    cfg: Config,
}

impl Claude {
    pub fn new(cfg: Config) -> Claude {
        Claude { cfg }
    }

    /// The folder of a key's job: in the journal of its run when the key names one (`flow-<run id>-<step>`),
    /// otherwise under `claude-jobs/` of the zodchi home.
    pub fn job_dir(&self, key: &str) -> PathBuf {
        if let Some(run) = key.strip_prefix("flow-").and_then(|rest| rest.get(..RUN_ID_LEN).filter(|_| rest.as_bytes().get(RUN_ID_LEN) == Some(&b'-'))) {
            let journal = self.cfg.home.join("flows").join(run);
            if journal.join("run.json").is_file() {
                return journal.join("claude").join(key);
            }
        }
        self.cfg.home.join("claude-jobs").join(key)
    }
}

fn ended(key: &str, status: &str, error: &str, turn: &Value, account: &Value) -> Value {
    json!({ "key": key, "executor": "claude", "status": status, "error": error, "account": account, "turnStartedAt": turn, "finishedAt": iso() })
}

/// The final state of the job in `dir`. The call ran in the foreground of `submit`, so a job without `final.json`
/// was left by a process that ended: with no `job.json` the key was only reserved and nothing started; before the
/// program started it failed with nothing sent; after, the call may have run and its outcome is unknown.
fn final_state(dir: &Path, key: &str) -> Result<Value> {
    if let Some(fin) = read_stored(&dir.join("final.json")) {
        return Ok(fin);
    }
    if !dir.is_dir() {
        return Err(GatewayError(format!("No Claude job {key}")));
    }
    let file = dir.join("job.json");
    if !file.exists() {
        return Ok(ended(key, "failed", "the process of the call ended after reserving the key and before recording the job: claude was not started", &Value::Null, &Value::Null));
    }
    let Some(job) = read_stored(&file) else {
        return Ok(ended(key, "unknown", "the job record of the call cannot be read: the call may have run", &Value::Null, &Value::Null));
    };
    if job.get("turnStartedAt").is_none_or(Value::is_null) {
        return Ok(ended(key, "failed", "the process of the call ended before claude was started", &Value::Null, &job["account"]));
    }
    Ok(ended(key, "unknown", "the process of the call ended after claude was started and before its answer was saved: the call may have run", &job["turnStartedAt"], &job["account"]))
}

impl Claude {
    /// Whether this call may go out now, checked right before it: Claude is still enabled on this machine and Claude
    /// Code is signed in with the account the run was bound to at the gate. The binding, or why nothing is sent.
    fn authorized(&self, p: &Program, cwd: &Path, role: &Value) -> std::result::Result<String, String> {
        if !claude_enabled(&self.cfg) {
            return Err("Claude is no longer enabled as an executor (\"claude\": true in ~/.zodchi/flow.json): nothing was sent".into());
        }
        let bound = role[ROLE_ACCOUNT].as_str().unwrap_or("");
        if bound.is_empty() {
            return Err("the request names no Claude account bound at the gate: nothing was sent".into());
        }
        let now = signed_in(p, cwd).map_err(|why| format!("{why}: nothing was sent"))?;
        if now != bound {
            return Err(format!("Claude Code is signed in with another account ({now}) than the one this run was bound to at the gate ({bound}): nothing was sent"));
        }
        Ok(now)
    }
}

impl Executor for Claude {
    /// The installed role with the pinned model and effort and the schema of this version: its frame and time limit
    /// are the call's. It carries the account the run was bound to at the gate, checked before each call.
    fn role(&self, name: &str, pick: &Pick, schema: &Value) -> Result<Value> {
        let mut role = load_role(&self.cfg, name, &Overrides { model: Some(pick.model.clone()), effort: Some(pick.effort.clone()), ..Default::default() })?;
        role["outputSchema"] = schema.clone();
        let mut role = check_role(&role)?;
        role[ROLE_ACCOUNT] = json!(pick.account);
        Ok(role)
    }

    /// Calls Claude once for `key`, in the foreground: the job folder is created exclusively (a key that has one is
    /// never called again: false) and synced into its parent, `job.json` is synced before the program starts and
    /// `final.json` after it ended. A call the opt-in or the account no longer allows ends `refused`, nothing sent.
    fn submit(&self, key: &str, stored: &Value) -> Result<bool> {
        if !is_key(key) {
            return fail(format!("not a job key: {key:?}"));
        }
        if !stored["decisionsImage"].is_null() {
            return fail("The Claude executor does not send images.");
        }
        let dir = self.job_dir(key);
        let parent = dir.parent().map(Path::to_path_buf).unwrap_or_default();
        if !parent.is_dir() {
            fs::create_dir_all(&parent)?;
            if let Some(up) = parent.parent() {
                sync_dir(up)?;
            }
        }
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
            Err(e) => return Err(e.into()),
        }
        sync_dir(&parent)?;
        cut("claude reserved");
        let role = &stored["role"];
        let model = role["model"].as_str().unwrap_or("").to_string();
        let effort = role["effort"].as_str().unwrap_or("medium").to_string();
        let minutes = role["timeoutMin"].as_f64().filter(|m| m.is_finite() && *m > 0.0).unwrap_or(30.0);
        let bound = role[ROLE_ACCOUNT].clone();
        let mut job = json!({ "key": key, "executor": "claude", "model": model, "effort": effort, "timeoutMin": minutes,
            "account": bound, "status": "starting", "createdAt": iso(), "pid": std::process::id() });
        write_synced(&dir.join("job.json"), &job)?;
        let fin = match find_program() {
            Err(why) => ended(key, "failed", &why, &Value::Null, &bound),
            Ok(program) => match self.authorized(&program, &dir, role) {
                Err(why) => ended(key, "refused", &why, &Value::Null, &bound),
                Ok(account) => {
                    let account = json!(account);
                    let text = message(role["instructions"].as_str().unwrap_or(""), stored["prompt"].as_str().unwrap_or(""), &role["outputSchema"]);
                    let turn = iso();
                    let job_file = dir.join("job.json");
                    let started = || {
                        job["status"] = json!("running");
                        job["turnStartedAt"] = json!(turn);
                        write_synced(&job_file, &job)
                    };
                    let outcome = call(&program, &dir, &model, &effort, &text, &role["outputSchema"], Duration::from_secs_f64(minutes * 60.0), started);
                    let raw = match &outcome {
                        Ok((_, raw)) => Some(raw.clone()),
                        Err((Sent::Yes | Sent::TimedOut, _, raw)) => Some(raw.clone()),
                        Err((Sent::No, _, _)) => None,
                    };
                    if let Some(raw) = raw {
                        write_bytes_synced(&dir.join("raw.json"), raw.as_bytes())?;
                    }
                    match outcome {
                        Ok((data, _)) => {
                            let mut fin = ended(key, "succeeded", "", &json!(turn), &account);
                            fin["error"] = Value::Null;
                            fin["result"] = json!({ "data": data });
                            fin
                        }
                        Err((Sent::TimedOut, why, _)) => ended(key, "timeout", &why, &json!(turn), &account),
                        Err((Sent::Yes, why, _)) => ended(key, "failed", &why, &json!(turn), &account),
                        Err((Sent::No, why, _)) => ended(key, "failed", &why, &Value::Null, &account),
                    }
                }
            },
        };
        write_synced(&dir.join("final.json"), &fin)?;
        Ok(true)
    }

    /// Whether the key has a job folder: a reserved one without `job.json` too, which `wait_final` reads as a call
    /// that never started.
    fn exists(&self, key: &str) -> bool {
        is_key(key) && self.job_dir(key).is_dir()
    }

    fn wait_final(&self, key: &str) -> Result<Value> {
        final_state(&self.job_dir(key), key)
    }

    fn died_before_turn(&self, fin: &Value) -> bool {
        fin["status"] == json!("failed") && fin.get("turnStartedAt").is_none_or(Value::is_null)
    }

    fn name(&self) -> &'static str {
        "claude"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zodchi_core::claude::conforms;

    #[test]
    fn the_flow_schemas_are_checked() {
        let patch: Value = serde_json::from_str(include_str!("../../flows/code-package/v1/patch.schema.json")).unwrap();
        let ok = json!({ "status": "done", "summary": "s", "unverified": [], "questions": [],
            "changes": [{ "op": "modify", "path": "a", "from": null, "baseBlob": "b", "content": "c" }] });
        assert!(conforms(&ok, &patch, "answer").is_ok());
        let mut bad = ok.clone();
        bad["changes"][0]["op"] = json!("chmod");
        assert!(conforms(&bad, &patch, "answer").unwrap_err().contains("answer.changes[0].op"));
    }

    #[test]
    fn a_cut_job_is_read_by_how_far_it_came() {
        let dir = std::env::temp_dir().join(format!("zodchi-claude-test-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        let key = "flow-test-write";
        assert!(final_state(&dir, key).is_err(), "no folder: no job");
        fs::create_dir_all(&dir).unwrap();
        write_synced(&dir.join("job.json"), &json!({ "key": key, "status": "starting", "account": "claude-x" })).unwrap();
        assert_eq!(final_state(&dir, key).unwrap()["status"], json!("failed"));
        write_synced(&dir.join("job.json"), &json!({ "key": key, "status": "running", "turnStartedAt": "t" })).unwrap();
        assert_eq!(final_state(&dir, key).unwrap()["status"], json!("unknown"), "a started call may have run");
        fs::write(dir.join("job.json"), "{ cut").unwrap();
        assert_eq!(final_state(&dir, key).unwrap()["status"], json!("unknown"), "an unreadable record is never read as not started");
        write_synced(&dir.join("final.json"), &json!({ "status": "succeeded" })).unwrap();
        assert_eq!(final_state(&dir, key).unwrap()["status"], json!("succeeded"));
        let _ = fs::remove_dir_all(&dir);
    }
}
