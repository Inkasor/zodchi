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

use serde_json::{json, Map, Value};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use zodchi_core::config::Config;
use zodchi_core::role::{check_role, load_role, Overrides};
use zodchi_core::util::{fail, is_key, iso, read_stored, sha256_hex, write_json_atomic, GatewayError, Result};

use super::Executor;
use crate::models::{claude_enabled, Pick};

/// A Claude program to run instead of `claude` on PATH; a `.js` or `.mjs` file runs with the Node on PATH.
pub const ENV_BIN: &str = "ZODCHI_CLAUDE_BIN";
/// The system prompt of every call: Claude Code's own (about tools and a workspace) does not apply.
const SYSTEM: &str = "You answer one step of an automated workflow. You have no tools and no files beyond what the message holds. Reply with exactly one JSON object as the message asks, and nothing else.";
/// Settings of every call: no hook runs, whatever the person's settings say.
const SETTINGS: &str = "{\"disableAllHooks\": true}\n";
const OUTPUT_LIMIT: usize = 16 << 20;
const RUN_ID_LEN: usize = 22; // "20261118-120000-abcdef"
/// The field of a stored Claude role that carries the account the run was bound to at the gate.
const ROLE_ACCOUNT: &str = "claudeAccount";

/// The Claude program: an executable, or a script run by Node.
#[derive(Clone, Debug)]
pub struct Program {
    pub exe: PathBuf,
    pub script: Option<PathBuf>,
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).flat_map(|dir| names.iter().map(move |n| dir.join(n))).find(|c| c.is_file())
}

/// `ZODCHI_CLAUDE_BIN` when it is set; otherwise the native `claude` on PATH (`claude.exe` on Windows: a `.cmd`
/// shim is a shell script and is never run). The reason when there is none.
pub fn find_program() -> std::result::Result<Program, String> {
    if let Some(bin) = std::env::var_os(ENV_BIN).filter(|v| !v.is_empty()) {
        let bin = PathBuf::from(bin);
        if !bin.is_file() {
            return Err(format!("the claude program is missing ({ENV_BIN} names {}, which is not a file)", bin.display()));
        }
        let ext = bin.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if ext == "js" || ext == "mjs" {
            let Some(node) = on_path(if cfg!(windows) { &["node.exe"] } else { &["node"] }) else {
                return Err(format!("{ENV_BIN} is a script and there is no node on PATH to run it"));
            };
            return Ok(Program { exe: node, script: Some(bin) });
        }
        return Ok(Program { exe: bin, script: None });
    }
    match on_path(if cfg!(windows) { &["claude.exe"] } else { &["claude"] }) {
        Some(exe) => Ok(Program { exe, script: None }),
        None => Err(format!("the claude program is missing (no native claude on PATH; or set {ENV_BIN})")),
    }
}

/// Whether a variable of the caller stays out of the Claude child: API keys and other providers (no fallback from
/// the subscription to a key or another account), credentials of other tools, and the marks of a parent session.
fn withheld(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    if n == "CLAUDE_CODE_OAUTH_TOKEN" {
        return false; // the person's own subscription sign-in for headless use
    }
    n.starts_with("ANTHROPIC_")
        || n.starts_with("CLAUDE_CODE_USE_")
        || n.starts_with("AWS_BEARER_TOKEN")
        || n == "CLAUDECODE"
        || n == "CLAUDE_CODE_ENTRYPOINT"
        || n.starts_with("ZODCHI_FLOW_")
        || ["API_KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD"].iter().any(|w| n.contains(w))
}

fn command(p: &Program) -> Command {
    let mut c = Command::new(&p.exe);
    if let Some(script) = &p.script {
        c.arg(script);
    }
    for (name, _) in std::env::vars_os() {
        if withheld(&name.to_string_lossy()) {
            c.env_remove(&name);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0); // the whole group goes on a timeout
    }
    c
}

/// What a finished program left.
pub struct Ran {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
}

fn reader(mut from: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut from).take(OUTPUT_LIMIT as u64).read_to_end(&mut buf);
        let _ = io::copy(&mut from, &mut io::sink());
        let _ = tx.send(buf);
    });
    rx
}

