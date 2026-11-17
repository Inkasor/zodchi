//! The server end to end: the real `zodchi-server` binary on a free port of 127.0.0.1, a scratch data folder, and
//! `tests/fake-codex.mjs` (run by Node) in place of Codex. No real Codex and no network beyond loopback.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_zodchi-server");

struct Env {
    root: PathBuf,
    data: PathBuf,
    roles: PathBuf,
}

impl Env {
    fn new() -> Env {
        let root = std::env::temp_dir().join(format!("zodchi-server-test-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        let data = root.join("data");
        let roles = root.join("roles");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&roles).unwrap();
        let write = |name: &str, value: Value| std::fs::write(roles.join(name), value.to_string()).unwrap();
        write("ask.json", json!({ "description": "plain text", "mode": "expert", "model": "fake-model", "effort": "low" }));
        write("structured.json", json!({ "mode": "expert", "model": "fake-model", "effort": "low", "schema": "structured.schema.json" }));
        write("structured.schema.json", json!({ "type": "object", "properties": { "codexHome": { "type": "string" } }, "required": ["codexHome"], "additionalProperties": false }));
        write("picture.json", json!({ "kind": "image", "mode": "expert", "model": "fake-model", "effort": "low" }));
        write("builder.json", json!({ "mode": "work", "model": "fake-model", "effort": "low", "sandbox": "workspace-write", "mcpServers": [] }));
        write("judge.json", json!({ "kind": "decisions", "mode": "expert", "model": "fake-model", "timeoutMin": 5 }));
        Env { root, data, roles }
    }

    fn command(&self) -> Command {
        let mut c = Command::new(BIN);
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fake-codex.mjs");
        c.env("ZODCHI_CODEX_BIN", fake).env("ZODCHI_ROLES", &self.roles).env("ZODCHI_HOME", self.root.join("home"));
        c.env_remove("OPENAI_API_KEY").env_remove("CODEX_HOME");
        c
    }

    /// An admin command; its JSON output.
    fn admin(&self, args: &[&str]) -> Value {
        let out = self.command().args(args).arg("--data").arg(&self.data).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice(&out.stdout).unwrap()
    }

    /// A user, already signed in (for the fake Codex) unless `signed_in` is false. Returns (id, token).
    fn user(&self, name: &str, signed_in: bool) -> (String, String) {
        let added = self.admin(&["user", "add", name]);
        let id = added["id"].as_str().unwrap().to_string();
        if signed_in {
            std::fs::write(self.codex_home(&id).join("fake-auth.json"), "{}").unwrap();
        }
        (id, added["token"].as_str().unwrap().to_string())
    }

    /// An answer shows neither the data folder nor a path inside it (registry, users, jobs, Codex homes), nor the
    /// test's folder (roles, the zodchi home), in any separator or case.
    fn assert_no_paths(&self, body: &[u8]) {
        // Every decoded string and the raw body, so an escaped separator hides nothing.
        fn strings(value: &Value, out: &mut String) {
            match value {
                Value::String(s) => {
                    out.push_str(s);
                    out.push('\n');
                }
                Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
                Value::Object(map) => map.values().for_each(|v| strings(v, out)),
                _ => {}
            }
        }
        let mut text = String::from_utf8_lossy(body).to_string();
        if let Ok(value) = serde_json::from_slice::<Value>(body) {
            strings(&value, &mut text);
        }
        let text = text.to_ascii_lowercase();
        let mut needles = vec!["server.json".to_string(), "users\\".into(), "users/".into(), "codex-home".into()];
        for path in [&self.data, &self.root, &self.roles] {
            let path = std::path::absolute(path).unwrap().display().to_string().to_ascii_lowercase();
            needles.push(path.replace('\\', "/"));
            needles.push(path.replace('/', "\\"));
        }
        for needle in needles {
            assert!(!text.contains(&needle), "the answer names {needle}: {text}");
        }
    }

    fn codex_home(&self, id: &str) -> PathBuf {
        self.data.join("users").join(id).join("codex-home")
    }

    fn serve(&self, extra: &[&str]) -> Server {
        let log = self.root.join(format!("server-stderr-{:08x}.log", rand::random::<u32>()));
        let mut child = self.command().args(["serve", "--listen", "127.0.0.1:0", "--data"]).arg(&self.data).args(extra)
            .stdout(Stdio::piped()).stderr(Stdio::from(std::fs::File::create(&log).unwrap())).spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let address = line.split("http://").nth(1).and_then(|r| r.split_whitespace().next()).unwrap_or_else(|| panic!("no address in {line:?}")).to_string();
        Server { child, address, log }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        // Workers may still hold files for a moment; what stays behind is in the temp folder.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Server {
    child: Child,
    address: String,
    /// The server's standard error: where the raw diagnostics go.
    log: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Answer {
    status: u16,
    content_type: String,
    body: Vec<u8>,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", String::from_utf8_lossy(&self.body)))
    }

    /// The public error of the answer: `error.code` and `error.message` (the error is `{code, message, field?}`).
    fn error(&self) -> (String, String) {
        let value = self.json();
        let error = &value["error"];
        (error["code"].as_str().unwrap_or_else(|| panic!("no error code in {value}")).to_string(), error["message"].as_str().unwrap_or("").to_string())
    }
}

impl Server {
    /// What the server has written to its standard error so far.
    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }

    #[cfg(unix)]
    fn child_alive(&self) -> bool {
        Command::new("kill").args(["-0", &self.child.id().to_string()]).status().map(|s| s.success()).unwrap_or(false)
    }

    fn call(&self, method: &str, path: &str, token: Option<&str>, body: Option<&Value>) -> Answer {
        let mut stream = TcpStream::connect(&self.address).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(120))).unwrap();
        let payload = body.map(|b| b.to_string()).unwrap_or_default();
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n", self.address, payload.len());
        if let Some(token) = token {
            head.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        if body.is_some() {
            head.push_str("Content-Type: application/json\r\n");
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(payload.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("a response head");
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        let content_type = head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("content-type")).map(|(_, v)| v.trim().to_string())).unwrap_or_default();
        Answer { status, content_type, body: raw[split + 4..].to_vec() }
    }

