//! The HTTP API. Every route but `/health` needs an identity from the [`Authenticator`]; a user sees only their own
//! jobs (another user's key is 404, never 403) and runs only on their own subscription. Jobs are the core's job
//! folders under `<data>/users/<id>/jobs`, so idempotency, the queue, workers and settling come from `zodchi-core`.

use crate::auth::{Authenticator, Identity, Refusal};
use crate::lock::PidLock;
use crate::login::Logins;
use crate::public::{error_value, job_error, job_view, log, PublicError};
use crate::{registry, signal};
use base64::Engine;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zodchi_core::appserver::image_type;
use zodchi_core::config::Config;
use zodchi_core::job::{self, compose_prompt, is_terminal, read_job, Request, LIMIT_IMAGES, LIMIT_IMAGE_BYTES, LIMIT_PROMPT};
use zodchi_core::role::{load_role, roles, Overrides};
use zodchi_core::util::{fail, is_key, is_role_name, is_user_id, pretty, sha256_hex, GatewayError, Result};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The largest request body.
pub const LIMIT_BODY: usize = 32 * 1024 * 1024;
/// The fewest HTTP threads: at most half of them wait in long polls, so with two there is always one that does not.
pub const MIN_THREADS: usize = 2;
/// The longest wait of `GET /v1/jobs/{key}?waitSec=n`.
pub const MAX_WAIT_SEC: u64 = 60;

#[derive(Debug, Clone)]
pub struct Options {
    pub data: PathBuf,
    pub listen: String,
    pub threads: usize,
    pub max_user_jobs: usize,
    pub max_jobs: usize,
}

impl Options {
    pub fn new(data: PathBuf) -> Options {
        Options { data, listen: "127.0.0.1:8787".into(), threads: 16, max_user_jobs: 4, max_jobs: 16 }
    }
}

/// One answer of the API.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, value: &Value) -> Reply {
        Reply { status, content_type: "application/json", body: (pretty(value) + "\n").into_bytes() }
    }
    /// A public error: `{"error": {code, message}}`. The message is fixed text, or composed from the client's own
    /// request; never a server value (see `public`).
    pub fn error(status: u16, code: &'static str, message: impl Into<String>) -> Reply {
        Reply::public(&PublicError::new(status, code, message))
    }
    pub fn public(error: &PublicError) -> Reply {
        Reply::json(error.status, &json!({ "error": error.value() }))
    }
    pub fn json_of(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

pub struct App {
    data: PathBuf,
    auth: Box<dyn Authenticator>,
    pub logins: Logins,
    /// Looking up a key, counting the unfinished jobs and creating the job are one step for the whole server.
    admission: Mutex<()>,
    polls: AtomicUsize,
    max_polls: usize,
    /// Set when serving stops: long polls give up their wait, so the threads can be joined.
    stopping: AtomicBool,
    max_user_jobs: usize,
    max_jobs: usize,
}

/// A place among the long polls, given back when dropped.
struct Poll<'a>(&'a AtomicUsize);
impl Drop for Poll<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A 500 `storage_error`: the server cannot read or write its own files. The `detail` (a path, an I/O error) goes to
/// the server's log; the client gets `public` and nothing of the detail.
fn storage(public: impl Into<String>, detail: &str) -> Reply {
    let public = public.into();
    log(&public, detail);
    Reply::error(500, "storage_error", public)
}

/// A 500 `storage_error` with the common message.
fn storage_error(detail: &str) -> Reply {
    storage("The server cannot read or write its files for this request. The server's operator has the details.", detail)
}

fn status_of(job: &Value) -> &str {
    job.get("status").and_then(Value::as_str).unwrap_or("")
}

fn content_type(file: &str) -> &'static str {
    match file.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// An output image of a job is `out-<n>.<ext>` in the job folder and nothing else.
fn is_output_file(name: &str) -> bool {
    name.starts_with("out-") && name.len() < 40 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.') && !name.contains("..")
}

