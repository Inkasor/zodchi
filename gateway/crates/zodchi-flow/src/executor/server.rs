//! Model steps through a zodchi-server (docs/flow-server.md). The engine, Git, claims, checks and the journal stay on
//! this machine; only the model steps go to the server, each on the subscription of the person whose token is in
//! `~/.zodchi/flow.json` (`{ "server": "<url>", "tokenFile": "<path>" }`).
//!
//! A step is `POST /v1/jobs` with the step's journaled key, the installed role's name, the pinned model and effort,
//! the prompt built here with every file inlined, and the output schema of this workflow version; then
//! `GET /v1/jobs/{key}?waitSec=60` until the job is final, and `GET /v1/jobs/{key}/result` for its answer, which the
//! engine validates. A resumed run looks its journaled key up (`GET /v1/jobs/{key}`). A key the server does not know
//! is posted again under the same key, with the request the journal holds, only when no job of it can have run and
//! gone: the journal has no "submitted" record of it, its intent is younger than the server keeps a finished job, and
//! the token is still the account's the request was made for (`GET /v1/account`, `user`). Otherwise the engine stops
//! with an unknown outcome.
//!
//! HTTP goes through the system `curl`, as the Decisions API of zodchi-core does, so the engine carries no TLS stack
//! of its own: the token is written to curl's stdin as a header and never stands on a command line, in a file the
//! engine writes, in the journal, a log or a prompt. Nothing of the server's answer but the model's result is passed
//! on: the final job the engine gets holds the status, the time the model turn started, an error text written here
//! from the public error code, and the result.

use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use zodchi_core::config::{user_home, Config};
use zodchi_core::job::{is_terminal, LIMIT_PROMPT};
use zodchi_core::util::{fail, is_key, now_ms, parse_iso_ms, read_stored, sha256_hex, GatewayError, Result};

use super::Executor;
use crate::code_package::{REVIEWER_GATEWAY_ROLE, WRITER_GATEWAY_ROLE};
use crate::journal::{flows_dir, is_run_id};
use crate::models::{codex_usable, Pick};

/// How long a submission over the server's limit of unfinished jobs (429 `busy`) is asked again, under the same key.
const BUSY_BOUND: Duration = Duration::from_secs(600);
/// The first pause after a `busy`; it doubles up to `BUSY_MAX_PAUSE`.
const BUSY_FIRST_PAUSE: Duration = Duration::from_secs(2);
const BUSY_MAX_PAUSE: Duration = Duration::from_secs(30);
/// A poll that fails to reach the server is tried this many times in a row (a poll only reads) before the run stops.
const POLL_TRIES: u32 = 3;
const POLL_PAUSE: Duration = Duration::from_secs(5);
/// The long poll of one `GET /v1/jobs/{key}`; the server waits at most 60 seconds.
const WAIT_SEC: u64 = 60;
const LIMIT_TOKEN: usize = 4096;
/// A journaled request that the server does not know is posted again under its key only while its intent is younger
/// than this: the server removes a finished job seven days after it ended, and a job is made after its intent, so a
/// job of a younger intent cannot have run and been removed.
const REPLAY_WINDOW_MS: i128 = 6 * 86_400_000;

/// What a server executor needs, read once when it is made: the base URL and the token. Not `Debug`: the token is
/// never printed.
struct Setup {
    base: String,
    token_file: PathBuf,
    token: String,
    /// A loopback server: no proxy of the environment is used for it.
    loopback: bool,
}

pub struct Server {
    setup: std::result::Result<Setup, String>,
    checked: std::cell::RefCell<Vec<String>>,
    /// The zodchi home, whose journal holds the requests of the runs.
    home: PathBuf,
    /// The server's id of the token's account (`GET /v1/account`, `user`), read by the preflight.
    user: std::cell::RefCell<Option<String>>,
    /// Why a resumed key is not looked up (`exists`): the wait that follows stops the step with it.
    stop: std::cell::RefCell<Option<String>>,
}

/// One answer of the server.
struct Answer {
    status: u16,
    content_type: String,
    body: Vec<u8>,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    /// The public error code of the answer, or `http <status>` when it has none.
    fn code(&self) -> String {
        self.json()["error"]["code"].as_str().filter(|c| is_code(c)).map(str::to_string).unwrap_or_else(|| format!("http {}", self.status))
    }
}

