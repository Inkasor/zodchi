//! Upload one accepted video privately and reconcile it through the shared journal.

mod api;
mod artifact;
mod auth;

#[cfg(test)]
mod tests;

use self::{
    api::{Google, Transfer},
    artifact::Artifact,
    auth::{SystemVault, Vault},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use zodchi_core::{
    config::Config,
    util::{fail, iso, publish, sha256_hex, GatewayError, Result},
};
use zodchi_flow_engine::{
    accepted_media, input_common as input,
    journal::{self, Journal},
    video_media as media, Exit,
};

pub use auth::{connect, whoami};
pub const NAME: &str = "youtube-publish";
const VERSION: &str = "1";
const APPROVAL: &str = "approve private upload";
pub const REPLY_WAITING_ONLY: &str =
    "The upload has its decision. Resolve the reported issue and resume the same YouTube run.";

pub fn start(raw: &Value) -> Result<Exit> {
    match prepare(raw) {
        Ok(exit) => Ok(exit),
        Err(error) => Ok(Exit {
            code: 2,
            result: json!({ "workflow": NAME, "refused": error.0 }),
        }),
    }
}

fn metadata(raw: &Value) -> Result<Value> {
    let title = media::text(&raw["title"], "title")?;
    let description = raw["description"].as_str().ok_or_else(|| {
        GatewayError(
            "description needs text. Use an empty string if you want no description.".into(),
        )
    })?;
    if title.chars().count() > 100 || title.contains(['<', '>']) {
        return fail("The YouTube title must have at most 100 characters and no angle brackets.");
    }
    if description.len() > 5000 || description.contains(['<', '>', '\0']) {
        return fail("The YouTube description must have at most 5000 UTF-8 bytes and no angle brackets or NUL.");
    }
    let category = raw["categoryId"]
        .as_str()
        .filter(|s| s.parse::<u16>().is_ok_and(|n| n > 0) && s.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(|| {
            GatewayError("categoryId needs a YouTube category number as text.".into())
        })?;
    let kids = raw["selfDeclaredMadeForKids"]
        .as_bool()
        .ok_or_else(|| GatewayError("Choose true or false for selfDeclaredMadeForKids.".into()))?;
    Ok(json!({
        "snippet": { "title": title, "description": description, "categoryId": category },
        "status": { "privacyStatus": "private", "selfDeclaredMadeForKids": kids },
    }))
}

fn prepare(raw: &Value) -> Result<Exit> {
    media::fields(
        raw,
        &[
            "videoRun",
            "profile",
            "channelId",
            "title",
            "description",
            "categoryId",
            "selfDeclaredMadeForKids",
        ],
        "YouTube publication",
    )?;
    let profile = auth::profile(&raw["profile"])?;
    let channel = auth::channel_id(&raw["channelId"])?;
    let video_run = media::text(&raw["videoRun"], "videoRun")?;
    let metadata = metadata(raw)?;
    let (dir, artifact) = accepted_media::accepted_upload(video_run)?;
    if !Path::new(media::text(&artifact["path"], "accepted MP4")?)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("mp4"))
    {
        return fail("The accepted video must be an MP4.");
    }
    let plan = json!({ "artifact": artifact, "videoRun": video_run, "profile": profile,
        "channelId": channel, "metadata": metadata, "notifySubscribers": false });
    let id = journal::new_run_id();
    let run = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"),
        "createdAt": iso(), "repo": dir, "label": metadata["snippet"]["title"],
        "inputs": { "argsSha256": input::args_digest(raw), "planSha256": input::args_digest(&plan), "plan": plan },
    });
    let mut journal = Journal::create(&Config::new(None)?.home, &id, &run)?;
    waiting(&mut journal, &run)
}

fn waiting(journal: &mut Journal, run: &Value) -> Result<Exit> {
    const QUESTION: &str =
        "Confirm the displayed MP4, channel and metadata for a private YouTube upload.";
    if !journal
        .last_event()
        .is_some_and(|event| event["kind"] == "waiting" && event["step"] == APPROVAL)
    {
        journal.append(json!({
            "kind": "waiting", "step": APPROVAL, "question": QUESTION,
            "planSha256": run["inputs"]["planSha256"],
        }))?;
    }
    Ok(Exit {
        code: 2,
        result: json!({
            "runId": run["runId"], "workflow": NAME, "journal": journal.dir,
            "status": "waiting", "step": APPROVAL, "question": QUESTION,
            "youtube": status_detail(run, journal.events()),
        }),
    })
}

