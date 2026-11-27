//! One video from scenario choice to an approved, verified file.

use crate::{video_manifest as manifest, video_metrics as metrics, video_research};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};
use zodchi_core::{
    config::Config,
    job::{self, Request},
    process::{self, process_start},
    role::{load_role, Overrides},
    util::{fail, iso, publish, sha256_hex, GatewayError, Result},
};
use zodchi_flow_engine::{
    accepted_media::{self, assert_artifact, VideoFiles, MARKER},
    boundary::{self, Launch},
    executor::local::pinned_image,
    gateway, input_common,
    journal::{self, Journal, RunLock, StatusHooks},
    video_media as media, Exit,
};

pub use zodchi_flow_engine::accepted_media::{NAME, VERSION};
const SCRIPT: &str = "choose scenario";
const PROBE: &str = "accept probe";
const FINAL: &str = "accept final";

pub fn start(raw: &Value, launch: Option<Launch>) -> Result<Exit> {
    match (prepare(raw), launch) {
        (Ok((id, _)), None) => resume(&id, None, None),
        (Ok((id, journal)), Some(launch)) if !journal.file("result.json").exists() => {
            launch(&journal, &id)
        }
        (Ok((id, _)), Some(_)) => status(&id),
        (Err(error), _) => Ok(Exit {
            code: 2,
            result: json!({ "workflow": NAME, "refused": error.0 }),
        }),
    }
}

fn prepare(raw: &Value) -> Result<(String, Journal)> {
    media::fields(
        raw,
        &[
            "dir",
            "id",
            "format",
            "title",
            "brief",
            "ffmpeg",
            "ffprobe",
            "variants",
            "adopt",
            "research",
            "experts",
            "priorRuns",
            "viewTarget",
            "comparisonWindowSeconds",
        ],
        "video args",
    )?;
    let dir = media::directory(&raw["dir"], "args.dir")?;
    let lock = media::owned(&dir, ".zodchi-video-lock")?;
    let _lock = Journal::lock_directory(lock)?;
    let cfg = Config::context(&dir)?;
    let marker = media::owned(&dir, MARKER)?;
    if marker.exists() {
        let existing = media::read_json(&marker)?;
        let id = media::text(&existing["runId"], "existing video run ID")?;
        let (journal, run) = Journal::open(&cfg.home, id)?;
        if run["workflow"] != NAME
            || run["repo"] != json!(dir)
            || !input_common::args_match(&run["inputs"], raw)
        {
            return fail(format!("This directory already belongs to video run {id}. Resume that run or use another video directory."));
        }
        return Ok((id.to_owned(), journal));
    }
    let id = manifest::small_id(&raw["id"], "args.id", 48)?;
    let format = media::text(&raw["format"], "args.format")?;
    if !["short", "long"].contains(&format) {
        return fail("args.format must be short or long.");
    }
    let title = media::text(&raw["title"], "args.title")?;
    let ffmpeg = media::file(&dir, &raw["ffmpeg"], "args.ffmpeg")?;
    let ffprobe = media::file(&dir, &raw["ffprobe"], "args.ffprobe")?;
    let (base, base_sha) = manifest::initial(&dir, &id, format, title)?;
    let adopted = raw.get("adopt");
    let (variants, brief) = if let Some(adopt) = adopted {
        media::fields(adopt, &["file", "edit", "expect"], "args.adopt")?;
        if raw.get("variants").is_some() {
            return fail(
                "Supply an existing export with adopt, or scenario variants for a new video.",
            );
        }
        let path = media::file(&dir, &adopt["file"], "adopt.file")?;
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp4"))
        {
            return fail("adopt.file needs an MP4.");
        }
        let (edit, sources) = prepare_edit(&dir, adopt.get("edit"), &base)?;
        let expect = expectation(adopt.get("expect"))?;
        (
            vec![
                json!({"id": "existing", "edit": edit, "sources": sources, "adopt": media::pin(&path)?, "expect": expect }),
            ],
            Value::Null,
        )
    } else {
        let brief = media::pin(&media::file(&dir, &raw["brief"], "brief")?)?;
        let variants = raw["variants"]
            .as_array()
            .filter(|rows| (1..=12).contains(&rows.len()))
            .ok_or_else(|| GatewayError("Supply 1 to 12 scenario variants.".into()))?;
        let mut ids = HashSet::new();
        let variants = variants.iter().map(|v| {
            media::fields(v, &["id", "scenario", "edit", "probe", "final", "probeExpect", "expect", "inputs"], "variant")?;
            let id = manifest::small_id(&v["id"], "variant.id", 24)?;
            if !ids.insert(id.clone()) { return fail("Variant IDs must be distinct."); }
            let scenario = media::pin(&media::file(&dir, &v["scenario"], "variant.scenario")?)?;
            let (edit, sources) = prepare_edit(&dir, v.get("edit"), &base)?;
            let inputs = files(&dir, v.get("inputs"), "variant.inputs", 64)?;
            Ok(json!({ "id": id, "scenario": scenario, "edit": edit, "sources": sources, "inputs": inputs,
                "probe": media::tool_plan(&dir, &v["probe"])?,
                "final": media::tool_plan(&dir, &v["final"])?,
                "probeExpect": expectation(v.get("probeExpect"))?, "expect": expectation(v.get("expect"))? }))
        }).collect::<Result<Vec<_>>>()?;
        (variants, brief)
    };
    let run_id = journal::new_run_id();
    let mut research = raw
        .get("research")
        .map(|value| video_research::pin_report(&media::file(&dir, value, "research")?))
        .transpose()?;
    let frozen_research = if let Some(pin) = research.as_mut() {
        let source = media::checked(pin)?.to_path_buf();
        let bytes = fs::read(&source)?;
        if pin["sha256"] != sha256_hex(&bytes) {
            return fail("The research report changed while it was being copied.");
        }
        pin["sourcePath"] = json!(source);
        pin["path"] = json!(journal::flows_dir(&cfg.home)
            .join(&run_id)
            .join("video-research.json"));
        Some(bytes)
    } else {
        None
    };
    let experts = prepare_experts(&dir, &cfg, raw.get("experts"), adopted.is_some())?;
    let prior = metrics::prior(&cfg, raw.get("priorRuns"), format)?;
    let target = positive(raw.get("viewTarget"), "viewTarget", 10_000)?;
    let window = positive(
        raw.get("comparisonWindowSeconds"),
        "comparisonWindowSeconds",
        3600,
    )?;
    let plan = json!({ "variants": variants, "research": research, "experts": experts, "brief": brief,
        "priorRuns": prior, "adopted": adopted.is_some(), "ffmpeg": ffmpeg, "ffprobe": ffprobe,
        "viewTarget": target, "comparisonWindowSeconds": window });
    let run = json!({ "runId": run_id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"),
        "repo": dir, "videoId": id, "title": title, "format": format, "createdAt": iso(),
        "inputs": { "argsSha256": input_common::args_digest(raw), "manifest": base, "manifestSha256": base_sha,
            "plan": plan, "planSha256": sha256_hex(plan.to_string()) } });
    let journal = Journal::create(&cfg.home, &run_id, &run)?;
    if let Some(bytes) = frozen_research {
        journal.write_bytes("video-research.json", &bytes)?;
    }
    if !prior.is_empty() {
        journal.write_value("prior-video-stats.json", &plan["priorRuns"])?;
    }
    if !publish(&marker, &json!({"runId": run_id}).to_string())? {
        return fail("The video directory was reserved by another run.");
    }
    Ok((run_id, journal))
}