    fn submit(&self, token: &str, body: Value) -> Answer {
        self.call("POST", "/v1/jobs", Some(token), Some(&body))
    }

    /// Waits for the final status of a job.
    fn finished(&self, token: &str, key: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let answer = self.call("GET", &format!("/v1/jobs/{key}?waitSec=5"), Some(token), None);
            assert_eq!(answer.status, 200, "{}", String::from_utf8_lossy(&answer.body));
            let job = answer.json()["job"].clone();
            let status = job["status"].as_str().unwrap_or("").to_string();
            if ["succeeded", "failed", "limited", "auth_required", "unknown", "timeout"].contains(&status.as_str()) {
                return job;
            }
            assert!(Instant::now() < deadline, "job {key} did not finish: {job}");
        }
    }
}

fn same_path(a: &str, b: &Path) -> bool {
    Path::new(a) == b
}

#[test]
fn refuses_without_a_token_and_with_a_wrong_one() {
    let env = Env::new();
    let (_, token) = env.user("Anna", true);
    let server = env.serve(&[]);
    let health = server.call("GET", "/health", None, None);
    assert_eq!(health.status, 200);
    assert_eq!(health.json()["ok"], json!(true));
    assert_eq!(server.call("GET", "/v1/roles", None, None).status, 401);
    assert_eq!(server.call("GET", "/v1/roles", None, None).error().0, "unauthorized");
    assert_eq!(server.call("GET", "/v1/roles", Some("zs_wrong"), None).status, 401);
    assert_eq!(server.call("GET", "/v1/jobs/any", Some(&format!("{token}x")), None).status, 401);
    let roles = server.call("GET", "/v1/roles", Some(&token), None);
    assert_eq!(roles.status, 200);
    let names: Vec<String> = roles.json().as_array().unwrap().iter().map(|r| r["role"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, ["ask", "picture", "structured"], "work and decisions roles are not offered");
    assert!(roles.json()[0].get("source").is_none(), "no server paths");

    // One serving process per data folder.
    let second = env.command().args(["serve", "--listen", "127.0.0.1:0", "--data"]).arg(&env.data).output().unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("server.lock"));
}