/// Runs `c` with `input` on stdin in `cwd` for at most `limit`; a program still running then is stopped with what it
/// started. An error: the program did not start, so nothing was sent.
pub fn run(mut c: Command, input: &[u8], cwd: &Path, limit: Duration) -> io::Result<Ran> {
    c.current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let input = input.to_vec();
    std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = reader(child.stdout.take().expect("piped stdout"));
    let err = reader(child.stderr.take().expect("piped stderr"));
    let deadline = Instant::now() + limit;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                zodchi_core::process::kill_tree(child.id());
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break child.wait().ok(),
        }
    };
    // A grandchild that keeps a pipe open must not hold the engine: the output is taken as it is after a while.
    let take = |rx: mpsc::Receiver<Vec<u8>>| rx.recv_timeout(Duration::from_secs(10)).unwrap_or_default();
    Ok(Ran { code: status.and_then(|s| s.code()), stdout: take(out), stderr: take(err), timed_out })
}

/// The arguments of a call: one turn, the model and effort of the pick, no tools, no MCP, no hooks or plugins, no
/// session kept, the final result as JSON.
pub fn call_args(model: &str, effort: &str, settings: &Path) -> Vec<OsString> {
    let mut a: Vec<OsString> = ["-p", "--model", model, "--effort", effort, "--output-format", "json", "--tools", "", "--strict-mcp-config",
        "--disable-slash-commands", "--no-session-persistence", "--safe-mode", "--settings"].iter().map(OsString::from).collect();
    a.push(settings.as_os_str().to_owned());
    a.push("--system-prompt".into());
    a.push(SYSTEM.into());
    a
}

/// The message Claude gets: the role's frame, the step's prompt, then the form of the answer.
pub fn message(instructions: &str, prompt: &str, schema: &Value) -> String {
    let schema = serde_json::to_string_pretty(schema).unwrap_or_default();
    let frame = instructions.trim();
    format!("{frame}{}{prompt}\n\n# The answer\n\nAnswer with one JSON object that follows this JSON Schema, and nothing else: no text before or after it, no code fence.\n\n{schema}\n",
        if frame.is_empty() { "" } else { "\n\n" })
}

fn clip(text: &str, n: usize) -> String {
    let t = text.trim();
    if t.chars().count() > n { format!("{}...", t.chars().take(n).collect::<String>()) } else { t.to_string() }
}

/// The end of the program's error output for a message, without lines that may hold a credential.
fn stderr_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text.lines().filter(|l| {
        let low = l.to_ascii_lowercase();
        !["password", "token", "key", "secret", "cookie", "bearer", "authorization", "@"].iter().any(|w| low.contains(w))
    }).collect();
    let tail = lines[lines.len().saturating_sub(5)..].join(" | ");
    clip(&tail, 400)
}

/// The JSON object of a model's final message: as it is, or inside one code fence.
fn json_of(text: &str) -> Option<Value> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    let inner = t.strip_prefix("```json").or_else(|| t.strip_prefix("```"))?.strip_suffix("```")?;
    serde_json::from_str(inner.trim()).ok()
}

/// The validated answer of a call from `claude -p --output-format json`, or why there is none.
pub fn read_answer(stdout: &[u8], schema: &Value) -> std::result::Result<Value, String> {
    let Ok(out) = serde_json::from_slice::<Value>(stdout) else {
        return Err(format!("the output of claude is not its JSON result: {}", clip(&String::from_utf8_lossy(stdout), 200)));
    };
    if out["type"] != json!("result") {
        return Err("the output of claude is not a result".into());
    }
    let text = out["result"].as_str().unwrap_or("");
    if out["is_error"] == json!(true) || out["subtype"].as_str().is_some_and(|s| s != "success") {
        return Err(format!("claude ended with an error: {}", clip(if text.is_empty() { out["subtype"].as_str().unwrap_or("?") } else { text }, 300)));
    }
    let Some(data) = json_of(text) else {
        return Err(format!("the answer is not one JSON object: {}", clip(text, 200)));
    };
    conforms(&data, schema, "answer").map_err(|why| format!("the answer does not follow the step's schema: {why}"))?;
    Ok(data)
}

fn type_ok(v: &Value, t: &str) -> bool {
    match t {
        "object" => v.is_object(),
        "array" => v.is_array(),
        "string" => v.is_string(),
        "null" => v.is_null(),
        "boolean" => v.is_boolean(),
        "number" => v.is_number(),
        "integer" => v.is_i64() || v.is_u64(),
        _ => true,
    }
}