/// A JSON body field the server refuses, with the reason.
fn refused_field(name: &str) -> Option<&'static str> {
    Some(match name {
        "paid" | "questions" => "A decisions call (paid) is refused: it spends from the OpenAI API key, which on this server would be its owner's.",
        "resume" | "keepThread" => "resume and keepThread belong to a work call; the server runs no work calls.",
        _ => return None,
    })
}

const FIELDS: [&str; 8] = ["key", "role", "prompt", "images", "model", "effort", "timeoutMin", "credits"];

/// The client's request, checked, with its fingerprint.
struct JobRequest {
    key: String,
    role: String,
    prompt: String,
    images: Vec<Vec<u8>>,
    overrides: Overrides,
    credits: bool,
    fingerprint: String,
}

fn job_request(body: &[u8]) -> std::result::Result<JobRequest, String> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "The body is not JSON.".to_string())?;
    let Value::Object(map) = value else { return Err("The body is a JSON object.".into()) };
    for name in map.keys() {
        if let Some(reason) = refused_field(name) {
            return Err(reason.into());
        }
        if !FIELDS.contains(&name.as_str()) {
            return Err(format!("Unknown field \"{name}\". A job takes {}.", FIELDS.join(", ")));
        }
    }
    let text = |name: &str| -> std::result::Result<Option<String>, String> {
        match map.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(format!("{name} is a string.")),
        }
    };
    let key = text("key")?.unwrap_or_default();
    if !is_key(&key) {
        return Err("key is 1-96 characters: A-Z a-z 0-9 . _ -".into());
    }
    let role = match map.get("role") {
        Some(Value::String(s)) if is_role_name(s) => s.clone(),
        Some(Value::String(_)) | Some(Value::Object(_)) => {
            return Err("role is the name of a role installed on the server (a-z 0-9 -); a role file or an inline role is refused.".into())
        }
        _ => return Err("role is required: the name of a role installed on the server (GET /v1/roles).".into()),
    };
    let prompt = text("prompt")?.unwrap_or_default();
    if prompt.trim().is_empty() {
        return Err("prompt is required.".into());
    }
    if prompt.len() > LIMIT_PROMPT {
        return Err(format!("The prompt is larger than {} KB.", LIMIT_PROMPT / 1024));
    }
    let mut images = Vec::new();
    let mut image_hashes = Vec::new();
    match map.get("images") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            if list.len() > LIMIT_IMAGES {
                return Err(format!("At most {LIMIT_IMAGES} images."));
            }
            for (index, item) in list.iter().enumerate() {
                let Some(encoded) = item.as_str() else { return Err(format!("Image {}: a base64 string.", index + 1)) };
                let encoded = match encoded.split_once(";base64,") {
                    Some((head, rest)) if head.starts_with("data:") => rest,
                    _ => encoded,
                };
                let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim())
                    .map_err(|_| format!("Image {}: not base64.", index + 1))?;
                if image_type(&bytes).is_none() || bytes.len() > LIMIT_IMAGE_BYTES {
                    return Err(format!("Image {}: PNG, JPEG or WebP up to {} MB.", index + 1, LIMIT_IMAGE_BYTES / 1024 / 1024));
                }
                image_hashes.push(sha256_hex(&bytes));
                images.push(bytes);
            }
        }
        Some(_) => return Err("images is an array of base64 strings.".into()),
    }
    let model = text("model")?;
    let effort = text("effort")?;
    let timeout_min = match map.get("timeoutMin") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_f64(),
        Some(_) => return Err("timeoutMin is a number.".into()),
    };
    let credits = match map.get("credits") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("credits is true or false.".into()),
    };
    // The fingerprint is the canonical client request, so a later change of the installed role does not turn a
    // repeat of the same request into a conflict.
    let canonical = json!({ "role": role, "prompt": prompt, "images": image_hashes, "model": model, "effort": effort,
        "timeoutMin": timeout_min.map(zodchi_core::role::js_number), "credits": credits });
    let fingerprint = format!("client:{}", sha256_hex(canonical.to_string()));
    Ok(JobRequest { key, role, prompt, images, overrides: Overrides { model, effort, timeout_min, questions: None }, credits, fingerprint })
}

