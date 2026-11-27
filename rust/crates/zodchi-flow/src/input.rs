use crate::{journal::{self, Journal}, registry, video_media, Exit};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::Path;
use zodchi_core::config::Config;
use zodchi_core::util::{fail, iso, GatewayError, Result};

#[allow(unused_imports)]
pub(crate) use crate::input_common::{args_digest, args_match, model_context, scrub, Scrubber};

pub(crate) fn read_input(file: &str, media_reply: bool) -> Result<String> {
    let mut raw = String::new();
    fs::File::open(file)?.take(8193).read_to_string(&mut raw)?;
    if raw.len() > 8192 || raw.trim().is_empty() || (!media_reply && raw.chars().count() > 2000) || raw.contains('\0') {
        return fail("Workflow input must contain between 1 and 2000 characters of text.");
    }
    Ok(raw)
}

pub(crate) fn private_places(config: &Config, run: &Value) -> [(String, &'static str); 2] {
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

#[derive(Clone, Copy)]
pub(crate) struct ReplyPolicy {
    pub read_text: Option<ReplyText>,
    pub media_decision: Option<MediaDecision>,
    pub waiting_only_error: Option<&'static str>,
    pub decision_flags: bool,
}

impl ReplyPolicy {
    pub(crate) const TEXT: Self = Self {
        read_text: None,
        media_decision: None,
        waiting_only_error: None,
        decision_flags: false,
    };
}

#[derive(Default)]
pub(crate) struct Reply<'a> {
    pub file: Option<&'a str>,
    pub allow_files: Option<&'a str>,
    pub answered: Option<&'a str>,
    pub no_new_decisions: bool,
}

pub(crate) struct ReplyRun<'a> {
    pub id: &'a str,
    pub config: &'a Config,
    pub run: &'a Value,
}

pub fn remark(id: &str, file: &str) -> Result<Exit> {
    let config = Config::new(None)?;
    let (journal, run) = Journal::open(&config.home, id)?;
    if journal.file("result.json").is_file() {
        return fail(format!("Run {id} has already recorded its result."));
    }
    if journal.file(journal::SHUTDOWN_REQUEST).is_file() {
        return fail(format!("Run {id} is closing."));
    }
    let text = sanitized(&config, &run, file, false)?;
    let prefix: String = iso().chars().filter(char::is_ascii_digit).collect();
    let name = format!("{prefix}-{:016x}", rand::random::<u64>());
    let mut result = json!({ "runId": id, "status": "recorded", "remarkId": name });
    if let Some(remark) = registry::for_run(&run).and_then(|entry| entry.remark) {
        if remark(&journal, &name, &text, &mut result)? {
            return Ok(Exit { result, code: 0 });
        }
    }
    journal.write_value(&format!("remarks/{name}.json"), &json!({ "text": text }))?;
    Ok(Exit { result, code: 0 })
}

pub fn reply(id: &str, args: &[String]) -> Result<Exit> {
    let mut reply = Reply::default();
    let mut args = args.iter().map(String::as_str);
    while let Some(flag) = args.next() {
        match flag {
            "--file" if reply.file.is_none() => {
                reply.file = Some(args.next().ok_or_else(|| zodchi_core::util::GatewayError("--file needs an answer file.".into()))?);
            }
            "--allow-files" if reply.allow_files.is_none() => {
                reply.allow_files = Some(args.next().ok_or_else(|| GatewayError("--allow-files needs a scope file.".into()))?);
            }
            "--answered" if reply.answered.is_none() => {
                reply.answered = Some(args.next().ok_or_else(|| zodchi_core::util::GatewayError("--answered needs decision numbers or all.".into()))?);
            }
            "--no-new-decisions" if !reply.no_new_decisions => reply.no_new_decisions = true,
            _ => return fail(format!("Unexpected reply option {flag}.")),
        }
    }
    if reply.file.is_none() && (reply.allow_files.is_none() || reply.answered.is_some() || reply.no_new_decisions) {
        return fail("Reply needs --file <answer.txt>.");
    }
    record_reply(id, &reply)
}

fn record_reply(id: &str, reply: &Reply<'_>) -> Result<Exit> {
    let config = Config::new(None)?;
    let (mut journal, run) = Journal::open(&config.home, id)?;
    // The approval and answer share one journal record when supplied together.
    let _lock = journal.lock()?;
    let target = ReplyRun { id, config: &config, run: &run };
    let entry = registry::for_run(&run);
    if let Some(handle_reply) = entry.and_then(|entry| entry.handle_reply) {
        return handle_reply(&mut journal, &target, reply);
    }
    journal.load()?;
    check_reply_open(&journal, id)?;
    if reply.allow_files.is_some() {
        return Err(no_scope_wait(id));
    }
    let file = reply.file.expect("reply without a scope file has an answer file");
    let policy = entry.map_or(ReplyPolicy::TEXT, |entry| entry.reply_policy);
    record_standard_reply(&mut journal, &target, file, reply, policy, None)
}

pub(crate) fn no_scope_wait(id: &str) -> GatewayError {
    GatewayError(format!("Run {id} is not waiting for an owner question in code-package."))
}

pub(crate) fn check_reply_open(journal: &Journal, id: &str) -> Result<()> {
    if journal.file("result.json").is_file() {
        return fail(format!("Run {id} has already recorded its result."));
    }
    Ok(())
}

pub(crate) fn record_standard_reply(
    journal: &mut Journal,
    target: &ReplyRun<'_>,
    file: &str,
    reply: &Reply<'_>,
    policy: ReplyPolicy,
    approval: Option<Value>,
) -> Result<Exit> {
    let &ReplyRun { id, config, run } = target;
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
        let text = sanitized(config, run, file, false)?;
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
        read_text(journal, config, run, Path::new(file))?
    } else {
        sanitized(config, run, file, policy.media_decision.is_some())?
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
    record_answer(journal, id, event, approval)
}

pub(crate) fn record_answer(journal: &mut Journal, id: &str, mut event: Value, approval: Option<Value>) -> Result<Exit> {
    let mut result = json!({ "runId": id, "status": "ready", "step": event["step"] });
    if let Some(approval) = approval {
        result["allowFiles"] = approval["files"].clone();
        event["scopeApproval"] = approval;
    }
    journal.append(event)?;
    Ok(Exit { result, code: 0 })
}
