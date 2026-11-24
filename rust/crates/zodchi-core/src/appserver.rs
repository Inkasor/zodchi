//! One `codex app-server` process, spoken to over stdio JSON-RPC, for one gateway job.
//! The role of the call decides what the model may touch. An expert call is a function: a fresh ephemeral thread
//! with no shell, no MCP, no plugins, no hooks and no project files. A work call is Codex working in the checkout
//! under the configuration of the repository, narrowed to what the role lists.

use crate::process::kill_tree;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

pub const CLIENT_NAME: &str = "zodchi-gateway";
pub const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// forced_login_method keeps a job on the ChatGPT account: an API key is never used as a fallback.
const COMMON_CONFIG: [&str; 4] =
    ["approval_policy=\"never\"", "forced_login_method=\"chatgpt\"", "model_provider=\"openai\"", "notify=[]"];
const EXPERT_CONFIG: [&str; 2] = ["project_doc_max_bytes=0", "web_search=\"disabled\""];
/// Every enabled feature adds tool descriptions to each turn and lets the model act on the machine.
pub const EXPERT_DISABLED: [&str; 23] = [
    "shell_tool", "unified_exec", "apps", "hooks", "multi_agent", "goals", "browser_use", "browser_use_external",
    "computer_use", "remote_plugin", "memories", "plugins", "skill_search", "sleep_tool", "in_app_browser",
    "in_app_local_automation", "guardian_approval", "mentions_v2", "image_generation", "shell_snapshot",
    "skill_mcp_dependency_install", "plugin_discovery_prefetch", "context_management",
];
/// Off in a work call unless the role enables them: they reach outside the checkout or write into the user's Codex.
pub const WORK_DISABLED: [&str; 11] = [
    "apps", "plugins", "remote_plugin", "plugin_discovery_prefetch", "skill_mcp_dependency_install", "browser_use",
    "browser_use_external", "computer_use", "in_app_browser", "in_app_local_automation", "memories",
];
/// What an image role needs: the image tool, reached from the `exec` tool of code mode.
pub const IMAGE_FEATURES: [&str; 2] = ["image_generation", "code_mode_host"];
pub const IMAGE_INSTRUCTIONS: &str = "This is an image job. Make the requested image with the image generation tool, exactly once. \
Pass on what the request says about the subject, the style, the format and the background as it is written, and add nothing of your own. \
Attached images are references: the request says what to take from them. Do not answer with text instead of the image. \
After the image is made, reply with an empty message.";
/// Replaces the coding-agent system prompt of Codex in an expert call.
pub const BASE_INSTRUCTIONS: &str = "You are a model called by the lead agent of a project. \
Do exactly what the request asks, from the material in the request alone. Do not ask follow-up questions.";
/// Only these variables reach Codex. OPENAI_API_KEY and NODE_OPTIONS of the caller never do.
const ENV_KEEP: [&str; 27] = [
    "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "HTTPS_PROXY",
    "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE",
];
const LIMIT_CODES: [&str; 3] = ["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded"];

pub const SAFETY_BLOCKED: &str = "safety_blocked";
pub const SAFETY_MESSAGE: &str = "Codex flagged this request for possible cybersecurity risk.";

/// How a model call ended when it did not succeed.
#[derive(Debug, Clone)]
pub struct TurnFailed {
    pub code: &'static str,
    pub message: String,
    pub resets_at: Option<Value>,
    /// The JSON-RPC error Codex answered with, when the failure is such an answer.
    pub rpc: Option<Value>,
}

impl TurnFailed {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        TurnFailed { code, message: message.into(), resets_at: None, rpc: None }
    }
}

pub type TurnResult<T> = std::result::Result<T, TurnFailed>;

pub fn classify_error(error: &Value) -> &'static str {
    // Use the explicit provider error, never the content of a prompt, tool result or assistant answer.
    if error["message"].as_str().is_some_and(|message| {
        message.trim_start().starts_with("This content was flagged for possible cybersecurity risk.")
    }) {
        return SAFETY_BLOCKED;
    }
    match error.get("codexErrorInfo") {
        Some(Value::String(s)) if LIMIT_CODES.contains(&s.as_str()) => "limited",
        Some(Value::String(s)) if s == "unauthorized" => "auth_required",
        _ => "failed",
    }
}

/// The extension of a raster the gateway takes and gives, or None for anything else, a file cut short included.
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 16 {
        return None;
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// The answer the gateway gives to a request of Codex: it approves nothing.
fn refusal(method: &str) -> Option<Value> {
    Some(match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => json!({ "decision": "decline" }),
        "item/permissions/requestApproval" => json!({ "permissions": {} }),
        "mcpServer/elicitation/request" => json!({ "action": "decline" }),
        "item/tool/requestUserInput" => json!({ "answers": {} }),
        "item/tool/call" => json!({ "contentItems": [], "success": false }),
        "applyPatchApproval" | "execCommandApproval" => json!({ "decision": "denied" }),
        _ => return None,
    })
}