fn query_value<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| pair.split_once('=').filter(|(k, _)| *k == name).map(|(_, v)| v))
}

impl App {
    pub fn new(data: &Path, auth: Box<dyn Authenticator>, opts: &Options) -> Result<App> {
        let data = std::path::absolute(data)?;
        Ok(App {
            logins: Logins::new(&data),
            data,
            auth,
            admission: Mutex::new(()),
            polls: AtomicUsize::new(0),
            // Half of the threads at most, and never the last one (see MIN_THREADS).
            max_polls: (opts.threads / 2).min(opts.threads.saturating_sub(1)),
            stopping: AtomicBool::new(false),
            max_user_jobs: opts.max_user_jobs,
            max_jobs: opts.max_jobs,
        })
    }

    pub fn data(&self) -> &Path {
        &self.data
    }

    /// One request. `body` is read only by the routes that take one. Every error in the answer is a public error
    /// (see `public`): a code and a fixed message, never a server value.
    pub fn handle(&self, method: &str, url: &str, headers: &[(String, String)], body: &mut dyn Read) -> Reply {
        self.route(method, url, headers, body)
    }

    fn route(&self, method: &str, url: &str, headers: &[(String, String)], body: &mut dyn Read) -> Reply {
        let (path, query) = url.split_once('?').unwrap_or((url, ""));
        let parts: Vec<&str> = path.trim_end_matches('/').split('/').skip(1).collect();
        if parts == ["health"] {
            return match method {
                "GET" => Reply::json(200, &json!({ "ok": true, "version": VERSION })),
                _ => Reply::error(405, "method_not_allowed", "Use GET /health."),
            };
        }
        let who = match self.auth.authenticate(headers) {
            Ok(who) if is_user_id(&who.id) => who,
            Ok(_) => return Reply::error(500, "unavailable", "The server cannot tell who is calling now; nobody gets in. The server's operator has the details."),
            // The authenticator's own words are not passed on: the client gets one fixed text for each.
            Err(Refusal::Unauthorized(_)) => return Reply::error(401, "unauthorized", "Authorization: Bearer <token> is required, and the token must be valid."),
            Err(Refusal::Unavailable(detail)) => {
                log("The authenticator cannot decide.", &detail);
                return Reply::error(500, "unavailable", "The server cannot tell who is calling now; nobody gets in. The server's operator has the details.");
            }
        };
        let sign_in = |outcome: std::result::Result<Value, PublicError>| outcome.map(|v| Reply::json(200, &v)).unwrap_or_else(|e| Reply::public(&e));
        match (method, parts.as_slice()) {
            ("POST", ["v1", "login"]) => sign_in(self.logins.start(&who.id)),
            ("GET", ["v1", "login"]) => sign_in(self.logins.status(&who.id)),
            ("DELETE", ["v1", "login"]) => sign_in(self.logins.logout(&who.id)),
            ("GET", ["v1", "account"]) => self.account(&who),
            ("GET", ["v1", "roles"]) => self.roles(&who),
            ("POST", ["v1", "jobs"]) => self.submit(&who, body),
            ("GET", ["v1", "jobs", key]) => self.job(&who, key, query_value(query, "waitSec")),
            ("GET", ["v1", "jobs", key, "result"]) => self.result(&who, key, None),
            ("GET", ["v1", "jobs", key, "result", index]) => self.result(&who, key, Some(index)),
            (_, ["v1", "login"] | ["v1", "account"] | ["v1", "roles"] | ["v1", "jobs", ..]) => {
                Reply::error(405, "method_not_allowed", format!("{method} is not a method of {path}."))
            }
            _ => Reply::error(404, "not_found", format!("No route {path}.")),
        }
    }

    fn tenant(&self, who: &Identity) -> Result<Config> {
        Config::tenant(&self.data, &who.id)
    }

