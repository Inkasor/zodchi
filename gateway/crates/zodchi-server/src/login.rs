//! Device-code sign-in of each user's own ChatGPT subscription, on a Codex app-server in that user's Codex home.
//!
//! Per user one mutex-guarded state: `none -> pending(attempt, loginId, app-server, deadline) -> connected | failed |
//! none`. A start while pending returns the open attempt. The app-server of a pending attempt lives until
//! `account/login/completed` arrives for its `loginId` or the code expires (15 minutes); then it is cancelled and
//! stopped. Completion events of another `loginId` are ignored. Nothing of an attempt survives a restart, and
//! "connected" is reported only from `account/read` on the user's Codex home (cached for at most 60 s).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use zodchi_core::appserver::AppServer;
use zodchi_core::config::Config;
use zodchi_core::job::mask_email;
use zodchi_core::util::{fail, GatewayError, Result};

/// The life of a device code.
pub const CODE_LIFE: Duration = Duration::from_secs(15 * 60);
/// How long `account/read` of a user is reused.
pub const ACCOUNT_CACHE: Duration = Duration::from_secs(60);
const RPC: Duration = Duration::from_secs(60);

struct Pending {
    attempt: u64,
    login_id: String,
    server: Arc<AppServer>,
    deadline: Instant,
    verification_url: String,
    user_code: String,
}

enum State {
    None,
    Pending(Pending),
    /// The last attempt completed; what is reported still comes from `account/read`.
    Connected,
    Failed(String),
}

type Slot = Arc<Mutex<State>>;

pub struct Logins {
    data: PathBuf,
    life: Duration,
    states: Mutex<HashMap<String, Slot>>,
    accounts: Arc<Mutex<HashMap<String, (Instant, Value)>>>,
    attempts: AtomicU64,
}

fn pending_json(p: &Pending) -> Value {
    json!({ "status": "pending", "loginId": p.login_id, "verificationUrl": p.verification_url, "userCode": p.user_code,
        "expiresInSec": p.deadline.saturating_duration_since(Instant::now()).as_secs() })
}

/// A field of the answer to `account/login/start`, at its top level or one level down.
fn field(answer: &Value, name: &str) -> Option<String> {
    let direct = answer.get(name).and_then(Value::as_str);
    let nested = || answer.as_object()?.values().find_map(|v| v.get(name).and_then(Value::as_str));
    direct.or_else(nested).map(String::from)
}

fn cancel_and_stop(server: &AppServer, login_id: &str) {
    let _ = server.send("account/login/cancel", json!({ "loginId": login_id }), Duration::from_secs(10));
    server.stop();
}

impl Logins {
    pub fn new(data: &Path) -> Logins {
        Logins::with_life(data, CODE_LIFE)
    }

    /// With another life of the code (tests).
    pub fn with_life(data: &Path, life: Duration) -> Logins {
        Logins { data: data.to_path_buf(), life, states: Mutex::new(HashMap::new()), accounts: Arc::new(Mutex::new(HashMap::new())), attempts: AtomicU64::new(0) }
    }

    fn slot(&self, user: &str) -> Slot {
        Arc::clone(self.states.lock().unwrap().entry(user.to_string()).or_insert_with(|| Arc::new(Mutex::new(State::None))))
    }

