//! Verify a named, already running Unity Editor by executing a pinned list of CLI commands.

use crate::{boundary::Launch, catalog::ProjectGate, git::Git, input_common, journal::Journal, patch, Exit};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::Stdio,
    thread,
    time::{Duration, Instant},
};
use zodchi_core::{
    config::Config,
    process::command_without_window,
    util::{fail, iso, sha256_hex, GatewayError, Result},
};

pub const NAME: &str = "unity-check";
const VERSION: &str = "1";
const READ_STATE: &str = "var dirty = false; for (var i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++) { dirty |= UnityEngine.SceneManagement.SceneManager.GetSceneAt(i).isDirty; } return new { dirty, playing = UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode, compiling = UnityEditor.EditorApplication.isCompiling, scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path };";
const OUTPUT_LIMIT: usize = 1024 * 1024;

pub fn start(raw: &Value, launch: Option<Launch>, require_workflow: ProjectGate) -> Result<Exit> {
    start_with(raw, launch, require_workflow, None)
}

pub(crate) fn start_child(raw: &Value, id: &str, require_workflow: ProjectGate) -> Result<Exit> {
    start_with(raw, None, require_workflow, Some(id))
}

fn start_with(raw: &Value, launch: Option<Launch>, require_workflow: ProjectGate, id: Option<&str>) -> Result<Exit> {
    match (prepare(raw, id, require_workflow), launch) {
        (Ok((id, journal)), Some(launch)) => launch(&journal, &id),
        (Ok((id, _)), None) => resume(&id, None, None),
        (Err(error), _) => Ok(Exit {
            code: 2,
            result: json!({ "workflow": NAME, "approved": false, "refused": error.0 }),
        }),
    }
}

fn absolute(value: &Value, field: &str) -> Result<PathBuf> {
    value
        .as_str()
        .map(PathBuf::from)
        .filter(|path| {
            path.is_absolute() && path.components().all(|part| part != Component::ParentDir)
        })
        .ok_or_else(|| {
            GatewayError(format!(
                "{field} must be an absolute path without parent components."
            ))
        })
}

fn cli_path(raw: &Value) -> Result<PathBuf> {
    let found = if raw.get("cli").is_some() {
        absolute(&raw["cli"], "args.cli")?
    } else {
        let name = if cfg!(windows) { "unity.exe" } else { "unity" };
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .map(|folder| folder.join(name))
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| GatewayError("The Unity CLI is missing from PATH.".into()))?
    };
    let path = fs::canonicalize(found)?;
    if !path.is_file()
        || (cfg!(windows)
            && !path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe")))
    {
        return fail("args.cli must select the Unity CLI executable.");
    }
    Ok(path)
}

