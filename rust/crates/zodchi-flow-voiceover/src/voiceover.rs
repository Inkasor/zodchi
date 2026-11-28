//! Render the approved wording of each timed cue as speech, then place the cues in a WAV.

use zodchi_flow_engine::{
    boundary::Launch,
    input_common,
    journal::{new_run_id, Journal},
    video_media as media, Exit,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use zodchi_core::{
    appserver::SAFETY_BLOCKED,
    config::Config,
    realtime::{self, SpeechRequest, MODEL, SAMPLE_RATE, VOICES},
    util::{fail, sha256_hex, GatewayError, Result},
};

pub const NAME: &str = "voiceover";
const VERSION: &str = "1";
const BYTES_PER_MS: usize = SAMPLE_RATE as usize * 2 / 1000;
const MAX_DURATION_MS: u64 = 600_000;
const MAX_CUE_MS: u64 = 25_000;
const VOICE_GUIDANCE: [&str; 10] = [
    "Even delivery for instructions and neutral narration",
    "Grounded delivery for conversational narration",
    "Warm delivery for stories and slower passages",
    "Clear animated delivery for a host or explainer",
    "Reserved delivery for dry humor and dialogue",
    "Steady delivery for factual and technical narration",
    "Bright delivery for a lively short",
    "Energetic delivery for a short hook or character",
    "First audition for expressive short-form narration",
    "First audition for measured narration and technical names",
];
const LANGUAGES: [(&str, &str, &str); 13] = [
    ("ru-RU", "Russian", "cedar"),
    ("en-US", "English (United States)", "marin"),
    ("en-GB", "English (United Kingdom)", "cedar"),
    ("fr-FR", "French (France)", "marin"),
    ("es-ES", "Spanish (Spain)", "marin"),
    ("es-MX", "Spanish (Mexico)", "marin"),
    ("de-DE", "German", "cedar"),
    ("it-IT", "Italian", "marin"),
    ("pt-BR", "Portuguese (Brazil)", "marin"),
    ("sr-Latn", "Serbian (Latin script)", "cedar"),
    ("pl-PL", "Polish", "cedar"),
    ("ja-JP", "Japanese", "cedar"),
    ("zh-CN", "Mandarin Chinese (mainland China)", "cedar"),
];

pub fn voices() -> Exit {
    let voices: Vec<_> = VOICES
        .iter()
        .zip(VOICE_GUIDANCE)
        .map(|(id, try_for)| json!({ "id": id, "tryFor": try_for }))
        .collect();
    let languages: Vec<_> = LANGUAGES.iter().map(|(tag, language, voice)| {
        json!({ "tag": tag, "language": language, "recommendedVoice": voice })
    }).collect();
    Exit {
        code: 0,
        result: json!({ "model": MODEL, "voices": voices, "languages": languages }),
    }
}

fn bounded_text<'a>(value: &'a Value, field: &str, limit: usize) -> Result<&'a str> {
    let text = media::text(value, field)?;
    if text.len() > limit {
        return fail(format!("{field} exceeds {limit} UTF-8 bytes."));
    }
    Ok(text)
}

fn optional_text<'a>(value: &'a Value, field: &str, limit: usize) -> Result<&'a str> {
    match value.get(field) {
        Some(text) => bounded_text(text, field, limit),
        None => Ok(""),
    }
}

fn time_ms(value: &Value, field: &str) -> Result<u64> {
    value
        .as_u64()
        .filter(|ms| *ms <= MAX_DURATION_MS)
        .ok_or_else(|| {
            GatewayError(format!(
                "{field} must be an integer from 0 to {MAX_DURATION_MS} milliseconds."
            ))
        })
}

fn playback_speed(value: Option<&Value>, default: f64, field: &str) -> Result<f64> {
    match value {
        Some(value) => value
            .as_f64()
            .filter(|speed| (0.25..=1.5).contains(speed))
            .ok_or_else(|| GatewayError(format!("{field} must be a number from 0.25 to 1.5."))),
        None => Ok(default),
    }
}

fn locale(tag: &str) -> Result<(&str, &str)> {
    let mut parts = tag.split('-');
    let primary = parts.next().unwrap_or("");
    if !(2..=3).contains(&primary.len())
        || !primary.bytes().all(|b| b.is_ascii_alphabetic())
        || !parts.take(5).all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
        || tag.split('-').count() > 5
    {
        return fail(
            "args.language must be a language tag such as ru-RU, en-US, fr-FR or sr-Latn.",
        );
    }
    Ok(LANGUAGES
        .iter()
        .find(|(name, _, _)| tag.eq_ignore_ascii_case(name))
        .or_else(|| {
            LANGUAGES
                .iter()
                .find(|(name, _, _)| tag.eq_ignore_ascii_case(name.split('-').next().unwrap_or("")))
        })
        .map_or((tag, "marin"), |(_, language, voice)| (*language, *voice)))
}