    fn account(&self, who: &Identity) -> Reply {
        let cfg = match self.tenant(who) {
            Ok(cfg) => cfg,
            Err(e) => return storage_error(&e.0),
        };
        if let Err(e) = fs::create_dir_all(&cfg.accounts[0].codex_home) {
            return storage_error(&e.to_string());
        }
        let mut out = job::account(&cfg);
        // The Codex home and the hint (which names it) are the server's; an `error` is what Codex said, which goes to
        // the log, and the client gets a public error in its place.
        let strip = |v: &mut Value| {
            if let Some(m) = v.as_object_mut() {
                m.shift_remove("codexHome");
                m.shift_remove("hint");
                if let Some(raw) = m.get("error").map(|e| e.as_str().map(String::from).unwrap_or_else(|| e.to_string())) {
                    log(&format!("Codex cannot read the account of {}.", who.id), &raw);
                    m.insert("error".into(), error_value("codex_unavailable", "Codex cannot read this sign-in now. The server's operator has the details.", None));
                }
            }
        };
        strip(&mut out);
        if let Some(rows) = out.get_mut("accounts").and_then(Value::as_array_mut) {
            rows.iter_mut().for_each(strip);
        }
        Reply::json(200, &out)
    }

    /// The roles a call to this server may name: installed expert roles of the text and image kinds.
    fn roles(&self, who: &Identity) -> Reply {
        let cfg = match self.tenant(who) {
            Ok(cfg) => cfg,
            Err(e) => return storage_error(&e.0),
        };
        let callable: Vec<Value> = roles(&cfg).into_iter()
            .filter(|r| r.get("error").is_none() && r.get("mode").and_then(Value::as_str) == Some("expert") && r.get("kind").and_then(Value::as_str) != Some("decisions"))
            .map(|mut r| {
                if let Some(m) = r.as_object_mut() {
                    m.shift_remove("source");
                }
                r
            })
            .collect();
        Reply::json(200, &Value::Array(callable))
    }