pub fn record_reply(waiting: &Value, raw: &str) -> Result<()> {
    let reply: Value = serde_json::from_str(raw)
        .map_err(|_| GatewayError("A YouTube reply needs a JSON decision.".into()))?;
    media::fields(
        &reply,
        &["decision", "planSha256", "ownerWords"],
        "YouTube upload reply",
    )?;
    media::owner_words(&reply["ownerWords"])?;
    if waiting["step"] != APPROVAL
        || !["approve", "reject"]
            .iter()
            .any(|choice| reply["decision"] == *choice)
        || reply["planSha256"] != waiting["planSha256"]
    {
        return fail("Approve or reject the exact displayed YouTube plan SHA-256.");
    }
    Ok(())
}

pub fn project_status(run: &Value, events: &[Value], result: &mut Value) {
    if run["workflow"] == NAME {
        result["youtube"] = status_detail(run, events);
    }
}

pub fn handoff(id: &str, run: &Value, current: &Value, result: &Value, result_path: &Path) -> Value {
    json!({ "runId": id, "workflow": run["workflow"], "version": run["version"],
        "status": current["status"], "step": current["step"], "journal": current["journal"],
        "question": current["question"], "reason": result.get("reason").unwrap_or(&current["infra"]),
        "youtube": current["youtube"], "resultFile": (!result.is_null()).then_some(result_path),
        "verdict": result["verdict"], "observed": result["observed"] })
}

fn status_detail(run: &Value, events: &[Value]) -> Value {
    let inputs = &run["inputs"];
    let mut detail = json!({ "plan": inputs["plan"], "planSha256": inputs["planSha256"] });
    if let Some(event) = events
        .iter()
        .rev()
        .find(|e| e["kind"] == "youtube uploaded")
    {
        detail["videoId"] = event["videoId"].clone();
        detail["bytesAcknowledged"] = inputs["plan"]["artifact"]["bytes"].clone();
    } else if let Some(event) = events
        .iter()
        .rev()
        .find(|e| e["kind"] == "youtube progress")
    {
        detail["bytesAcknowledged"] = event["bytesAcknowledged"].clone();
    }
    if let Some(event) = events
        .iter()
        .rev()
        .find(|e| e["kind"] == "youtube channel checked")
    {
        detail["channel"] = event["channel"].clone();
    }
    detail
}

pub fn resume(id: &str, given: Option<&Value>, rerun: Option<&str>) -> Result<Exit> {
    if rerun.is_some() {
        return fail(
            "Resume a YouTube upload without --rerun. Zodchi reconciles the saved session.",
        );
    }
    let home = Config::new(None)?.home;
    let (journal, run) = Journal::open(&home, id)?;
    if run["workflow"] != NAME
        || run["version"] != VERSION
        || given.is_some_and(|args| !input::args_match(&run["inputs"], args))
    {
        return fail("This YouTube run does not match the current command.");
    }
    resume_with(
        journal,
        &run,
        &home,
        &Google::new(),
        &SystemVault::new(&home)?,
    )
}

fn resume_with(
    mut journal: Journal,
    run: &Value,
    home: &Path,
    google: &Google,
    vault: &dyn Vault,
) -> Result<Exit> {
    let _lock = journal.lock()?;
    journal.load()?;
    let plan = &run["inputs"]["plan"];
    if run["inputs"]["planSha256"] != input::args_digest(plan) {
        return fail("The pinned YouTube publication plan was changed.");
    }
    if let Some(result) = journal.read_value("result.json") {
        return finish(&mut journal, result);
    }
    let Some(raw_reply) = journal
        .events()
        .iter()
        .rev()
        .find(|e| e["kind"] == "rerun" && e["step"] == APPROVAL)
        .and_then(|event| event["ownerAnswer"].as_str())
    else {
        return waiting(&mut journal, run);
    };
    record_reply(
        &json!({ "step": APPROVAL, "planSha256": run["inputs"]["planSha256"] }),
        raw_reply,
    )?;
    let decision: Value = serde_json::from_str(raw_reply).expect("validated YouTube reply");
    if decision["decision"] == "reject" {
        return finish(
            &mut journal,
            json!({
                "runId": run["runId"], "workflow": NAME, "status": "finished", "verdict": "cancelled",
            }),
        );
    }
    let mut publication = Publication {
        journal: &mut journal,
        run,
        plan,
        home,
        google,
        vault,
    };
    publication.run()
}