fn plan(raw: &Value) -> Result<Value> {
    media::fields(
        raw,
        &[
            "dir",
            "language",
            "voice",
            "speed",
            "style",
            "pronunciation",
            "durationMs",
            "cues",
            "paid",
        ],
        "voiceover args",
    )?;
    let dir = media::directory(&raw["dir"], "args.dir")?;
    let tag = bounded_text(&raw["language"], "args.language", 35)?;
    let (language, default_voice) = locale(tag)?;
    let voice = match raw.get("voice") {
        Some(value) => media::text(value, "args.voice")?,
        None => default_voice,
    };
    if !VOICES.contains(&voice) {
        return fail(
            "Unknown Realtime voice. Run zodchi flow voiceover voices for the available voices.",
        );
    }
    let style = optional_text(raw, "style", 2000)?;
    let pronunciation = optional_text(raw, "pronunciation", 2000)?;
    let speed = playback_speed(raw.get("speed"), 1.0, "args.speed")?;
    let cues = raw["cues"]
        .as_array()
        .filter(|cues| (1..=60).contains(&cues.len()))
        .ok_or_else(|| GatewayError("args.cues needs from 1 to 60 timed cues.".into()))?;
    let mut end = 0;
    let mut planned = Vec::new();
    for (index, cue) in cues.iter().enumerate() {
        let at = format!("cues[{index}]");
        media::fields(
            cue,
            &[
                "startMs",
                "endMs",
                "text",
                "spokenText",
                "direction",
                "speed",
            ],
            &at,
        )?;
        let start = time_ms(&cue["startMs"], &format!("{at}.startMs"))?;
        let until = time_ms(&cue["endMs"], &format!("{at}.endMs"))?;
        if start < end || until <= start || until - start > MAX_CUE_MS {
            return fail(format!(
                "{at} must follow the previous cue and have a window of 1 to {MAX_CUE_MS} ms."
            ));
        }
        let text = bounded_text(&cue["text"], &format!("{at}.text"), 2000)?;
        let spoken = cue
            .get("spokenText")
            .map(|value| bounded_text(value, &format!("{at}.spokenText"), 2000))
            .transpose()?
            .unwrap_or(text);
        let direction = optional_text(cue, "direction", 1000)?;
        let cue_speed = playback_speed(cue.get("speed"), speed, &format!("{at}.speed"))?;
        let instructions = format!(
            "You record one line for a short video. Speak in {language} ({tag}). The user message is the complete \
             spoken script. Read it verbatim once. Apply pronunciation and direction as silent performance notes. \
             Start with the first word of the script and end at the last. Fit comfortably within {:.2} seconds. \
             Performance: {style}\nPronunciation: {pronunciation}\nDirection for this line: {direction}",
            (until - start) as f64 * cue_speed / 1000.0
        );
        let max_output = ((until - start) / 16 + 256).clamp(256, 1536);
        planned.push(json!({
            "startMs": start, "endMs": until, "text": text, "spokenText": spoken,
            "instructions": instructions, "speed": cue_speed, "maxOutputTokens": max_output,
        }));
        end = until;
    }
    let duration = raw
        .get("durationMs")
        .map(|value| time_ms(value, "args.durationMs"))
        .transpose()?
        .unwrap_or(end);
    if duration < end {
        return fail("args.durationMs must cover every cue.");
    }
    Ok(json!({
        "dir": dir, "model": MODEL, "voice": voice, "language": tag, "speed": speed,
        "durationMs": duration, "calls": planned.len(), "cues": planned,
    }))
}

pub fn preview(raw: &Value) -> Result<Exit> {
    Ok(Exit {
        code: 0,
        result: plan(raw)?,
    })
}

pub fn project_stop_status(run: &Value, last: &Value, result: &mut Value) {
    if run["workflow"] == NAME {
        result["errorKind"] = last["errorKind"].clone();
        result["mayHaveBeenCharged"] = last["mayHaveBeenCharged"].clone();
    }
}