    fn server_for(&self, user: &str) -> Result<AppServer> {
        let cfg = Config::tenant(&self.data, user)?;
        let account = &cfg.accounts[0];
        std::fs::create_dir_all(&account.codex_home)?;
        let user_dir = account.codex_home.parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir);
        Ok(AppServer::new(&cfg.codex_bin, &account.codex_home, &user_dir, None, Some(user_dir.join("login-stderr.log"))))
    }

    /// `POST /v1/login`: the open attempt, or a new device-code sign-in.
    pub fn start(&self, user: &str) -> Result<Value> {
        let slot = self.slot(user);
        let mut state = slot.lock().unwrap();
        if let State::Pending(p) = &*state {
            if Instant::now() < p.deadline {
                return Ok(pending_json(p));
            }
            // Expired and not yet cleaned up by its watcher: that one stops its own app-server.
        }
        let server = Arc::new(self.server_for(user)?);
        // Subscribed before the start is sent: a completion that comes before the answer is not lost.
        let events = server.subscribe_account();
        let answer = match server.send("account/login/start", json!({ "type": "chatgptDeviceCode" }), RPC) {
            Ok(a) => a,
            Err(e) => {
                server.stop();
                return fail(format!("The sign-in could not be started: {}", e.message));
            }
        };
        let (Some(login_id), Some(verification_url), Some(user_code)) =
            (field(&answer, "loginId"), field(&answer, "verificationUrl"), field(&answer, "userCode"))
        else {
            server.stop();
            return fail("Codex answered account/login/start without loginId, verificationUrl and userCode.");
        };
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
        let pending = Pending { attempt, login_id: login_id.clone(), server: Arc::clone(&server), deadline: Instant::now() + self.life, verification_url, user_code };
        let out = pending_json(&pending);
        let deadline = pending.deadline;
        *state = State::Pending(pending);
        drop(state);
        let accounts = Arc::clone(&self.accounts);
        let user = user.to_string();
        thread::spawn(move || watch(slot, attempt, login_id, server, events, deadline, accounts, user));
        Ok(out)
    }

    /// `GET /v1/login`.
    pub fn status(&self, user: &str) -> Result<Value> {
        let slot = self.slot(user);
        let failed = {
            let state = slot.lock().unwrap();
            match &*state {
                State::Pending(p) if Instant::now() < p.deadline => return Ok(pending_json(p)),
                State::Failed(error) => Some(error.clone()),
                _ => None,
            }
        };
        let account = match self.account(user) {
            Ok(a) => a,
            Err(e) => return Ok(json!({ "status": if failed.is_some() { "failed" } else { "none" }, "error": failed.unwrap_or(e.0) })),
        };
        if account.get("type").and_then(Value::as_str) == Some("chatgpt") {
            return Ok(json!({ "status": "connected", "email": mask_email(account.get("email").and_then(Value::as_str)),
                "plan": account.get("planType").cloned().unwrap_or(Value::Null) }));
        }
        Ok(match failed {
            Some(error) => json!({ "status": "failed", "error": error }),
            None => json!({ "status": "none" }),
        })
    }

    /// `account/read` of the user's Codex home, reused for at most a minute.
    fn account(&self, user: &str) -> Result<Value> {
        if let Some((at, value)) = self.accounts.lock().unwrap().get(user) {
            if at.elapsed() < ACCOUNT_CACHE {
                return Ok(value.clone());
            }
        }
        let server = self.server_for(user)?;
        let read = server.account();
        server.stop();
        let value = read.map_err(|e| GatewayError(format!("The sign-in could not be read: {}", e.message)))?;
        self.accounts.lock().unwrap().insert(user.to_string(), (Instant::now(), value.clone()));
        Ok(value)
    }

    /// `DELETE /v1/login`: cancels and stops a pending attempt, then signs the user's Codex home out.
    pub fn logout(&self, user: &str) -> Result<Value> {
        let slot = self.slot(user);
        let mut state = slot.lock().unwrap();
        if let State::Pending(p) = std::mem::replace(&mut *state, State::None) {
            cancel_and_stop(&p.server, &p.login_id);
        }
        self.accounts.lock().unwrap().remove(user);
        let server = self.server_for(user)?;
        let out = server.send("account/logout", json!({}), RPC);
        server.stop();
        self.accounts.lock().unwrap().remove(user);
        out.map_err(|e| GatewayError(format!("The sign-out failed: {}", e.message)))?;
        Ok(json!({ "status": "none" }))
    }

    /// Shutdown: every pending attempt is cancelled and its app-server stopped.
    pub fn shutdown(&self) {
        let slots: Vec<Slot> = self.states.lock().unwrap().values().cloned().collect();
        for slot in slots {
            let mut state = slot.lock().unwrap();
            if let State::Pending(p) = std::mem::replace(&mut *state, State::None) {
                cancel_and_stop(&p.server, &p.login_id);
            }
        }
    }
}

/// Follows one attempt to its end. It changes the state only while the state is still this attempt, and it always
/// stops its own app-server.
#[allow(clippy::too_many_arguments)]
fn watch(slot: Slot, attempt: u64, login_id: String, server: Arc<AppServer>, events: Receiver<Value>, deadline: Instant,
    accounts: Arc<Mutex<HashMap<String, (Instant, Value)>>>, user: String) {
    let settle = |next: State| {
        let mut state = slot.lock().unwrap();
        if matches!(&*state, State::Pending(p) if p.attempt == attempt) {
            *state = next;
        }
    };
    loop {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(event) => {
                let params = event.get("params").cloned().unwrap_or(Value::Null);
                match event.get("method").and_then(Value::as_str).unwrap_or("") {
                    "account/login/completed" => {
                        if params.get("loginId").and_then(Value::as_str) != Some(login_id.as_str()) {
                            continue;
                        }
                        accounts.lock().unwrap().remove(&user);
                        if params.get("success") == Some(&json!(true)) {
                            settle(State::Connected);
                        } else {
                            let error = params.get("error").and_then(Value::as_str).unwrap_or("The sign-in did not complete.");
                            settle(State::Failed(error.to_string()));
                        }
                        server.stop();
                        return;
                    }
                    "__gone__" => {
                        settle(State::Failed("The sign-in process exited before the sign-in completed.".into()));
                        return;
                    }
                    _ => {}
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                cancel_and_stop(&server, &login_id);
                settle(State::Failed("The code expired before the sign-in completed; start again.".into()));
                return;
            }
            Err(RecvTimeoutError::Disconnected) => {
                server.stop();
                settle(State::Failed("The sign-in process exited before the sign-in completed.".into()));
                return;
            }
        }
    }
}