#[test]
fn two_users_have_their_own_jobs_and_their_own_codex_home() {
    let env = Env::new();
    let (a_id, a) = env.user("Anna", true);
    let (b_id, b) = env.user("Boris", true);
    let server = env.serve(&[]);

    let first = server.submit(&a, json!({ "key": "k1", "role": "ask", "prompt": "hello from A" }));
    assert_eq!(first.status, 201, "{}", String::from_utf8_lossy(&first.body));
    assert_eq!(first.json()["created"], json!(true));
    assert!(first.json()["job"].get("dir").is_none(), "no server paths");
    // The same request again: the same job, nothing spent.
    let again = server.submit(&a, json!({ "key": "k1", "role": "ask", "prompt": "hello from A" }));
    assert_eq!(again.status, 200);
    assert_eq!(again.json()["created"], json!(false));
    // Another request under the key: refused.
    assert_eq!(server.submit(&a, json!({ "key": "k1", "role": "ask", "prompt": "something else" })).status, 409);

    // B does not see A's job and has the key free for itself.
    assert_eq!(server.call("GET", "/v1/jobs/k1", Some(&b), None).status, 404);
    assert_eq!(server.call("GET", "/v1/jobs/k1/result", Some(&b), None).status, 404);
    let theirs = server.submit(&b, json!({ "key": "k1", "role": "ask", "prompt": "hello from B" }));
    assert_eq!(theirs.status, 201);

    // Each worker ran on its own user's Codex home and on nothing else.
    for (token, id) in [(&a, &a_id), (&b, &b_id)] {
        let job = server.finished(token, "k1");
        assert_eq!(job["status"], json!("succeeded"), "{job}");
        assert_eq!(job["account"], json!(id));
        let result = server.call("GET", "/v1/jobs/k1/result", Some(token), None);
        assert_eq!(result.status, 200);
        let text = String::from_utf8(result.body).unwrap();
        let home = text.strip_prefix("CODEX_HOME=").unwrap();
        assert!(same_path(home, &std::path::absolute(env.codex_home(id)).unwrap()), "{home}");
    }
}

#[test]
fn refuses_work_paid_inline_roles_and_too_many_images() {
    let env = Env::new();
    let (_, token) = env.user("Anna", true);
    let server = env.serve(&[]);
    let refused = |body: Value, words: &str| {
        let answer = server.submit(&token, body);
        assert_eq!(answer.status, 400, "{}", String::from_utf8_lossy(&answer.body));
        let (code, error) = answer.error();
        assert!(["bad_request", "role_not_found", "role_not_allowed"].contains(&code.as_str()), "{code}");
        assert!(error.contains(words), "{error}");
    };
    refused(json!({ "key": "w1", "role": "builder", "prompt": "p" }), "no repository");
    refused(json!({ "key": "d1", "role": "judge", "prompt": "p" }), "OpenAI API key");
    refused(json!({ "key": "d2", "role": "ask", "prompt": "p", "paid": true }), "OpenAI API key");
    refused(json!({ "key": "r1", "role": "ask", "prompt": "p", "resume": "k0" }), "work call");
    refused(json!({ "key": "i1", "role": { "mode": "expert", "model": "m", "effort": "low" }, "prompt": "p" }), "inline role");
    refused(json!({ "key": "i2", "role": "ask.json", "prompt": "p" }), "role file");
    refused(json!({ "key": "i3", "role": "missing", "prompt": "p" }), "No role missing");
    refused(json!({ "key": "m2", "role": "ask", "prompt": "p", "images": ["AAAA"] }), "PNG, JPEG or WebP");
    refused(json!({ "key": "m1", "role": "ask", "prompt": "p", "images": vec!["iVBORw0KGgo="; 9] }), "At most 8");
    // Nothing was stored for any of them.
    let jobs = std::fs::read_dir(env.data.join("users")).unwrap().next().unwrap().unwrap().path().join("jobs");
    assert_eq!(std::fs::read_dir(jobs).unwrap().count(), 0);
}

#[test]
fn stores_token_hashes_and_revokes_without_a_restart() {
    let env = Env::new();
    let (id, token) = env.user("Anna", true);
    let registry = std::fs::read_to_string(env.data.join("server.json")).unwrap();
    assert!(!registry.contains(&token), "a token in server.json");
    assert!(registry.contains(&zodchi_core::util::sha256_hex(token.as_bytes())));
    let server = env.serve(&[]);
    assert_eq!(server.call("GET", "/v1/roles", Some(&token), None).status, 200);

    let renewed = env.admin(&["user", "token", &id]);
    let fresh = renewed["token"].as_str().unwrap();
    assert_eq!(server.call("GET", "/v1/roles", Some(&token), None).status, 401, "the old token still works");
    assert_eq!(server.call("GET", "/v1/roles", Some(fresh), None).status, 200);
    let listed = env.admin(&["user", "list"]);
    assert_eq!(listed[0]["tokens"], json!(1));
    assert!(listed.to_string().find("zs_").is_none(), "user list shows no token");

    env.admin(&["user", "remove", &id]);
    assert_eq!(server.call("GET", "/v1/roles", Some(fresh), None).status, 401, "a removed user still gets in");
    assert!(env.data.join("users").join(&id).is_dir(), "the folder of a removed user stays");

    // A registry that cannot be read lets nobody in, and its answer names no server path.
    std::fs::write(env.data.join("server.json"), "{ broken").unwrap();
    for token in [Some(fresh), None] {
        let broken = server.call("GET", "/v1/roles", token, None);
        assert_eq!(broken.status, 500);
        assert_eq!(broken.error().0, "unavailable");
        env.assert_no_paths(&broken.body);
    }
}