/// A public error code as the server writes them: a-z and `_`, short. Anything else is not repeated.
fn is_code(text: &str) -> bool {
    !text.is_empty() && text.len() <= 40 && text.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// The base URL of a server: `https://host[:port][/prefix]`, or `http://` for a loopback host only (the token would
/// otherwise travel in clear). No user in it, no query, no fragment; a trailing `/` is dropped. Returns the base and
/// whether the host is loopback.
fn base_url(raw: &str) -> std::result::Result<(String, bool), String> {
    let url = raw.trim().trim_end_matches('/');
    // The rejected value is not repeated: a URL refused for a user or a query may hold a credential.
    let bad = |why: &str| Err(format!("The flow server named in flow.json (\"server\") is not usable: {why}."));
    let (secure, rest) = if let Some(rest) = url.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        (false, rest)
    } else {
        return bad("it starts with https://");
    };
    if url.bytes().any(|b| b <= b' ' || b >= 0x7f || matches!(b, b'"' | b'\'' | b'\\' | b'?' | b'#')) {
        return bad("a URL without spaces, quotes, a query or a fragment");
    }
    let authority = rest.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return bad("it names no host");
    }
    if authority.contains('@') {
        return bad("a URL with a user in it would carry a credential; the token goes in tokenFile");
    }
    let host = if authority.starts_with('[') {
        authority.split(']').next().map(|h| format!("{h}]")).unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or("").to_ascii_lowercase()
    };
    let loopback = host == "localhost" || host == "[::1]" || (host.starts_with("127.") && host.split('.').count() == 4 && host.split('.').all(|p| p.parse::<u8>().is_ok()));
    if !secure && !loopback {
        return bad("plain http is for a server on this machine (127.0.0.1, localhost); a server elsewhere is https://, behind its reverse proxy");
    }
    Ok((url.to_string(), loopback))
}

/// A token as a header can carry it: printable ASCII without spaces.
fn check_token(text: &str) -> std::result::Result<String, String> {
    let token = text.trim();
    if token.is_empty() || token.len() > LIMIT_TOKEN || !token.bytes().all(|b| (0x21..0x7f).contains(&b)) {
        return Err("it holds one token, printable characters without spaces".into());
    }
    Ok(token.to_string())
}

/// The `tokenFile` of flow.json: `~/` is the home folder, a relative path is relative to the zodchi home.
fn token_path(home: &Path, raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return user_home().join(rest);
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() { path } else { home.join(path) }
}

fn setup(cfg: &Config, server: &str) -> std::result::Result<Setup, String> {
    let (base, loopback) = base_url(server)?;
    let file = cfg.home.join("flow.json");
    let settings: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let Some(raw) = settings.get("tokenFile").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(format!("{} names a flow server and no tokenFile: put your token for {base} in a file only you can read and name it there as \"tokenFile\".", file.display()));
    };
    let token_file = token_path(&cfg.home, raw);
    let text = std::fs::read_to_string(&token_file).map_err(|_| format!("The token file {} of flow.json cannot be read.", token_file.display()))?;
    let token = check_token(&text).map_err(|why| format!("The token file {} of flow.json is not usable: {why}.", token_file.display()))?;
    Ok(Setup { base, token_file, token, loopback })
}

/// The text of a job that ended without a result, written here from its public code: the server's own words are not
/// passed on.
fn job_error_text(code: &str, base: &str) -> String {
    match code {
        "auth_required" | "sign_in_failed" => sign_in_text(base),
        "limited" => format!("limited: your ChatGPT subscription on the flow server {base} has no limit left; resume after it resets."),
        "timeout" => "timeout: the model call did not end in its time on the flow server and was stopped.".into(),
        "unknown" => "unknown: the flow server does not know whether the model turn ran.".into(),
        "job_failed" | "failed" => "job_failed: the model call failed on the flow server; its operator has the details.".into(),
        other => format!("{other}: the model call ended without a result on the flow server."),
    }
}

fn sign_in_text(base: &str) -> String {
    format!("auth_required: your ChatGPT subscription on the flow server {base} is not signed in. Sign in there first (POST {base}/v1/login with your token, open its verificationUrl and enter its userCode; GET {base}/v1/login says when it is connected), then resume. Nothing was spent.")
}

