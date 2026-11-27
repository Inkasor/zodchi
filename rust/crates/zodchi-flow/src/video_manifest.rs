//! Write the existing video manifest format from the Rust workflow journal.

use crate::{accepted_media::{encoded, MANIFEST}, journal::Journal, video_media as media};
use serde_json::{json, Value};
use std::{fs, path::Path};
use zodchi_core::util::{fail, iso, sha256_hex, write_atomic, GatewayError, Result};

const EDIT_FIELDS: [&str; 6] = [
    "proposed", "sources", "segments", "audio", "costs", "claims",
];

pub fn edit_of(manifest: &Value) -> Value {
    Value::Object(
        EDIT_FIELDS
            .into_iter()
            .map(|field| (field.to_string(), manifest[field].clone()))
            .collect(),
    )
}

fn rows<'a>(edit: &'a Value, field: &str) -> Result<&'a [Value]> {
    edit[field]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| GatewayError(format!("edit.{field} needs an array.")))
}

pub fn small_id(value: &Value, at: &str, max: usize) -> Result<String> {
    let id = media::text(value, at)?;
    if id.len() > max
        || !id.as_bytes()[0].is_ascii_lowercase() && !id.as_bytes()[0].is_ascii_digit()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte))
    {
        return fail(format!(
            "{at} needs a lower-case id of at most {max} characters."
        ));
    }
    Ok(id.to_string())
}

fn validate_rows(edit: &Value, field: &str, names: &[&str]) -> Result<()> {
    let mut ids = std::collections::HashSet::new();
    for row in rows(edit, field)? {
        media::fields(row, names, field)?;
        if !names.iter().all(|name| row.get(*name).is_some())
            || !ids.insert(small_id(&row["id"], field, 32)?)
        {
            return fail(format!("edit.{field} needs all fields and distinct IDs."));
        }
    }
    Ok(())
}

fn strings(row: &Value, fields: &[&str]) -> bool {
    fields.iter().all(|k| row[*k].is_string())
}

fn choice(row: &Value, field: &str, names: &[&str]) -> bool {
    row[field]
        .as_str()
        .is_some_and(|value| names.contains(&value))
}

pub fn normalized_edit(raw: &Value) -> Result<Value> {
    media::fields(raw, &EDIT_FIELDS, "edit")?;
    media::fields(
        &raw["proposed"],
        &["title", "description", "prompt", "voiceText"],
        "edit.proposed",
    )?;
    if !strings(
        &raw["proposed"],
        &["title", "description", "prompt", "voiceText"],
    ) {
        return fail("edit.proposed needs title, description, prompt and voiceText strings.");
    }
    for (field, names) in [
        ("sources", &["id", "kind", "path", "sha256", "note"][..]),
        (
            "segments",
            &[
                "id",
                "source",
                "in",
                "out",
                "speed",
                "speedMarked",
                "reason",
                "evidence",
                "model",
                "effort",
            ],
        ),
        (
            "audio",
            &[
                "id",
                "role",
                "origin",
                "source",
                "license",
                "attribution",
                "licenseChecked",
            ],
        ),
        (
            "costs",
            &[
                "id",
                "label",
                "scope",
                "basis",
                "amount",
                "currency",
                "rubPerUsd",
                "note",
            ],
        ),
        (
            "claims",
            &["id", "text", "kind", "segment", "confirmation", "note"],
        ),
    ] {
        validate_rows(raw, field, names)?;
    }
    let sources = rows(raw, "sources")?;
    let has_source = |source: &Value| sources.iter().any(|row| &row["id"] == source);
    for source in sources {
        media::text(&source["path"], "source.path")?;
        if !choice(
            source,
            "kind",
            &["screen", "voice", "music", "image", "other"],
        ) || !source["note"].is_string()
            || (!source["sha256"].is_null() && !source["sha256"].as_str().is_some_and(valid_sha))
        {
            return fail("Invalid source kind, note or SHA-256.");
        }
    }
    let segments = rows(raw, "segments")?;
    if segments.is_empty() {
        return fail("The edit needs at least one visible segment.");
    }
    for row in segments {
        let start = row["in"].as_f64().unwrap_or(-1.0);
        let end = row["out"].as_f64().unwrap_or(-1.0);
        let speed = row["speed"].as_f64().unwrap_or(0.0);
        media::text(&row["reason"], "segment.reason")?;
        if !has_source(&row["source"])
            || start < 0.0
            || end <= start
            || speed <= 0.0
            || !row["speedMarked"].is_boolean()
            || (speed != 1.0 && row["speedMarked"] != true)
            || !strings(row, &["evidence", "model", "effort"])
        {
            return fail("Each segment needs a known source, valid times and clear speed marking.");
        }
    }
    for row in rows(raw, "audio")? {
        if !choice(row, "role", &["voice", "music", "effect"])
            || !choice(row, "origin", &["recorded", "synthetic", "licensed", "own"])
            || !(row["source"].is_null() || has_source(&row["source"]))
            || !strings(row, &["license", "attribution"])
            || !row["licenseChecked"].is_boolean()
        {
            return fail("Invalid audio credit or source.");
        }
        if row["role"] == "music" {
            media::text(&row["license"], "music.license")?;
            media::text(&row["attribution"], "music.attribution")?;
        }
    }
    for row in rows(raw, "costs")? {
        if !choice(row, "scope", &["in-frame", "production"])
            || !choice(row, "currency", &["RUB", "USD"])
            || !choice(
                row,
                "basis",
                &["api-equivalent", "subscription-estimate", "measured"],
            )
            || !row["amount"].as_f64().is_some_and(|n| n >= 0.0)
            || !(row["rubPerUsd"].is_null() || row["rubPerUsd"].as_f64().is_some_and(|n| n > 0.0))
            || !strings(row, &["label", "note"])
        {
            return fail("Invalid cost amount, currency or basis.");
        }
    }
    for row in rows(raw, "claims")? {
        if !choice(row, "kind", &["reported", "confirmed"])
            || !(row["segment"].is_null() || segments.iter().any(|s| s["id"] == row["segment"]))
            || !strings(row, &["text", "confirmation", "note"])
            || (row["kind"] == "confirmed"
                && row["confirmation"].as_str().unwrap_or("").trim().is_empty())
            || (row["kind"] == "reported" && row["confirmation"] != "")
        {
            return fail("Claims must name known segments and carry evidence only when confirmed.");
        }
    }
    let mut edit = edit_of(raw);
    integral_numbers(&mut edit);
    Ok(edit)
}

