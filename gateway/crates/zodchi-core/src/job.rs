//! Jobs of the gateway. A job is one model call, made in the role the caller names and identified by a key inside
//! the repository it was made from. Repeating a key returns the same job and never spends twice. Nothing is retried
//! and no model is substituted. The folder of a job is `.agent-tmp/gateway/<key>/` with job.json, final.json,
//! request.json, worker.lock, actions.json, in-N/out-N images and codex-stderr.log, as in the reference gateway.

use crate::appserver::{image_type, AppServer, TurnFailed, TurnHooks};
use crate::config::{Account, Config};
use crate::decisions;
use crate::process::{alive, gone, process_start, stop_process};
use crate::role::check_role;
use crate::util::{fail, iso, merge, now_ms, parse_iso_ms, pause, pretty, publish, read_stored, sha256_hex, write_json_atomic, GatewayError, Result};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

pub const TERMINAL: [&str; 6] = ["succeeded", "failed", "limited", "auth_required", "unknown", "timeout"];
pub const MAX_PARALLEL: usize = 2;
pub const LIMIT_PROMPT: usize = 512 * 1024;
pub const LIMIT_IMAGES: usize = 8;
pub const LIMIT_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const RETENTION_MS: i128 = 7 * 86_400_000;
const WORKER_START_MS: i128 = 60_000;
const GRACE_MS: u64 = 60_000;
const BEAT_MS: u64 = 5000;
const STALE_MS: i128 = 90_000;
const UNSPENT: &str = "the model was not asked and nothing was spent.";
pub const LOGIN_HINT: &str = "Codex is not signed in to a ChatGPT subscription. Sign in yourself: codex login (with CODEX_HOME set to the account's home).";

pub fn is_terminal(status: &str) -> bool {
    TERMINAL.contains(&status)
}

fn status_of(job: &Value) -> &str {
    job.get("status").and_then(Value::as_str).unwrap_or("")
}

/// An expert has no access to files, so the caller sends the text it must read inside the prompt.
pub fn compose_prompt(prompt: &str, attachments: &[(String, Vec<u8>)]) -> Result<String> {
    let mut parts = vec![prompt.trim_end().to_string()];
    for (name, bytes) in attachments {
        if bytes.contains(&0) {
            return fail(format!("Attachment {name} is not a text file."));
        }
        let text = String::from_utf8_lossy(bytes);
        parts.push(format!("<attachment path=\"{name}\">\n{}\n</attachment>", text.trim_end()));
    }
    Ok(parts.join("\n\n") + "\n")
}

pub fn job_dir(cfg: &Config, key: &str) -> Result<PathBuf> {
    let Some(jobs) = &cfg.jobs_dir else {
        return fail("Run the gateway inside a Git repository, or pass --root <dir>.");
    };
    if !crate::util::is_key(key) {
        return fail("--key is 1-96 characters: A-Z a-z 0-9 . _ -");
    }
    Ok(jobs.join(key))
}

/// A job holds prompts, answers and the log of Codex. It must never reach Git, so Git has to say that the folder
/// of the jobs is ignored as a folder.
fn ensure_ignored(cfg: &Config) -> Result<()> {
    let root = cfg.root.as_ref().expect("root");
    let status = Command::new("git").arg("-C").arg(root).args(["check-ignore", "-q", "--", ".agent-tmp/gateway/"]).status();
    match status.ok().and_then(|s| s.code()) {
        Some(0) => Ok(()),
        Some(1) => fail(format!("{} does not ignore .agent-tmp/. Add \".agent-tmp/\" to its .gitignore before calling the gateway.", root.display())),
        _ => fail(format!("Git could not check the ignore rules of {}; the gateway works only inside a Git repository.", root.display())),
    }
}

/// The job as it ended, once it has, and as its worker wrote it last until then.
pub fn read_job(dir: &Path) -> Option<Value> {
    read_stored(&dir.join("final.json")).or_else(|| read_stored(&dir.join("job.json")))
}

fn write_job(dir: &Path, job: &Value) -> Result<Value> {
    write_json_atomic(&dir.join("job.json"), job)?;
    Ok(job.clone())
}

/// A job ends once: the first final.json stands, and whoever comes later gets that one. job.json follows it, and
/// only from what final.json holds.
fn finish(dir: &Path, job: &Value, status: &str, fields: &Value) -> Result<Value> {
    let mut ended = merge(job, &json!({ "status": status, "finishedAt": iso() }));
    ended = merge(&ended, fields);
    let file = dir.join("final.json");
    publish(&file, &pretty(&ended))?;
    let Some(last) = read_stored(&file) else {
        return fail(format!("{} could not be read back after it was written.", file.display()));
    };
    let _ = write_job(dir, &last);
    Ok(last)
}

struct WorkerLock {
    pid: Option<i64>,
    start: Option<String>,
    none: bool,
    beat_at: i128,
}

/// worker.lock belongs to the one worker of a job: its pid and start, touched for as long as it lives.
/// `none` marks the lock of a job that no worker came for.
fn worker_of(dir: &Path) -> Option<WorkerLock> {
    let file = dir.join("worker.lock");
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        // A lock that cannot be read at this moment decides nothing.
        Err(_) => return Some(WorkerLock { pid: None, start: None, none: false, beat_at: now_ms() }),
    };
    let beat_at = fs::metadata(&file).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i128).unwrap_or_else(now_ms);
    let owner: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Some(WorkerLock {
        pid: owner.get("pid").and_then(Value::as_i64),
        start: owner.get("start").and_then(|s| s.as_str().map(String::from).or_else(|| s.as_i64().map(|n| n.to_string()))),
        none: owner.get("none") == Some(&json!(true)),
        beat_at,
    })
}