/// Splits what curl printed: the body, then `\n<content type>\n<status>` from `-w`.
fn split_output(stdout: &[u8]) -> Option<Answer> {
    let at_status = stdout.iter().rposition(|&b| b == b'\n')?;
    let status = std::str::from_utf8(&stdout[at_status + 1..]).ok()?.trim().parse::<u16>().ok()?;
    let at_type = stdout[..at_status].iter().rposition(|&b| b == b'\n')?;
    let content_type = String::from_utf8_lossy(&stdout[at_type + 1..at_status]).trim().to_ascii_lowercase();
    Some(Answer { status, content_type, body: stdout[..at_type].to_vec() })
}

/// The answer of a finished job as the engine reads it: status, model-turn start, an error text of ours, and the
/// model's result. Nothing else of the server's job.
fn final_job(key: &str, job: &Value, data: Option<Value>, base: &str) -> Value {
    let status = job["status"].as_str().unwrap_or("").to_string();
    let error = if status == "succeeded" {
        Value::Null
    } else {
        let code = job["error"]["code"].as_str().filter(|c| is_code(c)).unwrap_or(&status).to_string();
        json!(job_error_text(&code, base))
    };
    let mut out = json!({ "key": key, "status": status, "error": error, "turnStartedAt": job.get("turnStartedAt").cloned().unwrap_or(Value::Null) });
    if let Some(data) = data {
        out["result"] = json!({ "data": data });
    }
    out
}

/// What the journal under `home` holds of a server job's key: its last intent, the request stored for it (checked
/// against the intent's digest), and whether a "submitted" record of the key exists. The run is the one whose id
/// starts the key (`flow-<run>-...`) and whose events name the key in an intent of the server executor.
fn journaled(home: &Path, key: &str) -> std::result::Result<(Value, Value, bool), String> {
    let dir = flows_dir(home);
    let entries = std::fs::read_dir(&dir).map_err(|_| "the journal folder of the runs cannot be read".to_string())?;
    let mut found = None;
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if !is_run_id(&id) || !key.starts_with(&format!("flow-{id}-")) {
            continue;
        }
        let text = std::fs::read_to_string(entry.path().join("events.jsonl")).unwrap_or_default();
        let events: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        let Some(intent) = events.iter().rev().find(|e| e["kind"] == json!("intent") && e["key"] == json!(key)) else { continue };
        if found.is_some() {
            return Err("more than one run of the journal names the key".into());
        }
        let submitted = events.iter().any(|e| e["kind"] == json!("submitted") && e["key"] == json!(key));
        found = Some((entry.path(), intent.clone(), submitted));
    }
    let (run, intent, submitted) = found.ok_or("no run of the journal has an intent of the key")?;
    if intent["effect"] != json!("gateway job") || intent["executor"] != json!("server") {
        return Err("its intent is not a model step of the flow server".into());
    }
    let file = intent["request"].as_str().unwrap_or("");
    let name = file.strip_prefix("requests/").unwrap_or("");
    if name.is_empty() || !name.ends_with(".json") || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_')) || name.contains("..") {
        return Err("its intent names no stored request".into());
    }
    let stored = read_stored(&run.join("requests").join(name)).ok_or("its stored request is missing")?;
    if intent["digest"].as_str() != Some(sha256_hex(stored.to_string()).as_str()) {
        return Err("its stored request does not match the digest of its intent".into());
    }
    Ok((intent, stored, submitted))
}

impl Server {
    pub fn new(cfg: Config, server: String) -> Server {
        Server { setup: setup(&cfg, &server), checked: Default::default(), home: cfg.home.clone(), user: Default::default(), stop: Default::default() }
    }

    fn setup(&self) -> Result<&Setup> {
        self.setup.as_ref().map_err(|why| GatewayError(why.clone()))
    }