pub fn start(raw: &Value, launch: Option<Launch>) -> Result<Exit> {
    if raw["paid"] != true {
        return fail("voiceover uses the OpenAI API. Set args.paid to true to authorize the planned cue calls.");
    }
    let plan = plan(raw)?;
    let dir = PathBuf::from(plan["dir"].as_str().expect("voiceover folder"));
    let cfg = Config::context(&dir)?;
    let id = new_run_id();
    let run = json!({
        "runId": id, "workflow": NAME, "version": VERSION, "release": env!("CARGO_PKG_VERSION"),
        "repo": dir, "inputs": {
            "argsSha256": input_common::args_digest(raw), "planSha256": input_common::args_digest(&plan), "plan": plan,
        },
        "pair": { "voice": { "provider": "openai-realtime", "model": MODEL, "voice": plan["voice"], "language": plan["language"] } },
        "policy": { "paid": true, "plannedCalls": plan["calls"] },
    });
    let journal = Journal::create(&cfg.home, &id, &run)?;
    if let Some(launch) = launch {
        launch(&journal, &id)
    } else {
        resume(&id, None)
    }
}

pub fn resume(id: &str, rerun: Option<&str>) -> Result<Exit> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    let _lock = journal.lock()?;
    journal.load()?;
    let plan = &run["inputs"]["plan"];
    if run["workflow"] != NAME
        || run["version"] != VERSION
        || run["policy"]["paid"] != true
        || run["inputs"]["planSha256"] != input_common::args_digest(plan)
    {
        return fail("The pinned voiceover plan does not match the run.");
    }
    if let Some(result) = journal.read_value("result.json") {
        if rerun.is_some() {
            return fail("This voiceover run has finished. Start a new run for revised cues.");
        }
        if let Some(track) = result.get("track").filter(|track| !track.is_null()) {
            verify_wave(&journal.file("voiceover.wav"), track)?;
        }
        return finish(&mut journal, result);
    }
    if let Some(step) = rerun {
        if !journal
            .last_event()
            .is_some_and(|event| event["kind"] == "stop" && event["step"] == step)
            || journal
                .last("intent", step, journal.attempt(step))
                .is_none()
        {
            return fail("Retry must name the stopped cue that may have been charged.");
        }
        journal.append(json!({ "kind": "rerun", "step": step }))?;
    }
    let voice = plan["voice"].as_str().expect("pinned voice");
    let mut rows = Vec::new();
    let mut track =
        vec![0; plan["durationMs"].as_u64().expect("pinned duration") as usize * BYTES_PER_MS];
    for (index, cue) in plan["cues"]
        .as_array()
        .expect("pinned cues")
        .iter()
        .enumerate()
    {
        let row = match render_cue(&mut journal, voice, index, cue)? {
            Cue::Done(row) => row,
            Cue::Stop {
                step,
                code,
                message,
            } => return stop(&mut journal, id, &step, code, &message),
        };
        if row["fits"] == true {
            let bytes = verify_wave(Path::new(row["path"].as_str().expect("cue path")), &row)?;
            let start = cue["startMs"].as_u64().expect("cue start") as usize * BYTES_PER_MS;
            let pcm = &bytes[44..];
            track[start..start + pcm.len()].copy_from_slice(pcm);
        }
        rows.push(row);
    }
    let fits = rows.iter().all(|row| row["fits"] == true);
    let track = if fits {
        let bytes = wave(&track);
        let path = journal.write_bytes("voiceover.wav", &bytes)?;
        json!({ "path": path, "sha256": sha256_hex(&bytes), "durationMs": plan["durationMs"] })
    } else {
        Value::Null
    };
    let verdict = if fits { "rendered" } else { "timing-review" };
    let script_review: Vec<_> = rows
        .iter()
        .filter(|row| row["scriptMatch"] != true)
        .map(|row| &row["cue"])
        .collect();
    let result = json!({
        "runId": id, "workflow": NAME, "status": verdict, "model": MODEL,
        "voice": voice, "language": plan["language"], "track": track,
        "scriptReview": script_review, "cues": rows,
    });
    journal.write_value("result.json", &result)?;
    finish(&mut journal, result)
}

enum Cue {
    Done(Value),
    Stop {
        step: String,
        code: &'static str,
        message: String,
    },
}

