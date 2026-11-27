//! Validate and reopen the frozen files shared by video and its upload consumer.

use crate::{journal::{Journal, RunLock}, video_media as media};
use serde_json::Value;
use std::path::{Path, PathBuf};
use zodchi_core::{
    config::Config,
    util::{fail, pretty, sha256_hex, write_atomic, GatewayError, Result},
};

pub const NAME: &str = "video";
pub(crate) const VERSION: &str = "1";
pub(crate) const MARKER: &str = ".zodchi-video-run.json";
pub(crate) const MANIFEST: &str = "manifest.json";

pub(crate) struct VideoFiles {
    pub journal: Journal,
    pub run: Value,
    pub dir: PathBuf,
    pub cfg: Config,
    pub manifest: Value,
}

pub(crate) fn open(id: &str) -> Result<(VideoFiles, RunLock)> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    if run["workflow"] != NAME
        || run["version"] != VERSION
        || run["inputs"]["planSha256"] != sha256_hex(run["inputs"]["plan"].to_string())
    {
        return fail("This is not a supported video run with an intact plan.");
    }
    let dir = media::directory(&run["repo"], "recorded video directory")?;
    if media::read_json(&media::owned(&dir, MARKER)?)?["runId"] != id {
        return fail("The video directory no longer belongs to this run.");
    }
    let lock = journal.lock()?;
    journal.load()?;
    let manifest = load_manifest(&journal, &run, &dir)?;
    let cfg = Config::context(&dir)?;
    Ok((VideoFiles { journal, run, dir, cfg, manifest }, lock))
}

pub(crate) fn encoded(value: &Value) -> String {
    pretty(value) + "\n"
}

fn load_manifest(journal: &Journal, run: &Value, dir: &Path) -> Result<Value> {
    let path = media::owned(dir, MANIFEST)?;
    let last = journal
        .events()
        .iter()
        .rev()
        .find(|event| event["kind"] == "video manifest");
    let (body, before) = last.map_or(
        (&run["inputs"]["manifest"], &run["inputs"]["manifestSha256"]),
        |e| (&e["body"], &e["before"]),
    );
    let expected = sha256_hex(encoded(body));
    let current = if path.exists() {
        media::stamp(&path)?["sha256"].clone()
    } else {
        Value::Null
    };
    if current != expected && &current != before {
        return fail("manifest.json changed outside the video workflow.");
    }
    if current != expected {
        write_atomic(&path, encoded(body).as_bytes())?;
    }
    Ok(body.clone())
}

pub(crate) fn assert_artifact(dir: &Path, artifact: &Value) -> Result<()> {
    let relative = media::text(&artifact["relativePath"], "recorded render path")?;
    let path = media::owned(dir, relative)?;
    if media::checked(artifact)? != path {
        return fail("The verified artifact is outside the recorded render slot.");
    }
    Ok(())
}

pub(crate) fn accepted_upload(id: &str) -> Result<(PathBuf, Value)> {
    let (video, _lock) = open(id)?;
    let result = video.journal.read_value("result.json")
        .filter(|result| result["verdict"] == "approved" && video.manifest["status"] == "accepted")
        .ok_or_else(|| GatewayError("Choose an approved video run with an accepted, unpublished final MP4.".into()))?;
    let artifact = &result["final"];
    if artifact["render"] != video.manifest["chosen"] {
        return fail("The accepted render does not match the video manifest.");
    }
    assert_artifact(&video.dir, artifact)?;
    Ok((video.dir, artifact.clone()))
}