/// A job whose worker is gone gets its honest final status. Nothing is decided about a job while its worker or its
/// Codex may still be alive.
fn settle(dir: &Path, job: Option<Value>) -> Result<Option<Value>> {
    let Some(job) = job else { return Ok(None) };
    if is_terminal(status_of(&job)) {
        return Ok(Some(job));
    }
    let Some(worker) = worker_of(dir) else {
        let created = job.get("createdAt").and_then(Value::as_str).and_then(parse_iso_ms).unwrap_or_else(now_ms);
        if now_ms() - created <= WORKER_START_MS {
            return Ok(Some(job));
        }
        // No worker has come for the job. Taking the lock of the worker makes sure that none will.
        if !publish(&dir.join("worker.lock"), "{\"none\":true}").unwrap_or(false) {
            return Ok(Some(job));
        }
        return finish(dir, &job, "failed", &json!({ "error": format!("No worker started for the job; {UNSPENT}") })).map(Some);
    };
    if worker.none {
        return finish(dir, &job, "failed", &json!({ "error": format!("No worker started for the job; {UNSPENT}") })).map(Some);
    }
    if worker.pid.is_some_and(|p| p > 0 && alive(p as u32)) && now_ms() - worker.beat_at < STALE_MS {
        return Ok(Some(job));
    }
    // A silent worker may be frozen and not dead: it is stopped for certain before its place is given away.
    if !gone(stop_process(worker.pid.unwrap_or(0), worker.start.as_deref())) {
        return Ok(Some(job));
    }
    let last = read_job(dir).unwrap_or(job);
    if is_terminal(status_of(&last)) {
        return Ok(Some(last));
    }
    if let Some(pid) = last.get("codexPid").and_then(Value::as_i64) {
        if !gone(stop_process(pid, last.get("codexStart").and_then(Value::as_str))) {
            return Ok(Some(last));
        }
    } else if last.get("codexSpawnAt").is_some_and(|v| !v.is_null()) {
        // The worker set out to create Codex and did not write what came of it: a Codex nobody can name may live.
        return Ok(Some(last));
    }
    if last.get("turnRequestedAt").is_none_or(Value::is_null) {
        return finish(dir, &last, "failed", &json!({ "error": format!("The worker stopped before the model call; {UNSPENT}") })).map(Some);
    }
    // The turn may have run and used the subscription: it is never rerun silently.
    finish(dir, &last, "unknown", &json!({ "error": "The worker stopped after it set out to ask for the model turn; whether the turn ran is unknown." })).map(Some)
}

pub fn job(cfg: &Config, key: &str) -> Result<Value> {
    let dir = job_dir(cfg, key)?;
    match settle(&dir, read_job(&dir))? {
        Some(found) => Ok(found),
        None => fail(format!("No job {key} in {}.", cfg.jobs_dir.as_ref().unwrap().display())),
    }
}

fn all_job_dirs(cfg: &Config) -> Vec<PathBuf> {
    let Some(jobs) = &cfg.jobs_dir else { return vec![] };
    let Ok(entries) = fs::read_dir(jobs) else { return vec![] };
    entries.filter_map(|e| e.ok()).filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)).map(|e| e.path()).collect()
}

/// Disk stays bounded: a finished job lives seven days. Only folders that hold a finished job are removed.
fn sweep(cfg: &Config) {
    for dir in all_job_dirs(cfg) {
        if let Some(found) = read_job(&dir) {
            let finished = found.get("finishedAt").and_then(Value::as_str).and_then(parse_iso_ms);
            if is_terminal(status_of(&found)) && finished.is_some_and(|f| now_ms() - f > RETENTION_MS) {
                let _ = fs::remove_dir_all(&dir);
            }
        }
    }
}

/// What a caller asks for.
pub struct Request {
    pub key: String,
    pub role: Value,
    pub prompt: String,
    pub images: Vec<Vec<u8>>,
    pub credits: bool,
    pub paid: bool,
    pub resume: Option<String>,
    /// The caller's word for this call; None leaves it to the role.
    pub keep_thread: Option<bool>,
}