fn prepare(raw: &Value, id: Option<&str>, require_workflow: ProjectGate) -> Result<(String, Journal)> {
    if raw.as_object().is_none_or(|args| {
        args.keys()
            .any(|key| !["repo", "tmp", "steps", "cli", "note"].contains(&key.as_str()))
    }) {
        return fail("unity-check accepts repo, tmp, steps, cli and note.");
    }
    let repo = fs::canonicalize(absolute(&raw["repo"], "args.repo")?)?;
    let tmp = absolute(&raw["tmp"], "args.tmp")?;
    let steps = absolute(&raw["steps"], "args.steps")?;
    let git = Git::new(&repo);
    if fs::canonicalize(git.run(&["rev-parse", "--show-toplevel"])?.trim())? != repo {
        return fail("args.repo must be the top of the Git checkout.");
    }
    require_workflow(&git, &git.rev("HEAD^{commit}")?, NAME)?;
    let mut bytes = Vec::new();
    fs::File::open(steps)?
        .take((OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > OUTPUT_LIMIT {
        return fail("The Unity step file exceeds 1 MB.");
    }
    let plan: Value = serde_json::from_slice(&bytes)
        .map_err(|_| GatewayError("The Unity step file must be JSON.".into()))?;
    if plan.as_object().is_none_or(|fields| {
        fields
            .keys()
            .any(|key| !["project", "steps", "ownerRelease"].contains(&key.as_str()))
    }) {
        return fail("The Unity step file accepts project, steps and ownerRelease.");
    }
    let project = fs::canonicalize(absolute(&plan["project"], "project")?)?;
    if !project.starts_with(&repo) || !project.join("ProjectSettings").is_dir() {
        return fail("The step file must select a Unity project inside args.repo.");
    }
    let release = &plan["ownerRelease"];
    if !release.is_null()
        && release.as_object().is_none_or(|fields| {
            fields.is_empty()
                || fields
                    .keys()
                    .any(|key| !["scene", "playing", "dirty"].contains(&key.as_str()))
                || release["scene"].as_str().is_none_or(str::is_empty)
                || release
                    .get("playing")
                    .is_some_and(|value| !value.is_boolean())
                || release
                    .get("dirty")
                    .is_some_and(|value| !value.is_boolean())
        })
    {
        return fail(
            "ownerRelease needs an exact scene path and boolean playing or dirty permissions.",
        );
    }
    let steps = plan["steps"]
        .as_array()
        .filter(|steps| !steps.is_empty())
        .ok_or_else(|| GatewayError("The Unity step file needs at least one step.".into()))?;
    let mut captures = std::collections::HashSet::new();
    for (index, step) in steps.iter().enumerate() {
        let at = format!("steps[{index}]");
        if step.as_object().is_none_or(|fields| {
            fields
                .keys()
                .any(|key| !["command", "args", "expect", "capture"].contains(&key.as_str()))
        }) || step["command"].as_str().is_none_or(|name| {
            name.is_empty()
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        }) || step["expect"].as_object().is_none_or(|expected| {
            expected.is_empty()
                || expected
                    .keys()
                    .any(|pointer| !pointer.is_empty() && !pointer.starts_with('/'))
        }) {
            return fail(format!(
                "{at} needs a named Editor command and expected JSON values."
            ));
        }
        let argv = step["args"]
            .as_array()
            .ok_or_else(|| GatewayError(format!("{at}.args must be an array.")))?;
        if argv
            .iter()
            .any(|value| value.as_str().is_none_or(|text| text.contains('\0')))
        {
            return fail(format!("{at}.args may contain only text without NUL."));
        }
        let copies = argv.iter().filter(|word| *word == "{capture}").count();
        if let Some(value) = step.get("capture") {
            let name = value
                .as_str()
                .filter(|name| patch::plain(name) && !name.contains('/') && captures.insert(*name))
                .ok_or_else(|| {
                    GatewayError(format!("{at}.capture must be a distinct output filename."))
                })?;
            if copies != 1 || !name.to_ascii_lowercase().ends_with(".png") {
                return fail(format!(
                    "{at} needs one capture placeholder for the requested PNG."
                ));
            }
        } else if copies > 0 {
            return fail(format!(
                "{at} names an output placeholder without a capture."
            ));
        }
    }
    let cli = cli_path(raw)?;
    let cfg = Config::new(Some(&repo))?;
    let scrubber = input_common::Scrubber::new(&cfg)?;
    if tmp
        .ancestors()
        .any(|part| fs::symlink_metadata(part).is_ok_and(|meta| meta.file_type().is_symlink()))
    {
        return fail("args.tmp crosses a link.");
    }
    fs::create_dir_all(&tmp)?;
    let id = id.map(String::from).unwrap_or_else(crate::journal::new_run_id);
    let out = fs::canonicalize(tmp)?.join(format!("unity-{id}"));
    fs::create_dir(&out)?;
    let note = raw["note"].as_str().map(|note| scrubber.text(note, &[]));
    let run = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"),
        "createdAt": iso(), "repo": repo, "project": project, "output": out, "cli": cli, "note": note,
        "inputs": { "argsSha256": input_common::args_digest(raw), "planSha256": sha256_hex(plan.to_string()), "plan": plan },
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    Ok((id, journal))
}

struct Editor<'a> {
    cli: &'a Path,
    project: &'a Path,
    output: &'a Path,
}

impl Editor<'_> {
    fn call(&self, args: &[String], seconds: u64) -> Result<Value> {
        let mut command = command_without_window(self.cli);
        command
            .current_dir(self.project)
            .args([
                "--format",
                "json",
                "--non-interactive",
                "--no-pager",
                "--no-banner",
            ])
            .args(args)
            .env("UNITY_NO_UPDATE_CHECK", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|_| GatewayError("The Unity CLI could not be started.".into()))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let read = thread::spawn(move || {
            let mut data = Vec::new();
            stdout
                .take((OUTPUT_LIMIT + 1) as u64)
                .read_to_end(&mut data)
                .map(|_| data)
        });
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return fail("Unity CLI timed out. The Editor may have handled the command.");
            }
            thread::sleep(Duration::from_millis(30));
        };
        let bytes = read
            .join()
            .map_err(|_| GatewayError("Cannot read Unity's result.".into()))??;
        if bytes.len() > OUTPUT_LIMIT {
            return fail("Unity returned more than 1 MB.");
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
            GatewayError(format!(
                "Unity returned no JSON. Exit {}.",
                status.code().unwrap_or(-1)
            ))
        })?;
        if !status.success() || value["success"] == false {
            let reason = value["errors"][0]["code"]
                .as_str()
                .filter(|code| {
                    code.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
                })
                .unwrap_or("UNITY_ERROR");
            return fail(format!(
                "Unity reported {reason}. Exit {}.",
                status.code().unwrap_or(-1)
            ));
        }
        Ok(value)
    }

    fn command(&self, name: &str, params: Vec<String>) -> Result<Value> {
        let mut args = vec![
            "command".into(),
            name.into(),
            "--project-path".into(),
            self.project.to_string_lossy().into_owned(),
            "--timeout".into(),
            "90".into(),
            "--result-only".into(),
        ];
        if !params.is_empty() {
            args.push("--".into());
            args.extend(params);
        }
        self.call(&args, 95)
    }

    fn connect(&self) -> Result<Value> {
        let args = vec![
            "status".into(),
            "--project-path".into(),
            self.project.to_string_lossy().into_owned(),
            "--until-ready".into(),
            "--timeout".into(),
            "60".into(),
        ];
        let answer = self.call(&args, 65)?;
        let rows = answer["data"]["instances"]
            .as_array()
            .ok_or("Unity reported no instances.")
            .map_err(|error| GatewayError(error.into()))?;
        let matched: Vec<_> = rows
            .iter()
            .filter(|row| {
                row["state"] == "ready"
                    && row["project"].as_str().is_some_and(|path| {
                        fs::canonicalize(path).is_ok_and(|path| path == self.project)
                    })
            })
            .collect();
        if matched.len() != 1 || matched[0]["pid"].as_u64().is_none() {
            return fail("Unity did not identify one ready Editor for the exact project.");
        }
        Ok(matched[0].clone())
    }
}