    /// One request through the system curl. The token goes to curl's stdin as a header; the body, when there is one,
    /// is a temporary file of this process that holds no token and is removed when curl has ended.
    fn http(&self, method: &str, route: &str, body: Option<&[u8]>, max_time: u64) -> Result<Answer> {
        let s = self.setup()?;
        let url = format!("{}{route}", s.base);
        let mut command = Command::new("curl");
        // --disable first: no curlrc of the user (retries, tracing, its own headers) takes part.
        command.args(["--disable", "-sS", "--proto", "=http,https", "--max-redirs", "0", "--connect-timeout", "15", "--max-time"])
            .arg(max_time.to_string())
            .args(["-X", method])
            .arg(&url)
            .args(["-H", "@-", "-w", "\n%{content_type}\n%{http_code}"]);
        if s.loopback {
            command.args(["--noproxy", "*"]);
        }
        let file = match body {
            Some(bytes) => {
                let file = std::env::temp_dir().join(format!("zodchi-flow-{}-{:08x}.json", std::process::id(), rand::random::<u32>()));
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let written = options.open(&file).and_then(|mut f| f.write_all(bytes));
                if let Err(e) = written {
                    let _ = std::fs::remove_file(&file);
                    return fail(format!("The request to the flow server could not be prepared ({e}); nothing was sent."));
                }
                command.args(["-H", "content-type: application/json", "--data-binary"]).arg(format!("@{}", file.display()));
                Some(file)
            }
            None => None,
        };
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let output = command.spawn().and_then(|mut child| {
            if let Some(mut stdin) = child.stdin.take() {
                // A header line from stdin: curl reads it before it sends anything.
                let _ = stdin.write_all(format!("Authorization: Bearer {}\n", s.token).as_bytes());
            }
            child.wait_with_output()
        });
        if let Some(file) = &file {
            let _ = std::fs::remove_file(file);
        }
        let output = output.map_err(|e| GatewayError(format!("curl could not be started for the flow server ({e}); curl is needed on PATH. Nothing was sent.")))?;
        let answer = if output.status.success() { split_output(&output.stdout) } else { None };
        answer.ok_or_else(|| {
            let said = String::from_utf8_lossy(&output.stderr).lines().next().unwrap_or("").trim().chars().take(300).collect::<String>();
            GatewayError(format!("{method} {url}: the flow server could not be reached or did not answer in time (curl exit {}: {said}).", output.status.code().map(|c| c.to_string()).unwrap_or_else(|| "none".into())))
        })
    }

    /// The error of an answer that is not what the step needs, from its public code.
    fn refusal(&self, what: &str, answer: &Answer) -> GatewayError {
        let s = match self.setup() {
            Ok(s) => s,
            Err(e) => return e,
        };
        let code = answer.code();
        GatewayError(match code.as_str() {
            "unauthorized" => format!("{what}: the flow server {} refused the token in {} (unauthorized). Check the file, or ask the server's admin for a new token.", s.base, s.token_file.display()),
            "auth_required" | "sign_in_failed" => sign_in_text(&s.base),
            "role_not_found" => format!("{what}: the flow server {} has not installed the role of this request (role_not_found); its admin installs the roles of this zodchi version.", s.base),
            _ => format!("{what}: the flow server {} answered {} {code}.", s.base, answer.status),
        })
    }

    /// The roles a step needs are installed on the server (`GET /v1/roles`, once per executor) and the caller's
    /// subscription there is signed in and has limit left (`GET /v1/account`). Nothing is submitted; a failure names
    /// what to do. The gate of a run can call this before it claims anything.
    pub fn preflight(&self, roles: &[&str]) -> Result<()> {
        let missing: Vec<&str> = roles.iter().copied().filter(|r| !self.checked.borrow().iter().any(|c| c == r)).collect();
        if missing.is_empty() {
            return Ok(());
        }
        let s = self.setup()?;
        let listed = self.http("GET", "/v1/roles", None, 60)?;
        if listed.status != 200 {
            return Err(self.refusal("GET /v1/roles", &listed));
        }
        let rows = listed.json().as_array().cloned().unwrap_or_default();
        for name in &missing {
            let row = rows.iter().find(|r| r["role"].as_str() == Some(name));
            match row {
                None => return fail(format!("The flow server {} has no role {name} (GET /v1/roles): its admin installs the roles of this zodchi version there. Nothing was submitted.", s.base)),
                Some(r) if !(r["kind"].is_null() || r["kind"] == json!("text")) => {
                    return fail(format!("The role {name} on the flow server {} is not a text role, so it cannot answer by this workflow's schema. Nothing was submitted.", s.base))
                }
                Some(_) => {}
            }
        }
        let account = self.http("GET", "/v1/account", None, 60)?;
        if account.status != 200 {
            return Err(self.refusal("GET /v1/account", &account));
        }
        let account = account.json();
        if let Some(code) = account["error"]["code"].as_str() {
            let code = if is_code(code) { code } else { "error" };
            return fail(format!("The flow server {} cannot read your sign-in now ({code}). Nothing was submitted.", s.base));
        }
        if account["connected"] != json!(true) {
            return fail(sign_in_text(&s.base));
        }
        if codex_usable(&account).is_err() {
            return fail(format!("Your ChatGPT subscription on the flow server {} has no limit left now; resume after it resets. Nothing was submitted.", s.base));
        }
        // The account the requests of this run are made for: a resume posts a request again only under the same one.
        *self.user.borrow_mut() = account["user"].as_str().filter(|u| !u.is_empty()).map(str::to_string);
        self.checked.borrow_mut().extend(missing.iter().map(|r| r.to_string()));
        Ok(())
    }