fn positive(value: Option<&Value>, at: &str, default: u64) -> Result<u64> {
    value
        .map(|v| {
            v.as_u64()
                .filter(|n| *n > 0)
                .ok_or_else(|| GatewayError(format!("{at} needs a positive integer.")))
        })
        .transpose()
        .map(|n| n.unwrap_or(default))
}

fn expectation(input: Option<&Value>) -> Result<Value> {
    let v = input.cloned().unwrap_or(json!({}));
    media::fields(&v, &["width", "height", "seconds"], "expect")?;
    for field in ["width", "height"] {
        if let Some(value) = v.get(field) {
            positive(Some(value), field, 1)?;
        }
    }
    if v.get("seconds")
        .is_some_and(|n| !n.as_f64().is_some_and(|n| n > 0.0))
    {
        return fail("expect.seconds needs a positive duration.");
    }
    Ok(v)
}

fn prepare_edit(dir: &Path, raw: Option<&Value>, base: &Value) -> Result<(Value, Vec<Value>)> {
    let mut edit = manifest::normalized_edit(raw.unwrap_or(&manifest::edit_of(base)))?;
    let mut pins = Vec::new();
    for row in edit["sources"].as_array_mut().unwrap() {
        let path = media::file(dir, &row["path"], "edit source")?;
        let pin = media::pin(&path)?;
        if !row["sha256"].is_null() && row["sha256"] != pin["sha256"] {
            return fail(format!(
                "The source differs from its declared hash: {}",
                path.display()
            ));
        }
        row["sha256"] = pin["sha256"].clone();
        pins.push(pin);
    }
    Ok((edit, pins))
}

fn files(dir: &Path, raw: Option<&Value>, at: &str, max: usize) -> Result<Vec<Value>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    raw.as_array()
        .filter(|v| v.len() <= max)
        .ok_or_else(|| GatewayError(format!("{at} needs an array of up to {max} paths.")))?
        .iter()
        .map(|v| media::pin(&media::file(dir, v, at)?))
        .collect()
}

