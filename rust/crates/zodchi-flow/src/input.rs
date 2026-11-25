use crate::{checks, journal::Journal, patch, Exit};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use zodchi_core::config::Config;
use zodchi_core::util::{fail, iso, Result};

pub(crate) fn args_digest(raw: &Value) -> String {
    let mut canonical = raw.clone();
    canonical.sort_all_objects();
    zodchi_core::util::sha256_hex(canonical.to_string())
}

pub(crate) fn args_match(inputs: &Value, raw: &Value) -> bool {
    match inputs["argsSha256"].as_str() {
        Some(digest) => args_digest(raw) == digest,
        None => raw == &inputs["args"],
    }
}

fn sanitized(config: &Config, run: &Value, file: &str, reply: bool) -> Result<String> {
    let mut raw = String::new();
    fs::File::open(file)?.take(8193).read_to_string(&mut raw)?;
    let media_reply = reply && (run["workflow"] == crate::video::NAME || run["workflow"] == crate::youtube_publish::NAME);
    if raw.len() > 8192 || raw.trim().is_empty() || (!media_reply && raw.chars().count() > 2000) || raw.contains('\0') {
        return fail("Workflow input must contain between 1 and 2000 characters of text.");
    }
    let places = [
        (config.home.to_string_lossy().into_owned(), "<zodchi-home>"),
        (run["repo"].as_str().unwrap_or("").to_string(), "<repo>"),
    ];
    if media_reply {
        let mut value: Value = serde_json::from_str(raw.trim().trim_start_matches('\u{feff}'))
            .map_err(|_| zodchi_core::util::GatewayError("A media reply needs a JSON decision.".into()))?;
        let words = crate::video_media::owner_words(&value["ownerWords"])?;
        value["ownerWords"] = json!(scrub(config, words, &places)?);
        return Ok(value.to_string());
    }
    scrub(config, raw.trim(), &places)
}

pub fn scrub(config: &Config, raw: &str, places: &[(String, &str)]) -> Result<String> {
    Ok(Scrubber::new(config)?.text(raw, places))
}

pub struct Scrubber {
    words: Vec<String>,
}

pub(crate) const PRIVATE_WITHHELD: &str = "[private text removed]";

pub(crate) fn private_words(contents: &str) -> Vec<String> {
    contents.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_lowercase).collect()
}

pub(crate) fn withheld_lines(text: &str) -> usize {
    text.lines().filter(|line| matches!(*line, PRIVATE_WITHHELD | checks::WITHHELD_LINE)).count()
}

impl Scrubber {
    pub fn new(config: &Config) -> Result<Self> {
    let denylist = std::env::var_os("ZODCHI_DENYLIST").map(PathBuf::from)
        .unwrap_or_else(|| config.home.join("private-words.txt"));
    let contents = match fs::read_to_string(&denylist) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return fail(format!("Cannot read the workflow private-words file: {error}")),
    };
        Ok(Self { words: private_words(&contents) })
    }

    pub(crate) fn allow_words(mut self, words: &[String]) -> Self {
        self.words.retain(|word| !words.contains(word));
        self
    }

    pub fn private(&self, line: &str) -> bool {
        self.has_private_word(line) || Self::credential_shape(line)
    }

    pub(crate) fn has_private_word(&self, line: &str) -> bool {
        let lower = line.to_lowercase();
        self.words.iter().any(|word| lower.contains(word))
    }

    pub(crate) fn credential_shape(line: &str) -> bool {
        let lower = line.to_ascii_lowercase();
        ["sk-", "ghp_", "github_pat_", "xoxb-", "akia", "eyj"].iter().any(|prefix| lower.contains(prefix))
    }

    pub fn value(&self, value: &mut Value, places: &[(String, &str)]) {
        match value {
            Value::String(text) => *text = self.text(text, places),
            Value::Array(items) => items.iter_mut().for_each(|v| self.value(v, places)),
            Value::Object(fields) => fields.values_mut().for_each(|v| self.value(v, places)),
            _ => {}
        }
    }

    pub fn text(&self, raw: &str, places: &[(String, &str)]) -> String {
        let mut private_key = false;
        let lines = raw.lines().map(|line| {
            let upper = line.to_ascii_uppercase();
            if upper.contains("-----BEGIN ") && upper.contains("PRIVATE KEY-----") {
                private_key = true;
            }
            let hidden = private_key || self.private(line);
            if upper.contains("-----END ") && upper.contains("PRIVATE KEY-----") {
                private_key = false;
            }
            if hidden { PRIVATE_WITHHELD } else { line }
        }).collect::<Vec<_>>().join("\n");
        checks::sanitize(&lines, places)
    }
}