    /// `GET /v1/jobs/{key}?waitSec=60`, tried again a few times when the server cannot be reached (a poll only reads).
    fn poll(&self, key: &str) -> Result<Value> {
        let mut tries = 0;
        loop {
            match self.http("GET", &format!("/v1/jobs/{key}?waitSec={WAIT_SEC}"), None, WAIT_SEC + 60) {
                Ok(a) if a.status == 200 => {
                    let job = a.json()["job"].clone();
                    if job["key"] != json!(key) {
                        return fail(format!("GET /v1/jobs/{key}: the flow server answered without the job."));
                    }
                    return Ok(job);
                }
                Ok(a) if a.status == 404 => return fail(format!("The job {key} is not on the flow server (any more).")),
                Ok(a) => return Err(self.refusal(&format!("GET /v1/jobs/{key}"), &a)),
                Err(e) => {
                    tries += 1;
                    if tries >= POLL_TRIES {
                        return Err(e);
                    }
                    std::thread::sleep(POLL_PAUSE);
                }
            }
        }
    }

    /// The journaled request of `key` was made for the configured server and the token's account: a resumed key is
    /// looked up only then, so a job of the same key on another server or under another account is never taken as
    /// this run's. A mismatch, or a side that cannot be read, names both.
    fn same_origin(&self, key: &str) -> std::result::Result<(), String> {
        let s = self.setup().map_err(|e| e.0)?;
        let (_, stored, _) = journaled(&self.home, key).map_err(|why| format!("The request of {key} cannot be matched with the flow server {} and your account: {why}. Nothing was looked up.", s.base))?;
        let role = &stored["role"];
        let server = role["server"].as_str().unwrap_or("(none)");
        if server != s.base {
            return Err(format!("The request of {key} was made for the flow server {server}, and flow.json now names {}: its job is not looked up there. Put the server back, or run the step again with --rerun.", s.base));
        }
        let account = self.http("GET", "/v1/account", None, 60).map_err(|e| e.0)?;
        if account.status != 200 {
            return Err(self.refusal("GET /v1/account", &account).0);
        }
        let journaled_user = role["user"].as_str().filter(|u| !u.is_empty());
        let user = account.json()["user"].as_str().filter(|u| !u.is_empty()).map(str::to_string);
        if journaled_user.is_none() || journaled_user != user.as_deref() {
            return Err(format!("The request of {key} was made for the account {} on the flow server {}, and the token in {} is of the account {}: its job is not looked up under it. Put the request's token back, or run the step again with --rerun.", journaled_user.unwrap_or("(not named)"), s.base, s.token_file.display(), user.as_deref().unwrap_or("(not named)")));
        }
        Ok(())
    }

    /// Posts the journaled request of a key the server does not know again, under the same key, when no job of it can
    /// have run: the journal has no "submitted" record of it (a "submitted" job that is gone ran, or was taken), its
    /// intent is younger than `REPLAY_WINDOW_MS` (a job made from it cannot have been swept), it was made for this
    /// server, and the token is still the account's it was made for (another person's subscription is never used,
    /// and a job of another account is not seen). True when the job was created now.
    fn replay(&self, key: &str) -> Result<bool> {
        let s = self.setup()?;
        let (intent, stored, submitted) = journaled(&self.home, key).map_err(GatewayError)?;
        if submitted {
            return fail("the journal records it as submitted, so its job was taken and is gone now");
        }
        let at = intent["at"].as_str().and_then(parse_iso_ms).ok_or_else(|| GatewayError("its intent has no time".into()))?;
        if now_ms() - at > REPLAY_WINDOW_MS {
            return fail("its intent is older than six days, so a job of it may have run and been removed by the server");
        }
        let role = &stored["role"];
        if role["server"].as_str() != Some(s.base.as_str()) {
            return fail("its request was made for another flow server");
        }
        let Some(user) = role["user"].as_str().filter(|u| !u.is_empty()) else {
            return fail("its request does not name the account it was made for (the server did not say it)");
        };
        let account = self.http("GET", "/v1/account", None, 60)?;
        if account.status != 200 {
            return Err(self.refusal("GET /v1/account", &account));
        }
        if account.json()["user"].as_str() != Some(user) {
            return fail(format!("the token in {} is not the one of the account the request was made for", s.token_file.display()));
        }
        self.submit(key, &stored)
    }
}