fn expert_role(cfg: &Config, entry: &Value, pick: &Value) -> Result<Value> {
    let provider = media::text(&pick["provider"], "provider")?;
    let model = media::text(&pick["model"], "model")?;
    let effort = media::text(&pick["effort"], "effort")?;
    if !["codex", "claude"].contains(&provider) || (provider == "claude" && effort == "ultra") {
        return fail("Choose codex or claude and an effort supported by the provider.");
    }
    let role = load_role(
        cfg,
        media::text(&entry["role"], "expert role")?,
        &Overrides {
            model: Some(model.to_owned()),
            effort: Some(effort.to_owned()),
            ..Default::default()
        },
    )?;
    if role["mode"] != "expert" || role["kind"] != "text" {
        return fail("The video expert needs a text expert role.");
    }
    Ok(role)
}

fn prepare_experts(
    dir: &Path,
    cfg: &Config,
    raw: Option<&Value>,
    adopted: bool,
) -> Result<Vec<Value>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    raw.as_array().filter(|rows| rows.len() <= 12).ok_or_else(|| GatewayError("experts needs at most 12 entries.".into()))?
        .iter().map(|entry| {
            media::fields(entry, &["stage", "role", "provider", "model", "effort", "prompt", "attach", "images", "frames"], "expert")?;
            let stage = media::text(&entry["stage"], "expert.stage")?;
            if !["script", "probe", "final"].contains(&stage) || adopted && stage != "final" {
                return fail("Choose script, probe or final, or only final for an adopted export.");
            }
            let prompt = media::pin(&media::file(dir, &entry["prompt"], "expert.prompt")?)?;
            let attachments = files(dir, entry.get("attach"), "expert.attach", 12)?;
            let images = files(dir, entry.get("images"), "expert.images", job::LIMIT_IMAGES)?;
            let frames = entry.get("frames").map(|v| v.as_array().filter(|rows| stage != "script"
                && rows.len() + images.len() <= job::LIMIT_IMAGES
                && rows.iter().all(|t| t.as_f64().is_some_and(|n| n >= 0.0)))
                .ok_or_else(|| GatewayError("frames lists timestamps of a probe or final MP4 within the gateway image limit.".into())))
                .transpose()?;
            for image in &images {
                pinned_image(media::checked(image)?)?;
            }
            Ok(json!({ "stage": stage, "role": entry["role"], "provider": entry["provider"],
                "model": entry["model"], "effort": entry["effort"], "definition": expert_role(cfg, entry, entry)?,
                "prompt": prompt, "attach": attachments, "images": images, "frames": frames }))
        }).collect()
}

struct Video {
    journal: Journal,
    run: Value,
    cfg: Config,
    dir: PathBuf,
    manifest: Value,
}

impl Video {
    fn open(id: &str) -> Result<(Self, RunLock)> {
        let (VideoFiles { journal, run, dir, cfg, manifest }, lock) = accepted_media::open(id)?;
        Ok((Self { journal, run, dir, cfg, manifest }, lock))
    }

    fn plan(&self) -> &Value {
        &self.run["inputs"]["plan"]
    }

    fn save(&mut self) -> Result<()> {
        manifest::save(&mut self.journal, &self.dir, &self.manifest)
    }

    fn stop(&mut self, step: &str, error: &GatewayError) -> Result<Exit> {
        self.journal
            .append(json!({ "kind": "stop", "step": step, "stoppedAt": step, "what": error.0 }))?;
        Ok(Exit {
            code: 2,
            result: json!({ "runId": self.run["runId"], "status": "stopped", "step": step, "error": error.0 }),
        })
    }

    fn waiting(&mut self, step: &str, question: &str, detail: Value) -> Result<Exit> {
        let event =
            json!({ "kind": "waiting", "step": step, "question": question, "video": detail });
        if !self.journal.last_event().is_some_and(|e| {
            e["kind"] == "waiting" && e["step"] == step && e["video"] == event["video"]
        }) {
            self.journal.append(event.clone())?;
        }
        let mut exit = status(self.run["runId"].as_str().unwrap())?;
        exit.result["status"] = json!("waiting");
        exit.result["question"] = json!(question);
        exit.result["video"]["decision"] = event["video"].clone();
        exit.code = 2;
        Ok(exit)
    }

    fn answer(&self, step: &str) -> Option<Value> {
        self.journal
            .events()
            .iter()
            .rev()
            .find(|e| e["kind"] == "rerun" && e["step"] == step)
            .and_then(|e| serde_json::from_str(e["ownerAnswer"].as_str()?).ok())
    }