    /// The unfinished jobs of the caller and of the whole server, from the job folders on disk (every user's,
    /// removed users' included). A job without a live worker is settled first, so it stops counting. The count
    /// fails closed: a folder that cannot be listed is an error (the job is refused), and a job folder whose record
    /// cannot be read counts as unfinished, since its worker may still be running.
    fn unfinished(&self, me: &str) -> Result<(usize, usize)> {
        let (mut mine, mut all) = (0, 0);
        let listing = |dir: &Path| -> Result<Option<fs::ReadDir>> {
            match fs::read_dir(dir) {
                Ok(entries) => Ok(Some(entries)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => fail(format!("The unfinished jobs cannot be counted: {} cannot be read: {e}", dir.display())),
            }
        };
        let users_dir = self.data.join("users");
        let Some(users) = listing(&users_dir)? else { return Ok((0, 0)) };
        for user in users {
            let user = user.map_err(|e| GatewayError(format!("The unfinished jobs cannot be counted: {}: {e}", users_dir.display())))?;
            let id = user.file_name().to_string_lossy().into_owned();
            // Only user folders hold jobs; anything else in users/ is not the server's.
            let Ok(cfg) = Config::tenant(&self.data, &id) else { continue };
            let jobs_dir = user.path().join("jobs");
            let Some(jobs) = listing(&jobs_dir)? else { continue };
            for entry in jobs {
                let entry = entry.map_err(|e| GatewayError(format!("The unfinished jobs cannot be counted: {}: {e}", jobs_dir.display())))?;
                let key = entry.file_name().to_string_lossy().into_owned();
                let is_dir = entry.file_type().map_err(|e| GatewayError(format!("The unfinished jobs cannot be counted: {}: {e}", entry.path().display())))?.is_dir();
                if !is_key(&key) || !is_dir {
                    continue;
                }
                let open = match read_job(&entry.path()) {
                    Some(found) if is_terminal(status_of(&found)) => false,
                    Some(_) => job::job(&cfg, &key).map(|j| !is_terminal(status_of(&j))).unwrap_or(true),
                    None => true,
                };
                if open {
                    all += 1;
                    if id == me {
                        mine += 1;
                    }
                }
            }
        }
        Ok((mine, all))
    }

    fn submit(&self, who: &Identity, body: &mut dyn Read) -> Reply {
        let mut bytes = Vec::new();
        if body.take(LIMIT_BODY as u64 + 1).read_to_end(&mut bytes).is_err() {
            return Reply::error(400, "bad_request", "The body could not be read.");
        }
        if bytes.len() > LIMIT_BODY {
            return Reply::error(400, "bad_request", format!("The body is larger than {} MB.", LIMIT_BODY / 1024 / 1024));
        }
        let req = match job_request(&bytes) {
            Ok(r) => r,
            Err(reason) => return Reply::error(400, "bad_request", reason),
        };
        let cfg = match self.tenant(who) {
            Ok(c) => c,
            Err(e) => return storage_error(&e.0),
        };
        let dir = cfg.jobs_dir.as_ref().expect("a tenant has a job root").join(&req.key);
        let created = {
            let _admission = self.admission.lock().unwrap_or_else(|p| p.into_inner());
            // A repeat of an existing key is answered from its job and never refused by admission.
            if dir.exists() {
                let Some(found) = read_job(&dir) else {
                    return Reply::public(&PublicError::new(409, "key_conflict", format!("The folder of job {} exists without a job; use a new key.", req.key)).field("key"));
                };
                if found.get("requestSha256").and_then(Value::as_str) != Some(req.fingerprint.as_str()) {
                    return Reply::public(&PublicError::new(409, "key_conflict", format!("Key {} already belongs to a different request. A new request needs a new key.", req.key)).field("key"));
                }
                return match job::job(&cfg, &req.key) {
                    Ok(current) => Reply::json(200, &json!({ "job": job_view(&current), "created": false })),
                    Err(e) => storage_error(&e.0),
                };
            }
            // The role as installed first: a failure here is the server's role, never the client's. The overrides come
            // after: a failure then is about the model, effort or timeoutMin the client sent.
            let installed = match load_role(&cfg, &req.role, &Overrides::default()) {
                Ok(r) => r,
                // The folders looked in and the text of the failure are the server's own business: they go to the log.
                Err(e) if e.0.starts_with("No role ") => {
                    return Reply::public(&PublicError::new(400, "role_not_found", format!("No role {} is installed on this server; GET /v1/roles lists them.", req.role)).field("role"))
                }
                Err(e) => {
                    let public = format!("Role {} is installed but cannot be loaded. The server's operator has the details.", req.role);
                    log(&public, &e.0);
                    return Reply::public(&PublicError::new(400, "role_invalid", public).field("role"));
                }
            };
            let overridden = req.overrides.model.is_some() || req.overrides.effort.is_some() || req.overrides.timeout_min.is_some();
            let role = if !overridden {
                installed
            } else {
                match load_role(&cfg, &req.role, &req.overrides) {
                    Ok(r) => r,
                    Err(e) => {
                        let public = "model, effort or timeoutMin is not accepted; check them against GET /v1/roles.";
                        log(public, &e.0);
                        return Reply::public(&PublicError::new(400, "bad_request", public));
                    }
                }
            };
            if role.get("kind").and_then(Value::as_str) == Some("decisions") {
                return Reply::public(&PublicError::new(400, "role_not_allowed", format!("Role {} is a decisions call (paid): it spends from the OpenAI API key, which on this server would be its owner's.", req.role)).field("role"));
            }
            if role.get("mode").and_then(Value::as_str) == Some("work") {
                return Reply::public(&PublicError::new(400, "role_not_allowed", format!("Role {} works in a repository; the server has no repository of the caller to work in.", req.role)).field("role"));
            }
            let (mine, all) = match self.unfinished(&who.id) {
                Ok(counts) => counts,
                // The reason names folders of the data root: it is logged, the caller learns only that the key is free.
                Err(e) => return storage(format!("The unfinished jobs cannot be counted; the job is refused. The key {} is still free.", req.key), &e.0),
            };
            if mine >= self.max_user_jobs {
                return Reply::error(429, "busy", format!("You have {mine} unfinished jobs; at most {} at once. The key {} is still free.", self.max_user_jobs, req.key));
            }
            if all >= self.max_jobs {
                return Reply::error(429, "busy", format!("The server has {all} unfinished jobs; at most {} at once. The key {} is still free.", self.max_jobs, req.key));
            }
            let prompt = match compose_prompt(&req.prompt, &[]) {
                Ok(p) => p,
                Err(e) => return storage(format!("The prompt could not be composed. The key {} is still free.", req.key), &e.0),
            };
            let request = Request { key: req.key.clone(), role, prompt, images: req.images, credits: req.credits, paid: false,
                resume: None, keep_thread: None, fingerprint: Some(req.fingerprint.clone()) };
            // What the client could get wrong was checked above (the request, the role, the images, the prompt), so a
            // failure here is the server's: its folders and files. The core removes a half-made job, so the key is free.
            match job::submit(&cfg, &request, false) {
                Ok((current, created)) => (current, created),
                Err(e) => return storage(format!("The job could not be stored; nothing was spent. The key {} is still free.", req.key), &e.0),
            }
        };
        let (current, is_new) = created;
        if is_new {
            if let Err(e) = self.spawn_worker(&who.id, &req.key) {
                // The job stays queued; without a worker it is settled as failed, nothing spent.
                eprintln!("zodchi-server: no worker for job {} of {}: {e}", req.key, who.id);
            }
        }
        Reply::json(if is_new { 201 } else { 200 }, &json!({ "job": job_view(&current), "created": is_new }))
    }

    fn spawn_worker(&self, user: &str, key: &str) -> Result<()> {
        let args: Vec<std::ffi::OsString> =
            vec!["work".into(), "--data".into(), self.data.clone().into(), "--user".into(), user.into(), "--key".into(), key.into()];
        let mut child = job::spawn_detached(&args, false)?;
        // The server outlives its workers: each one is waited on, so a finished worker is reaped, not a zombie.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    fn find(&self, who: &Identity, key: &str) -> std::result::Result<(Config, Value), Reply> {
        let missing = || Reply::error(404, "not_found", format!("No job {key}."));
        if !is_key(key) {
            return Err(missing());
        }
        let cfg = self.tenant(who).map_err(|e| storage_error(&e.0))?;
        if !cfg.jobs_dir.as_ref().expect("a tenant has a job root").join(key).is_dir() {
            return Err(missing());
        }
        match job::job(&cfg, key) {
            Ok(found) => Ok((cfg, found)),
            Err(_) => Err(missing()),
        }
    }

    fn job(&self, who: &Identity, key: &str, wait: Option<&str>) -> Reply {
        let (cfg, mut current) = match self.find(who, key) {
            Ok(found) => found,
            Err(reply) => return reply,
        };
        let seconds = match wait.map(str::parse::<u64>) {
            None => 0,
            Some(Ok(n)) => n.min(MAX_WAIT_SEC),
            Some(Err(_)) => return Reply::error(400, "bad_request", "waitSec is a whole number of seconds."),
        };
        if seconds > 0 && !is_terminal(status_of(&current)) {
            // At most half of the threads wait; over that the job is answered as it is.
            if let Some(_poll) = self.enter_poll() {
                // In slices of a second, so that a stopping server is not held up by a long poll.
                let deadline = Instant::now() + Duration::from_secs(seconds);
                while !is_terminal(status_of(&current)) && !self.stopping.load(Ordering::SeqCst) {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    match job::wait(&cfg, key, left.min(Duration::from_secs(1))) {
                        Ok(found) => current = found,
                        Err(e) => return storage_error(&e.0),
                    }
                }
            }
        }
        Reply::json(200, &json!({ "job": job_view(&current) }))
    }

    /// A place among the long polls, or None when half of the threads already wait.
    fn enter_poll(&self) -> Option<Poll<'_>> {
        let mut now = self.polls.load(Ordering::SeqCst);
        while now < self.max_polls {
            match self.polls.compare_exchange(now, now + 1, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return Some(Poll(&self.polls)),
                Err(seen) => now = seen,
            }
        }
        None
    }

