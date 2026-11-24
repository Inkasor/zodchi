//! The engine's Git and journal primitives against a throwaway repository and run folder.

use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use zodchi_flow::git::Git;
use zodchi_flow::journal::Journal;
use zodchi_flow::patch::Plan;

fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zodchi-flow-test-{tag}-{:08x}", rand_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn rand_suffix() -> u32 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() ^ std::process::id()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo(tag: &str) -> PathBuf {
    let dir = temp(tag);
    git(&dir, &["init", "-q"]);
    git(&dir, &["config", "user.name", "Fixture"]);
    git(&dir, &["config", "user.email", &format!("fixture{}example.org", '@')]);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/a.txt"), "a\n").unwrap();
    std::fs::write(dir.join("src/b.txt"), "b\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "base"]);
    dir
}

#[test]
fn a_missing_file_is_absent_not_an_error() {
    let dir = repo("absent");
    let g = Git::new(&dir);
    assert!(!g.exists_at("HEAD", "REVIEW.md").unwrap());
    assert!(!g.exists_at("HEAD", ".claude/skills/verify/SKILL.md").unwrap());
    assert!(g.show("HEAD", "REVIEW.md").unwrap().is_none());
    assert!(g.exists_at("HEAD", "src/a.txt").unwrap());
    assert_eq!(g.show("HEAD", "src/a.txt").unwrap().unwrap(), b"a\n");
    assert_eq!(g.entry_at("HEAD", "src").unwrap().unwrap().1, "tree");
    assert!(g.show("HEAD", "src").unwrap().is_none(), "a folder is not a file");
    assert!(g.exists_at("no-such-commit", "src/a.txt").is_err(), "an unreadable commit is an error");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_candidate_tree_takes_claimed_files_only() {
    let dir = repo("candidate");
    let g = Git::new(&dir);
    std::fs::write(dir.join("src/a.txt"), "a2\n").unwrap();
    std::fs::write(dir.join("src/b.txt"), "b2\n").unwrap();
    let scratch = temp("candidate-scratch");
    let tree = g.candidate_tree("HEAD", &["src/a.txt".to_string()], &[], &scratch).unwrap();
    let changed = g.changes("HEAD", &tree).unwrap();
    assert_eq!(changed, vec![("M".to_string(), "src/a.txt".to_string())]);
    // A folder named as a claim takes in its whole content: refused.
    assert!(g.candidate_tree("HEAD", &["src".to_string()], &[], &scratch).is_err());
    // A renamed script keeps its executable mode.
    std::fs::write(dir.join("src/run.sh"), "echo hi\n").unwrap();
    let tree = g.candidate_tree("HEAD", &["src/run.sh".to_string()], &["src/run.sh".to_string()], &scratch).unwrap();
    assert_eq!(g.entry_at(&tree, "src/run.sh").unwrap().unwrap().0, "100755");
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&scratch);
}

#[test]
fn a_torn_last_record_is_dropped_and_the_next_one_reads() {
    let home = temp("journal");
    let mut j = Journal::create(&home, "run-1", &json!({ "runId": "run-1" })).unwrap();
    j.append(json!({ "kind": "intent", "step": "write" })).unwrap();
    let file = home.join("flows/run-1/events.jsonl");
    let mut bytes = std::fs::read(&file).unwrap();
    // A record cut in the middle of a multi-byte character, without its line end.
    bytes.extend_from_slice("{\"kind\":\"done\",\"note\":\"\u{00e9}".as_bytes());
    bytes.pop();
    std::fs::write(&file, &bytes).unwrap();
    let (mut j, _) = Journal::open(&home, "run-1").unwrap();
    j.load().unwrap();
    assert_eq!(j.events().len(), 1);
    j.append(json!({ "kind": "done", "step": "write" })).unwrap();
    let (mut again, _) = Journal::open(&home, "run-1").unwrap();
    again.load().unwrap();
    assert_eq!(again.events().len(), 2, "the record after the repair is read");
    // A broken record in the middle is never read as a shorter history.
    let mut text = std::fs::read(&file).unwrap();
    text.splice(0..1, b"#".iter().copied());
    std::fs::write(&file, &text).unwrap();
    let (mut broken, _) = Journal::open(&home, "run-1").unwrap();
    assert!(broken.load().is_err());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_damaged_plan_is_not_an_empty_one() {
    assert!(Plan::from_json(&serde_json::Value::Null).is_none());
    assert!(Plan::from_json(&json!({ "writes": {}, "before": {} })).is_none());
    let plan = Plan::from_json(&json!({ "writes": { "a": "x" }, "before": { "a": null }, "after": { "a": "1" }, "exec": [] })).unwrap();
    assert_eq!(plan.writes["a"].as_deref(), Some(b"x".as_slice()));
}
