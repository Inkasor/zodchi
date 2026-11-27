//! Probe a Decisions rubric against fixed sound and defective frames.

use crate::{
    boundary::Launch, catalog::ProjectGate,
    design_brief, executor::local::pinned_image, gateway, git::Git, input_common,
    journal::Journal, models::Pick, Exit,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};
use zodchi_core::{
    config::Config,
    job::LIMIT_PROMPT,
    role::{load_role, Overrides},
    util::{fail, is_key, iso, sha256_hex, GatewayError, Result},
};

pub const NAME: &str = "rubric-probe";
const VERSION: &str = "1";

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
            result: json!({
                "workflow": NAME, "approved": false, "refused": error.0,
            }),
        }),
    }
}

fn plain_path(value: &Value, name: &str) -> Result<PathBuf> {
    value
        .as_str()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.components().all(|c| c != Component::ParentDir))
        .ok_or_else(|| {
            GatewayError(format!(
                "{name} must be an absolute path without parent components."
            ))
        })
}

fn prepare(raw: &Value, id: Option<&str>, require_workflow: ProjectGate) -> Result<(String, Journal)> {
    let args = raw
        .as_object()
        .ok_or_else(|| GatewayError("rubric-probe needs an arguments object.".into()))?;
    if let Some(key) = args
        .keys()
        .find(|key| !["repo", "tmp", "label", "role", "frames", "paid"].contains(&key.as_str()))
    {
        return fail(format!("Unknown rubric-probe argument: {key}"));
    }
    if raw["paid"] != true {
        return fail("rubric-probe uses the Decisions API. Set args.paid to true after approving the spend for these frames.");
    }
    let role_name = raw["role"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| GatewayError("args.role must name a Decisions rubric.".into()))?;
    let label = raw["label"]
        .as_str()
        .filter(|text| is_key(text) && text.len() <= 40)
        .ok_or_else(|| GatewayError("args.label must be a short gateway key.".into()))?;
    let repo = plain_path(&raw["repo"], "args.repo")?;
    let tmp = plain_path(&raw["tmp"], "args.tmp")?;
    let git = Git::new(&repo);
    let top = git.run(&["rev-parse", "--show-toplevel"])?;
    if fs::canonicalize(top.trim())? != fs::canonicalize(&repo)? {
        return fail("args.repo must be the top of its Git checkout.");
    }
    require_workflow(&git, &git.rev("HEAD^{commit}")?, NAME)?;
    if git
        .output(
            &["check-ignore", "-q", "--", ".agent-tmp/gateway/"],
            &[("GIT_LITERAL_PATHSPECS", "0".into())],
            None,
        )?
        .status
        .code()
        != Some(0)
    {
        return fail("The repository must ignore .agent-tmp/ for gateway jobs.");
    }
    let cfg = Config::new(Some(&repo))?;
    let rubric = load_role(&cfg, role_name, &Overrides::default())?;
    if rubric["kind"] != "decisions" || rubric["mode"] != "expert" {
        return fail("args.role must be an expert Decisions rubric.");
    }
    let questions: Vec<&str> = rubric["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|question| question.get("expect").is_some())
        .filter_map(|question| question["name"].as_str())
        .collect();
    if questions.is_empty() {
        return fail("The Decisions rubric needs at least one question with an expectation.");
    }
    let frames = raw["frames"]
        .as_array()
        .filter(|list| !list.is_empty())
        .ok_or_else(|| GatewayError("Supply one or more frames in args.frames.".into()))?;
    let scrubber = input_common::Scrubber::new(&cfg)?;
    if scrubber.text(label, &[]) != label {
        return fail("args.label contains private text.");
    }
    let mut unique = HashSet::new();
    let mut pinned = Vec::new();
    for (index, frame) in frames.iter().enumerate() {
        let at = format!("args.frames[{index}]");
        if frame.as_object().is_none_or(|fields| {
            fields
                .keys()
                .any(|key| !["file", "note", "sound", "defects"].contains(&key.as_str()))
        }) {
            return fail(format!(
                "{at} needs file, note, sound and optional defects."
            ));
        }
        let source = plain_path(&frame["file"], &format!("{at}.file"))?;
        let canonical = fs::canonicalize(&source)
            .map_err(|_| GatewayError(format!("{at}.file is missing.")))?;
        if !canonical.is_file() || !unique.insert(canonical) {
            return fail(format!("{at}.file must name a distinct regular frame."));
        }
        let bytes = pinned_image(&source)
            .map_err(|error| GatewayError(format!("{at}.file: {}", error.0)))?;
        image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|_| GatewayError(format!("{at}.file could not be identified.")))?
            .decode()
            .map_err(|_| GatewayError(format!("{at}.file is not a complete decodable frame.")))?;
        let note = frame["note"]
            .as_str()
            .map(|note| scrubber.text(note, &[]))
            .filter(|note| !note.trim().is_empty() && note.len() + 1024 <= LIMIT_PROMPT)
            .ok_or_else(|| GatewayError(format!("{at}.note needs bounded text.")))?;
        let sound = frame["sound"]
            .as_bool()
            .ok_or_else(|| GatewayError(format!("{at}.sound must be a boolean.")))?;
        let defects = match frame.get("defects") {
            None => Vec::new(),
            Some(Value::Array(rows))
                if rows
                    .iter()
                    .all(|row| row.as_str().is_some_and(|name| questions.contains(&name))) =>
            {
                rows.clone()
            }
            Some(_) => {
                return fail(format!(
                    "{at}.defects must list names of rated rubric questions."
                ))
            }
        };
        if sound && !defects.is_empty() {
            return fail(format!("{at} marks a sound frame as defective."));
        }
        pinned.push(json!({
            "file": source, "note": note, "sound": sound, "defects": defects,
            "imageSha256": sha256_hex(&bytes),
        }));
    }
    if tmp
        .ancestors()
        .any(|part| fs::symlink_metadata(part).is_ok_and(|m| m.file_type().is_symlink()))
    {
        return fail("args.tmp crosses a link.");
    }
    fs::create_dir_all(&tmp)?;
    let id = id.map(String::from).unwrap_or_else(crate::journal::new_run_id);
    let output = fs::canonicalize(&tmp)?.join(format!("rubric-{id}"));
    fs::create_dir(&output)?;
    let material =
        json!({ "rubric": rubric, "name": role_name, "questions": questions, "frames": pinned });
    let run = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"),
        "createdAt": iso(), "label": label, "repo": repo, "output": output,
        "inputs": { "argsSha256": input_common::args_digest(raw), "material": material, "materialSha256": sha256_hex(material.to_string()) },
        "policy": { "paid": true },
        "pair": { "decisions": { "provider": "openai", "model": rubric["model"], "role": role_name } },
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    // The input receipt has enough information to recover a cut before a frame copy is published.
    for (index, frame) in pinned.iter().enumerate() {
        prepare_image(&journal, index, frame)?;
    }
    Ok((id, journal))
}