fn render_cue(journal: &mut Journal, voice: &str, index: usize, cue: &Value) -> Result<Cue> {
    let number = index + 1;
    let step = format!("cue {number}");
    let attempt = journal.attempt(&step);
    let stem = format!("cues/{number}-{attempt}");
    let file = format!("{stem}.wav");
    let receipt = format!("{stem}.json");
    if let Some(row) = journal.read_value(&receipt) {
        if row["cue"] != number
            || row["attempt"] != attempt
            || row["path"] != json!(journal.file(&file))
            || row["planSha256"] != input_common::args_digest(cue)
            || journal
                .last("intent", &step, attempt)
                .map(|event| &event["planSha256"])
                != Some(&row["planSha256"])
        {
            return fail(format!(
                "The saved receipt for {step} does not match its intent."
            ));
        }
        let wav = verify_wave(&journal.file(&file), &row)?;
        let window_ms =
            cue["endMs"].as_u64().expect("cue end") - cue["startMs"].as_u64().expect("cue start");
        if row["fits"] != (wav.len() - 44 <= window_ms as usize * BYTES_PER_MS) {
            return fail(format!(
                "The recorded timing for {step} differs from its WAV."
            ));
        }
        if let Some(done) = journal.last("done", &step, attempt) {
            if done["result"] != row {
                return fail(format!(
                    "The saved receipt for {step} changed after completion."
                ));
            }
        } else {
            journal.append(
                json!({ "kind": "done", "step": step, "attempt": attempt, "result": row }),
            )?;
        }
        return Ok(Cue::Done(row));
    }
    if journal.last("intent", &step, attempt).is_some() {
        return Ok(Cue::Stop {
            step, code: "unknown",
            message: "The cue has a paid intent without a verified audio receipt. Inspect its files before explicitly retrying.".into(),
        });
    }
    if journal.last("safety blocked", &step, attempt).is_some() {
        return Ok(Cue::Stop {
            step,
            code: SAFETY_BLOCKED,
            message: "The provider blocked this cue for safety.".into(),
        });
    }
    let spoken = cue["spokenText"].as_str().expect("spoken text");
    let plan_sha = input_common::args_digest(cue);
    let request = SpeechRequest {
        voice,
        speed: cue["speed"].as_f64().unwrap_or(1.0),
        instructions: cue["instructions"].as_str().expect("speech instructions"),
        text: spoken,
        max_output_tokens: cue["maxOutputTokens"].as_u64().expect("output limit") as u32,
    };
    let speech = realtime::speak(request, || {
        journal.append(json!({
        "kind": "intent", "step": step, "attempt": attempt, "model": MODEL, "planSha256": plan_sha,
    }))
    });
    let speech = match speech {
        Ok(speech) => speech,
        Err(error) => {
            return Ok(Cue::Stop {
                step,
                code: error.code,
                message: error.message,
            })
        }
    };
    let mut row = speech.receipt;
    let start = cue["startMs"].as_u64().expect("cue start");
    let end = cue["endMs"].as_u64().expect("cue end");
    let audio = wave(&speech.pcm);
    let words = row["transcript"]
        .as_str()
        .map(normalized_words)
        .unwrap_or_default();
    row["cue"] = json!(number);
    row["attempt"] = json!(attempt);
    row["planSha256"] = json!(plan_sha);
    row["startMs"] = json!(start);
    row["endMs"] = json!(end);
    row["durationMs"] = json!(speech.pcm.len().div_ceil(BYTES_PER_MS));
    row["fits"] = json!(speech.pcm.len() <= (end - start) as usize * BYTES_PER_MS);
    row["text"] = cue["text"].clone();
    row["spokenText"] = cue["spokenText"].clone();
    row["scriptMatch"] = json!(!words.is_empty() && words == normalized_words(spoken));
    row["sha256"] = json!(sha256_hex(&audio));
    row["path"] = json!(journal.write_bytes(&file, &audio)?);
    journal.write_value(&receipt, &row)?;
    journal.append(json!({ "kind": "done", "step": step, "attempt": attempt, "result": row }))?;
    Ok(Cue::Done(row))
}

fn stop(journal: &mut Journal, id: &str, step: &str, code: &str, message: &str) -> Result<Exit> {
    let attempt = journal.attempt(step);
    let charged = journal.last("intent", step, attempt).is_some();
    let prior = journal.last_event().filter(|event| {
        event["kind"] == "stop"
            && event["step"] == step
            && event["attempt"] == attempt
            && (charged || event["errorKind"] == SAFETY_BLOCKED)
    });
    let (code, message) = if let Some(prior) = prior {
        (
            prior["errorKind"].as_str().unwrap_or(code).to_string(),
            prior["what"].as_str().unwrap_or(message).to_string(),
        )
    } else {
        if code == SAFETY_BLOCKED {
            journal.append(json!({
                "kind": "safety blocked", "step": step, "attempt": attempt, "provider": "openai-realtime",
            }))?;
        }
        journal.append(
            json!({ "kind": "stop", "step": step, "attempt": attempt, "stoppedAt": step,
            "errorKind": code, "what": message, "mayHaveBeenCharged": charged }),
        )?;
        (code.to_string(), message.to_string())
    };
    Ok(Exit {
        code: 2,
        result: json!({
            "runId": id, "workflow": NAME, "status": "stopped", "step": step,
            "errorKind": code, "error": message, "mayHaveBeenCharged": charged,
        }),
    })
}

