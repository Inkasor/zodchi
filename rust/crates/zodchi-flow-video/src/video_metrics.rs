use serde_json::{json, Value};
use std::collections::HashSet;
use zodchi_core::{
    config::Config,
    util::{fail, parse_iso_ms, GatewayError, Result},
};
use zodchi_flow_engine::{journal::Journal, video_media as media};

pub fn prompt_summary(prior: &Value) -> Vec<Value> {
    prior.as_array().into_iter().flatten().map(|run| {
        let sample = run["samples"].as_array().and_then(|samples| samples.last()).unwrap_or(&Value::Null);
        let first_seconds: Vec<_> = sample["retention"].as_array().into_iter().flatten()
            .filter(|point| point["second"].as_f64().is_some_and(|second| second <= 3.0)).take(12).collect();
        json!({ "runId": run["runId"], "title": run["title"], "elapsedSeconds": sample["elapsedSeconds"],
            "views": sample["views"], "stayedToWatchPercent": sample["stayedToWatchPercent"], "openingRetention": first_seconds })
    }).collect()
}

pub fn prior(home: &Config, raw: Option<&Value>, format: &str) -> Result<Vec<Value>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let ids = raw.as_array().filter(|v| v.len() <= 30).ok_or_else(|| {
        GatewayError("priorRuns must be an array of up to 30 video run IDs.".into())
    })?;
    let mut seen = HashSet::new();
    ids.iter()
        .map(|id| {
            let id = media::text(id, "priorRuns entry")?;
            if !seen.insert(id) {
                return fail("priorRuns has a duplicate run ID.");
            }
            series(home, id, format)
        })
        .collect()
}

fn series(home: &Config, id: &str, format: &str) -> Result<Value> {
    let (journal, run) = Journal::open(&home.home, id)?;
    if run["workflow"] != "video" || run["format"] != format {
        return fail(format!("{id} is not a video of format {format}."));
    }
    let events = journal.snapshot()?;
    let publication = events
        .iter()
        .rev()
        .find(|event| event["kind"] == "video published")
        .ok_or_else(|| GatewayError(format!("Video {id} has no recorded publication.")))?;
    let mut samples: Vec<_> = events
        .iter()
        .filter(|event| event["kind"] == "video stats")
        .map(|event| event["sample"].clone())
        .collect();
    samples.sort_by_key(|sample| sample["elapsedSeconds"].as_u64());
    Ok(json!({
        "runId": id, "title": run["title"], "publication": publication["publication"], "samples": samples,
    }))
}

pub fn parse_sample(raw: &Value, publication: &Value, target: u64) -> Result<Value> {
    media::fields(
        raw,
        &[
            "publicationId",
            "capturedAt",
            "views",
            "stayedToWatchPercent",
            "retention",
        ],
        "stats",
    )?;
    if raw["publicationId"] != publication["id"] {
        return fail("The statistics must name the recorded publication ID.");
    }
    let at = time(&raw["capturedAt"], "capturedAt")?;
    let published = time(&publication["snapshotAt"], "publishedAt")?;
    let elapsed = at
        .checked_sub(published)
        .filter(|ms| *ms >= 0)
        .and_then(|ms| u64::try_from(ms / 1000).ok())
        .ok_or_else(|| GatewayError("The snapshot must be at or after publication.".into()))?;
    let views = raw["views"]
        .as_u64()
        .ok_or_else(|| GatewayError("views needs a nonnegative integer.".into()))?;
    let stayed = &raw["stayedToWatchPercent"];
    if !stayed.is_null() && !stayed.as_f64().is_some_and(|n| (0.0..=100.0).contains(&n)) {
        return fail("stayedToWatchPercent must be between 0 and 100 when available.");
    }
    let points = if raw["retention"].is_null() {
        None
    } else {
        Some(
            raw["retention"]
                .as_array()
                .filter(|rows| rows.len() <= 300)
                .ok_or_else(|| GatewayError("Supply up to 300 retention points.".into()))?,
        )
    };
    let mut last = -1.0;
    for point in points.into_iter().flatten() {
        media::fields(point, &["second", "percent"], "retention point")?;
        let second = point["second"]
            .as_f64()
            .filter(|n| *n >= 0.0 && *n > last)
            .ok_or_else(|| {
                GatewayError("Retention seconds must increase from zero or later.".into())
            })?;
        if !point["percent"].as_f64().is_some_and(|n| n >= 0.0) {
            return fail("Retention percent must be nonnegative.");
        }
        last = second;
    }
    Ok(json!({
        "publicationId": raw["publicationId"], "capturedAt": raw["capturedAt"], "capturedAtMs": at,
        "elapsedSeconds": elapsed, "views": views, "viewTarget": target, "targetReached": views >= target,
        "stayedToWatchPercent": stayed, "retention": raw["retention"]
    }))
}

pub fn time(value: &Value, at: &str) -> Result<i128> {
    let value = media::text(value, at)?;
    value
        .ends_with('Z')
        .then(|| parse_iso_ms(value))
        .flatten()
        .ok_or_else(|| GatewayError(format!("{at} needs an RFC 3339 UTC timestamp ending in Z.")))
}

pub fn compare(
    cfg: &Config,
    prior: &Value,
    format: &str,
    sample: &Value,
    window: u64,
) -> Result<Value> {
    let elapsed = sample["elapsedSeconds"].as_u64().unwrap();
    let mut comparisons = Vec::new();
    for prior in prior.as_array().into_iter().flatten() {
        let id = prior["runId"].as_str().unwrap();
        let series = series(cfg, id, format)?;
        let matched = series["samples"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| {
                let difference = row["elapsedSeconds"].as_u64()?.abs_diff(elapsed);
                Some((difference, row))
            })
            .filter(|(difference, _)| *difference <= window)
            .min_by_key(|(difference, _)| *difference);
        comparisons.push(match matched {
            Some((difference, row)) => {
                json!({ "runId": id, "ageDifferenceSeconds": difference, "sample": row })
            }
            None => json!({ "runId": id, "reason": "No captured sample at a comparable age." }),
        });
    }
    Ok(json!(comparisons))
}