fn prepare_image(journal: &Journal, index: usize, frame: &Value) -> Result<PathBuf> {
    let name = format!("frames/frame-{}.image", index + 1);
    let copy = journal.file(&name);
    let from = if copy.is_file() {
        &copy
    } else {
        frame["file"]
            .as_str()
            .map(Path::new)
            .ok_or_else(|| GatewayError("The run has no source for a pinned frame.".into()))?
    };
    let bytes = pinned_image(from)?;
    if frame["imageSha256"] != sha256_hex(&bytes) {
        return fail(format!(
            "Frame {} no longer matches the run's input.",
            index + 1
        ));
    }
    if from != copy {
        journal.write_bytes(&name, &bytes)?;
    }
    Ok(copy)
}

pub fn resume(id: &str, given: Option<&Value>, retry: Option<&str>) -> Result<Exit> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if run["workflow"] != NAME
        || run["version"] != VERSION
        || run["policy"]["paid"] != true
        || given.is_some_and(|given| !input_common::args_match(&run["inputs"], given))
    {
        return fail("The run does not match this rubric-probe command.");
    }
    let _lock = journal.lock()?;
    journal.load()?;
    if let Some(result) = journal.read_value("result.json") {
        if retry.is_some() {
            return fail("This rubric probe has finished.");
        }
        finish_event(&mut journal)?;
        return Ok(Exit { code: 0, result });
    }
    if let Some(step) = retry {
        if !journal
            .last_event()
            .is_some_and(|event| event["kind"] == "stop" && event["step"] == step)
        {
            return fail("Retry must name the stopped frame. It can spend for another call.");
        }
        journal.append(json!({ "kind": "rerun", "step": step }))?;
    }
    let material = &run["inputs"]["material"];
    if run["inputs"]["materialSha256"] != sha256_hex(material.to_string()) {
        return fail("The pinned rubric and frames do not match their recorded digest.");
    }
    let cfg = Config::new(run["repo"].as_str().map(Path::new))?;
    let frames = material["frames"]
        .as_array()
        .ok_or_else(|| GatewayError("The run has no frames.".into()))?;
    let questions: Vec<&str> = material["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let images = frames
        .iter()
        .enumerate()
        .map(|(index, frame)| prepare_image(&journal, index, frame))
        .collect::<Result<Vec<_>>>()?;
    let pick = Pick::from_json(&run["pair"]["decisions"]);
    let name = material["name"].as_str().unwrap_or("");
    let mut answers = Vec::new();
    let mut input_tokens = Some(0u64);
    for (index, (frame, image)) in frames.iter().zip(images).enumerate() {
        let step = format!("frame {}", index + 1);
        let call = gateway::Call {
            id,
            step: &step,
            round: 1,
            role: name,
            pick: &pick,
            schema: &Value::Null,
            prompt: frame["note"].as_str().unwrap_or("").to_string(),
            writer_workspace: None,
        };
        let decision = gateway::Decision {
            role: &material["rubric"],
            image,
            sha256: frame["imageSha256"].as_str().unwrap_or(""),
        };
        let result = match gateway::ask_decision(&mut journal, &cfg, call, decision, |response| {
            validate(response, &questions)
        }) {
            Ok(result) => result,
            Err(error) => return stop(&mut journal, &run, &step, error),
        };
        input_tokens = input_tokens
            .zip(result["inputTokens"].as_u64())
            .and_then(|(total, n)| total.checked_add(n));
        answers.push(
            result["verdict"]["questions"]
                .as_array()
                .expect("validated")
                .clone(),
        );
    }
    let verdicts: Vec<Value> = questions
        .into_iter()
        .map(|name| summarize(name, frames, &answers))
        .collect();
    let folder = run["output"]
        .as_str()
        .map(Path::new)
        .ok_or_else(|| GatewayError("The run has no output folder.".into()))?;
    if !fs::symlink_metadata(folder).is_ok_and(|meta| meta.file_type().is_dir()) {
        return fail("The saved rubric output directory is missing or has been replaced.");
    }
    let path = folder.join("verdicts.json");
    let result = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "label": run["label"], "models": run["pair"], "approved": true,
        "journal": journal.dir, "role": name, "file": path, "verdicts": verdicts, "inputTokens": input_tokens,
    });
    let text = serde_json::to_string_pretty(&result).expect("verdict JSON") + "\n";
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && fs::read_to_string(&path).is_ok_and(|old| old == text) => {}
        Ok(_) => return fail("The rubric artifact has been replaced or edited."),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            design_brief::publish(&path, &text, false)?
        }
        Err(error) => return Err(error.into()),
    }
    journal.write_value("result.json", &result)?;
    finish_event(&mut journal)?;
    Ok(Exit { code: 0, result })
}