impl Executor for Server {
    /// The request's role: the name of a role installed on the server, the pinned model and effort, the schema of
    /// this version and the server it goes to. The server resolves the role; a missing one stops the step here,
    /// before anything is submitted (the two code-package roles are checked together).
    fn role(&self, name: &str, pick: &Pick, schema: &Value) -> Result<Value> {
        let s = self.setup()?;
        let mut needed = vec![name];
        if name == WRITER_GATEWAY_ROLE || name == REVIEWER_GATEWAY_ROLE {
            needed = vec![WRITER_GATEWAY_ROLE, REVIEWER_GATEWAY_ROLE];
        }
        self.preflight(&needed)?;
        let user = self.user.borrow().clone();
        Ok(json!({ "name": name, "model": pick.model, "effort": pick.effort, "outputSchema": schema, "server": s.base, "user": user }))
    }

    /// `POST /v1/jobs` with the stored request. The same key and request give the same job (200), so asking again
    /// never spends again; a 429 `busy` leaves the key free and is asked again under the same key, for at most
    /// `BUSY_BOUND`. A 409 (the key belongs to another request) and every other refusal stop the step.
    fn submit(&self, key: &str, stored: &Value) -> Result<bool> {
        let s = self.setup()?;
        let role = &stored["role"];
        if role["server"].as_str() != Some(s.base.as_str()) {
            return fail(format!("The request of {key} was made for the flow server {}, and flow.json now names {}: it is not sent elsewhere. Put the server back, or run the step again with --rerun.", role["server"].as_str().unwrap_or("(none)"), s.base));
        }
        let prompt = stored["prompt"].as_str().unwrap_or("");
        if prompt.trim().is_empty() || prompt.trim_end().len() + 1 > LIMIT_PROMPT {
            return fail(format!("The request of {key} is empty or over the server's {} KB; nothing was submitted.", LIMIT_PROMPT / 1024));
        }
        let body = json!({ "key": key, "role": role["name"], "prompt": prompt, "model": role["model"], "effort": role["effort"], "schema": role["outputSchema"] });
        let body = body.to_string().into_bytes();
        let started = Instant::now();
        let mut pause = BUSY_FIRST_PAUSE;
        loop {
            let answer = self.http("POST", "/v1/jobs", Some(&body), 120)?;
            match answer.status {
                200 | 201 => {
                    let v = answer.json();
                    if v["job"]["key"] != json!(key) {
                        return fail(format!("POST /v1/jobs: the flow server answered without the job {key}."));
                    }
                    return Ok(v["created"] == json!(true));
                }
                429 if started.elapsed() + pause <= BUSY_BOUND => {
                    eprintln!("zodchi flow: the flow server is busy (429); asking again for {key} in {} s", pause.as_secs());
                    std::thread::sleep(pause);
                    pause = (pause * 2).min(BUSY_MAX_PAUSE);
                }
                429 => return fail(format!("POST /v1/jobs: the flow server {} stayed busy (429) for {} minutes; the key {key} is still free. Resume later.", s.base, BUSY_BOUND.as_secs() / 60)),
                409 => return fail(format!("POST /v1/jobs: the key {key} belongs to a different request on the flow server {} ({}).", s.base, answer.code())),
                _ => return Err(self.refusal("POST /v1/jobs", &answer)),
            }
        }
    }

