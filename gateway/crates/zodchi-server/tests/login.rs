//! Sign-in cleanup racing shutdown and replacement, in process (its own test binary, since it sets the environment
//! of the process): no sign-in app-server is left running when `Logins::shutdown` returns or when an expired
//! attempt has been replaced. `tests/fake-codex.mjs` stands in for Codex; its `fake-slow-exit` and `fake-slow-cancel`
//! files stretch the stop and the cancel, so a cleanup that nobody waits for is caught while it is still going on.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use zodchi_server::login::Logins;
use zodchi_server::registry;

/// One scratch root and one environment for this whole test binary (set once, before any test reads it).
fn root() -> &'static PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("zodchi-login-test-{}-{:08x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(root.join("roles")).unwrap();
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fake-codex.mjs");
        std::env::set_var("ZODCHI_CODEX_BIN", &fake);
        std::env::set_var("ZODCHI_ROLES", root.join("roles"));
        std::env::set_var("ZODCHI_HOME", root.join("home"));
        std::env::remove_var("CODEX_HOME");
        root
    })
}

/// A data folder with one user; (data, user id, that user's Codex home).
fn user(name: &str) -> (PathBuf, String, PathBuf) {
    let data = root().join(name);
    let (user, _) = registry::add(&data, "Anna").unwrap();
    let home = data.join("users").join(&user.id).join("codex-home");
    (data, user.id, home)
}

/// The pid of the fake app-server behind a loginId (`login-<pid>`).
fn pid_of(started: &serde_json::Value) -> u32 {
    started["loginId"].as_str().unwrap().strip_prefix("login-").unwrap().parse().unwrap()
}

/// Asserts that the process `pid` is gone, waiting up to 10 s. Liveness, not the fake's `fake-exited` marker: the
/// marker is written only on a graceful exit, and a stop that has to kill the app-server (a slow machine) never
/// writes it.
fn assert_gone(pid: u32, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while zodchi_core::process::alive(pid) {
        assert!(Instant::now() < deadline, "{what}: the app-server {pid} is still running 10 s later");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn wait_for(file: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !file.exists() {
        assert!(Instant::now() < deadline, "{} never appeared", file.display());
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The completion arrives and the watcher is stopping the app-server (which takes 1.5 s to exit) when shutdown runs:
/// shutdown returns only once that process is gone.
#[test]
fn shutdown_waits_for_a_completed_attempt_to_stop() {
    let (data, id, home) = user("completed");
    std::fs::write(home.join("fake-slow-exit"), "").unwrap();
    let logins = Logins::new(&data);
    let started = logins.start(&id).unwrap();
    // The fake completes the sign-in 300 ms after the start; fake-closing appears once its stdin is closed.
    wait_for(&home.join("fake-closing"));
    logins.shutdown();
    assert_gone(pid_of(&started), "a completed sign-in outlived shutdown");
    let _ = std::fs::remove_dir_all(&data);
}

/// An attempt past its deadline is replaced by the next start: that start returns only once the old app-server is
/// cancelled and gone (cancel 1 s, exit 1.5 s), and shutdown leaves neither app-server running.
#[test]
fn an_expired_attempt_is_stopped_before_it_is_replaced() {
    let (data, id, home) = user("expired");
    std::fs::write(home.join("fake-login-mode"), "never").unwrap();
    std::fs::write(home.join("fake-slow-exit"), "").unwrap();
    std::fs::write(home.join("fake-slow-cancel"), "").unwrap();
    let logins = Logins::with_life(&data, Duration::from_secs(1));
    let first = logins.start(&id).unwrap();
    std::thread::sleep(Duration::from_millis(1200));
    let second = logins.start(&id).unwrap();
    let (old, new) = (pid_of(&first), pid_of(&second));
    assert_ne!(old, new, "the expired attempt was returned again");
    assert_gone(old, "the expired attempt was not stopped when it was replaced");
    assert_eq!(std::fs::read_to_string(home.join("fake-login-cancelled")).ok(), first["loginId"].as_str().map(String::from));
    logins.shutdown();
    assert_gone(old, "the expired attempt outlived shutdown");
    assert_gone(new, "the replacing attempt outlived shutdown");
    let _ = std::fs::remove_dir_all(&data);
}