/// The JSON Schema keywords the flow schemas use: type (one or a list), enum, const, required, properties,
/// additionalProperties and items. Other keywords (descriptions, titles) say nothing about validity.
pub fn conforms(v: &Value, schema: &Value, at: &str) -> std::result::Result<(), String> {
    let Some(s) = schema.as_object() else { return Ok(()) };
    match s.get("type") {
        Some(Value::String(t)) if !type_ok(v, t) => return Err(format!("{at} is not of type {t}")),
        Some(Value::Array(ts)) if !ts.iter().filter_map(Value::as_str).any(|t| type_ok(v, t)) => {
            return Err(format!("{at} is none of the types {}", Value::Array(ts.clone())));
        }
        _ => {}
    }
    if let Some(list) = s.get("enum").and_then(Value::as_array) {
        if !list.contains(v) {
            return Err(format!("{at} is not one of {}", Value::Array(list.clone())));
        }
    }
    if let Some(c) = s.get("const") {
        if c != v {
            return Err(format!("{at} is not {c}"));
        }
    }
    if let Some(obj) = v.as_object() {
        let empty = Map::new();
        let props = s.get("properties").and_then(Value::as_object).unwrap_or(&empty);
        for r in s.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !obj.contains_key(r) {
                return Err(format!("{at} has no {r}"));
            }
        }
        for (k, val) in obj {
            match (props.get(k), s.get("additionalProperties")) {
                (Some(p), _) => conforms(val, p, &format!("{at}.{k}"))?,
                (None, Some(Value::Bool(false))) => return Err(format!("{at} has {k}, which the schema does not allow")),
                (None, Some(extra @ Value::Object(_))) => conforms(val, extra, &format!("{at}.{k}"))?,
                _ => {}
            }
        }
    }
    if let (Some(list), Some(items)) = (v.as_array(), s.get("items")) {
        for (i, item) in list.iter().enumerate() {
            conforms(item, items, &format!("{at}[{i}]"))?;
        }
    }
    Ok(())
}

/// The program's version (`claude --version`), or why it does not run.
pub fn version(p: &Program, cwd: &Path) -> std::result::Result<String, String> {
    let mut c = command(p);
    c.arg("--version");
    let ran = run(c, b"", cwd, Duration::from_secs(60)).map_err(|e| format!("claude --version did not start: {e}"))?;
    let text = String::from_utf8_lossy(&ran.stdout).trim().to_string();
    match (ran.timed_out, ran.code) {
        (true, _) => Err("claude --version did not answer within a minute".into()),
        (false, Some(0)) if !text.is_empty() => Ok(clip(text.lines().next().unwrap_or(""), 80)),
        (false, code) => Err(format!("claude --version exited {}: {}", code.map_or("without a code".into(), |c| c.to_string()), stderr_tail(&ran.stderr))),
    }
}

/// The account a sign-in names, as a local binding that holds no secret and no address: a digest of the e-mail and
/// the organization `claude auth status` reports. A sign-in that names neither cannot be bound to a run.
pub fn account_of(status: &Value) -> std::result::Result<String, String> {
    let email = status["email"].as_str().unwrap_or("").trim().to_ascii_lowercase();
    let org = status["orgId"].as_str().unwrap_or("").trim().to_string();
    if email.is_empty() && org.is_empty() {
        return Err("claude auth status names no account (no email or orgId), so the run cannot be bound to it".into());
    }
    Ok(format!("claude-{}", &sha256_hex(format!("zodchi claude account\n{email}\n{org}"))[..16]))
}

/// Whether Claude Code is signed in with a Claude subscription (`claude auth status --json`), with the variables of
/// the call: an API key, a key helper or another provider is refused. Only the kind of sign-in is named; the account
/// comes back as its binding (`account_of`), never as its name.
pub fn signed_in(p: &Program, cwd: &Path) -> std::result::Result<String, String> {
    let mut c = command(p);
    c.args(["auth", "status", "--json"]);
    let ran = run(c, b"", cwd, Duration::from_secs(60)).map_err(|e| format!("claude auth status did not start: {e}"))?;
    let Ok(v) = serde_json::from_slice::<Value>(&ran.stdout) else {
        return Err(format!("claude auth status gave no JSON (exit {})", ran.code.map_or("none".into(), |c| c.to_string())));
    };
    let method = v["authMethod"].as_str().unwrap_or("none");
    let provider = v["apiProvider"].as_str().unwrap_or("firstParty");
    if v["loggedIn"] != json!(true) || method != "claude.ai" || provider != "firstParty" {
        return Err(format!("Claude Code is not signed in with a Claude subscription (claude auth status: authMethod {}, apiProvider {})", clip(method, 40), clip(provider, 40)));
    }
    account_of(&v)
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

/// How far a failed call came.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sent {
    /// The program never started: nothing was sent.
    No,
    /// The program ran and ended without a valid answer.
    Yes,
    /// The program ran past the time limit and was stopped.
    TimedOut,
}