#[test]
fn admin_commands_racing_lose_no_user() {
    let env = Env::new();
    let children: Vec<Child> = (0..8)
        .map(|i| env.command().args(["user", "add", &format!("racer {i}"), "--data"]).arg(&env.data).stdout(Stdio::null()).spawn().unwrap())
        .collect();
    for mut child in children {
        assert!(child.wait().unwrap().success());
    }
    let listed = env.admin(&["user", "list"]);
    assert_eq!(listed.as_array().unwrap().len(), 8, "{listed}");
}

#[test]
fn admission_refuses_over_the_limit_and_leaves_the_key_free() {
    let env = Env::new();
    let (_, token) = env.user("Anna", true);
    let server = env.serve(&["--max-user-jobs", "1"]);
    assert_eq!(server.submit(&token, json!({ "key": "slow-1", "role": "ask", "prompt": "SLOW one" })).status, 201);
    let over = server.submit(&token, json!({ "key": "next-1", "role": "ask", "prompt": "two" }));
    assert_eq!(over.status, 429, "{}", String::from_utf8_lossy(&over.body));
    assert_eq!(over.error().0, "busy");
    assert_eq!(server.call("GET", "/v1/jobs/next-1", Some(&token), None).status, 404, "the refused key was taken");
    // A repeat of the existing key is never refused by admission.
    assert_eq!(server.submit(&token, json!({ "key": "slow-1", "role": "ask", "prompt": "SLOW one" })).status, 200);
    // The result of an unfinished job: 409 with its status.
    let early = server.call("GET", "/v1/jobs/slow-1/result", Some(&token), None);
    assert_eq!(early.status, 409);
    assert!(["queued", "running"].contains(&early.json()["status"].as_str().unwrap()));
    assert_eq!(server.finished(&token, "slow-1")["status"], json!("succeeded"));
    assert_eq!(server.submit(&token, json!({ "key": "next-1", "role": "ask", "prompt": "two" })).status, 201);
}

/// Admission fails closed: a job folder whose record cannot be read counts as unfinished, and a jobs folder that
/// cannot be listed refuses the job (500) instead of counting nothing; either way the key stays free.
#[test]
fn admission_counts_fail_closed() {
    let env = Env::new();
    let (id, token) = env.user("Anna", true);
    let server = env.serve(&["--max-user-jobs", "1"]);
    let broken = env.data.join("users").join(&id).join("jobs").join("broken-1");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join("job.json"), "{").unwrap();
    let over = server.submit(&token, json!({ "key": "next-1", "role": "ask", "prompt": "one" }));
    assert_eq!(over.status, 429, "an unreadable record is not a finished job: {}", String::from_utf8_lossy(&over.body));
    std::fs::remove_dir_all(&broken).unwrap();

    // A (removed) user's jobs folder that is not a folder: the count cannot be established.
    let ghost = env.data.join("users").join("ghost-1");
    std::fs::create_dir_all(&ghost).unwrap();
    std::fs::write(ghost.join("jobs"), "not a folder").unwrap();
    let unknown = server.submit(&token, json!({ "key": "next-1", "role": "ask", "prompt": "one" }));
    assert_eq!(unknown.status, 500, "{}", String::from_utf8_lossy(&unknown.body));
    let (code, message) = unknown.error();
    assert_eq!(code, "storage_error");
    assert!(message.contains("cannot be counted"), "{message}");
    env.assert_no_paths(&unknown.body);
    assert!(!String::from_utf8_lossy(&unknown.body).contains("ghost-1"), "the answer names another user's folder");
    assert!(server.stderr().contains("ghost-1"), "the server's log lost the diagnostic: {}", server.stderr());
    assert_eq!(server.call("GET", "/v1/jobs/next-1", Some(&token), None).status, 404, "the refused key was taken");
    std::fs::remove_file(ghost.join("jobs")).unwrap();
    assert_eq!(server.submit(&token, json!({ "key": "next-1", "role": "ask", "prompt": "one" })).status, 201);
}

/// The server outlives its workers and reaps each one: a finished worker is not left as a zombie.
#[cfg(unix)]
#[test]
fn finished_workers_are_reaped() {
    let env = Env::new();
    let (_, token) = env.user("Anna", true);
    let server = env.serve(&[]);
    assert_eq!(server.submit(&token, json!({ "key": "reap-1", "role": "ask", "prompt": "hello" })).status, 201);
    let done = server.finished(&token, "reap-1");
    assert_eq!(done["status"], json!("succeeded"));
    let pid = done["workerPid"].as_u64().expect("the worker's pid").to_string();
    // The state of the worker's pid: empty once it is reaped, "Z" while it is a zombie.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let out = Command::new("ps").args(["-o", "stat=", "-p", &pid]).output().unwrap();
        let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if stat.is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "worker {pid} is still there as {stat:?} while the server runs");
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(server.child_alive(), "the server stays running");
}

