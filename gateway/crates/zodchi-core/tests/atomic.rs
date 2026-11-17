//! job.json is replaced whole: several threads writing it at once, or settling and finishing the same dead job at
//! once, never leave a reader with half a file.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use zodchi_core::config::Config;
use zodchi_core::job;
use zodchi_core::util::{iso, write_json_atomic};

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zodchi-core-atomic-{}-{:08x}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Reads `file` until `stop`: every read that succeeds must be whole JSON. Returns how many reads succeeded.
fn reader(file: PathBuf, stop: Arc<AtomicBool>) -> thread::JoinHandle<usize> {
    thread::spawn(move || {
        let mut seen = 0;
        while !stop.load(Ordering::SeqCst) {
            if let Ok(text) = std::fs::read_to_string(&file) {
                assert!(serde_json::from_str::<Value>(&text).is_ok(), "half a file: {text:?}");
                seen += 1;
            }
        }
        seen
    })
}

#[test]
fn concurrent_writes_of_one_file_stay_whole() {
    let dir = scratch();
    let file = dir.join("job.json");
    write_json_atomic(&file, &json!({ "start": true })).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let read = reader(file.clone(), Arc::clone(&stop));
    let writers: Vec<_> = (0..8).map(|n| {
        let file = file.clone();
        thread::spawn(move || {
            for round in 0..60 {
                // Values of different lengths, so an interleaved write could not pass as whole.
                let value = json!({ "writer": n, "round": round, "pad": "x".repeat((n * 997 + round * 13) % 4000) });
                write_json_atomic(&file, &value).unwrap();
            }
        })
    }).collect();
    for w in writers {
        w.join().unwrap();
    }
    stop.store(true, Ordering::SeqCst);
    assert!(read.join().unwrap() > 0);
    let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
    assert!(leftovers.is_empty(), "temporary files left behind");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn settling_one_dead_job_from_many_threads_keeps_job_json_whole() {
    let data = scratch();
    let cfg = Config::tenant(&data, "tester").unwrap();
    let dir = cfg.jobs_dir.clone().unwrap().join("dead-1");
    std::fs::create_dir_all(&dir).unwrap();
    // A worker that existed and is gone: the pid of a process that has exited, with a start that is not its own.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap()).arg("--list")
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    std::fs::write(dir.join("worker.lock"), json!({ "pid": pid, "start": "1" }).to_string()).unwrap();
    write_json_atomic(&dir.join("job.json"), &json!({ "key": "dead-1", "status": "running", "codexSpawnAt": null, "codexPid": null,
        "turnRequestedAt": null, "createdAt": iso(), "finishedAt": null })).unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let read = reader(dir.join("job.json"), Arc::clone(&stop));
    let settlers: Vec<_> = (0..8).map(|_| {
        let cfg = cfg.clone();
        thread::spawn(move || job::job(&cfg, "dead-1").unwrap())
    }).collect();
    let ends: Vec<Value> = settlers.into_iter().map(|t| t.join().unwrap()).collect();
    stop.store(true, Ordering::SeqCst);
    read.join().unwrap();
    // Exactly one end stands, and every thread got that one.
    for end in &ends {
        assert_eq!(end["status"], json!("failed"), "{end}");
        assert_eq!(end["finishedAt"], ends[0]["finishedAt"]);
    }
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("job.json")).unwrap()).unwrap();
    assert_eq!(stored["finishedAt"], ends[0]["finishedAt"]);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn a_tenant_is_only_its_own_folder() {
    let data = scratch();
    let cfg = Config::tenant(&data, "anna-1").unwrap();
    let user = std::path::absolute(&data).unwrap().join("users").join("anna-1");
    assert_eq!(cfg.jobs_dir, Some(user.join("jobs")));
    assert_eq!(cfg.accounts.len(), 1);
    assert_eq!(cfg.accounts[0].codex_home, user.join("codex-home"));
    assert!(cfg.root.is_none() && cfg.standalone);
    for bad in ["", "../x", "Anna", "a/b", "a.b", &"a".repeat(41)] {
        assert!(Config::tenant(&data, bad).is_err(), "{bad:?}");
    }
    let _ = std::fs::remove_dir_all(&data);
}