/// The outcome of a call: `Ok` with the validated answer and the raw output, or `Err` with how far it came, why, and
/// the raw output.
pub type Outcome = std::result::Result<(Value, String), (Sent, String, String)>;

/// What a program that ran left, judged: an answer counts only when it is valid and the program exited 0. A valid
/// answer followed by a crash or another exit code is a failure, with the raw output kept.
pub fn judge(ran: &Ran, schema: &Value, limit: Duration) -> Outcome {
    let raw = String::from_utf8_lossy(&ran.stdout).into_owned();
    if ran.timed_out {
        return Err((Sent::TimedOut, format!("no answer within {} min: the call was stopped", limit.as_secs().div_ceil(60)), raw));
    }
    let exit = format!("claude exited {}", ran.code.map_or("without a code".into(), |c| c.to_string()));
    match (read_answer(&ran.stdout, schema), ran.code) {
        (Ok(data), Some(0)) => Ok((data, raw)),
        (Ok(_), _) => Err((Sent::Yes, format!("{exit} after an answer in the schema, so the call is not taken as done: {}", stderr_tail(&ran.stderr)), raw)),
        (Err(_), code) if code != Some(0) && raw.trim().is_empty() => Err((Sent::Yes, format!("{exit}: {}", stderr_tail(&ran.stderr)), raw)),
        (Err(why), Some(0)) => Err((Sent::Yes, why, raw)),
        (Err(why), _) => Err((Sent::Yes, format!("{why} ({exit})"), raw)),
    }
}