    /// Whether the server holds the job of `key` for this token. First the journaled server and account must be the
    /// configured ones (`same_origin`); when they are not, or the server cannot be asked, the answer is yes, and the
    /// wait that follows stops the step with the reason, an infrastructure stop. A `404` is a key the server never got (a cut
    /// between the intent and the `POST`) or a job that is gone: the journaled request is posted again under the same
    /// key when `replay` can rule the second out, and the answer is then yes; otherwise no, and the engine stops with
    /// an unknown outcome.
    fn exists(&self, key: &str) -> bool {
        if !is_key(key) {
            return false;
        }
        if let Err(why) = self.same_origin(key) {
            *self.stop.borrow_mut() = Some(why);
            return true;
        }
        if !matches!(self.http("GET", &format!("/v1/jobs/{key}"), None, 60), Ok(a) if a.status == 404) {
            return true;
        }
        match self.replay(key) {
            Ok(created) => {
                eprintln!("zodchi flow: the flow server did not know {key}; its journaled request was posted again under the same key ({})", if created { "a new job" } else { "the job it had" });
                true
            }
            Err(e) => {
                eprintln!("zodchi flow: the flow server does not know {key}, and it is not posted again: {}", e.0);
                false
            }
        }
    }

    /// Polls until the job is final; for a success, reads the result. The job has its own time limit on the server,
    /// so this ends.
    fn wait_final(&self, key: &str) -> Result<Value> {
        let base = self.setup()?.base.clone();
        if let Some(why) = self.stop.borrow_mut().take() {
            return fail(why);
        }
        loop {
            let asked = Instant::now();
            let job = self.poll(key)?;
            let status = job["status"].as_str().unwrap_or("");
            if !is_terminal(status) {
                // A server whose long polls are all taken answers at once: not faster than once a second.
                if asked.elapsed() < Duration::from_secs(1) {
                    std::thread::sleep(Duration::from_secs(1));
                }
                continue;
            }
            if status != "succeeded" {
                return Ok(final_job(key, &job, None, &base));
            }
            let answer = self.http("GET", &format!("/v1/jobs/{key}/result"), None, 120)?;
            if answer.status != 200 {
                return Err(self.refusal(&format!("GET /v1/jobs/{key}/result"), &answer));
            }
            // A JSON result is the model's answer by the schema; anything else is not, and the engine says so.
            let data = if answer.content_type.starts_with("application/json") { answer.json() } else { Value::Null };
            return Ok(final_job(key, &job, Some(data), &base));
        }
    }

    /// A job that failed before its model turn started: nothing was asked, a new key may ask again.
    fn died_before_turn(&self, fin: &Value) -> bool {
        fin["status"] == json!("failed") && fin.get("turnStartedAt").is_none_or(Value::is_null)
    }

    fn name(&self) -> &'static str {
        "server"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls() {
        assert_eq!(base_url("https://gw.example.org/zodchi/").unwrap(), ("https://gw.example.org/zodchi".to_string(), false));
        assert_eq!(base_url("http://127.0.0.1:8787").unwrap(), ("http://127.0.0.1:8787".to_string(), true));
        assert!(base_url("http://localhost:1").unwrap().1);
        assert!(base_url("http://[::1]:1").unwrap().1);
        assert!(base_url("http://gw.example.org").is_err(), "plain http to another machine");
        assert!(base_url("http://127.0.0.1.example.org").is_err(), "not a loopback address");
        assert!(base_url(&format!("https://user:pw{}gw.example.org", "@")).is_err(), "a credential in the URL");
        assert!(base_url("https://gw.example.org/?a=1").is_err(), "a query");
        assert!(base_url("ftp://gw.example.org").is_err());
        assert!(base_url("https://").is_err());
    }

    #[test]
    fn a_refused_url_is_not_repeated() {
        for url in [format!("https://user:SECRET1{}gw.example.org", "@"), "https://gw.example.org/?token=SECRET1".into(), "http://gw.example.org/SECRET1".into(), "SECRET1".into()] {
            let why = base_url(&url).unwrap_err();
            assert!(!why.contains("SECRET1") && why.contains("flow.json"), "{why}");
        }
    }

