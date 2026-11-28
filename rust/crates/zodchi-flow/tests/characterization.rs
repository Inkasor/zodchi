//! Pre-split observations taken through the public CLI. All repositories, accounts and answers are fixtures.
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};
use zodchi_core::util::sha256_hex;
use zodchi_flow::{journal::new_run_id, CUT_EXIT};

const STUB: &str = "export const clamp = (x, lo, hi) => x;\n";
const FIXED: &str = "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n";

fn checkout() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
}

fn baseline() -> Value {
    serde_json::from_str(include_str!("fixtures/pre_split/journals.json")).unwrap()
}

fn cli_binary() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        // Cargo only supplies CARGO_BIN_EXE for binaries in the test's own package.
        // Ask for the sibling binary using the same build directory and locked dependencies.
        let result = Command::new(env!("CARGO"))
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
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8_lossy(&result.stdout)
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find_map(|row| {
                (row["reason"] == "compiler-artifact" && row["target"]["name"] == "zodchi")
                    .then(|| row["executable"].as_str().map(PathBuf::from))
                    .flatten()
            })
            .expect("Cargo reported the CLI binary")
    })
}

struct World {
    dir: PathBuf,
    repo: PathBuf,
    home: PathBuf,
    codex: PathBuf,
}

impl World {
    fn new() -> Self {
        // Workspace audit requires its output to be outside every Git checkout.
        let dir = temp_root().join(format!("zodchi-split-{}", new_run_id()));
        let home = dir.join("zodchi");
        let codex = dir.join("codex");
        let repo = dir.join("repo");
        for path in [&home, &codex, &repo, &dir.join("home"), &dir.join("tmp")] {
            fs::create_dir_all(path).unwrap();
        }
        let world = Self {
            dir,
            repo,
            home,
            codex,
        };
        fs::write(world.codex.join("fake-auth.json"), "{}").unwrap();
        world.git(&["init", "-q", "-b", "fixture"]);
        world.put("repo/.gitignore", ".agent-tmp/\n");
        world.put("repo/src/math.mjs", STUB);
        world.put(
            "brief.md",
            "# Clamp\n\nKeep the value within the given limits.\n",
        );
        world.git(&["add", "."]);
        world.git(&["commit", "-qm", "Fixture base"]);
        world
    }

    fn command(&self, program: impl AsRef<Path>) -> Command {
        let mut command = Command::new(program.as_ref());
        command
            .current_dir(&self.repo)
            .env("HOME", self.dir.join("home"))
            .env("USERPROFILE", self.dir.join("home"))
            .env("ZODCHI_HOME", &self.home)
            .env("CODEX_HOME", &self.codex)
            .env("ZODCHI_ROLES", checkout().join("roles"))
            .env(
                "ZODCHI_CODEX_BIN",
                checkout().join("scripts/e2e/fake-codex-flow.mjs"),
            )
            .env("ZODCHI_FIXTURE_VIDEO_TRACE", self.dir.join("video.log"))
            .env("ZODCHI_FIXTURE_VIDEO_FRAME", self.dir.join("frame.png"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Flow fixture")
            .env("GIT_AUTHOR_EMAIL", concat!("fixture", "@", "example.test"))
            .env("GIT_COMMITTER_NAME", "Flow fixture")
            .env(
                "GIT_COMMITTER_EMAIL",
                concat!("fixture", "@", "example.test"),
            )
            .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
            .env("TMPDIR", self.dir.join("tmp"))
            .env("TEMP", self.dir.join("tmp"))
            .env("TMP", self.dir.join("tmp"));
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
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn put(&self, path: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
        let file = self.dir.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, bytes).unwrap();
        file
    }

    fn write(&self, path: &str, value: &Value) -> PathBuf {
        self.put(path, serde_json::to_vec_pretty(value).unwrap())
    }

    fn answer(&self, step: &str, answer: Value) {
        self.write(
            &format!("codex/fake-flow/{}.json", step.replace(' ', "-")),
            &answer,
        );
    }

    fn flow(&self, args: &[&str]) -> Reply {
        self.flow_env(args, &[])
    }

    fn flow_env(&self, args: &[&str], extra: &[(&str, &str)]) -> Reply {
        let key = new_run_id();
        let stdout = self.dir.join(format!("{key}.out"));
        let stderr = self.dir.join(format!("{key}.err"));
        let mut child = self
            .command(cli_binary())
            .arg("flow")
            .args(args)
            .envs(extra.iter().copied())
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
                panic!(
                    "flow {args:?} timed out: {}",
                    fs::read_to_string(stderr).unwrap()
                );
            }
            thread::sleep(Duration::from_millis(15));
        };
        Reply::new(
            args,
            Output {
                status,
                stdout: fs::read(stdout).unwrap(),
                stderr: fs::read(stderr).unwrap(),
            },
        )
    }

    fn start(&self, workflow: &str, args: &Value, cut: Option<&str>) -> Reply {
        let file = self.write("start.json", args);
        let args = [workflow, "--args", file.to_str().unwrap()];
        match cut {
            Some(point) => self.flow_env(&args, &[("ZODCHI_FLOW_CUT", point)]),
            None => self.flow(&args),
        }
    }

    fn runs(&self, workflow: &str) -> Vec<String> {
        fs::read_dir(self.home.join("flows"))
            .into_iter()
            .flatten()
            .map(|row| row.unwrap())
            .filter_map(|row| {
                let run = read_json(&row.path().join("run.json"));
                (run["workflow"] == workflow).then(|| row.file_name().into_string().unwrap())
            })
            .collect()
    }

    fn run(&self, id: &str) -> PathBuf {
        self.home.join("flows").join(id)
    }

    fn one_run(&self, workflow: &str) -> String {
        let ids = self.runs(workflow);
        assert_eq!(ids.len(), 1, "expected one {workflow} run");
        ids[0].clone()
    }

    fn tool(&self, source: &Path, name: &str) -> PathBuf {
        let exe = self.dir.join(format!("{name}{}", env::consts::EXE_SUFFIX));
        let output = Command::new("rustc")
            .args(["--edition=2021"])
            .arg(source)
            .arg("-o")
            .arg(&exe)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fixture tool: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        exe
    }

