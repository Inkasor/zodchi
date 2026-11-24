//! The guards of round 2's findings: tracked links are no files, a check runs only once its start is recorded, and
//! what a model sees of a check holds no private folder, no credential line and no command line.

use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use zodchi_flow::checks::{self, Phase};
use zodchi_flow::git::Git;
use zodchi_flow::patch::Plan;

fn temp(tag: &str) -> PathBuf {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() ^ std::process::id();
    let dir = std::env::temp_dir().join(format!("zodchi-flow-guards-{tag}-{n:08x}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn verification_output_screens_extended_and_git_spellings_of_a_windows_path() {
    let drive = 'C';
    let suffix = "Profile/Fixture/AppData/Local/Temp/candidate/checkout";
    let place = format!("//?/{drive}:/{suffix}");
    let places = [(place, "<candidate>")];
    let text = format!("{drive}:/{suffix}\n/c/{suffix}");
    assert_eq!(checks::sanitize(&text, &places), "<candidate>\n<candidate>");
}

#[cfg(unix)]
#[test]
fn verification_output_resolves_the_parent_of_a_removed_checkout() {
    let dir = temp("checkout-alias");
    let real = dir.join("temp");
    let alias = dir.join("alias");
    std::fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let relative = "removed/checkout";
    let places = [(alias.join(relative).display().to_string(), "<candidate>")];
    let git_path = std::fs::canonicalize(&real).unwrap().join(relative);
    let result = checks::sanitize(&git_path.display().to_string(), &places);
    std::fs::remove_dir_all(dir).unwrap();
    assert_eq!(result, "<candidate>");
}

fn git(dir: &Path, args: &[&str], input: Option<&str>) -> String {
    let mut c = Command::new("git");
    c.arg("-C").arg(dir).args(args).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    c.stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() });
    let mut child = c.spawn().unwrap();
    if let Some(text) = input {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn a_tracked_link_is_no_file() {
    let dir = temp("link");
    git(&dir, &["init", "-q"], None);
    git(&dir, &["config", "user.name", "Fixture"], None);
    git(&dir, &["config", "user.email", &format!("fixture{}example.org", '@')], None);
    std::fs::write(dir.join("plain.txt"), "plain\n").unwrap();
    git(&dir, &["add", "plain.txt"], None);
    // A link to a private path, stored as Git stores links: a blob with the target, mode 120000.
    let target = git(&dir, &["hash-object", "-w", "--stdin"], Some("/private/elsewhere/notes.txt"));
    git(&dir, &["update-index", "--add", "--cacheinfo", &format!("120000,{target},link.txt")], None);
    git(&dir, &["commit", "-q", "-m", "base"], None);
    let g = Git::new(&dir);
    assert!(g.show("HEAD", "link.txt").unwrap().is_none(), "the link's target is never shown as a file");
    assert!(g.tracked_link("HEAD", "link.txt").unwrap());
    assert_eq!(g.show("HEAD", "plain.txt").unwrap().unwrap(), b"plain\n");
    assert!(!g.tracked_link("HEAD", "plain.txt").unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_check_runs_only_after_its_start_is_recorded() {
    let dir = temp("gate");
    let logs = dir.join("logs");
    let cmd = vec!["echo ran > ran.txt".to_string()];
    // The journal could not record the start: the command never runs, and no further one starts.
    let mut refused = |_: Phase, _: u32| false;
    let (evidence, recorded) = checks::run_list(&cmd, "checks", &dir, &logs, Duration::from_secs(60), &mut refused);
    assert!(!recorded);
    assert!(evidence[0]["exitCode"].is_null());
    assert!(!dir.join("ran.txt").exists(), "the command did not run");
    // Recorded: it runs, with its real exit code, and its start comes before its end.
    let mut seen = Vec::new();
    let mut on = |phase: Phase, pid: u32| {
        seen.push((phase, pid));
        true
    };
    let two = vec!["echo ran > ran.txt".to_string(), "exit 3".to_string()];
    let (evidence, recorded) = checks::run_list(&two, "checks", &dir, &logs, Duration::from_secs(60), &mut on);
    assert!(recorded);
    assert_eq!(evidence.iter().map(|e| e["exitCode"].clone()).collect::<Vec<_>>(), vec![json!(0), json!(3)]);
    assert!(dir.join("ran.txt").exists());
    assert_eq!(seen.iter().map(|(p, _)| *p).collect::<Vec<_>>(), vec![Phase::Started, Phase::Ended, Phase::Started, Phase::Ended]);
    assert_eq!(seen[0].1, seen[1].1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_model_sees_no_private_folder_credential_or_command() {
    // The paths are put together here, so that no literal one sits in the repository.
    let drive = format!("Q{}", ':');
    let home = format!("{drive}/Folks/someone");
    let tmp = format!("{home}/AppData/Local/Temp");
    let places = vec![(home.replace('/', "\\"), "~"), (tmp.clone(), "<tmp>")];
    let at = '@';
    let log = format!("at {}\\zodchi-flow-x\\a.mjs:3\nread /q/Folks/someone/fixture.json\nTOKEN=abc123 was set\nfetch https://user:pw{at}example.org/x failed\nplain line", tmp.replace('/', "\\"));
    let out = checks::sanitize(&log, &places);
    assert!(!out.to_lowercase().contains("someone"), "{out}");
    assert!(out.contains("<tmp>\\zodchi-flow-x\\a.mjs:3"), "{out}");
    assert!(out.contains("read ~/fixture.json"), "{out}");
    assert!(!out.contains("abc123") && !out.contains(&format!("pw{at}")), "{out}");
    assert!(out.ends_with("plain line"));
    let evidence = vec![json!({ "source": "checks", "command": "node a.mjs --key=SECRET" }), json!({ "source": "args.verify", "command": "x" }), json!({ "source": "checks", "command": "y" })];
    assert_eq!([checks::name(&evidence, 0), checks::name(&evidence, 1), checks::name(&evidence, 2)], ["checks #1", "args.verify #1", "checks #2"]);
}

#[test]
fn a_saved_plan_keeps_exact_modes() {
    let plan = Plan::from_json(&json!({ "writes": { "a": "x" }, "before": { "a": "0" }, "after": { "a": "1" }, "exec": [], "modes": { "a": 0o700 } })).unwrap();
    assert_eq!(plan.modes["a"], 0o700);
    assert_eq!(Plan::from_json(&plan.to_json()).unwrap().modes["a"], 0o700);
    assert!(Plan::from_json(&json!({ "writes": {}, "before": {}, "after": {}, "exec": [], "modes": { "a": "rwx" } })).is_none(), "a damaged mode is no plan");
}