/// Stores a job and starts its worker. Returns the job and whether it was created now.
pub fn submit(cfg: &Config, req: &Request, spawn_worker: bool) -> Result<(Value, bool)> {
    let dir = job_dir(cfg, &req.key)?;
    let role = check_role(&req.role)?;
    let kind = role.get("kind").and_then(Value::as_str).unwrap_or("text").to_string();
    let mode = role.get("mode").and_then(Value::as_str).unwrap_or("").to_string();
    let work = mode == "work";
    if req.keep_thread.is_some() && !work {
        return fail("--keep-thread is for a work call; an expert call never keeps a thread.");
    }
    if req.keep_thread == Some(false) && req.resume.is_some() {
        return fail("--resume continues a kept thread, and the call that continues it keeps it too; drop --no-keep-thread.");
    }
    let keep = work && (req.resume.is_some() || req.keep_thread.unwrap_or(role.get("keepThread") == Some(&json!(true))));
    if kind == "decisions" {
        if role.get("questions").is_none_or(Value::is_null) {
            return fail("A decisions call needs questions: --questions <file.json>, or the questions file of the role.");
        }
        if req.credits {
            return fail("--credits is for a call on the subscription. A decisions call is paid for by the OpenAI API key: --paid.");
        }
        if !req.paid {
            return fail("A decisions call is paid for by the OpenAI API key, not by the subscription. --paid lets it spend, once its owner named the sum.");
        }
    } else if req.paid {
        return fail("--paid is for a decisions call. This role runs on the subscription and takes nothing from the API key.");
    }
    if req.prompt.trim().is_empty() || req.prompt.len() > LIMIT_PROMPT {
        return fail(format!("The prompt is empty or larger than {} KB with its attachments.", LIMIT_PROMPT / 1024));
    }
    if req.images.len() > LIMIT_IMAGES {
        return fail(format!("At most {LIMIT_IMAGES} images."));
    }
    let mut inputs = Vec::new();
    for (index, bytes) in req.images.iter().enumerate() {
        let Some(ext) = image_type(bytes).filter(|_| bytes.len() <= LIMIT_IMAGE_BYTES) else {
            return fail(format!("Image {}: PNG, JPEG or WebP up to 20 MB.", index + 1));
        };
        inputs.push(json!({ "index": index, "ext": ext, "bytes": bytes.len(), "sha256": sha256_hex(bytes) }));
    }
    let mut resumed = Value::Null;
    if let Some(resume) = &req.resume {
        if !work {
            return fail("--resume continues a work call; an expert call has no thread to continue.");
        }
        let stored = fs::read_to_string(dir.join("request.json")).ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|r| r.get("resume").cloned());
        if stored.as_ref().and_then(|s| s.get("key")).and_then(Value::as_str) == Some(resume.as_str()) {
            resumed = stored.unwrap();
        } else {
            let earlier = job(cfg, resume)?;
            if earlier.get("mode").and_then(Value::as_str) == Some("work") && earlier.get("keepThread") == Some(&json!(false)) {
                return fail(format!("Job {resume} was ephemeral: Codex kept no thread of it, so there is nothing to continue; nothing was spent. \
Submit the earlier request again under a new key with --keep-thread, or make a new call under a new key and attach the previous answer."));
            }
            let thread = earlier.get("threadId").and_then(Value::as_str);
            if earlier.get("mode").and_then(Value::as_str) != Some("work") || thread.is_none() {
                return fail(format!("Job {resume} has no Codex thread to continue."));
            }
            if !is_terminal(status_of(&earlier)) {
                return fail(format!("Job {resume} is still {}; wait for it before continuing its thread.", status_of(&earlier)));
            }
            // The thread lives in the Codex home of the account that ran the earlier job; the continuation goes there.
            resumed = json!({ "key": resume, "threadId": thread, "account": earlier.get("account").cloned().unwrap_or(Value::Null) });
        }
    }
    let mut request = Map::new();
    request.insert("role".into(), role.clone());
    request.insert("prompt".into(), json!(req.prompt));
    request.insert("images".into(), Value::Array(inputs.clone()));
    request.insert("credits".into(), json!(req.credits));
    request.insert("paid".into(), json!(req.paid));
    request.insert("resume".into(), resumed.clone());
    if work {
        request.insert("keepThread".into(), json!(keep));
    }
    let request = Value::Object(request);
    let request_sha = sha256_hex(request.to_string());

    if !dir.exists() {
        ensure_ignored(cfg)?;
    }
    fs::create_dir_all(cfg.jobs_dir.as_ref().unwrap())?;
    if let Err(error) = fs::create_dir(&dir) {
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.into());
        }
        let mut found = read_job(&dir);
        for _ in 0..40 {
            if found.is_some() {
                break;
            }
            pause(50);
            found = read_job(&dir);
        }
        let Some(found) = found else { return fail(format!("The folder of job {} exists without a job; use a new key.", req.key)) };
        let stored = found.get("requestSha256").and_then(Value::as_str).unwrap_or("");
        // A job stored before the gateway asked whether to keep the thread has no `keepThread`; one stored before
        // the kinds of call existed has no `kind`. The same request repeated under its key is still that job.
        let older = found.get("keepThread").is_none();
        if older && work && req.keep_thread == Some(false) {
            return fail(format!("Key {} already belongs to a different request: a work job stored before --no-keep-thread existed keeps its thread. A new request needs a new key.", req.key));
        }
        let mut unasked = request.as_object().cloned().unwrap_or_default();
        unasked.remove("keepThread");
        let before = || {
            let mut rest = unasked.clone();
            rest.remove("paid");
            let mut role_before = role.as_object().cloned().unwrap_or_default();
            role_before.remove("kind");
            rest.insert("role".into(), Value::Object(role_before));
            sha256_hex(Value::Object(rest).to_string())
        };
        let same = stored == request_sha
            || (older && stored == sha256_hex(Value::Object(unasked.clone()).to_string()))
            || (found.get("kind").is_none() && kind == "text" && stored == before());
        if !same {
            return fail(format!("Key {} already belongs to a different request. A new request needs a new key.", req.key));
        }
        return Ok((settle(&dir, Some(found))?.unwrap_or(Value::Null), false));
    }
    fs::write(dir.join("request.json"), pretty(&request))?;
    for (index, bytes) in req.images.iter().enumerate() {
        let ext = inputs[index]["ext"].as_str().unwrap();
        fs::write(dir.join(format!("in-{index}.{ext}")), bytes)?;
    }
    let timeout_ms = role.get("timeoutMin").and_then(Value::as_f64).unwrap_or(30.0) * 60_000.0;
    let job = json!({
        "key": req.key, "role": role["name"], "kind": kind, "mode": mode, "model": role["model"], "effort": role["effort"],
        "status": "queued", "requestSha256": request_sha, "timeoutMs": crate::role::js_number(timeout_ms),
        "writes": work && role.get("sandbox").and_then(Value::as_str) == Some("workspace-write"),
        "dir": dir.display().to_string(), "root": cfg.root.as_ref().map(|r| r.display().to_string()), "workerPid": null,
        "codexSpawnAt": null, "codexPid": null, "codexStart": null, "account": null, "accountsSkipped": [],
        "error": null, "resetsAt": null, "tokens": null, "result": null, "actions": null,
        "credits": { "allowed": req.credits, "limitUsedUp": null, "balanceBefore": null, "balanceAfter": null }, "paid": req.paid,
        "keepThread": keep, "threadId": null, "resumedFrom": resumed.get("key").cloned().unwrap_or(Value::Null), "servers": null,
        "createdAt": iso(), "startedAt": null, "turnRequestedAt": null, "turnStartedAt": null, "finishedAt": null,
    });
    write_job(&dir, &job)?;
    sweep(cfg);
    if spawn_worker {
        spawn_detached_worker(cfg, &req.key, &kind)?;
    }
    Ok((read_job(&dir).unwrap_or(job), true))
}