    fn steps(&self) -> Vec<String> {
        let file = self.codex.join("fake-turns.jsonl");
        if !file.is_file() {
            return Vec::new();
        }
        jsonl(&file)
            .iter()
            .map(|row| row["step"].as_str().unwrap().to_owned())
            .collect()
    }
}

impl Drop for World {
    fn drop(&mut self) {
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.dir);
        } else {
            eprintln!("Fixture kept at {}", self.dir.display());
        }
    }
}

#[derive(Debug)]
struct Reply {
    code: i32,
    result: Value,
    err: String,
    out: String,
}

impl Reply {
    fn new(args: &[&str], output: Output) -> Self {
        let out = String::from_utf8(output.stdout).unwrap();
        let err = String::from_utf8_lossy(&output.stderr).into_owned();
        let code = output.status.code().unwrap_or(-1);
        assert_ne!(
            code as u32, 0xc0000142,
            "flow {args:?}: STATUS_DLL_INIT_FAILED ({code})"
        );
        let result = if out.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&out).unwrap()
        };
        Self {
            code,
            result,
            err,
            out,
        }
    }

    fn code(&self, expected: i32) -> &Self {
        assert_eq!(self.code, expected, "{self:?}");
        self
    }

    fn wrong(&self, message: &str) {
        self.code(1);
        assert!(
            self.out.is_empty() && self.err.contains(message),
            "{self:?}"
        );
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap()
}