struct Publication<'a> {
    journal: &'a mut Journal,
    run: &'a Value,
    plan: &'a Value,
    home: &'a Path,
    google: &'a Google,
    vault: &'a dyn Vault,
}

impl Publication<'_> {
    fn run(&mut self) -> Result<Exit> {
        let known = self
            .journal
            .events()
            .iter()
            .rev()
            .find(|row| row["kind"] == "youtube uploaded")
            .and_then(|row| row["videoId"].as_str())
            .map(str::to_owned);
        let artifact = match known
            .is_none()
            .then(|| Artifact::open(&self.plan["artifact"]))
            .transpose()
        {
            Ok(artifact) => artifact,
            Err(error) => return self.stop("verify MP4", &error),
        };
        let profile = auth::profile(&self.plan["profile"])?;
        let expected = auth::channel_id(&self.plan["channelId"])?;
        let result = auth::token(self.google, self.vault, profile, expected).and_then(|token| {
            self.google
                .channel(&token, expected)
                .map(|channel| (token, channel))
        });
        let (token, channel) = match result {
            Ok(verified) => verified,
            Err(error) => return self.stop("verify channel", &error),
        };
        self.journal.append(json!({ "kind": "youtube channel checked", "step": "verify channel", "channel": channel }))?;
        let id = match (known, artifact) {
            (Some(id), _) => id,
            (None, Some(mut artifact)) => match self.upload(&token, &mut artifact) {
                Ok(id) => id,
                Err(error) => return self.stop("upload", &error),
            },
            _ => unreachable!("an unknown upload has an open, verified artifact"),
        };
        let verification = match self.verify(&token, &id) {
            Ok(Some(observed)) => observed,
            Ok(None) => {
                self.journal.append(
                    json!({ "kind": "youtube processing", "step": "verify upload", "videoId": id }),
                )?;
                return Ok(self.receipt(
                    "processing",
                    json!({ "next": "Resume this run to read YouTube processing status." }),
                ));
            }
            Err(error) => return self.stop("verify upload", &error),
        };
        let result = json!({
            "runId": self.run["runId"], "workflow": NAME, "version": VERSION, "status": "finished", "verdict": "private_verified",
            "videoRun": self.plan["videoRun"], "artifact": self.plan["artifact"], "channel": channel,
            "videoId": id, "url": format!("https://www.youtube.com/watch?v={id}"),
            "observed": verification, "verifiedAt": iso(),
        });
        finish(self.journal, result)
    }

    fn upload_marker(&self) -> Result<PathBuf> {
        let key = sha256_hex(format!(
            "{}\n{}",
            self.plan["channelId"], self.plan["artifact"]["sha256"]
        ));
        let dir = self.home.join("youtube-uploads");
        fs::create_dir_all(&dir)?;
        Ok(dir.join(format!("{key}.json")))
    }

    fn upload(&mut self, token: &str, artifact: &mut Artifact) -> Result<String> {
        let marker = self.upload_marker()?;
        let _lock = Journal::lock_directory(marker.with_extension("lock"))?;
        let id = self.run["runId"].as_str().expect("publication run ID");
        let reservation = marker
            .try_exists()?
            .then(|| media::read_json(&marker))
            .transpose()?;
        if let Some(saved) = reservation.as_ref().filter(|saved| saved["runId"] != id) {
            let existing = saved["runId"]
                .as_str()
                .filter(|id| journal::is_run_id(id))
                .unwrap_or("unknown");
            return fail(format!(
                "This MP4 and channel are already reserved by YouTube run {existing}."
            ));
        }
        let reserved = reservation.is_some();
        let secret_key = format!("upload/{id}");
        let saved = self.vault.get(&secret_key)?;
        let resume = saved.is_some();
        let announced = self
            .journal
            .events()
            .iter()
            .any(|e| e["kind"] == "youtube session saved");
        let session =
            match saved {
                Some(session) => session,
                None if announced || reserved => return fail(
                    "The saved YouTube upload session is missing from the system credential store.",
                ),
                None => {
                    let session =
                        self.google
                            .start(token, artifact.size, &self.plan["metadata"])?;
                    self.vault.put(&secret_key, &session)?;
                    session
                }
            };
        // Record the owner and the existence of the secret before the first PUT.
        // A rejected session setup leaves the file available for a corrected plan.
        if !reserved && !publish(&marker, &json!({ "runId": id }).to_string())? {
            return fail("Another YouTube run reserved this file and channel.");
        }
        if !announced {
            self.journal
                .append(json!({ "kind": "youtube session saved", "step": "upload" }))?;
        }
        let mut next = if resume {
            self.google.probe(token, &session, artifact.size)?
        } else {
            Transfer::Offset(0)
        };
        loop {
            let offset = match next {
                Transfer::Stored(id) => {
                    self.journal.append(
                        json!({ "kind": "youtube uploaded", "step": "upload", "videoId": id }),
                    )?;
                    if self.vault.forget(&secret_key).is_err() {
                        self.journal.append(json!({ "kind": "youtube note", "step": "upload", "note": "The upload session could not be cleared from the credential store." }))?;
                    }
                    return Ok(id);
                }
                Transfer::Offset(offset) => offset,
            };
            self.journal.append(json!({ "kind": "youtube progress", "step": "upload", "bytesAcknowledged": offset }))?;
            if offset >= artifact.size {
                return fail("YouTube acknowledged all bytes and has yet to return the video ID. Resume to reconcile the saved session.");
            }
            let data = artifact.chunk(offset)?;
            next = self
                .google
                .chunk(token, &session, artifact.size, offset, &data)?;
            let end = offset + data.len() as u64;
            if matches!(next, Transfer::Offset(n) if n <= offset || n > end)
                || matches!(next, Transfer::Stored(_) if end != artifact.size)
            {
                return fail("YouTube returned an unexpected upload acknowledgement. Resume to reconcile the saved session.");
            }
        }
    }

    fn verify(&self, token: &str, id: &str) -> Result<Option<Value>> {
        let Some(remote) = self.google.video(token, id)? else {
            return Ok(None);
        };
        let status = &remote["status"];
        let snippet = &remote["snippet"];
        if snippet["channelId"] != self.plan["channelId"]
            || status["privacyStatus"] != "private"
            || !status["publishAt"].is_null()
        {
            return fail(
                "The uploaded video's channel, privacy or schedule differs from the approved plan.",
            );
        }
        let expected = &self.plan["metadata"];
        if snippet["title"] != expected["snippet"]["title"]
            || snippet["description"] != expected["snippet"]["description"]
            || snippet["categoryId"] != expected["snippet"]["categoryId"]
            || status["selfDeclaredMadeForKids"] != expected["status"]["selfDeclaredMadeForKids"]
        {
            return fail("YouTube returned metadata that differs from the approved plan.");
        }
        let processing = &remote["processingDetails"]["processingStatus"];
        let uploaded = &status["uploadStatus"];
        if ["failed", "rejected", "deleted"]
            .iter()
            .any(|state| uploaded == *state)
            || processing == "failed"
        {
            return fail("YouTube reported a failed or rejected upload. Inspect the recorded video ID in Studio.");
        }
        if uploaded == "processed" && (processing.is_null() || processing == "succeeded") {
            return Ok(Some(
                json!({ "privacyStatus": "private", "uploadStatus": uploaded, "processingStatus": processing,
                "title": snippet["title"], "description": snippet["description"], "categoryId": snippet["categoryId"],
                "selfDeclaredMadeForKids": status["selfDeclaredMadeForKids"] }),
            ));
        }
        Ok(None)
    }

    fn receipt(&self, status: &str, mut detail: Value) -> Exit {
        detail["runId"] = self.run["runId"].clone();
        detail["workflow"] = json!(NAME);
        detail["status"] = json!(status);
        detail["journal"] = json!(self.journal.dir);
        detail["youtube"] = status_detail(self.run, self.journal.events());
        Exit {
            code: 2,
            result: detail,
        }
    }

    fn stop(&mut self, step: &str, reason: &GatewayError) -> Result<Exit> {
        self.journal
            .append(json!({ "kind": "stop", "step": step, "stoppedAt": step, "what": reason.0 }))?;
        Ok(self.receipt("stopped", json!({ "stoppedAt": step, "reason": reason.0 })))
    }
}

fn finish(journal: &mut Journal, result: Value) -> Result<Exit> {
    if !journal
        .events()
        .iter()
        .any(|event| event["kind"] == "finished")
    {
        journal.write_value("result.json", &result)?;
        journal.append(
            json!({ "kind": "finished", "step": "result", "verdict": result["verdict"] }),
        )?;
    }
    Ok(Exit {
        code: if result["verdict"] == "private_verified" {
            0
        } else {
            2
        },
        result,
    })
}