pub fn environment(codex_home: &Path) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> =
        ENV_KEEP.iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect();
    env.push(("CODEX_HOME".into(), codex_home.display().to_string()));
    env
}

/// The settings and feature flags Codex starts with for a role. Without a role it starts as for an expert call.
pub fn launch_flags(role: Option<&Value>) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mode = role.and_then(|r| r.get("mode")).and_then(Value::as_str).unwrap_or("expert");
    let kind = role.and_then(|r| r.get("kind")).and_then(Value::as_str).unwrap_or("text");
    let strings = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
    };
    if mode != "work" {
        let enable: Vec<String> = if kind == "image" { IMAGE_FEATURES.iter().map(|s| s.to_string()).collect() } else { vec![] };
        let settings = COMMON_CONFIG.iter().chain(EXPERT_CONFIG.iter()).map(|s| s.to_string()).collect();
        let disable = EXPERT_DISABLED.iter().filter(|n| !enable.iter().any(|e| e == *n)).map(|s| s.to_string()).collect();
        return (settings, disable, enable);
    }
    let features = role.and_then(|r| r.get("features"));
    let enable = strings(features.and_then(|f| f.get("enable")));
    let mut disable: Vec<String> = WORK_DISABLED.iter().filter(|n| !enable.iter().any(|e| e == *n)).map(|s| s.to_string()).collect();
    for extra in strings(features.and_then(|f| f.get("disable"))) {
        if !disable.contains(&extra) {
            disable.push(extra);
        }
    }
    (COMMON_CONFIG.iter().map(|s| s.to_string()).collect(), disable, enable)
}

fn launcher(codex_bin: &Path) -> Command {
    let text = codex_bin.to_string_lossy().to_ascii_lowercase();
    if text.ends_with(".js") || text.ends_with(".mjs") {
        let node = if cfg!(windows) { "node.exe" } else { "node" };
        let mut c = Command::new(node);
        c.arg(codex_bin);
        c
    } else {
        Command::new(codex_bin)
    }
}

/// Codex rejects unknown feature flags at startup and the set changes between versions. The probe gets 30 seconds in
/// all, output included, and stops early when `cancelled` says so; a probe that overruns is killed with its tree.
fn supported_features(codex_bin: &Path, codex_home: &Path, cancelled: &dyn Fn() -> bool,
    before_spawn: &mut dyn FnMut() -> TurnResult<()>, on_spawn: &mut dyn FnMut(Option<u32>) -> TurnResult<()>) -> TurnResult<Option<Vec<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<Vec<String>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(found) = cache.lock().unwrap().get(codex_bin) {
        return Ok(found.clone());
    }
    let mut command = launcher(codex_bin);
    command.args(["features", "list"]).env_clear().envs(environment(codex_home)).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    no_window(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let record = |e: TurnFailed| TurnFailed::new("failed", format!("The Codex feature probe could not be recorded: {}; the model was not called.", e.message));
    before_spawn().map_err(record)?;
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(_) => {
            on_spawn(None).map_err(record)?;
            return Ok(None);
        }
    };
    let kill = |child: &mut std::process::Child| {
        kill_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
    };
    if let Err(e) = on_spawn(Some(child.id())) {
        kill(&mut child);
        return Err(record(e));
    }
    let Some(mut stdout) = child.stdout.take() else {
        kill(&mut child);
        return Ok(None);
    };
    let (tx, rx) = channel();
    thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
        let _ = tx.send(text);
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut text = None;
    let mut status = None;
    while Instant::now() < deadline && !cancelled() {
        if status.is_none() {
            status = child.try_wait().ok().flatten();
        }
        if text.is_none() {
            text = rx.recv_timeout(Duration::from_millis(50)).ok();
        }
        if status.is_some() && text.is_some() {
            break;
        }
        if text.is_some() {
            thread::sleep(Duration::from_millis(50));
        }
    }
    if status.is_none() || text.is_none() {
        // Overran or cancelled: the tree goes, which also closes a pipe a descendant held; the reader is abandoned.
        kill(&mut child);
        if cancelled() {
            return Err(TurnFailed::new("unknown", "The Codex process was stopped."));
        }
        return Ok(None);
    }
    let names = status.filter(|s| s.success()).map(|_| {
        text.unwrap_or_default().lines().filter_map(|l| l.split_whitespace().next().map(String::from)).collect::<Vec<_>>()
    });
    cache.lock().unwrap().insert(codex_bin.to_path_buf(), names.clone());
    Ok(names)
}

#[cfg(windows)]
fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn no_window(_command: &mut Command) {}