fn integral_numbers(value: &mut Value) {
    match value {
        Value::Number(n) if n.is_f64() => {
            let f = n.as_f64().unwrap();
            if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
                *n = (f as i64).into();
            }
        }
        Value::Array(rows) => rows.iter_mut().for_each(integral_numbers),
        Value::Object(fields) => fields.values_mut().for_each(integral_numbers),
        _ => {}
    }
}

fn valid_sha(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn history(at: &Value, kind: &str, render: Value, words: Value) -> Value {
    json!({ "at": at, "event": kind, "render": render, "by": if words.is_null() {"helper"} else {"owner"}, "words": words })
}

pub fn initial(dir: &Path, id: &str, format: &str, title: &str) -> Result<(Value, Value)> {
    let path = media::owned(dir, MANIFEST)?;
    if path.exists() {
        let draft = media::read_json(&path)?;
        if draft["version"] != 1
            || draft["id"] != id
            || draft["format"] != format
            || draft["status"] != "draft"
            || !draft["chosen"].is_null()
            || !draft["publication"].is_null()
            || !draft["renders"].is_array()
            || !draft["history"].is_array()
            || !draft["deliveryLimitBytes"].as_u64().is_some_and(|n| n > 0)
        {
            return fail("The directory's manifest must be a matching version-one draft.");
        }
        for render in draft["renders"].as_array().unwrap() {
            let render_id = media::text(&render["id"], "existing render ID")?;
            if number(render_id).is_none()
                || !["mp4", "mov", "mkv", "webm", "wav", "mp3", "png", "jpg"]
                    .iter()
                    .any(|ext| render["path"] == format!("renders/{render_id}/{render_id}.{ext}"))
            {
                return fail("An existing render is missing its canonical path.");
            }
        }
        let sha = media::stamp(&path)?["sha256"].clone();
        return Ok((draft, sha));
    }
    Ok((
        json!({
            "version": 1, "id": id, "format": format, "status": "draft",
            "proposed": {"title": title, "description": "", "prompt": "", "voiceText": ""},
            "deliveryLimitBytes": 20_971_520,
            "sources": [], "segments": [], "audio": [], "costs": [], "claims": [], "renders": [],
            "chosen": null, "publication": null, "history": [history(&json!(iso()), "init", Value::Null, Value::Null)]
        }),
        Value::Null,
    ))
}

pub fn save(journal: &mut Journal, dir: &Path, after: &Value) -> Result<()> {
    let path = media::owned(dir, MANIFEST)?;
    let before = media::stamp(&path)?["sha256"].clone();
    let previous = journal
        .events()
        .iter()
        .rev()
        .find(|event| event["kind"] == "video manifest")
        .map(|event| event["body"].clone())
        .or_else(|| {
            journal
                .read_value("run.json")
                .map(|run| run["inputs"]["manifest"].clone())
        })
        .ok_or_else(|| GatewayError("The previous manifest is missing from the journal.".into()))?;
    if before != sha256_hex(encoded(&previous)) {
        return fail("manifest.json changed outside the video workflow.");
    }
    journal.append(json!({ "kind": "video manifest", "before": before, "body": after }))?;
    write_atomic(&path, encoded(after).as_bytes())
}

fn number(id: &str) -> Option<u64> {
    id.strip_prefix('r')
        .filter(|s| !s.starts_with('0'))?
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0)
}