fn capture_digest(file: &Path) -> Result<String> {
    let meta = fs::symlink_metadata(file)?;
    if !meta.file_type().is_file() || meta.len() > zodchi_core::job::LIMIT_IMAGE_BYTES as u64 {
        return fail("Expected a regular PNG within the gateway size limit.");
    }
    let bytes = fs::read(file)?;
    if zodchi_core::appserver::image_type(&bytes) != Some("png")
        || !bytes.ends_with(&[0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
    {
        return fail("The PNG capture is incomplete.");
    }
    Ok(sha256_hex(bytes))
}

fn ready(editor: &Editor<'_>, release: &Value, owns_play: bool, owns_dirty: bool) -> Result<Value> {
    let state = editor.command("eval", vec![READ_STATE.into()])?;
    let scene = state["scene"]
        .as_str()
        .ok_or_else(|| GatewayError("Unity did not name the active scene.".into()))?;
    let released = release["scene"] == scene;
    if state["compiling"] != false {
        return fail("Unity is compiling or did not confirm its compilation state.");
    }
    if state["playing"].as_bool().is_none() || state["dirty"].as_bool().is_none() {
        return fail("Unity did not report Play and dirty flags.");
    }
    if state["playing"] == true && !owns_play && !(released && release["playing"] == true) {
        return fail("The Editor is already in Play mode outside this run.");
    }
    if state["dirty"] == true && !owns_dirty && !(released && release["dirty"] == true) {
        return fail("The Editor has unsaved scene changes outside this run.");
    }
    Ok(state)
}

pub fn resume(id: &str, given: Option<&Value>, retry: Option<&str>) -> Result<Exit> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if run["workflow"] != NAME
        || run["version"] != VERSION
        || retry.is_some()
        || given.is_some_and(|value| !input_common::args_match(&run["inputs"], value))
    {
        return fail("Resume unity-check with its original run ID and reconcile any interrupted Editor command first.");
    }
    let _lock = journal.lock()?;
    journal.load()?;
    if let Some(result) = journal.read_value("result.json") {
        finish_event(&mut journal)?;
        return Ok(exit(result));
    }
    let plan = &run["inputs"]["plan"];
    if run["inputs"]["planSha256"] != sha256_hex(plan.to_string()) {
        return fail("The saved Unity plan does not match its digest.");
    }
    let path = |name: &str| {
        run[name]
            .as_str()
            .map(Path::new)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| GatewayError(format!("The journal needs {name}.")))
    };
    let editor = Editor {
        cli: path("cli")?,
        project: path("project")?,
        output: path("output")?,
    };
    let cfg = Config::new(run["repo"].as_str().map(Path::new))?;
    let mut result = json!({ "runId": id, "workflow": NAME, "version": VERSION, "journal": journal.dir, "note": run["note"] });
    result["approved"] = json!(false);
    let mut owns_play = false;
    let mut owns_dirty = false;
    let mut records = Vec::new();
    let mut editor_pid = journal
        .last("done", "refresh", 1)
        .and_then(|event| event["result"]["pid"].as_u64());
    // An earlier unresolved effect must be surfaced before a connection probe or refresh.
    if let Some(pending) = journal.events().iter().find(|event| {
        event["kind"] == "editor intent"
            && journal
                .last("done", event["step"].as_str().unwrap_or(""), 1)
                .is_none()
    }) {
        let step = pending["step"].as_str().unwrap_or("editor").to_string();
        return stop(&mut journal, result, &step, "The Editor command may already have run. Inspect the project and its capture before the next run.", true);
    }
    for (index, spec) in plan["steps"].as_array().into_iter().flatten().enumerate() {
        let step = format!("editor {}", index + 1);
        let name = spec["command"].as_str().unwrap_or("");
        if let Some(done) = journal.last("done", &step, 1) {
            editor_pid = done["result"]["pid"].as_u64();
            owns_play = done["result"]["ownsPlay"] == true;
            owns_dirty = done["result"]["ownsDirty"] == true;
            let differs = done["result"]["differs"].clone();
            records.push(done["result"].clone());
            if differs.as_array().is_some_and(|rows| !rows.is_empty()) {
                return finish_difference(&mut journal, result, &step, records, differs);
            }
            continue;
        }
        let instance = match editor.connect() {
            Ok(instance) => instance,
            Err(error) => return stop(&mut journal, result, &step, &error.0, false),
        };
        let pid = instance["pid"].as_u64();
        if editor_pid.is_some() && editor_pid != pid {
            return stop(
                &mut journal,
                result,
                &step,
                "The named Editor was restarted between steps.",
                false,
            );
        }
        editor_pid = pid;
        let state = match ready(&editor, &plan["ownerRelease"], owns_play, owns_dirty) {
            Ok(state) => state,
            Err(error) => return stop(&mut journal, result, &step, &error.0, false),
        };
        if journal.last("done", "refresh", 1).is_none() {
            journal.append(json!({ "kind": "editor intent", "step": "refresh", "pid": pid, "command": "AssetDatabase.Refresh" }))?;
            if let Err(error) = editor.command(
                "eval",
                vec!["UnityEditor.AssetDatabase.Refresh(); return true;".into()],
            ) {
                return stop(&mut journal, result, "refresh", &error.0, false);
            }
            let refreshed = editor.connect().and_then(|target| {
                if target["pid"].as_u64() != pid {
                    return fail("The Editor restarted during refresh.");
                }
                ready(&editor, &plan["ownerRelease"], owns_play, owns_dirty)
            });
            if let Err(error) = refreshed {
                return stop(&mut journal, result, "refresh", &error.0, false);
            }
            let console = editor.command(
                "console",
                vec![
                    "--tail".into(),
                    "200".into(),
                    "--level".into(),
                    "error".into(),
                ],
            );
            let entries = match console {
                Ok(value) => value["entries"]
                    .as_array()
                    .cloned()
                    .or_else(|| value.as_array().cloned()),
                Err(error) => return stop(&mut journal, result, "console", &error.0, false),
            };
            if entries.is_none_or(|entries| !entries.is_empty()) {
                return stop(
                    &mut journal,
                    result,
                    "console",
                    "Unity did not confirm a clear error console after refreshing.",
                    false,
                );
            }
            journal.append(json!({ "kind": "done", "step": "refresh", "attempt": 1, "result": { "pid": pid } }))?;
        }
        let capture = spec["capture"]
            .as_str()
            .map(|file| editor.output.join(file));
        if !fs::symlink_metadata(editor.output).is_ok_and(|meta| meta.file_type().is_dir())
            || capture
                .as_ref()
                .is_some_and(|path| fs::symlink_metadata(path).is_ok())
        {
            return stop(
                &mut journal,
                result,
                &step,
                "The output directory is unavailable or the capture already exists.",
                false,
            );
        }
        let params = spec["args"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|arg| {
                if arg == "{capture}" {
                    capture
                        .as_ref()
                        .expect("validated")
                        .to_string_lossy()
                        .into_owned()
                } else {
                    arg.into()
                }
            })
            .collect();
        journal.append(
            json!({ "kind": "editor intent", "step": step, "pid": pid, "command": name }),
        )?;
        let answer = match editor.command(name, params) {
            Ok(answer) => answer,
            Err(error) => return stop(&mut journal, result, &step, &error.0, true),
        };
        crate::boundary::cut(&format!("unity {step}"));
        let differs: Vec<_> = spec["expect"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(pointer, expected)| {
                (answer.pointer(pointer) != Some(expected)).then_some(pointer)
            })
            .collect();
        let digest = if let Some(file) = &capture {
            match capture_digest(file) {
                Ok(digest) => Some(digest),
                _ => {
                    return stop(
                        &mut journal,
                        result,
                        &step,
                        "The Editor did not produce the requested PNG.",
                        true,
                    )
                }
            }
        } else {
            None
        };
        owns_play = (owns_play || name == "editor_play") && name != "editor_stop";
        let after = editor.command("eval", vec![READ_STATE.into()])?;
        owns_dirty |= state["dirty"] == false && after["dirty"] == true;
        if after["dirty"] == false {
            owns_dirty = false;
        }
        let answer_text = input_common::scrub(
            &cfg,
            &serde_json::to_string_pretty(&answer).expect("JSON"),
            &[],
        )?;
        let receipt = json!({
            "command": name, "pid": pid, "capture": capture, "sha256": digest, "exitCode": 0,
            "ownsPlay": owns_play, "ownsDirty": owns_dirty, "differs": differs, "readback": answer_text,
        });
        journal.append(json!({ "kind": "done", "step": step, "attempt": 1, "result": receipt }))?;
        crate::boundary::cut(&format!("done unity {step}"));
        records.push(receipt);
        if !differs.is_empty() {
            return finish_difference(&mut journal, result, &step, records, json!(differs));
        }
    }
    result["steps"] = json!(records);
    result["approved"] = json!(true);
    result["editor"] = json!({ "project": editor.project, "pid": editor_pid });
    journal.write_value("result.json", &result)?;
    finish_event(&mut journal)?;
    Ok(exit(result))
}

fn finish_difference(
    journal: &mut Journal,
    mut result: Value,
    step: &str,
    records: Vec<Value>,
    differs: Value,
) -> Result<Exit> {
    result["steps"] = json!(records);
    result["stoppedAt"] = json!(step);
    result["differs"] = differs;
    journal.write_value("result.json", &result)?;
    finish_event(journal)?;
    Ok(exit(result))
}

fn stop(
    journal: &mut Journal,
    mut result: Value,
    step: &str,
    reason: &str,
    uncertain: bool,
) -> Result<Exit> {
    journal.append(json!({ "kind": "stop", "step": step, "stoppedAt": step, "what": reason, "unknown": uncertain }))?;
    result["stoppedAt"] = json!(step);
    result["infra"] = json!(reason);
    result["unknown"] = json!(uncertain);
    Ok(exit(result))
}

fn finish_event(journal: &mut Journal) -> Result<()> {
    if !journal
        .events()
        .iter()
        .any(|event| event["kind"] == "finished")
    {
        journal.append(json!({ "kind": "finished", "step": "result" }))?;
    }
    Ok(())
}

fn exit(result: Value) -> Exit {
    Exit {
        code: if result["approved"] == true { 0 } else { 2 },
        result,
    }
}