fn finish(journal: &mut Journal, result: Value) -> Result<Exit> {
    if !journal
        .events()
        .iter()
        .any(|event| event["kind"] == "finished")
    {
        journal.append(json!({ "kind": "finished", "status": result["status"] }))?;
    }
    Ok(Exit {
        code: if result["status"] == "rendered" { 0 } else { 2 },
        result,
    })
}

fn normalized_words(text: &str) -> String {
    text.chars()
        .filter(|ch| !matches!(ch, '\u{300}' | '\u{301}'))
        .flat_map(char::to_lowercase)
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn wave(pcm: &[u8]) -> Vec<u8> {
    let len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

fn verify_wave(path: &Path, receipt: &Value) -> Result<Vec<u8>> {
    if fs::metadata(path)?.len() > MAX_DURATION_MS * BYTES_PER_MS as u64 + 44 {
        return fail("The WAV exceeds the voiceover length limit.");
    }
    let audio = fs::read(path)?;
    if audio.len() < 46
        || audio.len() % 2 != 0
        || &audio[..4] != b"RIFF"
        || &audio[8..16] != b"WAVEfmt "
        || &audio[36..40] != b"data"
        || u32::from_le_bytes(audio[40..44].try_into().expect("data length")) as usize
            != audio.len() - 44
        || receipt["sha256"] != sha256_hex(&audio)
    {
        return fail("The voiceover WAV is missing audio or differs from its receipt.");
    }
    Ok(audio)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_language_and_rejects_overlapping_cues() {
        let mut raw = json!({
            "dir": std::env::current_dir().unwrap(), "language": "fr-FR",
            "cues": [{ "startMs": 0, "endMs": 3500, "text": "Écoutez cette voix." }]
        });
        let pinned = plan(&raw).unwrap();
        assert_eq!(pinned["voice"], "marin");
        assert_eq!(pinned["durationMs"], 3500);
        assert!(pinned["cues"][0]["instructions"]
            .as_str()
            .unwrap()
            .contains("French (France)"));
        raw["cues"].as_array_mut().unwrap().push(json!({
            "startMs": 3000, "endMs": 5000, "text": "Un chevauchement."
        }));
        assert!(plan(&raw).is_err());
    }

    #[test]
    fn paid_intent_is_recovered_only_from_verified_audio() {
        let temp = std::env::temp_dir().join(format!("zodchi-audio-{}", new_run_id()));
        let mut journal = Journal::create(&temp, "test", &json!({})).unwrap();
        let cue = json!({ "startMs": 0, "endMs": 3000, "text": "Saved cue." });
        let plan_sha = input_common::args_digest(&cue);
        journal
            .append(json!({
                "kind": "intent", "step": "cue 1", "attempt": 1, "planSha256": plan_sha,
            }))
            .unwrap();
        assert!(matches!(
            render_cue(&mut journal, "cedar", 0, &cue).unwrap(),
            Cue::Stop {
                code: "unknown",
                ..
            }
        ));
        let bytes = wave(&[1, 2, 3, 4]);
        let path = journal.write_bytes("cues/1-1.wav", &bytes).unwrap();
        let receipt = json!({
            "cue": 1, "attempt": 1, "path": path, "planSha256": plan_sha,
            "fits": true, "sha256": sha256_hex(&bytes),
        });
        journal.write_value("cues/1-1.json", &receipt).unwrap();
        assert!(
            matches!(render_cue(&mut journal, "cedar", 0, &cue).unwrap(),
            Cue::Done(row) if row == receipt)
        );
        assert!(journal.last("done", "cue 1", 1).is_some());
        journal
            .write_bytes("cues/1-1.wav", &wave(&[5, 6, 7, 8]))
            .unwrap();
        assert!(render_cue(&mut journal, "cedar", 0, &cue).is_err());
        fs::remove_dir_all(temp).unwrap();
    }
}