fn action(item: &Value) -> Option<Value> {
    let get = |k: &str| item.get(k).cloned().unwrap_or(Value::Null);
    match item.get("type").and_then(Value::as_str)? {
        "commandExecution" => {
            let exit = get("exitCode");
            let mut command = json!({ "type": "command", "command": get("command"), "exitCode": exit,
                "status": get("status"), "durationMs": get("durationMs") });
            if matches!(exit.as_i64(), Some(-1073741502 | 3221225794)) {
                command["environmentIssue"] = json!("windows-dll-initialization");
            }
            Some(command)
        }
        "fileChange" => {
            let files: Vec<Value> = item.get("changes").and_then(Value::as_array).cloned().unwrap_or_default().iter().map(|c| {
                let kind = c.get("kind").map(|k| k.get("type").cloned().unwrap_or_else(|| k.clone())).unwrap_or(Value::Null);
                json!({ "path": c.get("path").cloned().unwrap_or(Value::Null), "kind": kind })
            }).collect();
            Some(json!({ "type": "fileChange", "status": get("status"), "files": files }))
        }
        "mcpToolCall" => Some(json!({ "type": "mcp", "server": get("server"), "tool": get("tool"), "status": get("status") })),
        _ => None,
    }
}

/// The picture of an `imageGeneration` item: inline, or the file Codex saved under its own home (never outside it).
pub fn image_bytes(item: &Value, codex_home: &Path) -> Option<Vec<u8>> {
    if let Some(inline) = item.get("result").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(inline) {
            if image_type(&bytes).is_some() {
                return Some(bytes);
            }
        }
    }
    let saved = item.get("savedPath").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let home = fs::canonicalize(codex_home).ok()?;
    let file = fs::canonicalize(saved).ok()?;
    if file == home || !file.starts_with(&home) {
        return None;
    }
    let bytes = fs::read(&file).ok()?;
    image_type(&bytes).map(|_| bytes)
}

#[derive(Default)]
struct Audit {
    seen: Vec<(String, Value)>,
    refused: Vec<String>,
}

type Reply = std::result::Result<Value, Value>;
type AuditHook = Arc<dyn Fn(Value) + Send + Sync>;

struct Shared {
    stdin: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, (String, Sender<Reply>)>>,
    threads: Mutex<HashMap<String, Sender<Value>>>,
    /// Listeners of account-level notifications (`account/...`) and of the exit of the process.
    accounts: Mutex<Vec<Sender<Value>>>,
    audit: Mutex<Audit>,
    on_audit: Mutex<Option<AuditHook>>,
    gone: Mutex<bool>,
}

impl Shared {
    fn snapshot(&self) -> Value {
        let audit = self.audit.lock().unwrap();
        json!({ "actions": audit.seen.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>(), "refused": audit.refused })
    }
    fn notify_audit(&self) {
        let hook = self.on_audit.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(self.snapshot());
        }
    }
    fn write(&self, message: &Value) -> TurnResult<()> {
        let mut guard = self.stdin.lock().unwrap();
        let Some(stdin) = guard.as_mut() else { return Err(TurnFailed::new("unknown", "The Codex process is not running.")) };
        let line = format!("{}\n", message);
        stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|_| TurnFailed::new("unknown", "The Codex process is not running."))
    }
    /// Nothing waits for an answer of a process that is gone or is being stopped.
    fn drop_all(&self) {
        *self.gone.lock().unwrap() = true;
        for (_, (_, tx)) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(json!({ "__gone__": true })));
        }
        for tx in self.threads.lock().unwrap().values() {
            let _ = tx.send(json!({ "method": "__gone__", "params": {} }));
        }
        for tx in self.accounts.lock().unwrap().iter() {
            let _ = tx.send(json!({ "method": "__gone__", "params": {} }));
        }
    }
    fn dispatch(&self, message: Value) {
        let id = message.get("id").filter(|v| !v.is_null()).cloned();
        let method = message.get("method").and_then(Value::as_str).map(String::from);
        match (id, method) {
            (Some(id), None) => {
                let Some(id) = id.as_u64() else { return };
                let Some((_, tx)) = self.pending.lock().unwrap().remove(&id) else { return };
                let reply = match message.get("error") {
                    Some(error) if !error.is_null() => Err(error.clone()),
                    _ => Ok(message.get("result").cloned().unwrap_or(json!({}))),
                };
                let _ = tx.send(reply);
            }
            (Some(id), Some(method)) => {
                self.audit.lock().unwrap().refused.push(method.clone());
                self.notify_audit();
                let answer = match refusal(&method) {
                    Some(result) => json!({ "id": id, "result": result }),
                    None => json!({ "id": id, "error": { "code": -32601, "message": "not supported by the gateway" } }),
                };
                let _ = self.write(&answer);
            }
            (None, Some(method)) => {
                let params = message.get("params").cloned().unwrap_or(json!({}));
                let started = method == "item/started";
                if started || method == "item/completed" {
                    let item = params.get("item").cloned().unwrap_or(json!({}));
                    if let Some(seen) = action(&item) {
                        let item_id = item.get("id").and_then(Value::as_str).map(String::from);
                        if item_id.is_some() || !started {
                            let mut audit = self.audit.lock().unwrap();
                            let key = item_id.unwrap_or_else(|| format!("#{}", audit.seen.len()));
                            if let Some(slot) = audit.seen.iter_mut().find(|(k, _)| *k == key) {
                                slot.1 = seen;
                            } else {
                                audit.seen.push((key, seen));
                            }
                            drop(audit);
                            self.notify_audit();
                        }
                    }
                }
                if method.starts_with("account/") {
                    for tx in self.accounts.lock().unwrap().iter() {
                        let _ = tx.send(json!({ "method": method, "params": params }));
                    }
                }
                let thread_id = params.get("threadId").and_then(Value::as_str)
                    .or_else(|| params.get("thread").and_then(|t| t.get("id")).and_then(Value::as_str));
                if let Some(thread_id) = thread_id {
                    if let Some(tx) = self.threads.lock().unwrap().get(thread_id) {
                        let _ = tx.send(json!({ "method": method, "params": params }));
                    }
                }
            }
            (None, None) => {}
        }
    }
}