/// One call in `dir`, which the caller owns: the settings and an empty working folder are made there. `started`
/// runs right before the program is started; an error from it starts nothing.
#[allow(clippy::too_many_arguments)]
pub fn call(p: &Program, dir: &Path, model: &str, effort: &str, text: &str, schema: &Value, limit: Duration, started: impl FnOnce() -> Result<()>) -> Outcome {
    let settings = dir.join("settings.json");
    let cwd = dir.join("cwd");
    let prepared = fs::write(&settings, SETTINGS).and_then(|_| fs::create_dir_all(&cwd));
    if let Err(e) = prepared {
        return Err((Sent::No, format!("cannot prepare the call folder: {e}"), String::new()));
    }
    let mut c = command(p);
    c.args(call_args(model, effort, &settings));
    if let Err(e) = started() {
        return Err((Sent::No, format!("cannot record the start of the call: {}", e.0), String::new()));
    }
    match run(c, text.as_bytes(), &cwd, limit) {
        Ok(ran) => judge(&ran, schema, limit),
        Err(e) => Err((Sent::No, format!("claude did not start: {e}"), String::new())),
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

    fn result(text: &str) -> Vec<u8> {
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": text }).to_string().into_bytes()
    }

    #[test]
    fn answers_are_read_and_checked() {
        let schema = json!({ "type": "object", "additionalProperties": false, "required": ["ok", "list"],
            "properties": { "ok": { "type": "boolean" }, "list": { "type": "array", "items": { "type": ["string", "null"] } } } });
        assert_eq!(read_answer(&result(r#"{"ok": true, "list": ["a", null]}"#), &schema).unwrap(), json!({ "ok": true, "list": ["a", null] }));
        assert!(read_answer(&result("```json\n{\"ok\": false, \"list\": []}\n```"), &schema).is_ok());
        assert!(read_answer(&result(r#"{"ok": true}"#), &schema).unwrap_err().contains("has no list"));
        assert!(read_answer(&result(r#"{"ok": true, "list": [], "more": 1}"#), &schema).unwrap_err().contains("does not allow"));
        assert!(read_answer(&result(r#"{"ok": "yes", "list": []}"#), &schema).unwrap_err().contains("not of type boolean"));
        assert!(read_answer(&result(r#"{"ok": true, "list": [1]}"#), &schema).unwrap_err().contains("none of the types"));
        assert!(read_answer(&result("Here it is: {}"), &schema).unwrap_err().contains("not one JSON object"));
        assert!(read_answer(b"not json", &schema).is_err());
        let refused = json!({ "type": "result", "subtype": "success", "is_error": true, "result": "There's an issue with the selected model" });
        assert!(read_answer(refused.to_string().as_bytes(), &schema).unwrap_err().starts_with("claude ended with an error"));
    }

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
    fn keys_and_credentials_stay_out() {
        for name in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "OPENAI_API_KEY", "GH_TOKEN", "CLAUDECODE", "ZODCHI_FLOW_CUT"] {
            assert!(withheld(name), "{name}");
        }
        for name in ["PATH", "HOME", "USERPROFILE", "APPDATA", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY"] {
            assert!(!withheld(name), "{name}");
        }
        let args: Vec<String> = call_args("opus", "high", Path::new("s.json")).iter().map(|a| a.to_string_lossy().into_owned()).collect();
        let at = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[at + 1], "");
        for flag in ["-p", "--strict-mcp-config", "--safe-mode", "--no-session-persistence", "--disable-slash-commands"] {
            assert!(args.contains(&flag.to_string()), "{flag}");
        }
        assert!(!args.iter().any(|a| a.contains("fallback")));
        assert!(stderr_tail(b"fine\nAuthorization: Bearer abc\napi key x\n").ends_with("fine"));
    }

    #[test]
    fn an_answer_counts_only_with_a_clean_exit() {
        let schema = json!({ "type": "object", "required": ["ok"], "properties": { "ok": { "type": "boolean" } } });
        let ran = |code: Option<i32>, out: &[u8]| Ran { code, stdout: out.to_vec(), stderr: b"crashed after the answer\n".to_vec(), timed_out: false };
        let limit = Duration::from_secs(60);
        assert_eq!(judge(&ran(Some(0), &result(r#"{"ok": true}"#)), &schema, limit).unwrap().0, json!({ "ok": true }));
        for code in [Some(1), Some(3), None] {
            let (sent, why, raw) = judge(&ran(code, &result(r#"{"ok": true}"#)), &schema, limit).unwrap_err();
            assert_eq!(sent, Sent::Yes);
            assert!(why.starts_with("claude exited") && why.contains("not taken as done") && raw.contains(r#""type":"result""#), "{why}");
        }
        assert!(judge(&ran(Some(2), b""), &schema, limit).unwrap_err().1.ends_with("crashed after the answer"));
        assert!(judge(&ran(Some(1), &result("prose")), &schema, limit).unwrap_err().1.contains("not one JSON object"));
        let mut late = ran(Some(0), &result(r#"{"ok": true}"#));
        late.timed_out = true;
        assert_eq!(judge(&late, &schema, limit).unwrap_err().0, Sent::TimedOut);
    }

    #[test]
    fn an_account_is_a_digest_of_the_sign_in() {
        let one = account_of(&json!({ "email": format!("Person@{}", "example.test"), "orgId": "org-1", "subscriptionType": "max" })).unwrap();
        assert!(one.starts_with("claude-") && one.len() == 23 && !one.contains("org-1"), "{one}");
        assert_eq!(one, account_of(&json!({ "email": format!("person@{}", "example.test"), "orgId": "org-1" })).unwrap());
        assert_ne!(one, account_of(&json!({ "email": format!("person@{}", "example.test"), "orgId": "org-2" })).unwrap());
        assert!(account_of(&json!({ "loggedIn": true, "authMethod": "claude.ai" })).is_err());
    }

    #[test]
    fn a_cut_job_is_read_by_how_far_it_came() {
        let dir = std::env::temp_dir().join(format!("zodchi-claude-test-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        let key = "flow-test-write";
        assert!(final_state(&dir, key).is_err(), "no folder: no job");
        fs::create_dir_all(&dir).unwrap();
        let reserved = final_state(&dir, key).unwrap();
        assert_eq!((reserved["status"].as_str(), reserved["turnStartedAt"].is_null()), (Some("failed"), true), "a reserved key never started");
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

    #[test]
    fn a_call_past_its_limit_is_stopped() {
        let Some(node) = on_path(if cfg!(windows) { &["node.exe"] } else { &["node"] }) else { return };
        let mut c = Command::new(node);
        c.args(["-e", "process.stdin.resume(); setTimeout(() => {}, 60000)"]);
        let started = Instant::now();
        let ran = run(c, b"input", &std::env::temp_dir(), Duration::from_millis(500)).unwrap();
        assert!(ran.timed_out && started.elapsed() < Duration::from_secs(30));
        let mut c = Command::new(on_path(if cfg!(windows) { &["node.exe"] } else { &["node"] }).unwrap());
        c.args(["-e", "let s = ''; process.stdin.on('data', d => s += d).on('end', () => process.stdout.write(s.toUpperCase()))"]);
        let ran = run(c, b"echo", &std::env::temp_dir(), Duration::from_secs(30)).unwrap();
        assert_eq!((ran.code, ran.stdout.as_slice(), ran.timed_out), (Some(0), b"ECHO".as_slice(), false));
    }
}