    fn result(&self, who: &Identity, key: &str, index: Option<&str>) -> Reply {
        let (cfg, done) = match self.find(who, key) {
            Ok(found) => found,
            Err(reply) => return reply,
        };
        let status = status_of(&done);
        if !is_terminal(status) {
            return Reply::json(409, &json!({ "status": status, "error": error_value("not_final", "The job is not final yet.", None) }));
        }
        if status != "succeeded" {
            // The stored error is dropped: the public one is mapped from the status.
            let error = job_error(status).unwrap_or_else(|| error_value("job_failed", "The job failed. The server's operator has the details.", None));
            return Reply::json(422, &json!({ "status": status, "error": error }));
        }
        let result = done.get("result").cloned().unwrap_or(Value::Null);
        if done.get("kind").and_then(Value::as_str) == Some("image") {
            let images = result.get("images").and_then(Value::as_array).cloned().unwrap_or_default();
            let Some(index) = index else {
                let list: Vec<Value> = images.iter().enumerate().map(|(i, image)| {
                    let file = image.get("file").and_then(Value::as_str).unwrap_or("");
                    json!({ "index": i, "contentType": content_type(file), "bytes": image.get("bytes").cloned().unwrap_or(Value::Null),
                        "url": format!("/v1/jobs/{key}/result/{i}") })
                }).collect();
                return Reply::json(200, &json!({ "images": list }));
            };
            let file = index.parse::<usize>().ok().and_then(|i| images.get(i)).and_then(|image| image.get("file")).and_then(Value::as_str);
            let Some(file) = file.filter(|f| is_output_file(f)) else { return Reply::error(404, "not_found", format!("Job {key} has no image {index}.")) };
            let dir = cfg.jobs_dir.as_ref().expect("a tenant has a job root").join(key);
            return match fs::read(dir.join(file)) {
                Ok(bytes) => Reply { status: 200, content_type: content_type(file), body: bytes },
                Err(e) => storage(format!("The image of job {key} cannot be read."), &e.to_string()),
            };
        }
        if index.is_some() {
            return Reply::error(404, "not_found", format!("Job {key} made no images."));
        }
        let data = result.get("data").cloned().unwrap_or(Value::Null);
        if !data.is_null() {
            return Reply::json(200, &data);
        }
        let text = result.get("text").and_then(Value::as_str).unwrap_or("").to_string();
        Reply { status: 200, content_type: "text/plain; charset=utf-8", body: text.into_bytes() }
    }
}