/// The worker outlives the command that submitted the job, so a caller's timeout never interrupts a model call.
fn spawn_detached_worker(cfg: &Config, key: &str, kind: &str) -> Result<()> {
    let exe = std::env::current_exe()?;
    let mut command = Command::new(exe);
    command.args(["work", "--root"]).arg(cfg.root.as_ref().unwrap()).args(["--key", key]);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // The API key reaches only the worker of a decisions job.
    if kind != "decisions" {
        command.env_remove("OPENAI_API_KEY");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn()?;
    Ok(())
}

/// The other jobs that hold a place. With `settle_them`, jobs without a worker are settled first.
fn running_elsewhere(cfg: &Config, own: &Path, settle_them: bool, beat: &dyn Fn()) -> Vec<Value> {
    all_job_dirs(cfg).into_iter().filter(|d| d != own).filter_map(|d| {
        if settle_them {
            beat();
            // A job that could not be settled keeps its place, as it reads now.
            settle(&d, read_job(&d)).unwrap_or_else(|_| read_job(&d))
        } else {
            read_job(&d)
        }
    }).filter(|j| status_of(j) == "running").collect()
}

/// Two calls run at once at most, and only one of them writes into the checkout. Counting the running jobs and
/// becoming one of them is a single step for the whole repository, under `.claim.lock`.
fn claim(cfg: &Config, dir: &Path, current: &Value, interval_ms: u64, beat: &dyn Fn()) -> Result<Option<Value>> {
    let jobs = cfg.jobs_dir.as_ref().unwrap();
    let lock = jobs.join(".claim.lock");
    let mine = format!("{} {}", std::process::id(), dir.display());
    let holder = || fs::read_to_string(&lock).unwrap_or_default();
    let writes = current.get("writes") == Some(&json!(true));
    let room = || {
        let others = running_elsewhere(cfg, dir, false, beat);
        others.len() < MAX_PARALLEL && !(writes && others.iter().any(|o| o.get("writes") == Some(&json!(true))))
    };
    let take = || -> Result<bool> {
        match fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(mine.as_bytes())?;
                Ok(true)
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied) => {
                // A worker that died inside the step leaves the lock behind.
                let pid: Option<u32> = holder().split_whitespace().next().and_then(|p| p.parse().ok());
                let old = fs::metadata(&lock).and_then(|m| m.modified()).ok()
                    .and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(30));
                if pid.is_some_and(|p| !alive(p)) || old {
                    let _ = fs::remove_file(&lock);
                }
                Ok(false)
            }
            Err(e) => Err(e.into()),
        }
    };
    loop {
        running_elsewhere(cfg, dir, true, beat);
        while !take()? {
            pause(20 + rand::random::<u64>() % 40);
        }
        let outcome = (|| -> Result<Option<Option<Value>>> {
            if read_job(dir).map(|j| status_of(&j) == "queued") != Some(true) {
                return Ok(Some(None));
            }
            if room() {
                let running = write_job(dir, &merge(current, &json!({ "status": "running", "startedAt": iso() })))?;
                // Of two that got in together, at least the later one sees the other and steps back.
                if room() {
                    return Ok(Some(Some(running)));
                }
                write_job(dir, current)?;
            }
            Ok(None)
        })();
        if holder() == mine {
            let _ = fs::remove_file(&lock);
        }
        if let Some(done) = outcome? {
            return Ok(done);
        }
        pause((interval_ms as f64 * (0.5 + rand::random::<f64>())) as u64);
    }
}

/// What the work call did, in numbers. The full list is in actions.json of the job.
fn summary(audit: &Value) -> Value {
    let actions = audit.get("actions").and_then(Value::as_array).cloned().unwrap_or_default();
    let commands: Vec<&Value> = actions.iter().filter(|a| a.get("type").and_then(Value::as_str) == Some("command")).collect();
    let failed = commands.iter().filter(|a| a.get("exitCode").and_then(Value::as_i64).is_some_and(|c| c != 0)).count();
    let mut changed: Vec<Value> = Vec::new();
    for a in actions.iter().filter(|a| a.get("type").and_then(Value::as_str) == Some("fileChange")) {
        for f in a.get("files").and_then(Value::as_array).cloned().unwrap_or_default() {
            let p = f.get("path").cloned().unwrap_or(Value::Null);
            if !changed.contains(&p) {
                changed.push(p);
            }
        }
    }
    json!({ "commands": commands.len(), "failedCommands": failed, "changedFiles": changed,
        "mcpCalls": actions.iter().filter(|a| a.get("type").and_then(Value::as_str) == Some("mcp")).count(),
        "refused": audit.get("refused").cloned().unwrap_or(json!([])) })
}