struct Reply<'a> {
    answered: Option<&'a str>,
    no_new_decisions: bool,
}

pub fn remark(id: &str, file: &str) -> Result<Exit> {
    record(id, file, None)
}

pub fn reply(id: &str, args: &[String]) -> Result<Exit> {
    let mut file = None;
    let mut reply = Reply { answered: None, no_new_decisions: false };
    let mut args = args.iter().map(String::as_str);
    while let Some(flag) = args.next() {
        match flag {
            "--file" if file.is_none() => {
                file = Some(args.next().ok_or_else(|| zodchi_core::util::GatewayError("--file needs an answer file.".into()))?);
            }
            "--answered" if reply.answered.is_none() => {
                reply.answered = Some(args.next().ok_or_else(|| zodchi_core::util::GatewayError("--answered needs decision numbers or all.".into()))?);
            }
            "--no-new-decisions" if !reply.no_new_decisions => reply.no_new_decisions = true,
            _ => return fail(format!("Unexpected reply option {flag}.")),
        }
    }
    let Some(file) = file else { return fail("Reply needs --file <answer.txt>.") };
    record(id, file, Some(reply))
}

fn record(id: &str, file: &str, reply: Option<Reply<'_>>) -> Result<Exit> {
    let config = Config::new(None)?;
    let (mut journal, run) = Journal::open(&config.home, id)?;
    if let Some(reply) = reply {
        let _lock = journal.lock()?;
        journal.load()?;
        if journal.file("result.json").is_file() {
            return fail(format!("Run {id} has already recorded its result."));
        }
        let waiting = journal.last_event();
        if run["workflow"] == crate::youtube_publish::NAME && !waiting.is_some_and(|event| event["kind"] == "waiting") {
            return fail("The upload has its decision. Resolve the reported issue and resume the same YouTube run.");
        }
        if let Some(step) = waiting.filter(|event| event["kind"] == "stop")
            .and_then(|event| event["step"].as_str()).map(String::from) {
            if reply.answered.is_some() || reply.no_new_decisions {
                return fail("A stopped run accepts a text clarification. Decision flags apply to displayed owner questions.");
            }
            let text = sanitized(&config, &run, file, false)?;
            journal.append(json!({ "kind": "owner clarification", "step": step, "ownerClarification": text }))?;
            return Ok(Exit { result: json!({ "runId": id, "status": "stopped", "reply": "recorded", "step": step }), code: 0 });
        }
        if waiting.is_some_and(|event| event["kind"] == "waiting" && event["reason"] == "budget") {
            return fail(format!("Use zodchi flow budget {id} to extend the package budget."));
        }
        let Some(step) = waiting.filter(|event| event["kind"] == "waiting")
            .and_then(|event| event["writerStep"].as_str().or_else(|| event["step"].as_str())).map(String::from) else {
            return fail(format!("Run {id} must be waiting or stopped to receive a reply."));
        };
        let text = if run["workflow"] == crate::research::NAME {
            crate::research::reply_text(&journal, &config, &run, std::path::Path::new(file))?
        } else {
            sanitized(&config, &run, file, true)?
        };
        if (reply.answered.is_some() || reply.no_new_decisions) && run["workflow"] != crate::design_brief::NAME {
            return fail("--answered and --no-new-decisions apply only to design-brief.");
        }
        if run["workflow"] == crate::video::NAME {
            crate::video::record_reply(journal.last_event().unwrap(), &text)?;
        }
        if run["workflow"] == crate::youtube_publish::NAME {
            crate::youtube_publish::record_reply(journal.last_event().unwrap(), &text)?;
        }
        let mut event = json!({ "kind": "rerun", "step": step, "ownerAnswer": text });
        if reply.answered.is_some() || reply.no_new_decisions {
            let decisions = journal.last_event().unwrap()["decisions"].as_array()
                .ok_or_else(|| zodchi_core::util::GatewayError("The run has no displayed owner decisions.".into()))?;
            if let Some(selection) = reply.answered {
                let indices = if selection == "all" {
                    (0..decisions.len()).collect::<Vec<_>>()
                } else {
                    selection.split(',').map(|value| value.trim().parse::<usize>().ok()
                        .and_then(|number| number.checked_sub(1)).filter(|index| *index < decisions.len()))
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| zodchi_core::util::GatewayError("--answered must name displayed decision numbers, or all.".into()))?
                };
                let questions: Vec<&Value> = indices.iter().map(|index| &decisions[*index]["question"]).collect();
                event["answeredDecisions"] = json!(questions);
            }
            if reply.no_new_decisions {
                event["noNewDecisions"] = json!(true);
            }
        }
        journal.append(event)?;
        return Ok(Exit { result: json!({ "runId": id, "status": "ready", "step": step }), code: 0 });
    }
    if journal.file("result.json").is_file() {
        return fail(format!("Run {id} has already recorded its result."));
    }
    let text = sanitized(&config, &run, file, false)?;
    let prefix: String = iso().chars().filter(char::is_ascii_digit).collect();
    let name = format!("{prefix}-{:016x}", rand::random::<u64>());
    journal.write_value(&format!("remarks/{name}.json"), &json!({ "text": text }))?;
    Ok(Exit { result: json!({ "runId": id, "status": "recorded", "remarkId": name }), code: 0 })
}