fn validate(response: &Value, questions: &[&str]) -> std::result::Result<(), String> {
    let rows = response["verdict"]["questions"]
        .as_array()
        .ok_or("The frame has no rubric verdict.")?;
    if rows.len() != questions.len()
        || questions
            .iter()
            .any(|name| rows.iter().filter(|row| row["name"] == *name).count() != 1)
        || rows.iter().any(|row| {
            !matches!(
                row["outcome"].as_str(),
                Some("pass" | "fail" | "known" | "unclear")
            )
        })
    {
        return Err("The frame must have one outcome for each rated question.".into());
    }
    Ok(())
}

fn summarize(name: &str, frames: &[Value], answers: &[Vec<Value>]) -> Value {
    let mut sound = Vec::new();
    let mut defect = Vec::new();
    let mut rows = Vec::new();
    for (frame, verdict) in frames.iter().zip(answers) {
        let row = verdict
            .iter()
            .find(|row| row["name"] == name)
            .expect("validated");
        if frame["sound"] == true {
            sound.push(row["outcome"] == "pass");
        }
        if frame["defects"]
            .as_array()
            .is_some_and(|names| names.iter().any(|value| value == name))
        {
            defect.push(row["outcome"] == "fail");
        }
        rows.push(json!({ "frame": frame["file"], "outcome": row["outcome"], "agreement": row["agreement"] }));
    }
    let catches = defect.iter().all(|caught| *caught);
    let passes_sound = sound.iter().all(|passes| *passes);
    let verdict = match (sound.is_empty(), defect.is_empty(), catches, passes_sound) {
        (_, true, _, _) => "no defect frame for it",
        (true, _, _, _) => "no sound frame",
        (_, _, true, true) => "keep",
        (_, _, true, false) => "catches, unsure on sound frames: reword",
        _ => "does not catch: reword or drop",
    };
    json!({ "question": name, "verdict": verdict, "answers": rows })
}

fn stop(journal: &mut Journal, run: &Value, step: &str, error: gateway::CallError) -> Result<Exit> {
    let (at, why) = match error {
        gateway::CallError::Stop { at, reason } => (at, reason),
        gateway::CallError::Context { bytes } => (
            format!("context too large at {step}"),
            format!("The material has {bytes} bytes before the call."),
        ),
    };
    journal.append(json!({ "kind": "stop", "step": step, "stoppedAt": at, "what": why }))?;
    Ok(Exit {
        code: 2,
        result: json!({
            "runId": run["runId"], "workflow": NAME, "models": run["pair"], "journal": journal.dir,
            "approved": false, "stoppedAt": at, "infra": why,
        }),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_complete_rows_and_scores_against_known_frames() {
        let frames = vec![
            json!({"file": "sound.png", "sound": true, "defects": []}),
            json!({"file": "defect.png", "sound": false, "defects": ["straight"]}),
        ];
        let row = |name, outcome| json!({ "name": name, "outcome": outcome, "agreement": 0.98 });
        let sound = vec![row("straight", "pass")];
        assert!(validate(&json!({"verdict": {"questions": &sound}}), &["unknown"]).is_err());
        assert!(validate(
            &json!({"verdict": {"questions": [&sound[0], &sound[0]]}}),
            &["straight"]
        )
        .is_err());
        assert_eq!(
            summarize(
                "straight",
                &frames,
                &[
                    vec![row("straight", "unclear")],
                    vec![row("straight", "fail")]
                ]
            )["verdict"],
            "catches, unsure on sound frames: reword",
        );
    }
}