fn jsonl(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn review() -> Value {
    json!({"verdict":"approved","summary":"Fixture approved","findings":[],"notVerified":[]})
}

fn research_answer() -> Value {
    json!({"items":[{"text":"Use one support at each end.","group":"Supports","replaces":[]}],
        "assumptions":[],"facts":[]})
}

fn research_args(w: &World) -> Value {
    w.put("zodchi/private-words.txt", "synthetic-private-word\n");
    let request = w.put("request.md", "A workshop shelf.\n");
    let question = w.put("question.md", "Where should the supports go?\n");
    w.answer(
        "constraints",
        json!({"complete":true,
        "constraints":[{"text":"Hold a small box.","status":"unconfirmed","decision":""}]}),
    );
    json!({"repo":w.repo,"tmp":w.dir.join("research"),"label":"workshop","request":request,
        "questions":[{"file":question,"title":"Supports"}]})
}

fn package(w: &World) -> Value {
    let blob = w.git(&["rev-parse", "HEAD:src/math.mjs"]);
    w.answer("write", json!({"status":"done","summary":"Clamp the value","unverified":[],"questions":[],
        "changes":[{"op":"modify","path":"src/math.mjs","from":null,"baseBlob":blob,"content":FIXED,"edits":null}]}));
    w.answer("review 1", review());
    json!({"label":"clamp","brief":w.dir.join("brief.md"),"repo":w.repo,"files":["src/math.mjs"]})
}

fn controls(w: &World) {
    let id = "20260101-000000-abcdef";
    let missing = "20260101-000000-012345";
    let note = w.put("note.txt", "Keep the existing wording.\n");
    let note = note.to_str().unwrap();
    let scope = w.write("scope.json", &json!(["src/extra.mjs"]));
    let scope = scope.to_str().unwrap();
    let (mut j, _) = {
        w.write(&format!("zodchi/flows/{id}/run.json"), &json!({
            "runId":id, "workflow":"code-package", "version":"1", "release":"1.0.3", "repo":w.repo,
            "inputs":{"args":{"budget":{"calls":1}}}
        }));
        w.put(&format!("zodchi/flows/{id}/events.jsonl"), "");
        zodchi_flow::journal::Journal::open(&w.home, id).unwrap()
    };
    j.append(json!({"kind":"waiting","step":"write","reason":"budget"}))
        .unwrap();
    let status = w.flow(&["status", id]);
    assert_eq!(status.code(0).result["status"], "waiting");
    let handoff = w.flow(&["status", id, "--handoff"]);
    assert_eq!(handoff.code(0).result["step"], "write");
    let remark = w.flow(&["remark", id, "--file", note]);
    assert_eq!(remark.code(0).result["status"], "recorded");
    let saved_remark = format!(
        "remarks/{}.json",
        remark.result["remarkId"].as_str().unwrap()
    );
    assert_eq!(
        read_json(&j.file(&saved_remark))["text"],
        "Keep the existing wording."
    );
    let extend = w.flow(&["budget", id, "--add-calls", "2"]);
    assert_eq!(extend.code(0).result["budget"]["callLimit"], 3);
    assert_eq!(w.flow(&["apply", id]).code(2).result["status"], "blocked");
    j.append(json!({"kind":"waiting","step":"apply write","scope":["src/extra.mjs"]}))
        .unwrap();
    let allowed = w.flow(&["reply", id, "--allow-files", scope]);
    assert_eq!(
        allowed.code(0).result["allowFiles"],
        json!(["src/extra.mjs"])
    );
    j.append(json!({"kind":"waiting","step":"write","question":"Accept these words?"}))
        .unwrap();
    let reply = w.flow(&["reply", id, "--file", note]);
    assert_eq!(reply.code(0).result["status"], "ready");
    assert_eq!(
        jsonl(&j.file("events.jsonl")).last().unwrap()["ownerAnswer"],
        "Keep the existing wording."
    );
    w.flow(&["_worker", missing]).wrong("No run");
    w.flow(&["_worker", missing, "write"]).wrong("No run");
}

#[test]
fn cli_catalog_controls_and_invalid_calls() {
    let w = World::new();
    let list = w.flow(&["list"]);
    let list = &list.code(0).result;
    let help = w.flow(&["--help"]);
    let help = &help.code(0).result;
    assert_eq!(help["catalog"], *list);
    let recorded = baseline();
    let usage = recorded["usage"].as_str().unwrap()
        .replace("       zodchi flow <workflow> --resume", concat!(
            "       zodchi flow verify <commit-or-ref> [--repo <dir>] [--args <file.json>] [--only checks|verify] [--detach]\n",
            "       zodchi flow <workflow> --resume",
        ))
        .replace("--allow-files <file.json>\n", "--allow-files <file.json> [--file <text>]\n")
        .replace("0 success or approved,", "0 success, approved or closed by the owner,");
    assert_eq!(help["usage"], usage.as_str());
    let mut prior_catalog = list.clone();
    let prior_entries = prior_catalog["workflows"].as_array_mut().unwrap();
    let verify = prior_entries.iter().position(|entry| entry["name"] == "verify").unwrap();
    assert_eq!(prior_entries.remove(verify), json!({
        "name": "verify",
        "version": "1",
        "domain": "core",
        "purpose": "Run the project's verification on a committed tree without a model call.",
        "limits": "Runs the committed plan in the shared check checkout and records a reusable receipt.",
        "required": ["commit-or-ref"],
        "docs": "docs/flow.md#verify-a-commit",
        "example": { "commit-or-ref": "HEAD" }
    }));
    let package = prior_entries.iter_mut()
        .find(|entry| entry["name"] == "code-package").unwrap();
    let limits = package["limits"].as_str().unwrap()
        .strip_suffix(" Set kind to analysis to select hardWriter (the default is code).").unwrap();
    package["limits"] = json!(limits);
    assert_eq!(
        sha256_hex(prior_catalog.to_string()),
        recorded["catalogSha256"].as_str().unwrap()
    );
    let names: BTreeSet<_> = list["workflows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    let captured: BTreeSet<_> = recorded["runs"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .chain(["verify"])
        .collect();
    assert_eq!(names, captured);
    assert_eq!(w.flow(&["-h"]).code(0).result, *help);
    let entries = list["workflows"].as_array().unwrap();
    for entry in entries {
        let name = entry["name"].as_str().unwrap();
        assert_eq!(w.flow(&[name, "--help"]).code(0).result, *entry);
        if name == "code-package" {
            assert_eq!(
                entry["dryRun"],
                "zodchi flow code-package --args <file.json> --dry-run"
            );
        }
    }
    let repo = w.repo.to_str().unwrap();
    assert_eq!(w.flow(&["list", "--repo", repo]).code(0).result, *list);
    w.write(
        "repo/.zodchi/workflows.json",
        &json!({"domains": ["video"]}),
    );
    w.git(&["add", ".zodchi/workflows.json"]);
    w.git(&["commit", "-qm", "Enable the video domain"]);
    w.write("repo/.zodchi/workflows.json", &json!({"domains": []}));
    let mut expected = list.clone();
    expected["workflows"]
        .as_array_mut()
        .unwrap()
        .retain(|row| row["domain"] == "core" || row["domain"] == "video");
    assert_ne!(expected, *list);
    assert_eq!(w.flow(&["list", "--repo", repo]).code(0).result, expected);
    let cleanup = w.flow(&["cleanup", "--help"]);
    assert!(cleanup.code(0).result["usage"]
        .as_str()
        .unwrap()
        .starts_with("Usage: zodchi flow cleanup"));
    let cleanup = w.flow(&["cleanup"]);
    assert_eq!(cleanup.code(0).result["apply"], false);
    for (args, message) in [
        (&[][..], "Usage: zodchi flow"),
        (&["runs", "--args", "x"][..], "Usage: zodchi flow"),
        (&["list", "--bad"][..], "No workflow"),
        (
            &["unknown-workflow"][..],
            "No workflow \"unknown-workflow\"",
        ),
        (
            &["unknown-workflow", "--help"][..],
            "No workflow \"unknown-workflow\"",
        ),
        (&["status"][..], "No workflow"),
        (&["cleanup", "--bad"][..], "Usage: zodchi flow cleanup"),
        (
            &["code-package", "--args"][..],
            "Unexpected argument: --args",
        ),
        (
            &["research", "--detach", "--detach"][..],
            "Unexpected argument: --detach",
        ),
        (
            &["video", "--args", "nowhere.json"][..],
            "Cannot read the args",
        ),
        (&["status", "/invalid"][..], "Not a run id"),
    ] {
        let call = w.flow(args);
        call.wrong(message);
        let prefix = match args {
            [] | ["runs", "--args", "x"] => Some(String::new()),
            ["list", "--bad"] | ["unknown-workflow"] | ["status"] => Some(format!(
                "No workflow {:?} in zodchi flow. Run zodchi flow list for the catalog.\n",
                args[0]
            )),
            ["code-package", "--args"] | ["research", "--detach", "--detach"] => {
                Some(format!("Unexpected argument: {}\n", args[1]))
            }
            _ => None,
        };
        if let Some(prefix) = prefix {
            assert_eq!(call.err.trim_end(), format!("{prefix}{usage}"));
        }
    }
    let invalid = w.put("invalid.json", "not json");
    w.flow(&["research", "--args", invalid.to_str().unwrap()])
        .wrong("are not JSON");
    let empty = w.write("empty.json", &json!({}));
    let empty = empty.to_str().unwrap();
    w.flow(&["research", "--args", empty, "--rerun", "ask q1"])
        .wrong("--rerun goes with --resume");
    let voice = w.flow(&["voiceover", "voices"]);
    assert_eq!(voice.code(0).result["voices"].as_array().unwrap().len(), 10);
    let voice_args = w.write("voice.json", &voiceover(&w));
    let voice_plan = w.flow(&["voiceover", "plan", "--args", voice_args.to_str().unwrap()]);
    assert_eq!(voice_plan.code(0).result["voice"], "marin");
    w.flow(&["youtube-publish", "connect", "--args", empty])
        .wrong("profile");
    w.flow(&["youtube-publish", "whoami", "--profile", "/invalid"])
        .wrong("profile");
    w.flow(&["video", "research", "--args", empty])
        .wrong("args.dir");
    for subcommand in ["publish", "stats"] {
        w.flow(&["video", subcommand, "/invalid", "--file", empty])
            .wrong("Not a run id");
    }
    controls(&w);
}

fn voiceover(w: &World) -> Value {
    json!({"dir":w.repo,"language":"en-US","paid":true,"cues":[{"startMs":0,"endMs":2000,"text":"A shelf."}]})
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

fn assert_ops_host_refusal(w: &World) -> bool {
    #[cfg(target_os = "linux")]
    let reason = (unsafe { libc::getuid() == 0 || libc::geteuid() == 0 })
        .then_some("must not run as root or elevated");
    #[cfg(windows)]
    let reason = windows_elevated().then_some("must not run as root or elevated");
    #[cfg(all(unix, not(target_os = "linux")))]
    let reason = Some("cannot enforce the local dry-run privilege boundary");
    #[cfg(not(any(unix, windows)))]
    let reason = Some("Cannot verify the current privilege");

    let Some(reason) = reason else {
        return false;
    };
    let script = w.put("unsupported.sh", "#!/bin/sh\nexit 0\n");
    let tmp = w.dir.join("ops");
    fs::create_dir(&tmp).unwrap();
    let reply = w.start(
        "ops-script",
        &json!({"script":script,"tmp":tmp,"sudo":["sudo","bash","{script}"],"fixes":0}),
        None,
    );
    let result = &reply.code(2).result;
    assert_eq!(result["workflow"], "ops-script");
    assert_eq!(result["ready"], false);
    assert!(result["refused"].as_str().unwrap().contains(reason));
    assert!(w.runs("ops-script").is_empty());
    assert!(fs::read_dir(tmp).unwrap().next().is_none());
    true
}

fn ops_args(w: &World, repair: bool) -> (Value, PathBuf) {
    let python = ["python3", "python"]
        .into_iter()
        .find(|python| {
            w.command(python)
                .args(["-c", "import sys; assert sys.version_info.major == 3"])
                .output()
                .is_ok_and(|out| out.status.success())
        })
        .expect("the ops-script fixture needs Python 3");
    let script = w.put(
        "repo/example.py",
        if repair {
            "if True print('bad syntax')\n"
        } else {
            "print('fixture')\n"
        },
    );
    w.git(&["add", "example.py"]);
    w.git(&["commit", "-qm", "Add the script"]);
    let tmp = w.dir.join("ops");
    fs::create_dir(&tmp).unwrap();
    let mut args = json!({"script":script, "tmp":tmp,
        "check":[python,"{copy}","--check"],"sudo":["sudo",python,"{script}","--apply"],"fixes":0});
    if repair {
        args["fixes"] = json!(1);
        args["repo"] = json!(w.repo);
    }
    // As in flow-ops-script.mjs, the Python-only fixture needs Bash and sha256sum for preflight.
    // It runs neither a shell script nor the proposed sudo command.
    let source = w.put("bash.rs", r#"fn main() {
        let exe = std::env::current_exe().unwrap();
        if exe.file_stem().unwrap() == "sha256sum" { println!("sha256sum (GNU coreutils) fixture"); }
        else { println!("GNU bash, version fixture"); }
    }"#);
    let bash = w.tool(&source, "bash");
    fs::copy(
        &bash,
        w.dir.join(format!("sha256sum{}", env::consts::EXE_SUFFIX)),
    )
    .unwrap();
    (args, bash)
}

fn ops_start(w: &World, args: &Value, bash: &Path, point: &str, trace: Option<&Path>) -> Reply {
    let input = w.write("ops.json", args);
    let path = env::join_paths(
        std::iter::once(w.dir.clone())
            .chain(env::split_paths(&env::var_os("PATH").unwrap_or_default())),
    )
    .unwrap();
    let mut extra = vec![
        ("ZODCHI_BASH", bash.to_str().unwrap()),
        ("PATH", path.to_str().unwrap()),
        ("ZODCHI_FLOW_CUT", point),
    ];
    if let Some(trace) = trace {
        extra.push(("GIT_TRACE2_EVENT", trace.to_str().unwrap()));
    }
    w.flow_env(&["ops-script", "--args", input.to_str().unwrap()], &extra)
}

fn asset_args(w: &World) -> Value {
    let args = package(w);
    let package = w.write("package.json", &args);
    let ledger = w.write("repo/ledger.json", &json!({"method":"timber","rounds":[]}));
    json!({"repo":w.repo,"ledger":ledger,"tmp":w.dir.join("asset"),"label":"shelf",
        "stage":1,"summary":"Check the shelf support","package":package})
}

fn video_args(w: &World, adopt: bool) -> Value {
    let tool = w.tool(
        &checkout().join("scripts/e2e/fixtures/video-tool.rs"),
        "video-tool",
    );
    let source = w.put("media/source.mp4", "fixture MP4");
    w.put("frame.png", png());
    w.put("media/brief.md", "Show how the field is filled.\n");
    w.put("media/scenario.md", "Show one field.\n");
    let edit = json!({
        "proposed":{"title":"An opening","description":"","prompt":"Make a short.","voiceText":""},
        "sources":[{"id":"screen","kind":"screen","path":source,"sha256":null,"note":""}],
        "segments":[{"id":"take","source":"screen","in":0.0,"out":1.0,"speed":1.0,"speedMarked":false,
            "reason":"Show the result.","evidence":"A saved receipt.","model":"","effort":""}],
        "audio":[],"costs":[],"claims":[]
    });
    let mut args = json!({"dir":w.dir.join("media"),"id":"short","format":"short","title":"An opening",
        "ffmpeg":tool, "ffprobe":tool});
    if adopt {
        args["adopt"] = json!({"file":source,"edit":edit});
    } else {
        let render = json!({"program":tool,"args":["render","{out}"]});
        args["brief"] = json!("brief.md");
        args["variants"] = json!([{"id":"one","scenario":"scenario.md","edit":edit,"probe":render,"final":render}]);
    }
    args
}

fn youtube_args(w: &World) -> Value {
    let video = w.start("video", &video_args(w, true), None);
    video.code(2);
    let id = video.result["runId"]
        .as_str()
        .unwrap_or_else(|| panic!("{video:?}"));
    let artifact = &video.result["video"]["decision"]["artifact"];
    let answer = w.write(
        "video-owner.json",
        &json!({"decision":"accept","render":artifact["render"],
        "sha256":artifact["sha256"],"ownerWords":"Use this cut."}),
    );
    w.flow(&["reply", id, "--file", answer.to_str().unwrap()])
        .code(0);
    assert_eq!(
        w.flow(&["video", "--resume", id]).code(0).result["verdict"],
        "approved"
    );
    json!({"videoRun":id,"profile":"fixture","channelId":"UC0000000000000000000000",
        "title":"Private fixture","description":"One field.","categoryId":"22","selfDeclaredMadeForKids":false})
}

fn start_fixture(w: &World, name: &str) -> Reply {
    let (args, cut) = match name {
        "code-package" => (package(w), Some("submit write")),
        "asset-round" => (asset_args(w), Some("asset ledger")),
        "branch-review" => {
            let base = w.git(&["rev-parse", "HEAD"]);
            w.put("repo/src/math.mjs", FIXED);
            w.git(&["commit", "-qam", "Implement clamp"]);
            w.answer("review", review());
            (
                json!({"repo":w.repo,"base":base,"label":"fixture","author":["codex/fake-writer"]}),
                Some("submit review"),
            )
        }
        "design-brief" => {
            let file = "repo1/src/math.mjs";
            let question = "How does clamp behave?";
            w.answer(
                "plan",
                json!({"questions":[{"question":question,"files":[file]}]}),
            );
            w.answer("facts 1", json!({"facts":[{"claim":"Returns its input.","file":file,"line":1,"quote":STUB.trim_end()}],"unknowns":[]}));
            w.answer("draft", json!({"markdown":"# Clamp\n\n## Goal\nKeep the value bounded.\n\n## Review boundary\nImportant: respect both limits.\nOut of scope: module changes.\n\n## Checks\nRead src/math.mjs.\n", "ownerDecisions":[],"unverified":[]}));
            w.answer("review", review());
            (
                json!({"label":"clamp","goal":"Keep the value bounded.","repos":[w.repo],"out":w.dir.join("draft.md"),
                "questions":[{"question":question,"files":["src/math.mjs"]}]}),
                Some("submit facts 1"),
            )
        }
        "incident-triage" => {
            let product = checkout().join("scripts/e2e/fixtures/incident-triage/product.mjs");
            w.put("data/status.txt", "ready\n");
            let adapter = w.write("adapter.json", &json!({"adapterVersion":1,"product":"Catalog","owner":"owner",
                "operations":{"status":{"description":"read status","argv":[node_path(w),product,"status"]}}}));
            (
                json!({"repo":w.repo,"incident":"fixture","adapter":adapter,"tmp":w.dir.join("incident"),"report":"Waiting for status."}),
                Some("incident lock published"),
            )
        }
        "method-question" => {
            w.answer("real 1", json!({"answer":"Two supports carry the shelf.","findings":[
                {"claim":"Two supports carry the shelf.","source":"https://example.test/shelf","quote":"Two supports carry the shelf."}],"notFound":[]}));
            (
                json!({"repo":w.repo,"tmp":w.dir.join("method"),"label":"shelf","context":"A workshop shelf.",
                "realLife":["How is the shelf supported?"],"games":["How do games reuse the shelf?"]}),
                Some("start method question"),
            )
        }
        "ops-script" => {
            let (args, bash) = ops_args(w, false);
            return ops_start(w, &args, &bash, "ops-start snapshot 0", None);
        }
        "research" => {
            w.answer("ask q1", research_answer());
            (research_args(w), Some("submit ask q1"))
        }
        "rubric-probe" => {
            let png = png();
            let sound = w.put("sound.png", &png);
            let defect = w.put("defect.png", &png);
            w.write(
                "repo/.zodchi/roles/upright.json",
                &json!({"kind":"decisions","mode":"expert","model":"fixture-model",
                "questions":"upright.questions.json"}),
            );
            w.write("repo/.zodchi/roles/upright.questions.json", &json!([
                {"name":"upright","type":"predicate","instructions":"Is it upright?","expect":true}]));
            (
                json!({"repo":w.repo,"tmp":w.dir.join("verdicts"),"label":"shelf","role":"upright","paid":true,
                "frames":[{"file":sound,"note":"Shelf","sound":true,"defects":[]},
                          {"file":defect,"note":"Shelf","sound":false,"defects":["upright"]}]}),
                Some("submit frame 1"),
            )
        }
        "unity-check" => {
            let cli = w.tool(
                &checkout().join("scripts/e2e/fixtures/unity-cli.rs"),
                "unity-fixture",
            );
            let project = w.repo.join("Unity");
            fs::create_dir_all(project.join("ProjectSettings")).unwrap();
            let plan = w.write(
                "unity.json",
                &json!({"project":project,
                "steps":[{"command":"find_gameobjects","args":[],"expect":{"/count":3}}]}),
            );
            let args = w.write(
                "unity-args.json",
                &json!({"repo":w.repo,"cli":cli,"tmp":w.dir.join("unity-out"),"steps":plan}),
            );
            let trace = w.dir.join("unity.log");
            return w.flow_env(
                &[name, "--args", args.to_str().unwrap()],
                &[
                    ("ZODCHI_FIXTURE_UNITY_TRACE", trace.to_str().unwrap()),
                    ("ZODCHI_FLOW_CUT", "unity editor 1"),
                ],
            );
        }
        "workspace-audit" => {
            let file = w.put("inventory/file.txt", "fixture inventory\n");
            (
                json!({"root":file.parent().unwrap(),"archive":w.dir.join("archive")}),
                None,
            )
        }
        "video" => (video_args(w, false), None),
        "voiceover" => (voiceover(w), None),
        "youtube-publish" => (youtube_args(w), None),
        "candidate-acceptance" => {
            w.put(
                "repo/test.mjs",
                "import test from 'node:test'; test('fixture', () => {});\n",
            );
            w.git(&["add", "test.mjs"]);
            w.git(&["commit", "-qm", "Add the candidate test"]);
            let node = node_path(w);
            (
                json!({"repo":w.repo,"head":w.git(&["rev-parse","HEAD"]),"label":"Fixture",
                "browser":{"node":node,"executable":node,"variable":"FIXTURE_CHROME"},
                "scenarios":[{"id":"first","test":"test.mjs","frames":[]}]}),
                Some("acceptance checkout staging"),
            )
        }
        "release-acceptance" => {
            let module = w.put(
                "browser.cjs",
                "throw new Error('the fixture should stop during selection');\n",
            );
            let node = node_path(w);
            w.answer("select", json!({"scenarios":["missing"]}));
            (
                json!({"repo":w.repo,"head":w.git(&["rev-parse","HEAD"]),"label":"Fixture",
                "baseUrl":"http://127.0.0.1:9999","health":{"path":"/health","pointer":"/sha"},
                "browser":{"executable":node,"module":module},"choose":"Select the fixture.",
                "scenarios":[{"id":"first","steps":[{"id":"open","open":"/dashboard","expect":{"selector":"#summary"}}]}]}),
                Some("acceptance model select"),
            )
        }
        "player-acceptance" => {
            w.answer("select", json!({"scenarios":["missing"]}));
            (
                json!({"repo":w.repo,"label":"Fixture","choose":"Select the fixture.","scenarios":[{"id":"first",
                "steps":[{"id":"fixture","program":"src/math.mjs","args":[],"receipt":"result.json"}]}]}),
                Some("acceptance model select"),
            )
        }
        _ => unreachable!("undocumented start fixture: {name}"),
    };
    w.start(name, &args, cut)
}

fn node_path(w: &World) -> String {
    let out = w
        .command("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

fn png() -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([0x48, 0x55, 0x90, 0xff]));
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

fn check_start(name: &str) {
    let w = World::new();
    if name == "ops-script" && assert_ops_host_refusal(&w) {
        return;
    }
    let response = start_fixture(&w, name);
    if name == "player-acceptance" && !cfg!(windows) {
        let result = &response.code(2).result;
        assert_eq!(result["status"], "refused");
        assert!(result["reason"]
            .as_str()
            .unwrap()
            .contains("Windows host"));
        assert!(w.runs(name).is_empty());
        return;
    }
    assert!(!w.runs(name).is_empty(), "{name}: {response:?}");
    let id = w.one_run(name);
    let dir = w.run(&id);
    let run = read_json(&dir.join("run.json"));
    assert_eq!(run["workflow"], name);
    assert_eq!(run["runId"], id);
    let events = jsonl(&dir.join("events.jsonl"));
    assert!(
        !events.iter().any(|event| event["kind"] == "finished"),
        "the fixture must be stopped partway through {name}"
    );
    let status = w.flow(&["status", &id]);
    status.code(0);
    assert_eq!(status.result["runId"], id);
    let observed = json!({
        "code":response.code, "status":status.result["status"],"step":status.result["step"],"event":status.result["event"],
    });
    let saved = &baseline()["runs"][name];
    assert_eq!(observed, saved["start"], "{name}: {response:?}");
    let saved_events = saved["events"].as_array().unwrap();
    assert_eq!(events.len(), saved_events.len(), "{name}: event count");
    for (event, recorded) in events.iter().zip(saved_events) {
        for field in ["kind", "step", "attempt"] {
            assert_eq!(event[field], recorded[field], "{name}: {field} in {event}");
        }
    }
    assert_eq!(
        response.result.is_null(),
        saved["result"].is_null(),
        "{name}: result on stdout"
    );
    for pointer in [
        "/workflow",
        "/version",
        "/status",
        "/step",
        "/event",
        "/approved",
        "/verdict",
        "/errorKind",
        "/mayHaveBeenCharged",
        "/video/decision/stage",
        "/youtube/plan/metadata/status/privacyStatus",
    ] {
        assert_eq!(
            response.result.pointer(pointer),
            saved["result"].pointer(pointer),
            "{name} {pointer}"
        );
    }
    let question = |result: &Value| {
        result["question"]
            .as_str()
            .map(|text| match result["inventorySha256"].as_str() {
                Some(digest) => {
                    assert!(text.contains(digest));
                    text.replace(digest, "<inventory-digest>")
                }
                None => text.to_string(),
            })
    };
    assert_eq!(
        question(&response.result),
        question(&saved["result"]),
        "{name}: question"
    );
    if observed["code"] == CUT_EXIT {
        assert!(
            response.err.contains("(ZODCHI_FLOW_CUT)"),
            "{name}: {response:?}"
        );
    }
}

macro_rules! named_starts {
    ($($test:ident => $workflow:literal),+ $(,)?) => {
        $(#[test] fn $test() { check_start($workflow); })+
    };
}

named_starts! {
    start_code_package => "code-package",
    start_asset_round => "asset-round",
    start_branch_review => "branch-review",
    start_design_brief => "design-brief",
    start_incident_triage => "incident-triage",
    start_method_question => "method-question",
    start_ops_script => "ops-script",
    start_research => "research",
    start_rubric_probe => "rubric-probe",
    start_unity_check => "unity-check",
    start_workspace_audit => "workspace-audit",
    start_video => "video",
    start_voiceover => "voiceover",
    start_youtube_publish => "youtube-publish",
    start_candidate_acceptance => "candidate-acceptance",
    start_release_acceptance => "release-acceptance",
    start_player_acceptance => "player-acceptance",
}

#[test]
fn archived_journals_keep_their_status_and_handoff() {
    let w = World::new();
    let corpus = baseline();
    for (name, fixture) in corpus["runs"].as_object().unwrap() {
        let id = fixture["run"]["runId"].as_str().unwrap();
        let dir = w.run(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("run.json"),
            serde_json::to_vec(&fixture["run"]).unwrap(),
        )
        .unwrap();
        let text = fixture["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| format!("{e}\n"))
            .collect::<String>();
        fs::write(dir.join("events.jsonl"), text).unwrap();
        let status = w.flow(&["status", id]);
        assert_eq!(status.code(0).result["workflow"], *name);
        for key in ["version", "release", "repo"] {
            assert_eq!(
                status.result[key], fixture["run"][key],
                "archived {name} {key}"
            );
        }
        for key in ["status", "step", "event"] {
            assert_eq!(
                status.result[key], fixture["start"][key],
                "archived {name} {key}"
            );
        }
        let handoff = w.flow(&["status", id, "--handoff"]);
        assert_eq!(handoff.code(0).result["runId"], id);
        for key in ["workflow", "version", "step", "status"] {
            assert_eq!(
                handoff.result[key], status.result[key],
                "archived {name} handoff {key}"
            );
        }
    }
}

#[test]
fn worker_and_resume_reuse_the_interrupted_local_write() {
    let w = World::new();
    let args = package(&w);
    w.start("code-package", &args, Some("submit write"))
        .code(CUT_EXIT);
    let id = w.one_run("code-package");
    let dir = w.run(&id);
    let events = dir.join("events.jsonl");
    let before = jsonl(&events);
    let intent = before.last().unwrap();
    assert_eq!(intent["kind"], "intent");
    assert_eq!(intent["step"], "write");
    assert_eq!(intent["key"], format!("flow-{id}-write"));
    let request = dir.join(intent["request"].as_str().unwrap());
    let frozen = fs::read(&request).unwrap();
    w.flow(&["research", "--resume", &id])
        .wrong(&format!("Run {id} belongs to \"code-package\""));
    let mut different = args;
    different["label"] = json!("different fixture");
    let different = w.write("different.json", &different);
    w.flow(&[
        "code-package",
        "--resume",
        &id,
        "--args",
        different.to_str().unwrap(),
    ])
    .wrong(&format!(
        "The args differ from those run {id} started with."
    ));
    assert_eq!(jsonl(&events), before);

    let worker = w.flow(&["_worker", &id]);
    assert_eq!(worker.code(0).result["runId"], id);
    assert_eq!(worker.result["approved"], true);
    assert_eq!(worker.result, read_json(&dir.join("worker-result.json")));
    let resumed = w.flow(&["code-package", "--resume", &id]);
    assert_eq!(resumed.code(0).result, worker.result);
    assert_eq!(fs::read(request).unwrap(), frozen);
    assert_eq!(w.steps(), ["write", "review 1"]);
    let after = jsonl(&events);
    assert!(after.starts_with(&before));
    let write_events: Vec<_> = after
        .iter()
        .filter(|e| e["step"] == "write")
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(write_events, ["intent", "done"]);
    let review_events: Vec<_> = after.iter().filter(|e| e["step"] == "review 1").collect();
    assert_eq!(
        review_events
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["intent", "submitted", "done"]
    );
    let review_request = dir.join(review_events[0]["request"].as_str().unwrap());
    let mut schema = read_json(&review_request)["role"]["outputSchema"].clone();
    schema.sort_all_objects();
    assert_eq!(
        sha256_hex(schema.to_string()),
        baseline()["codePackageReviewSchemaSha256"].as_str().unwrap()
    );
    assert_eq!(
        fs::read_to_string(w.repo.join("src/math.mjs")).unwrap(),
        FIXED
    );
}

fn child_gate_attempts(trace: &Path) -> usize {
    // Trace Git outside of the child journal. Every start attempt with these valid,
    // unchanged args checks the repository's ignore rules, even if journal creation then fails.
    // The package's Git wrapper adds -c core.quotepath=false. The gateway's own ignore check omits it.
    jsonl(trace)
        .into_iter()
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

#[test]
fn asset_child_context_cut_reenters_the_existing_child() {
    let w = World::new();
    let args = asset_args(&w);
    let input = w.write("asset.json", &args);
    let trace = w.dir.join("git-trace.jsonl");
    let extra = [
        ("GIT_TRACE2_EVENT", trace.to_str().unwrap()),
        ("ZODCHI_FLOW_CUT", "code-package context"),
    ];
    w.flow_env(&["asset-round", "--args", input.to_str().unwrap()], &extra)
        .code(CUT_EXIT);
    let parent = w.one_run("asset-round");
    let child = w.one_run("code-package");
    let parent_events = w.run(&parent).join("events.jsonl");
    let pin = jsonl(&parent_events)
        .into_iter()
        .find(|e| e["kind"] == "child intent" && e["workflow"] == "code-package")
        .unwrap();
    assert_eq!(pin["runId"], child);
    assert_eq!(pin["step"], "package");
    assert_eq!(pin["attempt"], 1);
    let starts = child_gate_attempts(&trace);
    assert_eq!(starts, 1);
    let dir = w.run(&child);
    assert!(!dir.join("initialized").exists());
    assert!(!dir.join("brief.md").exists());
    assert!(jsonl(&dir.join("events.jsonl")).is_empty());

    // A valid but different args record distinguishes control's argument gate
    // from the code-package resume function's own argument error.
    let child_run = dir.join("run.json");
    let original = fs::read(&child_run).unwrap();
    let mut different: Value = serde_json::from_slice(&original).unwrap();
    different["inputs"]["args"]["label"] = json!("different fixture");
    fs::write(&child_run, serde_json::to_vec(&different).unwrap()).unwrap();
    let mismatch = w.flow_env(&["asset-round", "--resume", &parent], &extra[..1]);
    assert_eq!(
        mismatch.code(1).err.trim(),
        format!("The args differ from those run {child} started with.")
    );
    fs::write(&child_run, &original).unwrap();

    // Resume finishes the existing child and leaves the round waiting for the owner.
    let resumed = w.flow_env(&["asset-round", "--resume", &parent], &extra[..1]);
    assert_eq!(resumed.code(2).result["status"], "waiting");
    assert!(resumed.result["stoppedAt"].is_null());
    assert_eq!(
        child_gate_attempts(&trace),
        starts,
        "resume must not reach another child start gate"
    );
    assert_eq!(w.runs("code-package"), [child.clone()]);
    assert_eq!(fs::read(child_run).unwrap(), original);
    assert_eq!(
        fs::read(dir.join("brief.md")).unwrap(),
        fs::read(w.dir.join("brief.md")).unwrap()
    );
    assert_eq!(fs::read_to_string(dir.join("initialized")).unwrap(), "1\n");
    assert!(jsonl(&dir.join("events.jsonl"))
        .iter()
        .any(|event| event["kind"] == "finished"));
    let events = jsonl(&parent_events);
    assert_eq!(events.len(), 3, "{events:?}");
    assert_eq!(events[0], pin);
    assert_eq!(events[1]["kind"], "done");
    assert_eq!(events[1]["step"], "package");
    assert_eq!(events[1]["result"]["runId"], child);
    assert_eq!(events[1]["result"]["ok"], true);
    assert_eq!(events[2]["kind"], "waiting");
    assert!(!w.run(&parent).join("result.json").exists());
    assert_eq!(w.steps(), ["write", "review 1"]);
}

#[test]
fn ops_repair_context_cut_stays_unresolved_without_starting_again() {
    let w = World::new();
    if assert_ops_host_refusal(&w) {
        return;
    }
    let (args, bash) = ops_args(&w, true);
    let trace = w.dir.join("git-trace.jsonl");
    ops_start(&w, &args, &bash, "code-package context", Some(&trace)).code(CUT_EXIT);
    let parent = w.one_run("ops-script");
    let child = w.one_run("code-package");
    let parent_events = w.run(&parent).join("events.jsonl");
    let before = jsonl(&parent_events);
    let intent = before.last().unwrap();
    assert_eq!(intent["kind"], "ops-repair");
    assert_eq!(intent["attempt"], 0);
    let failed = &before[before.len() - 2];
    assert_eq!(failed["kind"], "ops-done");
    assert_eq!(failed["step"], "static 0");
    assert_eq!(failed["result"]["ok"], false);
    assert_eq!(intent["child"], child);
    assert_eq!(intent["args"]["label"], format!("ops-{parent}-0"));
    assert_eq!(
        Path::new(intent["args"]["brief"].as_str().unwrap())
            .file_name()
            .unwrap(),
        format!("repair-0-{child}.md").as_str()
    );
    let child_run = w.run(&child).join("run.json");
    let frozen = fs::read(&child_run).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&frozen).unwrap()["inputs"]["args"],
        intent["args"]
    );
    assert!(Path::new(intent["args"]["brief"].as_str().unwrap()).is_file());
    assert!(!w.run(&child).join("initialized").exists());
    assert!(jsonl(&w.run(&child).join("events.jsonl")).is_empty());
    let starts = child_gate_attempts(&trace);
    assert_eq!(starts, 1);
    let resumed = w.flow_env(
        &["ops-script", "--resume", &parent],
        &[("GIT_TRACE2_EVENT", trace.to_str().unwrap())],
    );
    assert_eq!(resumed.code(2).result["status"], "unresolved");
    assert_eq!(resumed.result["runId"], parent);
    assert_eq!(resumed.result["step"], format!("repair 0 ({child})"));
    assert_eq!(
        child_gate_attempts(&trace),
        starts,
        "the recorded repair intent prevents another start"
    );
    assert_eq!(w.runs("code-package"), [child.clone()]);
    assert_eq!(fs::read(child_run).unwrap(), frozen);
    assert!(!w.run(&child).join("initialized").exists());
    assert!(!w.run(&child).join("brief.md").exists());
    assert!(jsonl(&w.run(&child).join("events.jsonl")).is_empty());
    assert_eq!(jsonl(&parent_events), before);
    assert!(!w.run(&parent).join("result.json").exists());
    assert!(w.steps().is_empty());
}

#[test]
fn ops_cut_after_snapshot_effect_does_not_repeat_it() {
    let w = World::new();
    if assert_ops_host_refusal(&w) {
        return;
    }
    let (args, bash) = ops_args(&w, false);
    ops_start(&w, &args, &bash, "ops-effect snapshot 0", None).code(CUT_EXIT);
    let id = w.one_run("ops-script");
    let events = w.run(&id).join("events.jsonl");
    let before = fs::read(&events).unwrap();
    assert_eq!(jsonl(&events).last().unwrap()["kind"], "ops-start");
    let snapshots = || {
        fs::read_dir(w.dir.join("ops"))
            .unwrap()
            .map(|row| row.unwrap().file_name())
            .collect::<Vec<_>>()
    };
    let saved = snapshots();
    assert_eq!(saved.len(), 1);
    let resumed = w.flow(&["ops-script", "--resume", &id]);
    assert_eq!(resumed.code(2).result["status"], "unresolved");
    assert_eq!(resumed.result["step"], "snapshot 0");
    assert_eq!(snapshots(), saved);
    assert_eq!(fs::read(events).unwrap(), before);
}

#[test]
fn screened_claude_submit_cut_reuses_the_receipt() {
    let w = World::new();
    let mut args = research_args(&w);
    args["models"] = json!({"researchExpert":{
        "candidates":[{"provider":"claude","model":"opus","effort":"high"}]}});
    let args = w.write("claude-research.json", &args);
    w.write("zodchi/flow.json", &json!({"claude":true}));
    let auth = w.write("claude/fake-auth.json", &json!({}));
    w.write("claude/answers/ask-q1.json", &research_answer());
    let fake = checkout().join("scripts/e2e/fake-claude.mjs");
    let extra = [
        ("ZODCHI_CLAUDE_BIN", fake.to_str().unwrap()),
        ("FAKE_CLAUDE_HOME", auth.parent().unwrap().to_str().unwrap()),
        ("ZODCHI_FLOW_CUT", "submit ask q1"),
    ];
    w.flow_env(&["research", "--args", args.to_str().unwrap()], &extra)
        .code(CUT_EXIT);
    let id = w.one_run("research");
    let dir = w.run(&id);
    let events = dir.join("events.jsonl");
    let before = jsonl(&events);
    let intent = before
        .iter()
        .find(|row| row["step"] == "ask q1" && row["kind"] == "intent")
        .unwrap();
    assert_eq!(intent["executor"], "claude");
    let key = intent["key"].as_str().unwrap();
    let receipt = dir.join("claude").join(key).join("final.json");
    let saved = fs::read(&receipt).unwrap();
    assert_eq!(read_json(&receipt)["status"], "succeeded");
    assert!(!before
        .iter()
        .any(|row| row["step"] == "ask q1" && row["kind"] == "done"));
    let resumed = w.flow_env(&["research", "--resume", &id], &extra[..2]);
    assert_eq!(resumed.code(2).result["status"], "waiting");
    assert_eq!(fs::read(receipt).unwrap(), saved);
    let turns: Vec<_> = jsonl(&w.dir.join("claude/calls.jsonl"))
        .into_iter()
        .filter(|row| row["kind"] == "call")
        .map(|row| row["step"].clone())
        .collect();
    assert_eq!(turns, ["preflight", "ask q1"]);
    assert_eq!(w.steps(), ["constraints"]);
    let after = jsonl(&events);
    assert_eq!(
        after
            .iter()
            .filter(|row| row["step"] == "ask q1" && row["kind"] == "intent")
            .count(),
        1
    );
    assert_eq!(
        after
            .iter()
            .filter(|row| row["step"] == "ask q1" && row["kind"] == "done")
            .count(),
        1
    );
}