#[test]
fn a_changed_role_does_not_turn_a_retry_into_a_conflict() {
    let env = Env::new();
    let (_, token) = env.user("Anna", true);
    let server = env.serve(&[]);
    let body = json!({ "key": "same-1", "role": "ask", "prompt": "hello" });
    assert_eq!(server.submit(&token, body.clone()).status, 201);
    std::fs::write(env.roles.join("ask.json"), json!({ "mode": "expert", "model": "other-model", "effort": "high" }).to_string()).unwrap();
    let retry = server.submit(&token, body);
    assert_eq!(retry.status, 200, "{}", String::from_utf8_lossy(&retry.body));
    assert_eq!(retry.json()["job"]["model"], json!("fake-model"), "the job keeps the role it was created with");
    // The role is gone altogether: the retry is still the same job.
    std::fs::remove_file(env.roles.join("ask.json")).unwrap();
    assert_eq!(server.submit(&token, json!({ "key": "same-1", "role": "ask", "prompt": "hello" })).status, 200);
}

#[test]
fn every_kind_of_result() {
    let env = Env::new();
    let (id, token) = env.user("Anna", true);
    let server = env.serve(&[]);
    for (key, role, prompt) in [("text-1", "ask", "plain"), ("json-1", "structured", "schema"), ("png-1", "picture", "a dot"), ("fail-1", "ask", "FAIL now")] {
        let answer = server.submit(&token, json!({ "key": key, "role": role, "prompt": prompt }));
        assert_eq!(answer.status, 201, "{key}: {}", String::from_utf8_lossy(&answer.body));
    }
    let home = std::path::absolute(env.codex_home(&id)).unwrap();

    assert_eq!(server.finished(&token, "text-1")["status"], json!("succeeded"));
    let text = server.call("GET", "/v1/jobs/text-1/result", Some(&token), None);
    assert_eq!((text.status, text.content_type.starts_with("text/plain")), (200, true));

    assert_eq!(server.finished(&token, "json-1")["status"], json!("succeeded"));
    let data = server.call("GET", "/v1/jobs/json-1/result", Some(&token), None);
    assert_eq!((data.status, data.content_type.as_str()), (200, "application/json"));
    assert!(same_path(data.json()["codexHome"].as_str().unwrap(), &home));

    let png = server.finished(&token, "png-1");
    assert_eq!(png["status"], json!("succeeded"), "{png}");
    let manifest = server.call("GET", "/v1/jobs/png-1/result", Some(&token), None);
    assert_eq!(manifest.status, 200);
    let image = &manifest.json()["images"][0];
    assert_eq!(image["contentType"], json!("image/png"));
    assert_eq!(image["url"], json!("/v1/jobs/png-1/result/0"));
    let bytes = server.call("GET", "/v1/jobs/png-1/result/0", Some(&token), None);
    assert_eq!((bytes.status, bytes.content_type.as_str()), (200, "image/png"));
    assert!(bytes.body.starts_with(&[0x89, b'P', b'N', b'G']));
    assert_eq!(server.call("GET", "/v1/jobs/png-1/result/1", Some(&token), None).status, 404);

    assert_eq!(server.finished(&token, "fail-1")["status"], json!("failed"));
    let failed = server.call("GET", "/v1/jobs/fail-1/result", Some(&token), None);
    assert_eq!(failed.status, 422);
    assert_eq!(failed.json()["status"], json!("failed"));
    assert_eq!(failed.error().0, "job_failed");
    assert!(!String::from_utf8_lossy(&failed.body).contains("boom"), "the stored error text reached the client: {}", String::from_utf8_lossy(&failed.body));
    assert!(std::fs::read_to_string(env.data.join("users").join(&id).join("jobs").join("fail-1").join("job.json")).unwrap().contains("boom"), "the job folder lost the error");
}

#[test]
fn a_worker_without_a_sign_in_reports_auth_required() {
    let env = Env::new();
    let (_, token) = env.user("Anna", false);
    let server = env.serve(&[]);
    assert_eq!(server.submit(&token, json!({ "key": "k1", "role": "ask", "prompt": "hi" })).status, 201);
    assert_eq!(server.finished(&token, "k1")["status"], json!("auth_required"));
}