fn respond(app: &App, mut request: tiny_http::Request) {
    let headers: Vec<(String, String)> =
        request.headers().iter().map(|h| (h.field.as_str().as_str().to_string(), h.value.as_str().to_string())).collect();
    let method = request.method().as_str().to_string();
    let url = request.url().to_string();
    let too_large = request.body_length().is_some_and(|n| n > LIMIT_BODY);
    let reply = if too_large {
        Reply::error(400, "bad_request", format!("The body is larger than {} MB.", LIMIT_BODY / 1024 / 1024))
    } else {
        app.handle(&method, &url, &headers, request.as_reader())
    };
    let mut response = tiny_http::Response::from_data(reply.body).with_status_code(reply.status);
    if let Ok(header) = tiny_http::Header::from_bytes(&b"Content-Type"[..], reply.content_type.as_bytes()) {
        response = response.with_header(header);
    }
    if reply.status == 401 {
        if let Ok(header) = tiny_http::Header::from_bytes(&b"WWW-Authenticate"[..], &b"Bearer"[..]) {
            response = response.with_header(header);
        }
    }
    let _ = request.respond(response);
}

/// Serves until Ctrl+C or SIGTERM: a fixed pool of threads, one serving process per data folder.
pub fn serve(opts: &Options, auth: Box<dyn Authenticator>) -> Result<()> {
    signal::install();
    let out = serve_until(opts, auth, &|_| {}, &signal::requested);
    signal::finished();
    out
}

