//! Import and extend the evidence from the YouTube collector used by the video project.

use crate::{journal::Journal, video_media as media, Exit};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
use zodchi_core::util::{fail, iso, write_json_atomic, GatewayError, Result};

fn video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn capture(raw: &Value) -> Result<Exit> {
    media::fields(
        raw,
        &[
            "dir",
            "search",
            "watch",
            "supplements",
            "reviews",
            "minimumViews",
            "collector",
        ],
        "video research",
    )?;
    let dir = media::directory(&raw["dir"], "args.dir")?;
    let lock = media::owned(&dir, ".zodchi-research-lock")?;
    let _lock = Journal::lock_directory(lock)?;
    let default_search = json!("youtube-search.json");
    let default_watch = json!("youtube-watch.json");
    if let Some(collector) = raw.get("collector") {
        if raw.get("search").is_some() || raw.get("watch").is_some() {
            return fail("collector produces the default youtube-search.json and youtube-watch.json files in args.dir.");
        }
        let search = media::owned(&dir, "youtube-search.json")?;
        let watch = media::owned(&dir, "youtube-watch.json")?;
        match (search.exists(), watch.exists()) {
            (false, false) => {
                let plan = media::tool_plan(&dir, collector)?;
                let result = media::run_tool(&plan, &dir, &dir, |_| Ok(()))?;
                media::require_success(&result, "YouTube collector")?;
            }
            (true, true) => {}
            _ => return fail("The capture is incomplete. Supply the missing source file or collect into a new directory."),
        }
    }
    let search = media::file(&dir, raw.get("search").unwrap_or(&default_search), "search")?;
    let watch = media::file(&dir, raw.get("watch").unwrap_or(&default_watch), "watch")?;
    let minimum = raw
        .get("minimumViews")
        .map(|v| {
            v.as_u64()
                .filter(|n| *n > 0)
                .ok_or_else(|| GatewayError("minimumViews must be a positive integer.".into()))
        })
        .transpose()?
        .unwrap_or(10_000);
    let report_file = media::owned(&dir, "research.json")?;
    let mut report = summarize(
        &dir,
        &search,
        &watch,
        minimum,
        raw.get("supplements"),
        raw.get("reviews"),
    )?;
    if report_file.exists() {
        let old = media::read_json(&report_file)?;
        if old["sources"] != report["sources"] {
            return fail("The recorded source snapshots differ. Keep them and write the new capture in its own directory.");
        }
        let mut reviews = review_rows(
            &dir,
            old["reviews"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            true,
        )?;
        reviews.extend(review_rows(
            &dir,
            report["reviews"].as_array().unwrap(),
            true,
        )?);
        coverage(&mut report, reviews);
    }
    write_json_atomic(&report_file, &report)?;
    Ok(Exit {
        code: 0,
        result: json!({
            "file": report_file, "coverage": report["coverage"], "pending": report["pending"]
        }),
    })
}

fn summarize(
    dir: &Path,
    search_file: &Path,
    watch_file: &Path,
    minimum: u64,
    supplements: Option<&Value>,
    reviews: Option<&Value>,
) -> Result<Value> {
    let search_pin = media::pin(search_file)?;
    let watch_pin = media::pin(watch_file)?;
    let search = media::read_json(search_file)?;
    let watch = media::read_json(watch_file)?;
    media::checked(&search_pin)?;
    media::checked(&watch_pin)?;
    let mut lists = search["searches"]
        .as_array()
        .filter(|v| !v.is_empty())
        .cloned()
        .ok_or_else(|| {
            GatewayError("The search snapshot needs the collector's searches array.".into())
        })?;
    let mut details = watch.as_array().cloned().ok_or_else(|| {
        GatewayError("The watch snapshot needs the collector's array of results.".into())
    })?;
    let mut extra = Vec::new();
    if let Some(supplements) = supplements {
        for input in supplements
            .as_array()
            .filter(|rows| rows.len() <= 16)
            .ok_or_else(|| {
                GatewayError(
                    "supplements needs up to 16 paths to collector follow-up snapshots.".into(),
                )
            })?
        {
            let file = media::file(dir, input, "supplemental research")?;
            let pin = media::pin(&file)?;
            let capture = media::read_json(&file)?;
            media::checked(&pin)?;
            lists.extend_from_slice(capture["queries"].as_array().ok_or_else(|| {
                GatewayError("A supplemental snapshot needs a queries array.".into())
            })?);
            details.extend_from_slice(capture["watch"].as_array().ok_or_else(|| {
                GatewayError("A supplemental snapshot needs a watch array.".into())
            })?);
            extra.push(pin);
        }
    }
    let captured = media::text(&search["captured"], "search snapshot timestamp")?;
    if zodchi_core::util::parse_iso_ms(captured).is_none() {
        return fail("The collector must provide the capture time.");
    }
    let mut candidates: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut queries = Vec::new();
    for search in &lists {
        let query = media::text(&search["query"], "search query")?;
        let url = media::text(&search["url"], "search URL")?;
        let cards = search["cards"]
            .as_array()
            .ok_or_else(|| GatewayError("Each search row needs a cards array.".into()))?;
        let mut ids = BTreeSet::new();
        for card in cards {
            let id = media::text(&card["id"], "card.id")?;
            if !video_id(id) {
                return fail("A search result has an invalid YouTube ID.");
            }
            ids.insert(id);
            candidates
                .entry(id.to_string())
                .or_default()
                .insert(query.to_string());
        }
        queries.push(
            json!({ "query": query, "url": url, "cards": ids.len(), "error": search["error"] }),
        );
    }
    let mut watch_by_id = BTreeMap::new();
    for row in &details {
        let id = media::text(&row["id"], "watch.id")?;
        if !video_id(id) {
            return fail("A watch result has an invalid YouTube ID.");
        }
        if !watch_by_id.contains_key(id) || row["error"].is_null() {
            watch_by_id.insert(id, row);
        }
    }
    let mut rows = Vec::new();
    for (id, queries) in candidates {
        let detail = watch_by_id
            .get(id.as_str())
            .copied()
            .unwrap_or(&Value::Null);
        let confirmed_views = if detail["error"].is_null() {
            detail["views"]
                .as_u64()
                .or_else(|| detail["views"].as_str()?.parse().ok())
        } else {
            None
        };
        rows.push(json!({
            "id": id, "url": format!("https://www.youtube.com/shorts/{id}"), "queries": queries,
            "title": detail["title"], "author": detail["author"], "views": confirmed_views,
            "watchError": detail["error"], "hasStoryboard": detail["has_storyboard"],
            "meetsThreshold": confirmed_views.is_some_and(|n| n >= minimum) && detail["shorts_eligible"] != false
        }));
    }
    let reviews = match reviews {
        Some(input) if input.is_string() => {
            media::read_json(&media::file(dir, input, "review list")?)?
        }
        Some(input) => input.clone(),
        None => json!([]),
    };
    let reviews = review_rows(
        dir,
        reviews
            .as_array()
            .ok_or_else(|| GatewayError("reviews needs an array.".into()))?,
        false,
    )?;
    let mut report = json!({
        "version": 1, "capturedAt": captured, "recordedAt": iso(), "minimumViews": minimum,
        "sources": {"search": search_pin, "watch": watch_pin, "supplements": extra}, "queries": queries, "candidates": rows
    });
    coverage(&mut report, reviews);
    Ok(report)
}

fn review_rows(dir: &Path, raw: &[Value], pinned: bool) -> Result<BTreeMap<String, Value>> {
    let mut rows = BTreeMap::new();
    let mut files = BTreeMap::new();
    for row in raw {
        media::fields(row, &["id", "basis", "evidence"], "review")?;
        let id = media::text(&row["id"], "review.id")?;
        let basis = media::text(&row["basis"], "review.basis")?;
        if !video_id(id) || !["storyboard", "video", "video-and-audio"].contains(&basis) {
            return fail(
                "A review needs a YouTube ID and basis storyboard, video or video-and-audio.",
            );
        }
        let evidence = if pinned {
            media::checked(&row["evidence"])?;
            row["evidence"].clone()
        } else {
            let path = media::file(dir, &row["evidence"], "review evidence")?;
            if !files.contains_key(&path) {
                files.insert(path.clone(), media::pin(&path)?);
            }
            files[&path].clone()
        };
        if rows
            .insert(
                id.to_string(),
                json!({ "id": id, "basis": basis, "evidence": evidence }),
            )
            .is_some()
        {
            return fail("Review entries must have distinct video IDs.");
        }
    }
    Ok(rows)
}

fn coverage(report: &mut Value, reviews: BTreeMap<String, Value>) {
    let queries = report["queries"].as_array().unwrap();
    let rows = report["candidates"].as_array().unwrap();
    let verified: Vec<_> = rows
        .iter()
        .filter(|r| r["meetsThreshold"] == true)
        .collect();
    let pending: Vec<_> = verified
        .iter()
        .filter(|r| !reviews.contains_key(r["id"].as_str().unwrap()))
        .map(|r| r["id"].clone())
        .collect();
    report["coverage"] = json!({
        "queries": queries.len(), "failedQueries": queries.iter().filter(|q| !q["error"].is_null()).count(),
        "candidates": rows.len(), "verified": verified.len(), "reviewed": verified.len() - pending.len(),
        "viewsUnconfirmed": rows.iter().filter(|r| r["views"].is_null()).count(), "pending": pending.len()
    });
    report["reviews"] = json!(reviews.into_values().collect::<Vec<_>>());
    report["pending"] = json!(pending);
}

pub fn pin_report(path: &Path) -> Result<Value> {
    let report = media::read_json(path)?;
    if report["version"] != 1 || !report["coverage"].is_object() || !report["sources"].is_object() {
        return fail("research must be a recorded video research report.");
    }
    for name in ["search", "watch"] {
        media::checked(&report["sources"][name])?;
    }
    for pin in report["sources"]["supplements"]
        .as_array()
        .into_iter()
        .flatten()
    {
        media::checked(pin)?;
    }
    let mut pin = media::pin(path)?;
    pin["coverage"] = report["coverage"].clone();
    Ok(pin)
}