pub fn allow_scope(id: &str, file: &str) -> Result<Exit> {
    let config = Config::new(None)?;
    let (mut journal, _) = Journal::open(&config.home, id)?;
    let _lock = journal.lock()?;
    journal.load()?;
    let Some(wait) = journal.last_event().filter(|event| event["kind"] == "waiting" && event["scope"].is_array()) else {
        return fail(format!("Run {id} is not waiting for a file-scope decision."));
    };
    let mut raw = String::new();
    fs::File::open(file)?.take(32769).read_to_string(&mut raw)?;
    let names: Vec<String> = serde_json::from_str(&raw)
        .ok().filter(|names: &Vec<String>| raw.len() <= 32768 && names.iter().all(|path| patch::plain(path)))
        .ok_or_else(|| zodchi_core::util::GatewayError("The scope decision file must be a JSON array of relative file paths.".into()))?;
    let pending = wait["scope"].as_array().expect("scope array");
    if names.len() != pending.len() || pending.iter().any(|path| path.as_str().is_none_or(|path| patch::claimed_as(&names, path).is_none())) {
        return fail("Approve precisely the proposed paths, or reply in text to ask the writer to adjust its proposal.");
    }
    let step = wait["step"].as_str().unwrap_or("").to_string();
    let attempt = journal.attempt(&step);
    let files = wait["scope"].clone();
    journal.append(json!({ "kind": "scope allowed", "step": step, "attempt": attempt, "files": files }))?;
    Ok(Exit { result: json!({ "runId": id, "status": "ready", "step": step, "allowFiles": files }), code: 0 })
}

pub fn model_context(journal: &Journal) -> Result<String> {
    let mut context = Vec::new();
    match fs::read_dir(journal.file("remarks")) {
        Ok(entries) => {
            let mut files: Vec<_> = entries.collect::<std::io::Result<Vec<_>>>()?.into_iter()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .map(|entry| entry.file_name()).collect();
            files.sort();
            for file in files {
                let name = format!("remarks/{}", file.to_string_lossy());
                if let Some(value) = journal.read_value(&name) {
                    if let Some(text) = value["text"].as_str() {
                        context.push(format!("Owner remark:\n{text}"));
                    }
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    for event in journal.events() {
        let step = event["step"].as_str().unwrap_or("the pending step");
        if let Some(text) = event["ownerAnswer"].as_str() {
            context.push(format!("Owner answer for {step}:\n{text}"));
        } else if let Some(text) = event["ownerClarification"].as_str() {
            context.push(format!("Owner clarification for {step} (updates earlier answers):\n{text}"));
        }
    }
    Ok(context.join("\n\n"))
}