#[test]
fn device_code_sign_in() {
    let env = Env::new();
    let (late_id, late) = env.user("Late", false);
    let (early_id, early) = env.user("Early", false);
    let (never_id, never) = env.user("Never", false);
    std::fs::write(env.codex_home(&early_id).join("fake-login-mode"), "early").unwrap();
    std::fs::write(env.codex_home(&never_id).join("fake-login-mode"), "never").unwrap();
    let _ = late_id;
    let server = env.serve(&[]);
    assert_eq!(server.call("GET", "/v1/login", Some(&late), None).json()["status"], json!("none"));

    // The completion arrives after the answer, and before it: both end connected.
    for token in [&late, &early] {
        let started = server.call("POST", "/v1/login", Some(token), None);
        assert_eq!(started.status, 200, "{}", String::from_utf8_lossy(&started.body));
        assert_eq!(started.json()["userCode"], json!("ABCD-1234"));
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let status = server.call("GET", "/v1/login", Some(token), None).json();
            if status["status"] == json!("connected") {
                assert_eq!(status["plan"], json!("plus"));
                break;
            }
            assert!(Instant::now() < deadline, "not connected: {status}");
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    // One open sign-in per user; DELETE cancels it and signs out.
    let first = server.call("POST", "/v1/login", Some(&never), None).json();
    assert_eq!(first["status"], json!("pending"));
    let second = server.call("POST", "/v1/login", Some(&never), None).json();
    assert_eq!(first["loginId"], second["loginId"]);
    assert_eq!(server.call("GET", "/v1/login", Some(&never), None).json()["status"], json!("pending"));
    assert_eq!(server.call("DELETE", "/v1/login", Some(&never), None).json()["status"], json!("none"));
    assert_eq!(server.call("GET", "/v1/login", Some(&never), None).json()["status"], json!("none"));

    // Signing out removes the sign-in of that user only.
    assert_eq!(server.call("DELETE", "/v1/login", Some(&late), None).status, 200);
    assert_eq!(server.call("GET", "/v1/login", Some(&late), None).json()["status"], json!("none"));
    assert_eq!(server.call("GET", "/v1/login", Some(&early), None).json()["status"], json!("connected"));
}

#[test]
fn the_account_of_the_caller_only() {
    let env = Env::new();
    let (id, token) = env.user("Anna", true);
    let server = env.serve(&[]);
    let account = server.call("GET", "/v1/account", Some(&token), None);
    assert_eq!(account.status, 200);
    let value = account.json();
    assert_eq!(value["connected"], json!(true));
    assert_eq!(value["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(value["name"], json!(id));
    assert!(value.get("codexHome").is_none(), "no server paths");
}

/// The body limit, in process: an authenticator of a fork stands in for the tokens.
#[test]
fn a_body_over_32_mb_is_refused() {
    use zodchi_server::api::{App, Options, LIMIT_BODY};
    use zodchi_server::auth::{Authenticator, Identity, Refusal};
    struct Everyone;
    impl Authenticator for Everyone {
        fn authenticate(&self, _headers: &[(String, String)]) -> Result<Identity, Refusal> {
            Ok(Identity { id: "someone".into(), name: "Someone".into() })
        }
    }
    let env = Env::new();
    let app = App::new(&env.data, Box::new(Everyone), &Options::new(env.data.clone())).unwrap();
    let mut body = std::io::repeat(b' ').take(LIMIT_BODY as u64 + 1);
    let reply = app.handle("POST", "/v1/jobs", &[], &mut body);
    assert_eq!(reply.status, 400);
    assert_eq!(reply.json_of()["error"]["code"], json!("bad_request"));
    assert!(reply.json_of()["error"]["message"].as_str().unwrap().contains("32 MB"));
    // The health route needs nobody; an identity outside [a-z0-9-] is never let in.
    struct Odd;
    impl Authenticator for Odd {
        fn authenticate(&self, _headers: &[(String, String)]) -> Result<Identity, Refusal> {
            Ok(Identity { id: "../x".into(), name: "x".into() })
        }
    }
    let odd = App::new(&env.data, Box::new(Odd), &Options::new(env.data.clone())).unwrap();
    assert_eq!(odd.handle("GET", "/health", &[], &mut std::io::empty()).status, 200);
    assert_eq!(odd.handle("GET", "/v1/roles", &[], &mut std::io::empty()).status, 500);
}

/// Writes a finished job with a stored error and returns the job folder.
fn stored_job(env: &Env, user: &str, key: &str, status: &str, error: &str, extra: Value) -> PathBuf {
    let dir = std::path::absolute(&env.data).unwrap().join("users").join(user).join("jobs").join(key);
    std::fs::create_dir_all(&dir).unwrap();
    let mut job = json!({ "key": key, "role": "ask", "kind": "text", "mode": "expert", "status": status, "error": error, "result": null,
        "createdAt": zodchi_core::util::iso(), "finishedAt": zodchi_core::util::iso() });
    for (name, value) in extra.as_object().unwrap() {
        job[name] = value.clone();
    }
    std::fs::write(dir.join("job.json"), job.to_string()).unwrap();
    dir
}

/// No raw diagnostic reaches a client, whatever its shape (a route-shaped path included) and its status: a job's stored
/// error (200 and 422), an account and sign-in error (200), a role that cannot be loaded (400), a storage error (500).
/// Each answer carries a public `{code, message}`; the diagnostic stays in the job folder or the server's log. The
/// model's own answer is returned as the model gave it.
#[test]
fn no_raw_diagnostic_reaches_a_client() {
    let env = Env::new();
    let (id, token) = env.user("Anna", true);
    let (bad_id, bad) = env.user("Boris", true);
    let data = std::path::absolute(&env.data).unwrap();
    let home = std::path::absolute(env.codex_home(&id)).unwrap();

    // The two paths of the review: they look like routes of the API and are not exempt from anything.
    let routes = "cannot read /v1/private/auth.json and /health/private/auth.json";
    let raw = format!("Cannot write {} nor {}: denied; {routes}", data.join("users").display(), home.display().to_string().replace('\\', "/"));
    let said = format!("the model saw {} and {routes}", home.display());
    let one = stored_job(&env, &id, "stored-1", "failed", &raw, json!({ "result": { "text": said },
        "servers": { "x": { "error": "cannot read /v1/private/servers.json" } }, "dir": data.display().to_string(), "root": "/health/private" }));
    stored_job(&env, &id, "stored-2", "limited", "cannot read /health/private/auth.json", json!({ "resetsAt": "cannot read /v1/private/reset.json" }));
    stored_job(&env, &id, "stored-3", "auth_required", "cannot read /v1/private/auth.json", json!({}));
    stored_job(&env, &id, "stored-4", "timeout", "cannot read /v1/private/auth.json", json!({}));
    stored_job(&env, &id, "stored-5", "unknown", "cannot read /v1/private/auth.json", json!({}));

    // Roles that cannot be loaded: their errors name the role file.
    std::fs::write(env.roles.join("broken.json"), "{ not json").unwrap();
    std::fs::write(env.roles.join("odd.json"), json!({ "mode": "expert", "model": "m", "effort": "low", "colour": "red" }).to_string()).unwrap();
    // Codex fails account/read with an error that names the Codex home.
    std::fs::write(env.codex_home(&bad_id).join("fake-account-error"), "").unwrap();
    let server = env.serve(&[]);

    let no_diagnostic = |answer: &Answer| {
        let text = String::from_utf8_lossy(&answer.body).to_string();
        for needle in ["private", "auth.json", "denied", "Cannot write", "cannot read /", "permission"] {
            assert!(!text.contains(needle), "the answer holds {needle:?}: {text}");
        }
        env.assert_no_paths(&answer.body);
    };

    // A stored job, polled (200) and asked for its result (422).
    let job = server.call("GET", "/v1/jobs/stored-1", Some(&token), None);
    assert_eq!(job.status, 200, "{}", String::from_utf8_lossy(&job.body));
    let mut shown = job.json();
    assert_eq!(shown["job"]["status"], json!("failed"));
    assert_eq!(shown["job"]["error"]["code"], json!("job_failed"), "{shown}");
    assert_eq!(shown["job"]["result"]["text"], json!(said), "the model's answer was changed");
    for hidden in ["dir", "root", "servers"] {
        assert!(shown["job"].get(hidden).is_none(), "{hidden} reached the client: {shown}");
    }
    shown["job"]["result"] = Value::Null;
    no_diagnostic(&Answer { status: 200, content_type: String::new(), body: shown.to_string().into_bytes() });
    for (key, status, code) in [("stored-1", "failed", "job_failed"), ("stored-2", "limited", "limited"), ("stored-3", "auth_required", "auth_required"),
        ("stored-4", "timeout", "timeout"), ("stored-5", "unknown", "unknown")] {
        let polled = server.call("GET", &format!("/v1/jobs/{key}"), Some(&token), None);
        assert_eq!(polled.status, 200);
        assert_eq!(polled.json()["job"]["error"]["code"], json!(code), "{key}");
        let failed = server.call("GET", &format!("/v1/jobs/{key}/result"), Some(&token), None);
        assert_eq!(failed.status, 422, "{key}");
        assert_eq!(failed.json()["status"], json!(status));
        assert_eq!(failed.error().0, code, "{key}");
        assert!(failed.json()["error"]["message"].as_str().unwrap().len() > 10);
        no_diagnostic(&failed);
        if key != "stored-1" {
            no_diagnostic(&polled);
        }
    }
    // The job folder keeps the raw text.
    assert!(std::fs::read_to_string(one.join("job.json")).unwrap().contains("/v1/private/auth.json"), "the job folder lost the error");

    // A role that cannot be loaded: 400 role_invalid, the reason only in the log; a missing role: role_not_found.
    for role in ["broken", "odd"] {
        let refused = server.submit(&token, json!({ "key": format!("{role}-1"), "role": role, "prompt": "p" }));
        assert_eq!(refused.status, 400, "{}", String::from_utf8_lossy(&refused.body));
        assert_eq!(refused.error().0, "role_invalid");
        assert_eq!(refused.json()["error"]["field"], json!("role"));
        assert!(refused.error().1.contains(role));
        no_diagnostic(&refused);
        assert_eq!(server.call("GET", &format!("/v1/jobs/{role}-1"), Some(&token), None).status, 404, "a refused key was taken");
    }
    let log = server.stderr();
    assert!(log.contains("is not JSON") && log.contains("Unknown field"), "the log lost the role errors: {log}");
    assert_eq!(server.submit(&token, json!({ "key": "m-1", "role": "ask", "prompt": "p", "effort": "not-an-effort" })).error().0, "bad_request");
    assert_eq!(server.submit(&token, json!({ "key": "m-2", "role": "gone", "prompt": "p" })).error().0, "role_not_found");

    // An account and a sign-in whose Codex fails with a path: 200 with a public error.
    let account = server.call("GET", "/v1/account", Some(&bad), None);
    assert_eq!(account.status, 200);
    assert_eq!(account.json()["connected"], json!(false));
    assert_eq!(account.error().0, "codex_unavailable");
    assert_eq!(account.json()["accounts"][0]["error"]["code"], json!("codex_unavailable"));
    no_diagnostic(&account);
    let login = server.call("GET", "/v1/login", Some(&bad), None);
    assert_eq!(login.status, 200);
    assert_eq!(login.json()["status"], json!("none"));
    assert_eq!(login.error().0, "codex_unavailable");
    no_diagnostic(&login);
    assert!(server.stderr().contains("permission denied"), "the log lost the account error: {}", server.stderr());
    assert!(server.stderr().contains("auth.json"), "the log lost the path of the account error");

    // The routes the server does not have, and methods it does not take, answer with a public error too.
    let none = server.call("GET", "/v1/private/auth.json", Some(&token), None);
    assert_eq!((none.status, none.error().0.as_str()), (404, "not_found"));
    let method = server.call("PUT", "/v1/jobs/stored-1", Some(&token), None);
    assert_eq!((method.status, method.error().0.as_str()), (405, "method_not_allowed"));
}

/// A long poll holds an HTTP thread, so the server refuses to start with one: `--threads 1` is an error with a clear
/// message and nothing listens; with two threads a long poll leaves one free, and `/health` answers while it waits.
#[test]
fn one_http_thread_is_refused_and_two_leave_one_free() {
    let env = Env::new();
    let (_, token) = env.user("Anna", true);
    let refused = env.command().args(["serve", "--threads", "1", "--listen", "127.0.0.1:0", "--data"]).arg(&env.data).output().unwrap();
    assert!(!refused.status.success(), "--threads 1 was accepted");
    let message = String::from_utf8_lossy(&refused.stderr).to_string();
    assert!(message.contains("--threads is at least 2"), "{message}");
    assert!(refused.stdout.is_empty(), "the server announced itself: {}", String::from_utf8_lossy(&refused.stdout));
    let zero = env.command().args(["serve", "--threads", "0", "--listen", "127.0.0.1:0", "--data"]).arg(&env.data).output().unwrap();
    assert!(!zero.status.success(), "--threads 0 was accepted");
    let message = String::from_utf8_lossy(&zero.stderr).to_string();
    assert!(message.contains("--threads is at least 2"), "{message}");
    assert!(zero.stdout.is_empty(), "the server announced itself: {}", String::from_utf8_lossy(&zero.stdout));

    let server = env.serve(&["--threads", "2"]);
    assert_eq!(server.submit(&token, json!({ "key": "slow-1", "role": "ask", "prompt": "SLOW one" })).status, 201);
    std::thread::scope(|scope| {
        let poll = scope.spawn(|| server.call("GET", "/v1/jobs/slow-1?waitSec=30", Some(&token), None).status);
        // Whatever the poll does, the other thread answers at once.
        std::thread::sleep(Duration::from_millis(500));
        let started = Instant::now();
        for _ in 0..5 {
            assert_eq!(server.call("GET", "/health", None, None).status, 200);
        }
        assert!(started.elapsed() < Duration::from_secs(3), "health waited behind the poll: {:?}", started.elapsed());
        assert_eq!(poll.join().unwrap(), 200);
    });
}