/// The state a running job shares between the worker and the model call.
#[derive(Clone)]
pub struct JobState {
    dir: PathBuf,
    current: Arc<Mutex<Value>>,
    decided: Arc<AtomicBool>,
}

impl JobState {
    pub fn get(&self) -> Value {
        self.current.lock().unwrap().clone()
    }
    pub fn decided(&self) -> bool {
        self.decided.load(Ordering::SeqCst)
    }
    /// Written now; a failed write fails the call. Nothing changes once the outcome is decided.
    pub fn save(&self, fields: Value) -> Result<()> {
        if self.decided() {
            return Ok(());
        }
        let mut current = self.current.lock().unwrap();
        let next = merge(&current, &fields);
        write_job(&self.dir, &next)?;
        *current = next;
        Ok(())
    }
    /// A fact from the model's side: kept even when it cannot be written at this moment.
    pub fn keep(&self, fields: Value) {
        if self.decided() {
            return;
        }
        let mut current = self.current.lock().unwrap();
        *current = merge(&current, &fields);
        let _ = write_job(&self.dir, &current);
    }
}

/// Runs one queued job to its final status. Called in the detached worker process.
pub fn work(cfg: &Config, key: &str) -> Result<Option<Value>> {
    let dir = job_dir(cfg, key)?;
    let lock = dir.join("worker.lock");
    if !dir.exists() || lock.exists() {
        return Ok(read_job(&dir));
    }
    let me = std::process::id();
    let owner = json!({ "pid": me, "start": process_start(me) });
    if !publish(&lock, &owner.to_string())? {
        return Ok(read_job(&dir));
    }
    let beating = Arc::new(AtomicBool::new(true));
    let beat_lock = lock.clone();
    let beat_flag = Arc::clone(&beating);
    let beat_thread = thread::spawn(move || {
        while beat_flag.load(Ordering::SeqCst) {
            touch(&beat_lock);
            for _ in 0..(BEAT_MS / 100) {
                if !beat_flag.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
    });
    let result = perform(cfg, &dir, &|| touch(&lock));
    beating.store(false, Ordering::SeqCst);
    let _ = beat_thread.join();
    result
}

fn touch(file: &Path) {
    if let Ok(f) = fs::OpenOptions::new().write(true).open(file) {
        let _ = f.set_modified(SystemTime::now());
    }
}

fn perform(cfg: &Config, dir: &Path, beat: &dyn Fn()) -> Result<Option<Value>> {
    let Some(current) = read_job(dir) else { return Ok(None) };
    if status_of(&current) != "queued" {
        return Ok(Some(current));
    }
    let current = write_job(dir, &merge(&current, &json!({ "workerPid": std::process::id() })))?;
    let Some(current) = claim(cfg, dir, &current, 2000, beat)? else { return Ok(read_job(dir)) };
    let request: Value = serde_json::from_str(&fs::read_to_string(dir.join("request.json"))?).map_err(|e| GatewayError(e.to_string()))?;
    let timeout_ms = current.get("timeoutMs").and_then(Value::as_f64).unwrap_or(1_800_000.0) as u64;
    let state = JobState { dir: dir.to_path_buf(), current: Arc::new(Mutex::new(current)), decided: Arc::new(AtomicBool::new(false)) };
    let kind = request.get("role").and_then(|r| r.get("kind")).and_then(Value::as_str).unwrap_or("text").to_string();
    let call = Call::new(cfg, dir, &request, state.clone());
    let (tx, rx) = channel();
    let runner = call.clone();
    thread::spawn(move || {
        let outcome = if kind == "decisions" { decisions::call(&runner) } else { runner.codex_call() };
        let _ = tx.send(outcome);
    });
    // The whole call, the steps before the model turn included, has a grace period beyond the time limit of the job.
    let (status, fields) = match rx.recv_timeout(Duration::from_millis(timeout_ms + GRACE_MS)) {
        Ok(Ok(fields)) => ("succeeded".to_string(), fields),
        Ok(Err(failed)) => (failed.code.to_string(), json!({ "error": failed.message, "resetsAt": failed.resets_at })),
        Err(_) => ("timeout".to_string(), json!({ "error": "The call did not end in its time and was stopped." })),
    };
    state.decided.store(true, Ordering::SeqCst);
    // The job keeps its place in the queue until nothing of the call is left: the final status is written after that.
    let extra = call.stop();
    let current = state.get();
    finish(dir, &current, &status, &merge(&fields, &extra)).map(Some)
}

/// One model call of a job, shared between the worker thread and the call thread.
#[derive(Clone)]
pub struct Call {
    pub cfg: Config,
    pub dir: PathBuf,
    pub request: Value,
    pub role: Value,
    pub state: JobState,
    pub timeout_ms: u64,
    server: Arc<Mutex<Option<Arc<AppServer>>>>,
    pub abort: Arc<AtomicBool>,
    /// A helper process of the call other than Codex (curl for the Decisions API); stop() kills and reaps it.
    pub helper: Arc<Mutex<Option<std::process::Child>>>,
}

impl Call {
    fn new(cfg: &Config, dir: &Path, request: &Value, state: JobState) -> Call {
        let timeout_ms = state.get().get("timeoutMs").and_then(Value::as_f64).unwrap_or(1_800_000.0) as u64;
        Call {
            cfg: cfg.clone(),
            dir: dir.to_path_buf(),
            request: request.clone(),
            role: request.get("role").cloned().unwrap_or(Value::Null),
            state,
            timeout_ms,
            server: Arc::new(Mutex::new(None)),
            abort: Arc::new(AtomicBool::new(false)),
            helper: Arc::new(Mutex::new(None)),
        }
    }

    fn work_mode(&self) -> bool {
        self.role.get("mode").and_then(Value::as_str) == Some("work")
    }

    /// A Codex process for one account, with the job's records of its pid and start.
    fn server_for(&self, account: &Account) -> Arc<AppServer> {
        let cwd = if self.work_mode() { self.cfg.root.clone().unwrap() } else { self.dir.clone() };
        let server = Arc::new(AppServer::new(&self.cfg.codex_bin, &account.codex_home, &cwd, Some(self.role.clone()), Some(self.dir.join("codex-stderr.log"))));
        if self.work_mode() {
            let file = self.dir.join("actions.json");
            server.set_on_audit(Arc::new(move |seen| { let _ = fs::write(&file, pretty(&seen)); }));
        }
        if let Some(old) = self.server.lock().unwrap().replace(Arc::clone(&server)) {
            old.stop();
        }
        server
    }

    fn started(&self, server: &AppServer) -> std::result::Result<(), TurnFailed> {
        let state = self.state.clone();
        let state2 = self.state.clone();
        server.start(&mut || self.note_spawn(&state), &mut |pid| Self::note_pid(&state2, pid))
    }

    /// Written before a process of the call is created: a job with this mark and no pid may have a process nobody
    /// can name, and keeps its place. The pid and start of an earlier process of the call are cleared in the same write.
    pub fn note_spawn(&self, state: &JobState) -> std::result::Result<(), TurnFailed> {
        state.save(json!({ "codexSpawnAt": iso(), "codexPid": null, "codexStart": null })).map_err(|e| TurnFailed::new("failed", e.0))
    }

    /// The pid and start of the process just created. A process the job could not take note of is not used.
    pub fn note_pid(state: &JobState, pid: Option<u32>) -> std::result::Result<(), TurnFailed> {
        let Some(pid) = pid else {
            return state.save(json!({ "codexSpawnAt": null })).map_err(|e| TurnFailed::new("failed", e.0));
        };
        // Read while the child is not reaped, so the pid is still this process.
        let start = process_start(pid);
        state.save(json!({ "codexPid": pid, "codexStart": start })).map_err(|e| TurnFailed::new("failed", e.0))
    }

    /// The subscriptions in the user's order: the first signed-in account whose limit is not used up takes the
    /// job. Every account passed over is written into the job with the reason. With --credits and no account left,
    /// the first account that has credits takes it.
    fn pick_account(&self) -> std::result::Result<(Arc<AppServer>, Value), TurnFailed> {
        let mut skipped: Vec<Value> = Vec::new();
        let mut credit_candidate: Option<Account> = None;
        let mut last_reset = Value::Null;
        // A continued thread lives in one Codex home: only that account may take the call.
        let only = self.request.get("resume").and_then(|r| r.get("account")).and_then(Value::as_str).map(String::from);
        let candidates: Vec<Account> = match &only {
            Some(name) => match self.cfg.account(name) {
                Some(a) => vec![a.clone()],
                None => return Err(TurnFailed::new("auth_required", format!("The thread to continue belongs to the account {name}, which ~/.zodchi/accounts.json no longer lists; the model was not called."))),
            },
            None => self.cfg.accounts.clone(),
        };
        for account in &candidates {
            let server = self.server_for(account);
            self.started(&server)?;
            let info = server.account()?;
            if info.get("type").and_then(Value::as_str) != Some("chatgpt") {
                skipped.push(json!({ "account": account.name, "reason": "not signed in to a ChatGPT subscription" }));
                server.stop();
                continue;
            }
            let limits = server.rate_limits().ok();
            let allowed = limits.as_ref().and_then(|l| l.get("ordinaryUsageAllowed")).and_then(Value::as_bool);
            let wallet = limits.as_ref().and_then(|l| l.get("rateLimits")).and_then(|r| r.get("credits")).cloned().unwrap_or(Value::Null);
            match allowed {
                Some(true) => {
                    let _ = self.state.save(json!({ "account": account.name, "accountsSkipped": skipped,
                        "credits": merge(&self.state.get()["credits"], &json!({ "limitUsedUp": false, "balanceBefore": wallet.get("balance").cloned().unwrap_or(Value::Null) })) }));
                    return Ok((server, wallet));
                }
                Some(false) => {
                    last_reset = limits.as_ref().and_then(|l| l.get("rateLimits")).and_then(|r| r.get("primary")).and_then(|p| p.get("resetsAt")).cloned().unwrap_or(Value::Null);
                    let has = wallet.get("hasCredits") == Some(&json!(true)) || wallet.get("unlimited") == Some(&json!(true));
                    if has && credit_candidate.is_none() {
                        credit_candidate = Some(account.clone());
                    }
                    skipped.push(json!({ "account": account.name, "reason": "the limit is used up", "resetsAt": last_reset }));
                }
                None => skipped.push(json!({ "account": account.name, "reason": "the limits could not be read" })),
            }
            server.stop();
        }
        let _ = self.state.save(json!({ "accountsSkipped": skipped }));
        if self.request.get("credits") == Some(&json!(true)) {
            if let Some(account) = credit_candidate {
                let server = self.server_for(&account);
                self.started(&server)?;
                let wallet = server.rate_limits().ok().and_then(|l| l.get("rateLimits").and_then(|r| r.get("credits")).cloned()).unwrap_or(Value::Null);
                let _ = self.state.save(json!({ "account": account.name,
                    "credits": merge(&self.state.get()["credits"], &json!({ "limitUsedUp": true, "balanceBefore": wallet.get("balance").cloned().unwrap_or(Value::Null) })) }));
                return Ok((server, wallet));
            }
        }
        let all_unsigned = skipped.iter().all(|s| s["reason"] == json!("not signed in to a ChatGPT subscription"));
        if all_unsigned {
            return Err(TurnFailed::new("auth_required", LOGIN_HINT));
        }
        let mut failed = TurnFailed::new("limited", if self.request.get("credits") == Some(&json!(true)) {
            "The limit of every subscription is used up and none has credits."
        } else {
            "The limit of every subscription is used up. --credits lets a call spend ChatGPT credits."
        });
        failed.resets_at = Some(last_reset);
        Err(failed)
    }

    /// A text or an image from Codex on a ChatGPT subscription.
    pub fn codex_call(&self) -> std::result::Result<Value, TurnFailed> {
        let (server, _) = self.pick_account()?;
        let keep_thread = self.work_mode() && self.request.get("keepThread").and_then(Value::as_bool).unwrap_or(true);
        let cwd = if self.work_mode() { self.cfg.root.clone().unwrap() } else { self.dir.clone() };
        let images: Vec<PathBuf> = self.request.get("images").and_then(Value::as_array).cloned().unwrap_or_default().iter()
            .map(|i| self.dir.join(format!("in-{}.{}", i["index"], i["ext"].as_str().unwrap_or("png")))).collect();
        let model = self.role["model"].as_str().unwrap_or("").to_string();
        let effort = self.role["effort"].as_str().unwrap_or("medium").to_string();
        let resume = self.request.get("resume").and_then(|r| r.get("threadId")).and_then(Value::as_str).map(String::from);
        let state = self.state.clone();
        let mut on_thread = |id: &str, servers: &Value| {
            let _ = state.save(json!({ "threadId": if keep_thread { json!(id) } else { Value::Null }, "servers": servers }));
        };
        let state_r = self.state.clone();
        let mut on_turn_request = || -> std::result::Result<(), TurnFailed> {
            if state_r.decided() {
                return Err(TurnFailed::new("timeout", "The call was cut off before the model turn."));
            }
            state_r.save(json!({ "turnRequestedAt": iso() })).map_err(|e| TurnFailed::new("failed", e.0))
        };
        let state_s = self.state.clone();
        let mut on_turn_start = || state_s.keep(json!({ "turnStartedAt": iso() }));
        let result = server.run_turn(&self.request["prompt"].as_str().unwrap_or(""), &self.role, &model, &effort, &cwd, &images,
            resume.as_deref(), keep_thread, Duration::from_millis(self.timeout_ms),
            TurnHooks { on_thread: &mut on_thread, on_turn_request: &mut on_turn_request, on_turn_start: &mut on_turn_start })?;
        // ChatGPT settles the balance some time after the call, so this figure may still be the old one.
        let after = server.rate_limits().ok().and_then(|l| l.get("rateLimits").and_then(|r| r.get("credits")).and_then(|c| c.get("balance")).cloned()).unwrap_or(Value::Null);
        let _ = self.state.save(json!({ "credits": merge(&self.state.get()["credits"], &json!({ "balanceAfter": after })) }));
        let mut data = Value::Null;
        if self.role.get("outputSchema").is_some_and(|s| !s.is_null()) {
            data = serde_json::from_str(&result.text).map_err(|_| TurnFailed::new("failed", "The model answered outside the JSON schema."))?;
        }
        let mut images_out = Vec::new();
        for (index, (bytes, revised, generation)) in result.images.iter().enumerate() {
            let file = format!("out-{index}.{}", image_type(bytes).unwrap_or("png"));
            fs::write(self.dir.join(&file), bytes).map_err(|e| TurnFailed::new("failed", e.to_string()))?;
            images_out.push(json!({ "index": index, "file": file, "bytes": bytes.len(), "sha256": sha256_hex(bytes), "revisedPrompt": revised, "generationId": generation }));
        }
        if self.role.get("kind").and_then(Value::as_str) == Some("image") && images_out.is_empty() {
            let said = if result.text.is_empty() { String::new() } else { format!(" It answered: {}", result.text.chars().take(400).collect::<String>()) };
            return Err(TurnFailed::new("failed", format!("The model made no image. The turn ran and was spent.{said}")));
        }
        Ok(json!({ "tokens": result.tokens, "result": { "text": result.text, "data": data, "images": images_out, "durationMs": result.duration_ms } }))
    }

    /// Stops whatever of the call still runs and returns what it adds to the job.
    pub fn stop(&self) -> Value {
        self.abort.store(true, Ordering::SeqCst);
        // A helper that is not reaped yet still owns its pid: kill it with its tree and reap it.
        if let Some(mut child) = self.helper.lock().unwrap().take() {
            if let Ok(None) = child.try_wait() {
                crate::process::kill_tree(child.id());
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        let server = self.server.lock().unwrap().clone();
        let Some(server) = server else { return json!({}) };
        server.stop();
        if !self.work_mode() {
            return json!({});
        }
        let audit = server.snapshot();
        let _ = fs::write(self.dir.join("actions.json"), pretty(&audit));
        json!({ "actions": summary(&audit) })
    }
}

/// Waits for the final status. Returning a job that is still running is not a failure: the worker goes on.
pub fn wait(cfg: &Config, key: &str, timeout: Duration) -> Result<Value> {
    let deadline = std::time::Instant::now() + timeout;
    let mut current = job(cfg, key)?;
    while !is_terminal(status_of(&current)) && std::time::Instant::now() < deadline {
        pause(1000);
        current = job(cfg, key)?;
    }
    Ok(current)
}

/// Copies the answer of a finished job: the image of an image job, or else the JSON by the schema, or the text.
/// A second and a third image go beside the first as <name>-2, <name>-3.
pub fn deliver(done: &Value, out: &Path) -> Result<Vec<String>> {
    if status_of(done) != "succeeded" {
        return Ok(vec![]);
    }
    let target = std::path::absolute(out)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let job_dir = PathBuf::from(done["dir"].as_str().unwrap_or(""));
    if done.get("kind").and_then(Value::as_str) == Some("image") {
        let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("image").to_string();
        let ext = target.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
        let mut written = Vec::new();
        for (index, image) in done["result"]["images"].as_array().cloned().unwrap_or_default().iter().enumerate() {
            let file = if index == 0 { target.clone() } else { target.with_file_name(format!("{stem}-{}{ext}", index + 1)) };
            fs::copy(job_dir.join(image["file"].as_str().unwrap_or("")), &file)?;
            written.push(file.display().to_string());
        }
        return Ok(written);
    }
    let data = &done["result"]["data"];
    let text = if !data.is_null() { pretty(data) + "\n" } else { done["result"]["text"].as_str().unwrap_or("").to_string() };
    fs::write(&target, text)?;
    Ok(vec![target.display().to_string()])
}

fn mask_email(email: Option<&str>) -> Value {
    match email {
        Some(e) if e.contains('@') => {
            let first: String = e.chars().take(1).collect();
            let domain = &e[e.find('@').unwrap()..];
            json!(format!("{first}***{domain}"))
        }
        Some(e) => json!(e),
        None => Value::Null,
    }
}

/// Every subscription in the user's order: signed in or not, its plan, limits and credits. No model call.
pub fn account(cfg: &Config) -> Value {
    let mut rows = Vec::new();
    for account in &cfg.accounts {
        let server = AppServer::new(&cfg.codex_bin, &account.codex_home, &std::env::temp_dir(), None, None);
        let row = match server.account() {
            Ok(info) if info.get("type").and_then(Value::as_str) == Some("chatgpt") => {
                let limits = server.rate_limits().ok();
                let rl = limits.as_ref().and_then(|l| l.get("rateLimits")).cloned().unwrap_or(Value::Null);
                json!({ "name": account.name, "codexHome": account.codex_home.display().to_string(), "connected": true,
                    "email": mask_email(info.get("email").and_then(Value::as_str)), "plan": info.get("planType").cloned().unwrap_or(Value::Null),
                    "ordinaryUsageAllowed": limits.as_ref().and_then(|l| l.get("ordinaryUsageAllowed")).cloned().unwrap_or(Value::Null),
                    "primary": rl.get("primary").cloned().unwrap_or(Value::Null), "secondary": rl.get("secondary").cloned().unwrap_or(Value::Null),
                    "credits": rl.get("credits").cloned().unwrap_or(Value::Null) })
            }
            Ok(_) => json!({ "name": account.name, "codexHome": account.codex_home.display().to_string(), "connected": false, "hint": LOGIN_HINT }),
            Err(e) => json!({ "name": account.name, "codexHome": account.codex_home.display().to_string(), "connected": false, "error": e.message }),
        };
        server.stop();
        rows.push(row);
    }
    // The first row also stands at the top level, in the shape of the reference gateway, for callers that read one.
    let first = rows.first().cloned().unwrap_or(json!({}));
    let usable = rows.iter().find(|r| r["connected"] == json!(true) && r["ordinaryUsageAllowed"] != json!(false)).cloned();
    let mut top = usable.unwrap_or(first);
    if let Some(map) = top.as_object_mut() {
        map.insert("accounts".into(), Value::Array(rows));
    }
    top
}

/// Opens the thread of a role exactly as a job would and reports what the model would get. No turn is started.
pub fn check(cfg: &Config, role: &Value) -> Result<Value> {
    let Some(root) = &cfg.root else { return fail("Run the gateway inside a Git repository, or pass --root <dir>.") };
    let base = json!({ "role": role["name"], "kind": role["kind"], "mode": role["mode"], "model": role["model"], "effort": role["effort"] });
    if role["kind"] == json!("decisions") {
        let key_set = std::env::var("OPENAI_API_KEY").map(|k| !k.is_empty()).unwrap_or(false);
        let questions = role["questions"].as_array().cloned().unwrap_or_default();
        let mut out = merge(&base, &json!({ "ok": key_set, "apiKey": if key_set { "set" } else { "not set" }, "questions": questions.len(),
            "expected": questions.iter().filter(|q| q.get("expect").is_some()).count() }));
        if !key_set {
            out["error"] = json!("OPENAI_API_KEY is not set where the gateway runs.");
        }
        return Ok(out);
    }
    let account = cfg.accounts.first().expect("at least one account");
    let server = AppServer::new(&cfg.codex_bin, &account.codex_home, root, Some(role.clone()), None);
    let out = match server.open_thread(role, role["model"].as_str().unwrap_or(""), root, true, None) {
        Ok(opened) => merge(&base, &json!({ "ok": true, "account": account.name, "sandbox": opened.sandbox, "approvalPolicy": opened.approval_policy,
            "servers": opened.servers, "instructionSources": opened.instruction_sources })),
        Err(e) => merge(&base, &json!({ "ok": false, "account": account.name, "error": e.message })),
    };
    server.stop();
    Ok(out)
}
