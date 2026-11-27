use crate::{
    boundary::{self, Exit},
    journal::{self, Journal},
    patch, video_media,
};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::Path;
use zodchi_core::config::Config;
use zodchi_core::util::{fail, iso, GatewayError, Result};

#[allow(unused_imports)]
pub(crate) use crate::input_common::{args_digest, args_match, model_context, scrub, Scrubber};

fn read_input(file: &str, media_reply: bool) -> Result<String> {
    let mut raw = String::new();
    fs::File::open(file)?.take(8193).read_to_string(&mut raw)?;
    if raw.len() > 8192 || raw.trim().is_empty() || (!media_reply && raw.chars().count() > 2000) || raw.contains('\0') {
        return fail("Workflow input must contain between 1 and 2000 characters of text.");
    }
    Ok(raw)
}

fn private_places(config: &Config, run: &Value) -> [(String, &'static str); 2] {
    [
        (config.home.to_string_lossy().into_owned(), "<zodchi-home>"),
        (run["repo"].as_str().unwrap_or("").to_string(), "<repo>"),
    ]
}

fn sanitized(config: &Config, run: &Value, file: &str, media_reply: bool) -> Result<String> {
    let raw = read_input(file, media_reply)?;
    let places = private_places(config, run);
    if media_reply {
        let mut value: Value = serde_json::from_str(raw.trim().trim_start_matches('\u{feff}'))
            .map_err(|_| zodchi_core::util::GatewayError("A media reply needs a JSON decision.".into()))?;
        let words = video_media::owner_words(&value["ownerWords"])?;
        value["ownerWords"] = json!(scrub(config, words, &places)?);
        return Ok(value.to_string());
    }
    scrub(config, raw.trim(), &places)
}

type ReplyText = fn(&Journal, &Config, &Value, &Path) -> Result<String>;
type MediaDecision = fn(&Value, &str) -> Result<()>;

#[derive(Default)]
pub(crate) struct ReplyPolicy {
    pub read_text: Option<ReplyText>,
    pub media_decision: Option<MediaDecision>,
    pub waiting_only_error: Option<&'static str>,
    pub decision_flags: bool,
}

struct Reply<'a> {
    answered: Option<&'a str>,
    no_new_decisions: bool,
    policy: fn(&Value) -> ReplyPolicy,
}

pub(crate) const REVIEW_GAPS: &str = "review gaps";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum GapOption {
    Accept,
    Attach,
    ReviewAgain,
}

impl GapOption {
    pub(crate) const ALL: [Self; 3] = [Self::Accept, Self::Attach, Self::ReviewAgain];

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Attach => "attach context or verification",
            Self::ReviewAgain => "review again",
        }
    }

    fn parse(label: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|option| option.label() == label)
    }
}

pub(crate) struct GapDecision {
    pub id: String,
    pub option: GapOption,
    pub material: String,
}

impl GapDecision {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "option": self.option.label(), "material": self.material })
    }

    pub(crate) fn from_json(decision: &Value) -> Option<Self> {
        Some(Self {
            id: decision["id"].as_str()?.to_string(),
            option: GapOption::parse(decision["option"].as_str()?)?,
            material: decision["material"].as_str()?.to_string(),
        })
    }
}

fn gap_decisions(text: &str, gaps: &[Value]) -> Result<Vec<GapDecision>> {
    let mut decisions: Vec<GapDecision> = Vec::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let header = line.split_once(':').filter(|(id, _)| is_gap_id(id.trim()));
        if let Some((id, option)) = header {
            let id = id.trim();
            if !gaps.iter().any(|gap| gap["id"] == id) {
                return fail(format!("Unknown review gap {id}."));
            }
            if decisions.iter().any(|decision| decision.id == id) {
                return fail(format!("Repeated review gap {id}."));
            }
            let option = GapOption::parse(option.trim()).ok_or_else(|| {
                GatewayError(format!(
                    "For {id}, choose accept, attach context or verification, or review again."
                ))
            })?;
            decisions.push(GapDecision { id: id.to_string(), option, material: String::new() });
        } else if let Some(decision) = decisions.last_mut() {
            decision.material.push_str(line);
            decision.material.push('\n');
        } else if !line.trim().is_empty() {
            return fail("Start the reply with a line of the form <gap id>: <option>.");
        }
    }
    for gap in gaps {
        let id = gap["id"].as_str().expect("waiting review gap has an id");
        if !decisions.iter().any(|decision| decision.id == id) {
            return fail(format!("Missing decision for review gap {id}."));
        }
    }
    Ok(decisions)
}

fn is_gap_id(id: &str) -> bool {
    id.strip_prefix('g').and_then(|rest| rest.split_once('-'))
        .is_some_and(|(review, index)| [review, index].into_iter().all(|part| {
            !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
        }))
}

pub fn remark(id: &str, file: &str) -> Result<Exit> {
    record(id, file, None)
}

pub fn reply(id: &str, args: &[String], policy: fn(&Value) -> ReplyPolicy) -> Result<Exit> {
    let mut file = None;
    let mut reply = Reply { answered: None, no_new_decisions: false, policy };
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
        let gap_wait = if run["workflow"] == boundary::WORKFLOW {
            journal::last_state_event(&journal.snapshot()?)
                .filter(|event| event["kind"] == "waiting" && event["reason"] == REVIEW_GAPS)
                .cloned()
        } else {
            None
        };
        if gap_wait.is_none() {
            journal.load()?;
        }
        if journal.file("result.json").is_file() {
            return fail(format!("Run {id} has already recorded its result."));
        }
        if let Some(waiting) = gap_wait {
            // Validate the entire gap reply before appending or repairing the journal.
            if reply.answered.is_some() || reply.no_new_decisions {
                return fail("--answered and --no-new-decisions apply only to design-brief.");
            }
            let gaps = waiting["gaps"].as_array().expect("waiting review gaps");
            let mut decisions = gap_decisions(&read_input(file, false)?, gaps)?;
            let scrubber = Scrubber::new(&config)?;
            let places = private_places(&config, &run);
            for decision in &mut decisions {
                decision.material = scrubber.text(decision.material.trim_end_matches('\n'), &places);
            }
            let step = &waiting["step"];
            journal.load()?;
            journal.append(json!({
                "kind": "rerun", "step": step, "attempt": waiting["attempt"],
                "ownerAnswer": decisions.iter().map(GapDecision::to_json).collect::<Vec<_>>(),
            }))?;
            boundary::cut("review gap reply");
            return Ok(Exit { result: json!({ "runId": id, "status": "ready", "step": step }), code: 0 });
        }
        let policy = (reply.policy)(&run);
        let waiting = journal.last_event();
        if let Some(error) = policy.waiting_only_error {
            if !waiting.is_some_and(|event| event["kind"] == "waiting") {
                return fail(error);
            }
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
        let text = if let Some(read_text) = policy.read_text {
            read_text(&journal, &config, &run, Path::new(file))?
        } else {
            sanitized(&config, &run, file, policy.media_decision.is_some())?
        };
        if (reply.answered.is_some() || reply.no_new_decisions) && !policy.decision_flags {
            return fail("--answered and --no-new-decisions apply only to design-brief.");
        }
        if let Some(validate) = policy.media_decision {
            validate(journal.last_event().unwrap(), &text)?;
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