    fn advance(&mut self) -> Result<Exit> {
        let plan = self.plan().clone();
        if !plan["research"].is_null() {
            media::checked(&plan["research"])?;
        }
        if !plan["brief"].is_null() {
            media::checked(&plan["brief"])?;
        }
        let variants = plan["variants"].as_array().unwrap();
        let variant = if plan["adopted"] == true {
            &variants[0]
        } else {
            if let Some(waiting) = self.experts("script", &Value::Null)? {
                return Ok(waiting);
            }
            let Some(reply) = self.answer(SCRIPT) else {
                for variant in variants {
                    media::checked(&variant["scenario"])?;
                }
                return self.waiting(SCRIPT, "Choose the scenario and opening to render as a probe.", json!({
                    "stage": "script", "brief": plan["brief"], "research": plan["research"],
                    "priorStats": self.prior_path(), "experts": self.expert_results("script"),
                    "variants": variants.iter().map(|v| json!({ "id": v["id"], "scenario": v["scenario"] })).collect::<Vec<_>>()
                }));
            };
            if reply["decision"] == "reject" {
                return self.finish("changes_requested", &Value::Null);
            }
            variants
                .iter()
                .find(|v| v["id"] == reply["variant"])
                .ok_or_else(|| GatewayError("The selected scenario is missing.".into()))?
        };
        if plan["adopted"] != true {
            let probe = match self.render("probe", variant) {
                Ok(probe) => probe,
                Err(error) => return self.stop("probe", &error),
            };
            if let Some(waiting) = self.experts("probe", &probe)? {
                return Ok(waiting);
            }
            match self.answer(PROBE) {
                None => return self.waiting(
                    PROBE,
                    "Review the probe in motion and confirm this file.",
                    json!({
                        "stage": "probe", "artifact": probe, "experts": self.expert_results("probe")
                    }),
                ),
                Some(reply) if reply["decision"] == "reject" => {
                    return self.finish("changes_requested", &Value::Null)
                }
                _ => {}
            }
        }
        let final_file = match self.render("final", variant) {
            Ok(final_file) => final_file,
            Err(error) => return self.stop("final", &error),
        };
        if let Some(waiting) = self.experts("final", &final_file)? {
            return Ok(waiting);
        }
        let Some(reply) = self.answer(FINAL) else {
            return self.waiting(FINAL, "Review the verified final MP4 and confirm this exact file.", json!({
                "stage": "final", "artifact": final_file, "experts": self.expert_results("final")
            }));
        };
        if reply["decision"] == "reject" {
            return self.finish("changes_requested", &final_file);
        }
        if manifest::owner_transition(
            &mut self.manifest,
            "accepted",
            &final_file["render"],
            &reply["ownerWords"],
            &Value::Null,
        )? {
            self.save()?;
        }
        self.finish("approved", &final_file)
    }

