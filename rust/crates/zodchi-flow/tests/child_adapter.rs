//! Exercise the private child adapter through its two CLI parent workflows.

use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};
use zodchi_core::util::sha256_hex;
use zodchi_flow::{journal::new_run_id, CUT_EXIT};

fn checkout() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
}

fn cli_binary() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let output = Command::new(env!("CARGO"))
            .current_dir(checkout().join("rust"))
            .args([
                "build",
                "--offline",
                "--locked",
                "-p",
                "zodchi-cli",
                "--bin",
                "zodchi",
                "--message-format=json",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find_map(|row| {
                if row["reason"] == "compiler-artifact" && row["target"]["name"] == "zodchi" {
                    row["executable"].as_str().map(PathBuf::from)
                } else {
                    None
                }
            })
            .expect("Cargo reported the sibling CLI binary")
    })
}

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    flows: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = temp_root().join(format!("zodchi-child-{}", new_run_id()));
        let fixture = Self {
            repo: root.join("repo"),
            flows: root.join("zodchi/flows"),
            root,
        };
        for name in ["repo", "home", "tmp", "zodchi", "codex"] {
            fs::create_dir_all(fixture.root.join(name)).unwrap();
        }
        fixture.put("codex/fake-auth.json", "{}");
        fixture.git(&["init", "-q", "-b", "fixture"]);
        fixture.put("repo/.gitignore", ".agent-tmp/\n");
        fixture.put("repo/clamp.mjs", "export const clamp = (x, lo, hi) => x;\n");
        fixture.git(&["add", "."]);
        fixture.git(&["commit", "-qm", "Fixture base"]);
        fixture
    }

    fn command(&self, program: impl AsRef<Path>) -> Command {
        let mut command = Command::new(program.as_ref());
        command
            .current_dir(&self.repo)
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("ZODCHI_HOME", self.root.join("zodchi"))
            .env("CODEX_HOME", self.root.join("codex"))
            .env("ZODCHI_ROLES", checkout().join("roles"))
            .env(
                "ZODCHI_CODEX_BIN",
                checkout().join("scripts/e2e/fake-codex-flow.mjs"),
            )
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Flow fixture")
            .env("GIT_AUTHOR_EMAIL", concat!("fixture", "@", "example.test"))
            .env("GIT_COMMITTER_NAME", "Flow fixture")
            .env(
                "GIT_COMMITTER_EMAIL",
                concat!("fixture", "@", "example.test"),
            );
        for key in ["TMPDIR", "TEMP", "TMP"] {
            command.env(key, self.root.join("tmp"));
        }
        for key in [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "ZODCHI_FLOW_CUT",
            "ZODCHI_DENYLIST",
            "ZODCHI_CLAUDE_BIN",
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_CONFIG_GLOBAL",
            "GIT_TRACE2_EVENT",
        ] {
            command.env_remove(key);
        }
        command
    }

    fn git(&self, args: &[&str]) -> String {
        let output = self.command("git").args(args).output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn put(&self, name: &str, content: impl AsRef<[u8]>) -> PathBuf {
        let path = self.root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }

    fn put_json(&self, name: &str, value: Value) -> PathBuf {
        self.put(name, serde_json::to_vec(&value).unwrap())
    }

    fn flow(&self, args: &[&str]) -> Command {
        let mut command = self.command(cli_binary());
        command
            .arg("flow")
            .args(args)
            .env("GIT_TRACE2_EVENT", self.root.join("git-trace.jsonl"));
        command
    }

    fn run_flow(&self, mut command: Command, expected: i32) -> Output {
        let call = new_run_id();
        let stdout = self.root.join(format!("{call}.out"));
        let stderr = self.root.join(format!("{call}.err"));
        let mut child = command
            .stdin(Stdio::null())
            .stdout(fs::File::create(&stdout).unwrap())
            .stderr(fs::File::create(&stderr).unwrap())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("flow timed out: {}", fs::read_to_string(&stderr).unwrap());
            }
            thread::sleep(Duration::from_millis(15));
        };
        let stdout = fs::read(stdout).unwrap();
        let stderr = fs::read(stderr).unwrap();
        assert_eq!(
            status.code(),
            Some(expected),
            "{command:?}\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        );
        Output {
            status,
            stdout,
            stderr,
        }
    }

    fn runs(&self, workflow: &str) -> Vec<String> {
        fs::read_dir(&self.flows)
            .into_iter()
            .flatten()
            .map(|row| row.unwrap())
            .filter_map(|row| {
                let run: Value =
                    serde_json::from_slice(&fs::read(row.path().join("run.json")).unwrap())
                        .unwrap();
                (run["workflow"] == workflow).then(|| row.file_name().into_string().unwrap())
            })
            .collect()
    }

    fn only_run(&self, workflow: &str) -> String {
        let ids = self.runs(workflow);
        assert_eq!(ids.len(), 1, "expected one {workflow} journal");
        ids[0].clone()
    }

    fn child_starts(&self) -> usize {
        // The package gate precedes journal creation, so this sees even a duplicate start attempt.
        jsonl(&self.root.join("git-trace.jsonl"))
            .iter()
            .filter(|row| {
                row["event"] == "start"
                    && row["argv"].as_array().is_some_and(|argv| {
                        argv.windows(6).any(|args| {
                            args == [
                                "-c",
                                "core.quotepath=false",
                                "check-ignore",
                                "-q",
                                "--",
                                ".agent-tmp/gateway/",
                            ]
                        })
                    })
            })
            .count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if thread::panicking() {
            eprintln!("Fixture kept at {}", self.root.display());
        } else {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

fn jsonl(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn result(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn asset_child_reenters_through_control_after_context_cut() {
    let fixture = Fixture::new();
    let brief = fixture.put(
        "brief.md",
        "# Clamp\n\nKeep the value within the given limits.\n",
    );
    let blob = fixture.git(&["rev-parse", "HEAD:clamp.mjs"]);
    fixture.put_json("codex/fake-flow/write.json", json!({
        "status": "done", "summary": "Clamp the value", "unverified": [], "questions": [],
        "changes": [{"op": "modify", "path": "clamp.mjs", "from": null, "baseBlob": blob,
            "content": "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n", "edits": null}],
    }));
    fixture.put_json(
        "codex/fake-flow/review-1.json",
        json!({
            "verdict": "approved", "summary": "Fixture approved", "findings": [], "notVerified": [],
        }),
    );
    let package = fixture.put_json(
        "package.json",
        json!({
            "label": "clamp", "brief": brief, "repo": fixture.repo, "files": ["clamp.mjs"],
        }),
    );
    let ledger = fixture.put_json(
        "repo/ledger.json",
        json!({"method": "timber", "rounds": []}),
    );
    let args = fixture.put_json(
        "asset.json",
        json!({
            "repo": fixture.repo, "ledger": ledger, "tmp": fixture.root.join("asset"),
            "label": "shelf", "stage": 1, "summary": "Check the shelf support", "package": package,
        }),
    );
    let mut start = fixture.flow(&["asset-round", "--args", args.to_str().unwrap()]);
    start.env("ZODCHI_FLOW_CUT", "code-package context");
    fixture.run_flow(start, CUT_EXIT);

    let parent = fixture.only_run("asset-round");
    let child = fixture.only_run("code-package");
    let parent_events = fixture.flows.join(&parent).join("events.jsonl");
    let before = jsonl(&parent_events);
    assert_eq!(before.len(), 1);
    let intent = &before[0];
    assert_eq!(intent["kind"], "child intent");
    assert_eq!(intent["runId"], child);
    assert_eq!(intent["workflow"], "code-package");
    assert_eq!(intent["step"], "package");
    assert_eq!(intent["attempt"], 1);
    assert_eq!(fixture.child_starts(), 1);
    let turns_file = fixture.root.join("codex/fake-turns.jsonl");
    assert!(!turns_file.exists());
    let dir = fixture.flows.join(&child);
    assert!(!dir.join("initialized").exists());
    assert!(!dir.join("brief.md").exists());
    assert!(jsonl(&dir.join("events.jsonl")).is_empty());

    let journal = dir.join("run.json");
    let frozen = fs::read(&journal).unwrap();
    let mut altered: Value = serde_json::from_slice(&frozen).unwrap();
    let mut canonical_args = altered["inputs"]["args"].clone();
    canonical_args.sort_all_objects();
    assert_eq!(intent["argsSha256"], sha256_hex(canonical_args.to_string()));
    altered["inputs"]["args"]["label"] = json!("different fixture");
    fs::write(&journal, serde_json::to_vec(&altered).unwrap()).unwrap();
    let resume = ["asset-round", "--resume", &parent];
    let mismatch = fixture.run_flow(fixture.flow(&resume), 1);
    assert_eq!(
        String::from_utf8_lossy(&mismatch.stderr).trim(),
        format!("The args differ from those run {child} started with.")
    );
    assert!(!turns_file.exists());
    fs::write(&journal, &frozen).unwrap();

    let resumed = result(&fixture.run_flow(fixture.flow(&resume), 2));
    assert_eq!(resumed["status"], "waiting");
    assert!(resumed["stoppedAt"].is_null());
    assert_eq!(fixture.runs("code-package"), [child.clone()]);
    assert_eq!(fixture.child_starts(), 1);
    assert_eq!(fs::read(journal).unwrap(), frozen);
    assert_eq!(
        fs::read(dir.join("brief.md")).unwrap(),
        fs::read(brief).unwrap()
    );
    assert_eq!(fs::read_to_string(dir.join("initialized")).unwrap(), "1\n");
    assert!(jsonl(&dir.join("events.jsonl"))
        .iter()
        .any(|event| event["kind"] == "finished"));
    let after = jsonl(&parent_events);
    assert_eq!(after.len(), 3);
    assert_eq!(after[0], before[0]);
    assert_eq!(after[1]["kind"], "done");
    assert_eq!(after[1]["step"], "package");
    assert_eq!(after[1]["result"]["runId"], child);
    assert_eq!(after[1]["result"]["ok"], true);
    assert_eq!(after[2]["kind"], "waiting");
    assert!(!fixture.flows.join(parent).join("result.json").exists());
    let turns = jsonl(&turns_file);
    let steps: Vec<_> = turns
        .iter()
        .map(|turn| turn["step"].as_str().unwrap())
        .collect();
    assert_eq!(steps, ["write", "review 1"]);
}

#[cfg(windows)]
fn windows_elevated() -> bool {
    // The same probe as the ops-script e2e scenarios: CI runners on Windows run elevated.
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "$p = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"])
        .output()
        .expect("cannot detect Windows elevation");
    match String::from_utf8_lossy(&out.stdout).trim() {
        "True" => true,
        "False" => false,
        other => panic!("cannot detect Windows elevation: {other}"),
    }
}

/// The system temp folder without its own links (macOS keeps it under the /var link).
fn temp_root() -> PathBuf {
    let base = env::temp_dir();
    #[cfg(unix)]
    let base = base.canonicalize().unwrap();
    base
}

fn ops_host_refusal() -> Option<&'static str> {
    #[cfg(target_os = "linux")]
    return (unsafe { libc::getuid() == 0 || libc::geteuid() == 0 })
        .then_some("must not run as root or elevated");
    #[cfg(windows)]
    return windows_elevated().then_some("must not run as root or elevated");
    #[cfg(all(unix, not(target_os = "linux")))]
    return Some("cannot enforce the local dry-run privilege boundary");
    #[cfg(not(any(unix, windows)))]
    return Some("Cannot verify the current privilege");
}

#[test]
fn ops_repair_with_uninitialized_child_stays_unresolved() {
    let fixture = Fixture::new();
    let tmp = fixture.root.join("ops");
    fs::create_dir(&tmp).unwrap();
    if let Some(reason) = ops_host_refusal() {
        let script = fixture.put("unsupported.sh", "#!/bin/sh\nexit 0\n");
        let args = fixture.put_json(
            "ops.json",
            json!({
                "script": script, "tmp": tmp, "sudo": ["sudo", "bash", "{script}"], "fixes": 0,
            }),
        );
        let output = fixture.run_flow(
            fixture.flow(&["ops-script", "--args", args.to_str().unwrap()]),
            2,
        );
        assert!(result(&output)["refused"]
            .as_str()
            .unwrap()
            .contains(reason));
        assert!(fixture.runs("ops-script").is_empty());
        return;
    }

    let python = ["python3", "python"]
        .into_iter()
        .find(|python| {
            fixture
                .command(python)
                .args(["-c", "import sys; assert sys.version_info.major == 3"])
                .output()
                .is_ok_and(|output| output.status.success())
        })
        .expect("the ops-script fixture needs Python 3");
    let script = fixture.put("repo/example.py", "if True print('bad syntax')\n");
    fixture.git(&["add", "example.py"]);
    fixture.git(&["commit", "-qm", "Add the script"]);
    let args = fixture.put_json(
        "ops.json",
        json!({
            "script": script, "tmp": tmp, "check": [python, "{copy}", "--check"],
            "sudo": ["sudo", python, "{script}", "--apply"], "fixes": 1, "repo": fixture.repo,
        }),
    );
    // Preflight probes these fixture tools for their versions. The only effect is the Python syntax check.
    let tool = fixture.put("tool.rs", r#"fn main() {
        let exe = std::env::current_exe().unwrap();
        if exe.file_stem().unwrap() == "sha256sum" { println!("sha256sum (GNU coreutils) fixture"); }
        else { println!("GNU bash, version fixture"); }
    }"#);
    let bash = fixture
        .root
        .join(format!("bash{}", env::consts::EXE_SUFFIX));
    let compiler = Command::new("rustc")
        .arg("--edition=2021")
        .arg(tool)
        .arg("-o")
        .arg(&bash)
        .output()
        .unwrap();
    assert!(
        compiler.status.success(),
        "{}",
        String::from_utf8_lossy(&compiler.stderr)
    );
    fs::copy(
        &bash,
        fixture
            .root
            .join(format!("sha256sum{}", env::consts::EXE_SUFFIX)),
    )
    .unwrap();
    let path = env::join_paths(
        std::iter::once(fixture.root.clone())
            .chain(env::split_paths(&env::var_os("PATH").unwrap_or_default())),
    )
    .unwrap();
    let mut start = fixture.flow(&["ops-script", "--args", args.to_str().unwrap()]);
    start
        .env("PATH", path)
        .env("ZODCHI_BASH", bash)
        .env("ZODCHI_FLOW_CUT", "code-package context");
    fixture.run_flow(start, CUT_EXIT);

    let parent = fixture.only_run("ops-script");
    let child = fixture.only_run("code-package");
    let parent_dir = fixture.flows.join(&parent);
    let parent_events = parent_dir.join("events.jsonl");
    let before = jsonl(&parent_events);
    let intent = before.last().unwrap();
    assert_eq!(intent["kind"], "ops-repair");
    assert_eq!(intent["attempt"], 0);
    assert_eq!(intent["child"], child);
    assert_eq!(intent["args"]["label"], format!("ops-{parent}-0"));
    let brief = Path::new(intent["args"]["brief"].as_str().unwrap());
    assert_eq!(
        brief.file_name().unwrap(),
        format!("repair-0-{child}.md").as_str()
    );
    assert!(brief.is_file());
    let failed = &before[before.len() - 2];
    assert_eq!(failed["kind"], "ops-done");
    assert_eq!(failed["step"], "static 0");
    assert_eq!(failed["result"]["ok"], false);
    assert_eq!(fixture.child_starts(), 1);
    let child_dir = fixture.flows.join(&child);
    let journal = child_dir.join("run.json");
    let frozen = fs::read(&journal).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&frozen).unwrap()["inputs"]["args"],
        intent["args"]
    );
    assert!(!child_dir.join("initialized").exists());
    assert!(jsonl(&child_dir.join("events.jsonl")).is_empty());

    let resumed = result(&fixture.run_flow(fixture.flow(&["ops-script", "--resume", &parent]), 2));
    assert_eq!(resumed["status"], "unresolved");
    assert_eq!(resumed["runId"], parent);
    assert_eq!(resumed["step"], format!("repair 0 ({child})"));
    assert_eq!(fixture.runs("code-package"), [child]);
    assert_eq!(fixture.child_starts(), 1);
    assert_eq!(fs::read(journal).unwrap(), frozen);
    assert!(!child_dir.join("initialized").exists());
    assert!(!child_dir.join("brief.md").exists());
    assert!(jsonl(&child_dir.join("events.jsonl")).is_empty());
    assert_eq!(jsonl(&parent_events), before);
    assert!(!parent_dir.join("result.json").exists());
    assert!(!fixture.root.join("codex/fake-turns.jsonl").exists());
}