/// What a turn produced.
pub struct TurnOutput {
    pub text: String,
    pub images: Vec<(Vec<u8>, Value, Value)>,
    pub tokens: Value,
    pub duration_ms: Value,
}

pub struct OpenedThread {
    pub thread_id: String,
    pub servers: Value,
    pub sandbox: Value,
    pub approval_policy: Value,
    pub instruction_sources: Value,
}

/// Callbacks of a turn: before the request for the turn (an error stops it), once it is accepted, once the thread is open.
pub struct TurnHooks<'a> {
    pub on_thread: &'a mut dyn FnMut(&str, &Value),
    pub on_turn_request: &'a mut dyn FnMut() -> TurnResult<()>,
    pub on_turn_start: &'a mut dyn FnMut(),
}

/// One AppServer is one Codex process. It is started once and is not started again after it exited or was stopped.
pub struct AppServer {
    pub codex_bin: PathBuf,
    pub codex_home: PathBuf,
    pub cwd: PathBuf,
    pub role: Option<Value>,
    pub stderr_file: Option<PathBuf>,
    child: Mutex<Option<Child>>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    started: Mutex<Option<TurnResult<()>>>,
    /// Shutdown: begun (no start after it) and finished (every stop() caller waits for it).
    life: Mutex<Life>,
    life_done: Condvar,
}

#[derive(Default)]
struct Life {
    stopping: bool,
    stopped: bool,
}

impl AppServer {
    pub fn new(codex_bin: &Path, codex_home: &Path, cwd: &Path, role: Option<Value>, stderr_file: Option<PathBuf>) -> Self {
        AppServer {
            codex_bin: codex_bin.to_path_buf(),
            codex_home: codex_home.to_path_buf(),
            cwd: cwd.to_path_buf(),
            role,
            stderr_file,
            child: Mutex::new(None),
            shared: Arc::new(Shared {
                stdin: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                threads: Mutex::new(HashMap::new()),
                accounts: Mutex::new(Vec::new()),
                audit: Mutex::new(Audit::default()),
                on_audit: Mutex::new(None),
                gone: Mutex::new(false),
            }),
            next_id: AtomicU64::new(0),
            started: Mutex::new(None),
            life: Mutex::new(Life::default()),
            life_done: Condvar::new(),
        }
    }

    pub fn set_on_audit(&self, hook: AuditHook) {
        *self.shared.on_audit.lock().unwrap() = Some(hook);
    }

    pub fn snapshot(&self) -> Value {
        self.shared.snapshot()
    }

    /// Account-level notifications of this process (`account/login/completed`, `account/updated`, ...) as
    /// `{method, params}`, and `{"method": "__gone__"}` once the process has exited or was stopped. Subscribe before
    /// the request whose outcome arrives as a notification, so a notification that comes before its answer is kept.
    /// A subscription made after the process is gone gets `__gone__` at once.
    pub fn subscribe_account(&self) -> Receiver<Value> {
        let (tx, rx) = channel();
        self.shared.accounts.lock().unwrap().push(tx.clone());
        if *self.shared.gone.lock().unwrap() {
            let _ = tx.send(json!({ "method": "__gone__", "params": {} }));
        }
        rx
    }

