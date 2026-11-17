//! Stopping the server, in process (its own test binary, since it sets the environment of the process): a sign-in
//! whose start is still on its way when the server stops does not escape cancellation, the HTTP threads are done
//! before `serve_until` returns, and only then is `server.lock` free. `tests/fake-codex.mjs` stands in for Codex.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use zodchi_server::api::{serve_until, Options};
use zodchi_server::auth::TokenAuthenticator;
use zodchi_server::lock::PidLock;
use zodchi_server::login::Logins;
use zodchi_server::registry;

fn post_login(address: &str, token: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(address).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let head = format!("POST /v1/login HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\nContent-Length: 0\r\nAuthorization: Bearer {token}\r\n\r\n");
    stream.write_all(head.as_bytes()).unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8_lossy(&raw).to_string();
    let status = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    (status, text)
}

#[test]
fn shutdown_cancels_a_sign_in_whose_start_is_still_running() {
    let root = std::env::temp_dir().join(format!("zodchi-shutdown-test-{}-{:08x}", std::process::id(), rand::random::<u32>()));
    let data = root.join("data");
    std::fs::create_dir_all(root.join("roles")).unwrap();
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fake-codex.mjs");
    // This test binary holds this one test, so the environment is its own.
    std::env::set_var("ZODCHI_CODEX_BIN", &fake);
    std::env::set_var("ZODCHI_ROLES", root.join("roles"));
    std::env::set_var("ZODCHI_HOME", root.join("home"));
    std::env::remove_var("CODEX_HOME");

    let (user, token) = registry::add(&data, "Anna").unwrap();
    let home = data.join("users").join(&user.id).join("codex-home");
    std::fs::write(home.join("fake-login-mode"), "slow").unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<String>();
    let serving = {
        let (stop, data) = (Arc::clone(&stop), data.clone());
        std::thread::spawn(move || {
            let mut opts = Options::new(data.clone());
            opts.listen = "127.0.0.1:0".into();
            opts.threads = 4;
            let auth = Box::new(TokenAuthenticator { data: std::path::absolute(&data).unwrap() });
            serve_until(&opts, auth, &|address| ready_tx.send(address.to_string()).unwrap(), &|| stop.load(Ordering::SeqCst))
        })
    };
    let address = ready_rx.recv_timeout(Duration::from_secs(30)).unwrap();
    assert!(PidLock::try_acquire(&data.join("server.lock")).unwrap().is_none(), "server.lock is held while serving");

    // The start is sent; once the fake app-server has it (and holds its answer for 1.5 s), the server is told to stop.
    let client = {
        let (address, token) = (address.clone(), token.clone());
        std::thread::spawn(move || post_login(&address, &token))
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    while !home.join("fake-login-started").exists() {
        assert!(Instant::now() < deadline, "the sign-in never reached the app-server");
        std::thread::sleep(Duration::from_millis(20));
    }
    stop.store(true, Ordering::SeqCst);
    serving.join().unwrap().unwrap();

    // serve_until has returned: the lock is free, and the request in flight was answered.
    assert!(PidLock::try_acquire(&data.join("server.lock")).unwrap().is_some(), "server.lock is free after serve_until");
    let (status, text) = client.join().unwrap();
    // The attempt became pending before shutdown reached it, so it was cancelled with its own loginId.
    assert_eq!(status, 200, "{text}");
    let login_id = std::fs::read_to_string(home.join("fake-login-started")).unwrap();
    assert!(text.contains(&login_id), "{text}");
    assert_eq!(std::fs::read_to_string(home.join("fake-login-cancelled")).ok().as_deref(), Some(login_id.as_str()), "the open sign-in was not cancelled");

    // After shutdown no new attempt starts.
    let logins = Logins::new(&data);
    logins.shutdown();
    let refused = logins.start(&user.id).expect_err("a start after shutdown is refused");
    assert!(refused.message.contains("stopping"), "{}", refused.message);

    let _ = std::fs::remove_dir_all(&root);
}