pub fn allocate(dir: &Path, manifest: &mut Value, step: &str, edit: &Value) -> Result<Value> {
    for field in EDIT_FIELDS {
        manifest[field] = edit[field].clone();
    }
    let renders = media::owned(dir, "renders")?;
    fs::create_dir_all(&renders)?;
    let mut max = manifest["renders"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| number(r["id"].as_str()?))
        .max()
        .unwrap_or(0);
    for entry in fs::read_dir(renders)? {
        if let Some(n) = number(&entry?.file_name().to_string_lossy()) {
            max = max.max(n);
        }
    }
    let n = max
        .checked_add(1)
        .ok_or_else(|| GatewayError("The video ran out of render IDs.".into()))?;
    let id = format!("r{n}");
    let now = json!(iso());
    let row = json!({
        "id": id, "path": format!("renders/{id}/{id}.mp4"), "purpose": if step == "probe" { "probe" } else { "build" },
        "state": "allocated", "createdAt": now, "doneAt": null, "bytes": null, "sha256": null, "note": "",
        "edit": edit, "editSha256": sha256_hex(edit.to_string())
    });
    manifest["renders"]
        .as_array_mut()
        .unwrap()
        .push(row.clone());
    manifest["history"].as_array_mut().unwrap().push(history(
        &now,
        "render-new",
        json!(id),
        Value::Null,
    ));
    Ok(row)
}

pub fn update_render(
    manifest: &mut Value,
    id: &Value,
    proof: &Value,
    error: Option<&str>,
) -> Result<bool> {
    let row = manifest["renders"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|r| &r["id"] == id)
        .ok_or_else(|| GatewayError("The allocated render is missing from the manifest.".into()))?;
    let state = if error.is_some() { "failed" } else { "built" };
    if row["state"] == state && row["sha256"] == proof["sha256"] && row["bytes"] == proof["bytes"] {
        return Ok(false);
    }
    if row["state"] != "allocated" {
        return fail("The render already has a different final receipt.");
    }
    let now = json!(iso());
    row["state"] = json!(state);
    row["doneAt"] = now.clone();
    row["bytes"] = proof["bytes"].clone();
    row["sha256"] = proof["sha256"].clone();
    row["note"] = json!(error.unwrap_or("ffprobe and full FFmpeg decode passed"));
    manifest["history"].as_array_mut().unwrap().push(history(
        &now,
        "render-done",
        id.clone(),
        Value::Null,
    ));
    Ok(true)
}

pub fn owner_transition(
    manifest: &mut Value,
    status: &str,
    render: &Value,
    words: &Value,
    publication: &Value,
) -> Result<bool> {
    media::owner_words(words)?;
    if manifest["status"] == status
        && &manifest["chosen"] == render
        && &manifest["publication"] == publication
    {
        return Ok(false);
    }
    let draft_sha = sha256_hex(edit_of(manifest).to_string());
    let built = manifest["renders"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| &r["id"] == render)
        .is_some_and(|r| {
            r["purpose"] == "build"
                && r["state"] == "built"
                && (status != "accepted" || r["editSha256"] == draft_sha)
        });
    if !built
        || match status {
            "accepted" => manifest["status"] != "draft" || !publication.is_null(),
            "published" => {
                manifest["status"] != "accepted"
                    || &manifest["chosen"] != render
                    || publication.is_null()
            }
            _ => true,
        }
    {
        return fail("The owner decision does not identify the eligible build.");
    }
    manifest["status"] = json!(status);
    manifest["chosen"] = render.clone();
    manifest["publication"] = publication.clone();
    manifest["history"].as_array_mut().unwrap().push(history(
        &json!(iso()),
        status,
        render.clone(),
        words.clone(),
    ));
    Ok(true)
}