    /// A feature to disable that this Codex does not know is skipped; a feature the role enables must exist.
    /// Called with the child lock held, so the feature probe, like Codex itself, starts only before shutdown and
    /// shutdown waits for it to be killed and reaped. The probe is recorded through the same hooks as Codex.
    fn arguments(&self, before_spawn: &mut dyn FnMut() -> TurnResult<()>, on_spawn: &mut dyn FnMut(Option<u32>) -> TurnResult<()>) -> TurnResult<Vec<String>> {
        let known = supported_features(&self.codex_bin, &self.codex_home, &|| self.life.lock().unwrap().stopping, before_spawn, on_spawn)?;
        let (settings, disable, enable) = launch_flags(self.role.as_ref());
        let mut args = vec!["app-server".to_string()];
        for s in settings {
            args.push("-c".into());
            args.push(s);
        }
        for f in disable {
            if known.as_ref().map(|k| k.contains(&f)).unwrap_or(true) {
                args.push("--disable".into());
                args.push(f);
            }
        }
        for f in enable {
            if known.as_ref().is_some_and(|k| !k.contains(&f)) {
                return Err(TurnFailed::new("failed", format!("The installed Codex has no feature {f}; the model was not called.")));
            }
            args.push("--enable".into());
            args.push(f);
        }
        Ok(args)
    }

    /// Starts Codex once. `before_spawn` runs right before the process is created (an error: no process);
    /// `on_spawn` gets the pid, or None when none came to be.
    pub fn start(&self, before_spawn: &mut dyn FnMut() -> TurnResult<()>, on_spawn: &mut dyn FnMut(Option<u32>) -> TurnResult<()>) -> TurnResult<()> {
        let mut started = self.started.lock().unwrap();
        if let Some(done) = started.clone() {
            return done;
        }
        let result = self.start_once(before_spawn, on_spawn);
        *started = Some(result.clone());
        result
    }