    #[test]
    fn journaled_requests() {
        let home = std::env::temp_dir().join(format!("zodchi-flow-test-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        let run = flows_dir(&home).join("r1");
        std::fs::create_dir_all(run.join("requests")).unwrap();
        let stored = json!({ "role": { "name": "flow-patch", "server": "http://127.0.0.1:1", "user": "u1" }, "prompt": "p" });
        std::fs::write(run.join("requests").join("flow-r1-write.json"), serde_json::to_string_pretty(&stored).unwrap()).unwrap();
        let intent = |key: &str, extra: Value| {
            let mut e = json!({ "kind": "intent", "step": "write", "effect": "gateway job", "key": key, "request": "requests/flow-r1-write.json", "digest": sha256_hex(stored.to_string()), "executor": "server", "at": "2026-01-01T00:00:00Z" });
            for (k, v) in extra.as_object().unwrap() {
                e[k] = v.clone();
            }
            e.to_string()
        };
        let events = |lines: &[String]| std::fs::write(run.join("events.jsonl"), lines.join("\n") + "\n").unwrap();
        events(&[intent("flow-r1-write", json!({}))]);
        let (i, s, submitted) = journaled(&home, "flow-r1-write").unwrap();
        assert_eq!((i["key"].as_str(), &s, submitted), (Some("flow-r1-write"), &stored, false));
        assert!(journaled(&home, "flow-r2-write").is_err(), "no run of that id");
        assert!(journaled(&home, "flow-r1-review-1").is_err(), "no intent of that key");
        events(&[intent("flow-r1-write", json!({})), json!({ "kind": "submitted", "step": "write", "key": "flow-r1-write", "created": true }).to_string()]);
        assert!(journaled(&home, "flow-r1-write").unwrap().2, "a submitted record is seen");
        events(&[intent("flow-r1-write", json!({ "digest": "0" }))]);
        assert!(journaled(&home, "flow-r1-write").unwrap_err().contains("digest"));
        events(&[intent("flow-r1-write", json!({ "request": "requests/../../x.json" }))]);
        assert!(journaled(&home, "flow-r1-write").unwrap_err().contains("no stored request"));
        events(&[intent("flow-r1-write", json!({ "executor": "local-gateway" }))]);
        assert!(journaled(&home, "flow-r1-write").is_err(), "a local gateway job is not the server's to post");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn tokens() {
        assert_eq!(check_token("zs_abc\n").unwrap(), "zs_abc");
        assert!(check_token("").is_err());
        assert!(check_token("a b").is_err());
        assert!(check_token("a\nb").is_err(), "a second line would be a second header");
    }

    #[test]
    fn curl_output() {
        let a = split_output(b"{\"a\":1}\n\napplication/json\n200").unwrap();
        assert_eq!((a.status, a.content_type.as_str(), a.body.as_slice()), (200, "application/json", b"{\"a\":1}\n".as_slice()));
        let empty = split_output(b"\n\n000").unwrap();
        assert_eq!((empty.status, empty.body.len()), (0, 0));
        assert!(split_output(b"no status").is_none());
    }

    #[test]
    fn final_jobs_carry_only_our_words() {
        let job = json!({ "key": "k", "status": "auth_required", "error": { "code": "auth_required", "message": "SERVER WORDS" }, "account": "u1", "turnStartedAt": null });
        let fin = final_job("k", &job, None, "https://gw.example.org");
        assert_eq!(fin["status"], json!("auth_required"));
        let text = fin["error"].as_str().unwrap();
        assert!(text.contains("/v1/login") && !text.contains("SERVER WORDS"));
        assert!(fin.get("account").is_none() && fin.get("result").is_none());
        let ok = final_job("k", &json!({ "key": "k", "status": "succeeded", "turnStartedAt": "t", "result": { "text": "x" } }), Some(json!({ "a": 1 })), "b");
        assert_eq!(ok["result"], json!({ "data": { "a": 1 } }));
        assert_eq!(ok["error"], Value::Null);
        let odd = final_job("k", &json!({ "status": "failed", "error": { "code": "Not A Code <x>" } }), None, "b");
        assert!(odd["error"].as_str().unwrap().starts_with("job_failed"), "a code that is not one falls back to the status");
    }

    #[test]
    fn death_before_the_turn() {
        let s = Server { setup: Err("none".into()), checked: Default::default(), home: PathBuf::new(), user: Default::default(), stop: Default::default() };
        assert!(s.died_before_turn(&json!({ "status": "failed", "turnStartedAt": null })));
        assert!(!s.died_before_turn(&json!({ "status": "failed", "turnStartedAt": "2026-01-01T00:00:00Z" })));
        assert!(!s.died_before_turn(&json!({ "status": "auth_required" })));
        assert!(!s.exists("not a key"));
        assert!(s.exists("k1"), "a server that cannot be asked is not proof that the job is missing");
    }
}