/// Serves until `stop` returns true. `ready` gets the address once the server listens. On stop, in this order:
/// sign-in admission is closed and every open sign-in cancelled and stopped; the HTTP threads finish the request
/// at hand and are joined; only then is `server.lock` released, when this returns.
pub fn serve_until(opts: &Options, auth: Box<dyn Authenticator>, ready: &dyn Fn(&str), stop: &dyn Fn() -> bool) -> Result<()> {
    if opts.threads < MIN_THREADS {
        return fail(format!("--threads is at least {MIN_THREADS}: a long poll holds one HTTP thread, and one more must stay free for every other request."));
    }
    let data = std::path::absolute(&opts.data)?;
    fs::create_dir_all(&data)?;
    let Some(_lock) = PidLock::try_acquire(&data.join("server.lock"))? else {
        return fail(format!("Another zodchi-server serves {} (server.lock is held by a live process).", data.display()));
    };
    registry::ensure(&data)?;
    let http = tiny_http::Server::http(opts.listen.as_str()).map_err(|e| GatewayError(format!("Cannot listen on {}: {e}", opts.listen)))?;
    let address = http.server_addr().to_ip().map(|a| a.to_string()).unwrap_or_else(|| opts.listen.clone());
    let app = Arc::new(App::new(&data, auth, opts)?);
    let http = Arc::new(http);
    let handlers: Vec<_> = (0..opts.threads).map(|_| {
        let (app, http) = (Arc::clone(&app), Arc::clone(&http));
        std::thread::spawn(move || {
            // A short wait for the next request, so a stopping server is seen between requests.
            while !app.stopping.load(Ordering::SeqCst) {
                match http.recv_timeout(Duration::from_millis(200)) {
                    Ok(Some(request)) => respond(&app, request),
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        })
    }).collect();
    println!("zodchi-server {VERSION} listening on http://{address} (data {})", data.display());
    use std::io::Write;
    let _ = std::io::stdout().flush();
    ready(&address);
    while !stop() {
        std::thread::sleep(Duration::from_millis(200));
    }
    eprintln!("zodchi-server: stopping; open sign-ins are cancelled.");
    // Sign-ins first: no new attempt is admitted from here on, and every open one is cancelled.
    app.logins.shutdown();
    app.stopping.store(true, Ordering::SeqCst);
    for handler in handlers {
        let _ = handler.join();
    }
    // Requests still queued and not taken are dropped with the listener; then the lock goes.
    drop(http);
    drop(_lock);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fingerprint_is_the_client_request() {
        let a = job_request(br#"{"key":"k1","role":"ask","prompt":"hi"}"#).ok().unwrap();
        let b = job_request(br#"{"prompt":"hi","role":"ask","key":"k1","credits":false}"#).ok().unwrap();
        let c = job_request(br#"{"key":"k1","role":"ask","prompt":"hi","effort":"high"}"#).ok().unwrap();
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_ne!(a.fingerprint, c.fingerprint);
    }

    #[test]
    fn refused_requests() {
        let refused = |body: &str| job_request(body.as_bytes()).err().unwrap_or_default();
        assert!(refused(r#"{"key":"k","role":"ask","prompt":"p","paid":true}"#).contains("OpenAI API key"));
        assert!(refused(r#"{"key":"k","role":"ask","prompt":"p","resume":"x"}"#).contains("work call"));
        assert!(refused(r#"{"key":"k","role":{"mode":"expert"},"prompt":"p"}"#).contains("inline role"));
        assert!(refused(r#"{"key":"k","role":"x.json","prompt":"p"}"#).contains("role file"));
        assert!(refused(r#"{"key":"k","role":"ask","prompt":"p","images":["","","","","","","","",""]}"#).contains("At most 8"));
        assert!(refused(r#"{"key":"k","role":"ask","prompt":"p","other":1}"#).contains("Unknown field"));
    }

    #[test]
    fn output_files_stay_in_the_job_folder() {
        assert!(is_output_file("out-0.png"));
        assert!(!is_output_file("../out-0.png"));
        assert!(!is_output_file("out-0/../../x"));
        assert!(!is_output_file("request.json"));
    }
}