    /// Starts Codex once. `before_spawn` runs right before the process is created (an error: no process);
    /// `on_spawn` gets the pid, or None when none came to be; an error from it stops the process before any request.
    /// Spawning and registering the child happen under the child lock, which stop() takes before it kills, and after
    /// shutdown has begun no process is started.
    fn start_once(&self, before_spawn: &mut dyn FnMut() -> TurnResult<()>, on_spawn: &mut dyn FnMut(Option<u32>) -> TurnResult<()>) -> TurnResult<()> {
        let cancelled = || TurnFailed::new("unknown", "The Codex process was stopped.");
        if self.life.lock().unwrap().stopping {
            return Err(cancelled());
        }
        let mut slot = self.child.lock().unwrap();
        if self.life.lock().unwrap().stopping {
            return Err(cancelled());
        }
        let args = self.arguments(before_spawn, on_spawn)?;
        let mut command = launcher(&self.codex_bin);
        command.args(&args).current_dir(&self.cwd).env_clear().envs(environment(&self.codex_home));
        command.stdin(Stdio::piped()).stdout(Stdio::piped());
        let stderr = match &self.stderr_file {
            Some(file) => fs::OpenOptions::new().create(true).append(true).open(file).map(Stdio::from).unwrap_or_else(|_| Stdio::null()),
            None => Stdio::null(),
        };
        command.stderr(stderr);
        no_window(&mut command);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let stdout = {
            if self.life.lock().unwrap().stopping {
                return Err(cancelled());
            }
            before_spawn().map_err(|e| TurnFailed::new("failed", format!("The Codex process could not be recorded: {}; the model was not called.", e.message)))?;
            let mut child = match command.spawn() {
                Ok(c) => c,
                Err(error) => {
                    let _ = on_spawn(None);
                    return Err(TurnFailed::new("failed", format!("Codex could not be started: {error}; the model was not called.")));
                }
            };
            let pid = child.id();
            *self.shared.stdin.lock().unwrap() = child.stdin.take();
            let stdout = child.stdout.take().expect("piped stdout");
            *slot = Some(child);
            // A process the job could not take note of is not used: it is stopped before any request.
            if let Err(error) = on_spawn(Some(pid)) {
                drop(slot);
                self.stop();
                return Err(TurnFailed::new("failed", format!("The Codex process could not be recorded: {}; the model was not called.", error.message)));
            }
            stdout
        };
        // Registered: the lock goes before any request, since stop() on a failed initialize takes it.
        drop(slot);
        let shared = Arc::clone(&self.shared);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    shared.dispatch(message);
                }
            }
            shared.drop_all();
        });
        let info = json!({ "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION } });
        match self.request("initialize", info, Duration::from_secs(60)) {
            Ok(_) => self.shared.write(&json!({ "method": "initialized", "params": {} })),
            Err(error) => {
                self.stop();
                Err(TurnFailed::new("failed", format!("Codex did not start: {} The model was not called.", error.message)))
            }
        }
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> TurnResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = channel();
        self.shared.pending.lock().unwrap().insert(id, (method.to_string(), tx));
        if *self.shared.gone.lock().unwrap() {
            self.shared.pending.lock().unwrap().remove(&id);
            return Err(TurnFailed::new("unknown", "The Codex process exited."));
        }
        if let Err(error) = self.shared.write(&json!({ "id": id, "method": method, "params": params })) {
            self.shared.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) if error.get("__gone__").is_some() => Err(TurnFailed::new("unknown", "The Codex process exited.")),
            Ok(Err(error)) => {
                let text = error.get("message").and_then(Value::as_str).unwrap_or("error");
                let mut failed = TurnFailed::new("failed", format!("{method}: {text}"));
                failed.rpc = Some(error.clone());
                Err(failed)
            }
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                self.shared.pending.lock().unwrap().remove(&id);
                Err(TurnFailed::new("timeout", format!("Codex did not answer {method}.")))
            }
        }
    }

    /// A request after the process is started (starting it without hooks when needed).
    pub fn send(&self, method: &str, params: Value, timeout: Duration) -> TurnResult<Value> {
        self.start(&mut || Ok(()), &mut |_| Ok(()))?;
        self.request(method, params, timeout)
    }

    pub fn account(&self) -> TurnResult<Value> {
        Ok(self.send("account/read", json!({}), Duration::from_secs(60))?.get("account").cloned().unwrap_or(Value::Null))
    }

    pub fn rate_limits(&self) -> TurnResult<Value> {
        self.send("account/rateLimits/read", json!({}), Duration::from_secs(60))
    }

    fn server_statuses(&self, thread_id: &str) -> TurnResult<Vec<Value>> {
        let mut all = Vec::new();
        let mut cursor: Option<Value> = None;
        loop {
            let mut params = json!({ "threadId": thread_id, "detail": "toolsAndAuthOnly" });
            if let Some(c) = &cursor {
                params["cursor"] = c.clone();
            }
            let page = self.send("mcpServerStatus/list", params, Duration::from_secs(60))?;
            all.extend(page.get("data").and_then(Value::as_array).cloned().unwrap_or_default());
            cursor = page.get("nextCursor").filter(|c| !c.is_null()).cloned();
            if cursor.is_none() {
                return Ok(all);
            }
        }
    }

    /// Opens the thread of the role and proves its MCP servers: every server the role lists is connected and no
    /// other server is.
    pub fn open_thread(&self, role: &Value, model: &str, cwd: &Path, ephemeral: bool, thread_id: Option<&str>) -> TurnResult<OpenedThread> {
        let work = role.get("mode").and_then(Value::as_str) == Some("work");
        let allowed: Vec<String> = if work {
            role.get("mcpServers").and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
        } else {
            vec![]
        };
        let mut config: Map<String, Value> = if work { role.get("config").and_then(Value::as_object).cloned().unwrap_or_default() } else { Map::new() };
        let read = self.send("config/read", json!({ "cwd": cwd.display().to_string() }), Duration::from_secs(60))?;
        let configured: Vec<String> = read.get("config").and_then(|c| c.get("mcp_servers")).and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
        for name in configured {
            if allowed.contains(&name) {
                continue;
            }
            if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                return Err(TurnFailed::new("failed", format!("MCP server \"{name}\" cannot be switched off by name; the model was not called.")));
            }
            config.insert(format!("mcp_servers.{name}.enabled"), json!(false));
        }
        let sandbox = if work { role.get("sandbox").cloned().unwrap_or(json!("read-only")) } else { json!("read-only") };
        let mut params = json!({ "cwd": cwd.display().to_string(), "model": model, "config": config, "approvalPolicy": "never", "sandbox": sandbox });
        let kind = role.get("kind").and_then(Value::as_str).unwrap_or("text");
        let windows_verification = if work && cfg!(windows) {
            "Use focused checks in this work session. If a program exits with STATUS_DLL_INIT_FAILED (0xC0000142, 3221225794 or -1073741502), record the command and exit code as a startup failure and leave its checks unverified. Treat EPERM while creating a test fixture link as a missing environment prerequisite. The lead runs the declared full verification on the candidate with the project runner."
        } else { "" };
        let frame: Vec<&str> = [if kind == "image" { IMAGE_INSTRUCTIONS } else { "" }, role.get("instructions").and_then(Value::as_str).unwrap_or(""), windows_verification]
            .into_iter().filter(|s| !s.is_empty()).collect();
        if !frame.is_empty() {
            params["developerInstructions"] = json!(frame.join("\n\n"));
        }
        if !work {
            params["baseInstructions"] = json!(BASE_INSTRUCTIONS);
        }
        let opened = match thread_id {
            Some(id) => {
                params["threadId"] = json!(id);
                self.send("thread/resume", params, Duration::from_secs(60))?
            }
            None => {
                params["ephemeral"] = json!(ephemeral);
                params["serviceName"] = json!(CLIENT_NAME);
                self.send("thread/start", params, Duration::from_secs(60))?
            }
        };
        let id = opened.get("thread").and_then(|t| t.get("id")).and_then(Value::as_str).unwrap_or("").to_string();
        let mut servers = Map::new();
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let mut waiting = Vec::new();
            for status in self.server_statuses(&id)? {
                let name = status.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                let runtime = status.get("runtimeStatus").cloned().unwrap_or(Value::Null);
                let text = runtime.as_str().unwrap_or("");
                let pending = runtime.is_null() || text == "starting" || text == "notStarted";
                let listed = allowed.contains(&name);
                if listed {
                    servers.insert(name.clone(), runtime.clone());
                }
                if pending {
                    waiting.push(name);
                } else if listed && text != "connected" {
                    return Err(TurnFailed::new("failed", format!("MCP server {name} of the role is {text}; the model was not called.")));
                } else if !listed && text == "connected" {
                    return Err(TurnFailed::new("failed", format!("MCP server {name} is connected, but the role does not list it; the model was not called.")));
                }
            }
            let missing: Vec<&String> = allowed.iter().filter(|n| !servers.contains_key(*n)).collect();
            if !missing.is_empty() {
                let names: Vec<&str> = missing.iter().map(|s| s.as_str()).collect();
                return Err(TurnFailed::new("failed", format!("MCP server {} of the role is not configured in this repository; the model was not called.", names.join(", "))));
            }
            if waiting.is_empty() {
                break;
            }
            if Instant::now() > deadline {
                return Err(TurnFailed::new("failed", format!("MCP servers did not settle: {}; the model was not called.", waiting.join(", "))));
            }
            thread::sleep(Duration::from_secs(1));
        }
        Ok(OpenedThread {
            thread_id: id,
            servers: Value::Object(servers),
            sandbox: opened.get("sandbox").cloned().unwrap_or(Value::Null),
            approval_policy: opened.get("approvalPolicy").cloned().unwrap_or(Value::Null),
            instruction_sources: opened.get("instructionSources").cloned().unwrap_or(json!([])),
        })
    }

    /// One model turn in the role. A turn that was asked for and neither accepted nor refused may have run.
    #[allow(clippy::too_many_arguments)]
    pub fn run_turn(&self, prompt: &str, role: &Value, model: &str, effort: &str, cwd: &Path, image_paths: &[PathBuf],
        resume_thread_id: Option<&str>, keep_thread: bool, timeout: Duration, hooks: TurnHooks<'_>) -> TurnResult<TurnOutput> {
        let work = role.get("mode").and_then(Value::as_str) == Some("work");
        let opened = self.open_thread(role, model, cwd, !(work && keep_thread), resume_thread_id)?;
        let thread_id = opened.thread_id.clone();
        (hooks.on_thread)(&thread_id, &opened.servers);
        let (tx, rx) = channel();
        self.shared.threads.lock().unwrap().insert(thread_id.clone(), tx);
        if *self.shared.gone.lock().unwrap() {
            let _ = self.shared.threads.lock().unwrap().get(&thread_id).map(|t| t.send(json!({ "method": "__gone__" })));
        }
        let result = (|| {
            let mut input = vec![json!({ "type": "text", "text": prompt })];
            for file in image_paths {
                let full = std::path::absolute(file).unwrap_or_else(|_| file.clone());
                input.push(json!({ "type": "localImage", "path": full.display().to_string() }));
            }
            let mut params = json!({ "threadId": thread_id, "input": input, "model": model, "effort": effort });
            if let Some(schema) = role.get("outputSchema").filter(|s| !s.is_null()) {
                params["outputSchema"] = schema.clone();
            }
            (hooks.on_turn_request)()?;
            let accepted = self.send("turn/start", params, Duration::from_secs(60)).map_err(|e| {
                if let Some(rpc) = &e.rpc {
                    if classify_error(rpc) == SAFETY_BLOCKED {
                        return TurnFailed::new(SAFETY_BLOCKED, SAFETY_MESSAGE);
                    }
                    let rpc = rpc.get("message").and_then(Value::as_str).unwrap_or("error");
                    TurnFailed::new("failed", format!("Codex refused the turn: {rpc}. The model was not called."))
                } else {
                    e
                }
            })?;
            (hooks.on_turn_start)();
            let turn_id = accepted.get("turn").and_then(|t| t.get("id")).and_then(Value::as_str).unwrap_or("").to_string();
            let deadline = Instant::now() + timeout;
            let (mut items, mut error, mut turn, mut tokens, mut gone) = (Vec::new(), Value::Null, Value::Null, Value::Null, false);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(left) {
                    Ok(message) => {
                        let params = message.get("params").cloned().unwrap_or(json!({}));
                        match message.get("method").and_then(Value::as_str).unwrap_or("") {
                            "item/completed" => items.push(params.get("item").cloned().unwrap_or(json!({}))),
                            "thread/tokenUsage/updated" => tokens = params.get("tokenUsage").and_then(|t| t.get("total")).cloned().unwrap_or(Value::Null),
                            "error" => {
                                if classify_error(&params["error"]) == SAFETY_BLOCKED {
                                    return Err(TurnFailed::new(SAFETY_BLOCKED, SAFETY_MESSAGE));
                                }
                                if params["willRetry"] != true {
                                    error = params.get("error").cloned().unwrap_or(json!({}));
                                }
                            }
                            "turn/completed" => { turn = params.get("turn").cloned().unwrap_or(json!({})); break; }
                            "__gone__" => { gone = true; break; }
                            _ => {}
                        }
                    }
                    Err(_) => {
                        let _ = self.send("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }), Duration::from_secs(10));
                        return Err(TurnFailed::new("timeout", "The model did not finish in the allowed time."));
                    }
                }
            }
            if gone {
                return Err(TurnFailed::new("unknown", "The Codex process exited during the turn; the outcome is unknown."));
            }
            let turn_error = turn.get("error").filter(|e| !e.is_null()).unwrap_or(&error);
            let status = turn.get("status").and_then(Value::as_str).unwrap_or("");
            if status != "completed" || !turn_error.is_null() {
                if classify_error(turn_error) == SAFETY_BLOCKED || classify_error(&error) == SAFETY_BLOCKED {
                    return Err(TurnFailed::new(SAFETY_BLOCKED, SAFETY_MESSAGE));
                }
                let message = turn_error.get("message").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("The turn ended with status {status}."));
                return Err(TurnFailed::new(classify_error(turn_error), message));
            }
            let mut text = String::new();
            for item in &items {
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") && item.get("phase").and_then(Value::as_str) != Some("commentary") {
                    if let Some(t) = item.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                        text = t.to_string();
                    }
                }
            }
            let wanted = role.get("kind").and_then(Value::as_str) == Some("image");
            let mut images = Vec::new();
            for item in &items {
                if item.get("type").and_then(Value::as_str) != Some("imageGeneration") {
                    continue;
                }
                if let Some(failure) = item.get("failure").filter(|f| !f.is_null()) {
                    if !wanted {
                        continue;
                    }
                    let kind = failure.get("type").and_then(Value::as_str).unwrap_or("no reason given");
                    let mut failed = TurnFailed::new(if kind == "usageLimitExceeded" { "limited" } else { "failed" }, format!("Codex did not make the image: {kind}."));
                    failed.resets_at = failure.get("resetsAt").cloned();
                    return Err(failed);
                }
                match image_bytes(item, &self.codex_home) {
                    Some(bytes) => images.push((bytes, item.get("revisedPrompt").cloned().unwrap_or(Value::Null), item.get("generationId").cloned().unwrap_or(Value::Null))),
                    None if wanted && item.get("status").and_then(Value::as_str) == Some("completed") => {
                        return Err(TurnFailed::new("failed", "Codex reported an image and the gateway could not reach its content as a PNG, JPEG or WebP. The turn ran and was spent."));
                    }
                    None => {}
                }
            }
            Ok(TurnOutput { text, images, tokens, duration_ms: turn.get("durationMs").cloned().unwrap_or(Value::Null) })
        })();
        self.shared.threads.lock().unwrap().remove(&thread_id);
        result
    }

    /// Ends the process: stdin is closed first when that does not wait on a writer, then the process tree is killed if
    /// it has not exited within 5 s. Killing needs only the pid, never the pipe, so a write blocked on a full pipe
    /// cannot hold shutdown up. Every caller returns only once the process is gone.
    pub fn stop(&self) {
        {
            let mut life = self.life.lock().unwrap();
            if life.stopping {
                while !life.stopped {
                    life = self.life_done.wait(life).unwrap();
                }
                return;
            }
            life.stopping = true;
        }
        // A start in progress finishes registering its child before this lock is ours.
        let mut guard = self.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if let Ok(mut stdin) = self.shared.stdin.try_lock() {
                *stdin = None;
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                    _ => {
                        // The child is not reaped yet, so its pid is still this process.
                        kill_tree(child.id());
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
        drop(guard);
        *self.shared.stdin.lock().unwrap() = None;
        self.shared.drop_all();
        let mut life = self.life.lock().unwrap();
        life.stopped = true;
        self.life_done.notify_all();
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worker_command_keeps_the_windows_initialization_failure() {
        for code in [-1073741502_i64, 3221225794] {
            let recorded = action(&json!({ "type": "commandExecution", "exitCode": code })).unwrap();
            assert_eq!(recorded["exitCode"], code);
            assert_eq!(recorded["environmentIssue"], "windows-dll-initialization");
        }
        let test_failure = action(&json!({ "type": "commandExecution", "exitCode": 1 })).unwrap();
        assert!(test_failure.get("environmentIssue").is_none());
    }
}