    fn prior_path(&self) -> Value {
        if self.plan()["priorRuns"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
        {
            json!(self.journal.file("prior-video-stats.json"))
        } else {
            Value::Null
        }
    }

    fn finish(&mut self, verdict: &str, artifact: &Value) -> Result<Exit> {
        let result = json!({
            "workflow": NAME, "version": VERSION, "runId": self.run["runId"], "verdict": verdict,
            "manifest": self.dir.join("manifest.json"), "final": artifact, "priorStats": self.prior_path(),
            "research": self.plan()["research"], "experts": self.expert_results("script").into_iter()
                .chain(self.expert_results("probe")).chain(self.expert_results("final")).collect::<Vec<_>>()
        });
        self.journal.write_value("result.json", &result)?;
        self.journal
            .append(json!({ "kind": "finished", "verdict": verdict }))?;
        Ok(Exit {
            code: if verdict == "approved" { 0 } else { 2 },
            result,
        })
    }

    fn render(&mut self, step: &str, variant: &Value) -> Result<Value> {
        let attempt = self.journal.attempt(step);
        if let Some(done) = self.journal.last("done", step, attempt) {
            assert_artifact(&self.dir, &done["result"])?;
            return Ok(done["result"].clone());
        }
        if !variant["scenario"].is_null() {
            media::checked(&variant["scenario"])?;
        }
        for pin in ["sources", "inputs"]
            .iter()
            .flat_map(|key| variant[*key].as_array().into_iter().flatten())
        {
            media::checked(pin)?;
        }
        let row = match self.journal.last("render allocation", step, attempt) {
            Some(event) => {
                let row = event["row"].clone();
                if !self.manifest["renders"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["id"] == row["id"])
                {
                    self.manifest = event["body"].clone();
                    self.save()?;
                }
                row
            }
            None => {
                let row =
                    manifest::allocate(&self.dir, &mut self.manifest, step, &variant["edit"])?;
                self.journal.append(
                    json!({ "kind": "render allocation", "step": step, "attempt": attempt,
                    "row": row, "body": self.manifest }),
                )?;
                self.save()?;
                row
            }
        };
        let path = media::owned(&self.dir, row["path"].as_str().unwrap())?;
        let verified = match self.journal.last("render verified", step, attempt) {
            Some(event) => {
                assert_artifact(&self.dir, &event["result"])?;
                event["result"].clone()
            }
            None => match self.make_render(step, attempt, &path, variant, &row) {
                Ok(verified) => {
                    self.journal.append(json!({ "kind": "render verified", "step": step, "attempt": attempt, "result": verified }))?;
                    verified
                }
                Err(error) => return Err(error),
            },
        };
        if manifest::update_render(&mut self.manifest, &row["id"], &verified, None)? {
            self.save()?;
        }
        self.journal.append(
            json!({ "kind": "done", "step": step, "attempt": attempt, "result": verified }),
        )?;
        Ok(verified)
    }

    fn make_render(
        &mut self,
        step: &str,
        attempt: u32,
        path: &Path,
        variant: &Value,
        row: &Value,
    ) -> Result<Value> {
        let adopt = variant.get("adopt");
        let intent = self.journal.last("render intent", step, attempt).is_some();
        let receipt = self.journal.last("render exited", step, attempt).cloned();
        if intent && receipt.is_none() {
            return fail(format!("The previous {step} renderer has no completion receipt. Inspect the output and explicitly retry {step} if needed."));
        }
        if let Some(receipt) = receipt {
            if receipt["exitCode"] != 0 || receipt["timedOut"] == true {
                return fail(receipt["error"].as_str().unwrap_or("The renderer failed."));
            }
        } else {
            if path.exists() {
                return fail("The new render output slot is already occupied.");
            }
            fs::create_dir_all(path.parent().unwrap())?;
            self.journal.append(json!({ "kind": "render intent", "step": step, "attempt": attempt,
                "render": row["id"], "path": path, "effect": if adopt.is_some() { "adopt" } else { "render" } }))?;
            let (code, timed_out, failure) = if let Some(pin) = adopt {
                let mut source = fs::File::open(media::checked(pin)?)?;
                let mut file = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(path)?;
                io::copy(&mut source, &mut file)?;
                file.sync_all()?;
                let copy = media::stamp(path)?;
                if copy["sha256"] != pin["sha256"] || copy["bytes"] != pin["bytes"] {
                    return fail("The copied MP4 differs from the existing export.");
                }
                (Some(0), false, None)
            } else {
                let ran = media::run_tool(&variant[step], &self.dir, path, |pid| {
                    self.journal
                        .append(
                            json!({ "kind": "render child", "step": step, "attempt": attempt,
                        "pid": pid, "start": process_start(pid) }),
                        )
                        .map_err(|error| io::Error::other(error.0))
                })?;
                self.journal
                    .write_bytes(&format!("video/{step}-{attempt}.stderr.log"), &ran.stderr)?;
                (
                    ran.code,
                    ran.timed_out,
                    media::require_success(&ran, "renderer").err().map(|e| e.0),
                )
            };
            self.journal.append(
                json!({ "kind": "render exited", "step": step, "attempt": attempt,
                "exitCode": code, "timedOut": timed_out, "error": failure }),
            )?;
            boundary::cut(&format!("video {step} exited"));
            if let Some(message) = failure {
                if manifest::update_render(
                    &mut self.manifest,
                    &row["id"],
                    &Value::Null,
                    Some(&message),
                )? {
                    self.save()?;
                }
                return fail(message);
            }
        }
        let expect = &variant[if step == "probe" {
            "probeExpect"
        } else {
            "expect"
        }];
        let path = media::owned(&self.dir, row["path"].as_str().unwrap())?;
        let mut proof = media::verify(&self.dir, self.plan(), &path, expect)?;
        proof["relativePath"] = row["path"].clone();
        proof["render"] = row["id"].clone();
        proof["editSha256"] = row["editSha256"].clone();
        proof["variant"] = variant["id"].clone();
        proof["adopted"] = json!(adopt.is_some());
        Ok(proof)
    }

    fn expert_results(&self, stage: &str) -> Vec<Value> {
        let prefix = format!("expert-{stage}-");
        self.journal
            .events()
            .iter()
            .filter(|e| {
                e["kind"] == "done"
                    && e["step"]
                        .as_str()
                        .is_some_and(|step| step.starts_with(&prefix))
            })
            .map(|e| e["result"].clone())
            .collect()
    }

    fn experts(&mut self, stage: &str, artifact: &Value) -> Result<Option<Exit>> {
        let experts = self.plan()["experts"].as_array().unwrap().clone();
        for (index, expert) in experts
            .iter()
            .enumerate()
            .filter(|(_, expert)| expert["stage"] == stage)
        {
            let step = format!("expert-{stage}-{}", index + 1);
            let attempt = self.journal.attempt(&step);
            if self.journal.last("done", &step, attempt).is_some() {
                continue;
            }
            let reply = self.answer(&step);
            if reply.as_ref().is_some_and(|r| r["decision"] == "skip") {
                self.journal.append(json!({ "kind": "done", "step": step, "attempt": attempt,
                    "result": { "stage": stage, "status": "skipped", "ownerWords": reply.unwrap()["ownerWords"] } }))?;
                continue;
            }
            let pick = reply.as_ref().unwrap_or(expert);
            match self.expert_call(&step, attempt, expert, pick, artifact) {
                Ok(job) => {
                    let file = self
                        .journal
                        .write_value(&format!("video/{step}-{attempt}.json"), &job["result"])?;
                    let images =
                        self.journal.last("intent", &step, attempt).unwrap()["images"].clone();
                    self.journal.append(json!({ "kind": "done", "step": step, "attempt": attempt, "result": {
                        "key": job["key"], "provider": pick["provider"], "model": job["model"], "effort": job["effort"],
                        "actualModels": job["actualModels"], "stage": stage, "answer": file, "attachments": expert["attach"], "images": images
                    } }))?;
                }
                Err(error) => {
                    if self.journal.last("safety blocked", &step, attempt).is_some() {
                        return self.stop(&step, &error).map(Some);
                    }
                    return self.waiting(&step, "The expert request is unavailable or has no usable result. Choose a model explicitly or skip this expert step.", json!({
                        "stage": "expert", "phase": stage, "provider": pick["provider"], "model": pick["model"], "effort": pick["effort"],
                        "error": error.0, "artifact": artifact
                    })).map(Some);
                }
            }
        }
        Ok(None)
    }

    fn expert_call(
        &mut self,
        step: &str,
        attempt: u32,
        expert: &Value,
        pick: &Value,
        artifact: &Value,
    ) -> Result<Value> {
        let key = gateway::base_key(self.run["runId"].as_str().unwrap(), step, attempt);
        let intended = self.journal.last("intent", step, attempt).is_some();
        if !intended {
            let role = if pick == expert {
                expert["definition"].clone()
            } else {
                expert_role(&self.cfg, expert, pick)?
            };
            let mut parts = Vec::new();
            for pin in expert["attach"].as_array().unwrap() {
                let path = media::checked(pin)?;
                parts.push((
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    read_text(path)?.into_bytes(),
                ));
            }
            let notes = input_common::model_context(&self.journal)?;
            let prompt = read_text(media::checked(&expert["prompt"])?)?;
            let brief = if self.plan()["brief"].is_null() {
                String::new()
            } else {
                read_text(media::checked(&self.plan()["brief"])?)?
            };
            let part = json!({"title": self.run["title"], "stage": expert["stage"], "researchCoverage": self.plan()["research"]["coverage"],
                "priorVideoStats": metrics::prompt_summary(&self.plan()["priorRuns"]), "artifact": artifact });
            let prompt =
                job::compose_prompt(&format!("{prompt}\n\n{brief}\n\n{part}\n\n{notes}"), &parts)?;
            let prompt = input_common::scrub(
                &self.cfg,
                &prompt,
                &[(self.dir.to_string_lossy().into_owned(), "<video>")],
            )?;
            let mut pins = expert["images"].as_array().unwrap().clone();
            pins.extend(self.frames(step, attempt, &expert["frames"], artifact)?);
            let images = pins
                .iter()
                .map(|pin| pinned_image(media::checked(pin)?))
                .collect::<Result<Vec<_>>>()?;
            let provider = media::text(&pick["provider"], "provider")?;
            let request = Request {
                key: key.clone(),
                role,
                prompt,
                images,
                credits: false,
                paid: false,
                resume: None,
                keep_thread: None,
                fingerprint: None,
            };
            self.journal.append(json!({ "kind": "intent", "step": step, "attempt": attempt, "effect": "expert job",
                "key": key, "provider": provider, "model": pick["model"], "effort": pick["effort"],
                "promptSha256": sha256_hex(&request.prompt), "attachments": expert["attach"], "images": pins }))?;
            eprintln!(
                "{}: {step} · {provider}/{} {} · {key}",
                self.run["runId"].as_str().unwrap(),
                pick["model"],
                pick["effort"]
            );
            let (_, created) = job::submit_for(&self.cfg, &request, true, provider)?;
            self.journal.append(json!({ "kind": "submitted", "step": step, "attempt": attempt, "key": key, "created": created }))?;
        } else if !job::job_dir(&self.cfg, &key)?.join("job.json").is_file() {
            return fail(format!(
                "The job {key} has no surviving receipt. Its outcome is unknown."
            ));
        }
        loop {
            let done = job::wait(&self.cfg, &key, Duration::from_secs(30))?;
            let status = done["status"].as_str().unwrap_or("");
            if status == "succeeded" {
                return Ok(done);
            }
            if status == zodchi_core::appserver::SAFETY_BLOCKED {
                gateway::record_safety_block(&mut self.journal, step, attempt, &key, pick["provider"].as_str().unwrap_or("codex"))?;
                return fail(zodchi_core::appserver::SAFETY_MESSAGE);
            }
            if job::is_terminal(status) {
                return fail(format!(
                    "{key} {status}: {}",
                    done["error"].as_str().unwrap_or("No usable answer.")
                ));
            }
        }
    }

    fn frames(
        &self,
        step: &str,
        attempt: u32,
        frames: &Value,
        artifact: &Value,
    ) -> Result<Vec<Value>> {
        let Some(frames) = frames.as_array().filter(|rows| !rows.is_empty()) else {
            return Ok(Vec::new());
        };
        assert_artifact(&self.dir, artifact)?;
        let input = Path::new(artifact["path"].as_str().unwrap());
        let duration = artifact["seconds"].as_f64().unwrap();
        let ffmpeg = media::text(&self.plan()["ffmpeg"], "ffmpeg")?;
        let dir = self.journal.file("video");
        fs::create_dir_all(&dir)?;
        frames
            .iter()
            .enumerate()
            .map(|(i, time)| {
                let seconds = time.as_f64().unwrap();
                if seconds >= duration {
                    return fail("An expert frame is past the end of its verified MP4.");
                }
                let path = dir.join(format!("{step}-{attempt}-frame-{i}.png"));
                let mut command = process::command_without_window(ffmpeg);
                command
                    .args([
                        "-nostdin",
                        "-v",
                        "error",
                        "-y",
                        "-ss",
                        &seconds.to_string(),
                        "-i",
                    ])
                    .arg(input)
                    .args(["-map", "0:v:0", "-frames:v", "1", "-threads", "1"])
                    .arg(&path);
                media::require_success(
                    &process::run(command, b"", &self.dir, Duration::from_secs(120))?,
                    "review frame extraction",
                )?;
                let mut pin = media::pin(&path)?;
                pin["second"] = time.clone();
                Ok(pin)
            })
            .collect()
    }
}

fn read_text(path: &Path) -> Result<String> {
    let mut text = String::new();
    fs::File::open(path)?
        .take((job::LIMIT_PROMPT + 1) as u64)
        .read_to_string(&mut text)?;
    if text.len() > job::LIMIT_PROMPT || text.contains('\0') {
        return fail("A model input must be UTF-8 text within the gateway prompt limit.");
    }
    Ok(text.trim_start_matches('\u{feff}').to_owned())
}

pub fn resume(id: &str, _given: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    let (mut video, _lock) = Video::open(id)?;
    if let Some(result) = video.journal.read_value("result.json") {
        if rerun.is_some() {
            return fail("The video has already finished.");
        }
        if !result["final"].is_null() {
            media::checked(&result["final"])?;
        }
        if !video
            .journal
            .events()
            .iter()
            .any(|e| e["kind"] == "finished")
        {
            video
                .journal
                .append(json!({ "kind": "finished", "verdict": result["verdict"] }))?;
        }
        return Ok(Exit {
            code: if result["verdict"] == "approved" {
                0
            } else {
                2
            },
            result,
        });
    }
    if let Some(step) = rerun {
        if !["probe", "final"].contains(&step)
            || !video
                .journal
                .last_event()
                .is_some_and(|e| e["kind"] == "stop" && e["step"] == step)
        {
            return fail("A retry may name only the stopped render step.");
        }
        let attempt = video.journal.attempt(step);
        if let Some(child) = video.journal.last("render child", step, attempt) {
            let pid = child["pid"].as_u64().unwrap_or(0) as u32;
            if process::alive(pid)
                && child["start"]
                    .as_str()
                    .is_none_or(|start| process_start(pid).as_deref() == Some(start))
            {
                return fail("The previous renderer may still be running.");
            }
        }
        video
            .journal
            .append(json!({ "kind": "rerun", "step": step }))?;
    }
    video.advance()
}

pub fn record_reply(waiting: &Value, raw: &str) -> Result<()> {
    let reply: Value = serde_json::from_str(raw).map_err(|_| {
        GatewayError("A video reply is a JSON object with the owner's decision and words.".into())
    })?;
    let detail = &waiting["video"];
    let choice = media::text(&reply["decision"], "decision")?;
    media::owner_words(&reply["ownerWords"])?;
    match detail["stage"].as_str().unwrap_or("") {
        "script" => {
            media::fields(
                &reply,
                &["decision", "variant", "ownerWords"],
                "scenario reply",
            )?;
            if choice == "reject" && reply.get("variant").is_none() {
                return Ok(());
            }
            if choice != "choose"
                || !detail["variants"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|variant| variant["id"] == reply["variant"])
            {
                return fail(
                    "The scenario reply must choose a listed variant or reject the proposals.",
                );
            }
        }
        "probe" | "final" => {
            media::fields(
                &reply,
                &["decision", "render", "sha256", "ownerWords"],
                "render reply",
            )?;
            let artifact = &detail["artifact"];
            if !["accept", "reject"].contains(&choice)
                || reply["render"] != artifact["render"]
                || reply["sha256"] != artifact["sha256"]
            {
                return fail(
                    "The reply must accept or reject the displayed render ID and SHA-256.",
                );
            }
            if choice == "accept" {
                media::checked(artifact)?;
            }
        }
        "expert" => {
            let names = if choice == "skip" {
                &["decision", "ownerWords"][..]
            } else {
                &["decision", "ownerWords", "provider", "model", "effort"]
            };
            media::fields(&reply, names, "expert reply")?;
            if choice == "skip" {
                return Ok(());
            }
            let provider = media::text(&reply["provider"], "provider")?;
            let effort = media::text(&reply["effort"], "effort")?;
            media::text(&reply["model"], "model")?;
            if choice != "replace"
                || !["codex", "claude"].contains(&provider)
                || !["low", "medium", "high", "xhigh", "max", "ultra"].contains(&effort)
                || provider == "claude" && effort == "ultra"
            {
                return fail("Choose skip or replace with an explicit provider, model and effort.");
            }
        }
        _ => return fail("There is no recognized video decision to answer."),
    }
    Ok(())
}

fn status(id: &str) -> Result<Exit> {
    journal::status(
        id,
        StatusHooks { details: Some(project_status), ..StatusHooks::default() },
    )
}

pub fn project_status(run: &Value, events: &[Value], result: &mut Value) {
    if run["workflow"] == NAME {
        result["video"] = status_detail(run, events);
    }
}

fn status_detail(run: &Value, events: &[Value]) -> Value {
    let last = events.last();
    let renders: Vec<_> = events
        .iter()
        .filter(|e| e["kind"] == "done" && (e["step"] == "probe" || e["step"] == "final"))
        .map(|e| e["result"].clone())
        .collect();
    let mut report = json!({ "title": run["title"], "format": run["format"], "research": run["inputs"]["plan"]["research"],
        "renders": renders, "publication": null, "latestStats": null });
    if let Some(event) = last.filter(|event| event["kind"] == "waiting") {
        report["decision"] = event["video"].clone();
    }
    if let Some(event) = events.iter().rev().find(|e| e["kind"] == "video published") {
        report["publication"] = event["publication"].clone();
    }
    if let Some(event) = events
        .iter()
        .filter(|e| e["kind"] == "video stats")
        .max_by_key(|e| e["sample"]["capturedAtMs"].as_i64().unwrap_or(0))
    {
        report["latestStats"] = event["sample"].clone();
        report["comparisons"] = event["comparisons"].clone();
    }
    report
}

pub fn record_publication(id: &str, raw: &Value) -> Result<Exit> {
    media::fields(
        raw,
        &[
            "render",
            "sha256",
            "publicationId",
            "publishedAt",
            "ownerWords",
        ],
        "publication",
    )?;
    let (mut video, _lock) = Video::open(id)?;
    let words = input_common::scrub(&video.cfg, media::owner_words(&raw["ownerWords"])?, &[])?;
    let result = video
        .journal
        .read_value("result.json")
        .filter(|result| result["verdict"] == "approved")
        .ok_or_else(|| {
            GatewayError("Record publication after the owner accepts the exact final file.".into())
        })?;
    let artifact = &result["final"];
    if raw["render"] != artifact["render"] || raw["sha256"] != artifact["sha256"] {
        return fail("Publication must identify the accepted render and SHA-256.");
    }
    assert_artifact(&video.dir, artifact)?;
    let id_public = media::text(&raw["publicationId"], "publicationId")?;
    if id_public.len() > 512 {
        return fail("publicationId is too long.");
    }
    metrics::time(&raw["publishedAt"], "publishedAt")?;
    let publication = json!({"id": id_public, "snapshotAt": raw["publishedAt"]});
    if let Some(event) = video
        .journal
        .events()
        .iter()
        .find(|e| e["kind"] == "video published")
    {
        if event["publication"] != publication {
            return fail("The video already has a different publication record.");
        }
    } else {
        if manifest::owner_transition(
            &mut video.manifest,
            "published",
            &raw["render"],
            &json!(words),
            &publication,
        )? {
            video.save()?;
        }
        video.journal.append(
            json!({ "kind": "video published", "publication": publication,
            "render": raw["render"], "sha256": raw["sha256"], "ownerWords": words }),
        )?;
    }
    Ok(Exit {
        code: 0,
        result: json!({"runId": id, "publication": publication, "file": artifact}),
    })
}

pub fn record_stats(id: &str, raw: &Value) -> Result<Exit> {
    let (mut video, _lock) = Video::open(id)?;
    let publication = video
        .journal
        .events()
        .iter()
        .rev()
        .find(|event| event["kind"] == "video published")
        .ok_or_else(|| {
            GatewayError("Record the publication before adding its statistics.".into())
        })?;
    let format = video.run["format"].as_str().unwrap();
    let sample = metrics::parse_sample(
        raw,
        &publication["publication"],
        video.plan()["viewTarget"].as_u64().unwrap(),
    )?;
    let comparisons = if let Some(event) = video.journal.events().iter().find(|e| {
        e["kind"] == "video stats" && e["sample"]["capturedAtMs"] == sample["capturedAtMs"]
    }) {
        if event["sample"] != sample {
            return fail("That snapshot time already has different statistics.");
        }
        event["comparisons"].clone()
    } else {
        let comparisons = metrics::compare(
            &video.cfg,
            &video.plan()["priorRuns"],
            format,
            &sample,
            video.plan()["comparisonWindowSeconds"].as_u64().unwrap(),
        )?;
        video.journal.append(
            json!({"kind": "video stats", "sample": sample, "comparisons": comparisons }),
        )?;
        comparisons
    };
    Ok(Exit {
        code: 0,
        result: json!({"runId": id, "sample": sample, "comparisons": comparisons}),
    })
}
